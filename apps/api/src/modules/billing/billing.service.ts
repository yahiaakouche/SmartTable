import { Inject, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentMethod, TableBillGroupStatus } from '@smarttable/shared-types';
import type {
  ConsolidatedBillDto,
  OrderDto,
  PaymentDto,
  PaymentRecordedDto,
  RecordPaymentRequest,
  TableBillGroupDto,
} from '@smarttable/shared-types';
import type { EmployeeRole } from '@smarttable/shared-types';
import {
  BILLING_REPOSITORY,
  BillGroupRow,
  BillingOrderItemRow,
  BillingOrderRow,
  BillingRepository,
  OrderWithItems,
  PaymentRow,
} from './billing.repository';
import { computeOrderTotals, sumTotals } from './billing-math';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  PaymentAlreadyRecordedException,
  PaymentNotReadyException,
} from '../../common/exceptions/domain.exception';

/** The acting-employee context, transport-agnostic (ES §3). */
export interface BillingActor {
  id: string;
  role: EmployeeRole;
}

/** Ruling D1 — an order counts toward the bill only once it is SERVED (or
 * has already passed through payment); cancelled orders are excluded from
 * totals entirely, and in-flight orders neither charge nor (alone) block
 * the bill VIEW — they block the PAYMENT. */
const BILLABLE_STATUSES: readonly string[] = [OrderStatus.SERVED, OrderStatus.PAID, OrderStatus.COMPLETED];

/**
 * The billing domain (FR8, FR9, FR12, FR34's close side, FR36/FR37, PRD §13)
 * — consolidated Table Bill Group bills and the single cash payment that
 * settles a guest visit.
 *
 * ES §5: all billing calculations live HERE (never in OrdersService and
 * never in a controller). The payment write itself — bill recomputation,
 * payment row, both per-order transitions, synchronous rollups, group close,
 * table flip — is one atomic repository transaction; this service owns the
 * pre/post orchestration: gate outcomes → exceptions, FR38 audits, and
 * Contract §4 after-commit events.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billingRepository: BillingRepository,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
  ) {}

  /** GET /billing/table-bill-groups/:id — the consolidated bill (FR9): the
   * main order and every add-on as ONE financial view (ruling D9 shape). */
  async getBill(tableBillGroupId: string): Promise<ConsolidatedBillDto> {
    const group = await this.billingRepository.findBillGroupById(tableBillGroupId);
    if (!group) throw new EntityNotFoundException('table-bill-group', tableBillGroupId);

    const ordersWithItems = await this.billingRepository.findOrdersWithItemsForGroup(group.id);
    const taxBasisPoints = await this.billingRepository.getTaxRateBasisPoints();
    const payment = await this.billingRepository.findPaymentForGroup(group.id);
    return this.assembleBill(group, ordersWithItems, taxBasisPoints, payment ?? null);
  }

  /** POST /payments — settles the whole Table Bill Group in ONE server-
   * computed cash payment (D2), moving every served order Paid → Completed
   * (D3: two recorded transitions each), closing the group (FR34) and
   * flipping the table to needs_cleaning (PRD §13, B1). Idempotent via the
   * Contract §1 Idempotency-Key infrastructure on the controller. */
  async recordPayment(input: RecordPaymentRequest, actor: BillingActor): Promise<PaymentRecordedDto> {
    const result = await this.billingRepository.recordPaymentTransaction({
      tableBillGroupId: input.tableBillGroupId,
      collectedByEmployeeId: actor.id,
    });

    switch (result.outcome) {
      case 'not_found':
        throw new EntityNotFoundException('table-bill-group', input.tableBillGroupId);
      case 'not_ready':
        throw new PaymentNotReadyException(input.tableBillGroupId, result.blockingOrderIds);
      case 'already_paid':
        throw new PaymentAlreadyRecordedException(input.tableBillGroupId, result.paymentId);
    }

    // ---- the transaction committed above; only audits + events below ----

    // FR38 — the payment and BOTH financial transitions per order are
    // audit-logged (Paid/Completed are named explicitly in FR38's list).
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'payment',
      entityId: result.payment.id,
      action: 'payment_recorded',
      newValueJson: JSON.stringify({
        tableBillGroupId: result.group.id,
        tableId: result.tableId,
        amountMinor: result.payment.amountMinor,
        method: result.payment.method,
        shiftId: result.shiftId,
        orderIds: result.perOrder.map((line) => line.order.id),
      }),
    });
    for (const line of result.perOrder) {
      await this.audit.append({
        actorEmployeeId: actor.id,
        entityType: 'order',
        entityId: line.order.id,
        action: 'order_paid',
        oldValueJson: JSON.stringify({ status: 'served' }),
        newValueJson: JSON.stringify({ status: 'paid', paymentId: result.payment.id }),
      });
      await this.audit.append({
        actorEmployeeId: actor.id,
        entityType: 'order',
        entityId: line.order.id,
        action: 'order_completed',
        oldValueJson: JSON.stringify({ status: 'paid' }),
        newValueJson: JSON.stringify({ status: 'completed', paymentId: result.payment.id }),
      });
    }

    // Contract §4 — events strictly after commit, and ONLY events from the
    // frozen list: there is deliberately no `payment.*` event; the financial
    // transitions surface through the existing order/table channels.
    for (const line of result.perOrder) {
      this.events.emitOrderStatusChanged({ orderId: line.order.id, fromStatus: 'served', toStatus: 'paid' });
      this.events.emitOrderStatusChanged({ orderId: line.order.id, fromStatus: 'paid', toStatus: 'completed' });
    }
    this.events.emitTableStatusChanged({ tableId: result.tableId, fromStatus: 'occupied', toStatus: 'needs_cleaning' });

    const paymentDto = this.paymentToDto(result.payment);
    const bill = this.assembleBill(result.group, result.perOrder, result.taxBasisPoints, result.payment);
    return { payment: paymentDto, bill };
  }

  // ---------------------------------------------------------------- helpers

  /** Ruling D9 bill shape: every non-cancelled order is listed (chronological);
   * totals aggregate BILLABLE orders only (D1). */
  private assembleBill(
    group: BillGroupRow,
    ordersWithItems: OrderWithItems[],
    taxBasisPoints: number,
    payment: PaymentRow | null,
  ): ConsolidatedBillDto {
    const nonCancelled = ordersWithItems.filter((line) => line.order.status !== OrderStatus.CANCELLED);
    const billableTotals = nonCancelled
      .filter((line) => BILLABLE_STATUSES.includes(line.order.status))
      .map((line) => computeOrderTotals(line.items, taxBasisPoints));
    const totals = sumTotals(billableTotals);
    return {
      group: this.groupToDto(group),
      orders: nonCancelled.map((line) => this.orderToDto(line.order, line.items)),
      subtotalMinor: totals.subtotalMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      taxRateBasisPoints: taxBasisPoints,
      payment: payment ? this.paymentToDto(payment) : null,
    };
  }

  private groupToDto(row: BillGroupRow): TableBillGroupDto {
    return {
      id: row.id,
      tableId: row.tableId,
      status: row.status as TableBillGroupStatus,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    };
  }

  private paymentToDto(row: PaymentRow): PaymentDto {
    return {
      id: row.id,
      tableBillGroupId: row.tableBillGroupId,
      amountMinor: row.amountMinor,
      method: row.method as PaymentMethod,
      collectedByEmployeeId: row.collectedByEmployeeId,
      shiftId: row.shiftId,
      createdAt: row.createdAt,
    };
  }

  /** Entity → response DTO (Contract §1 DTO boundary). Billing is a
   * financial surface reachable only by Owner/Manager/Cashier (baseline
   * Guard), so the full priced order shape is always correct here — the
   * FR6/Q7 kitchen stripping never applies. */
  private orderToDto(order: BillingOrderRow, items: BillingOrderItemRow[]): OrderDto {
    return {
      id: order.id,
      tableBillGroupId: order.tableBillGroupId,
      tableId: order.tableId,
      channel: order.channel as OrderDto['channel'],
      isAddon: order.isAddon,
      status: order.status as OrderStatus,
      source: order.source as OrderDto['source'],
      items: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        name: item.nameSnapshot,
        category: item.categorySnapshot,
        unitPriceMinor: item.unitPriceMinorSnapshot,
        quantity: item.quantity,
        notes: item.notes,
      })),
      createdByEmployeeId: order.createdByEmployeeId,
      acceptedByEmployeeId: order.acceptedByEmployeeId,
      servedByEmployeeId: order.servedByEmployeeId,
      cancelledByEmployeeId: order.cancelledByEmployeeId,
      cancellationReason: order.cancellationReason,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
