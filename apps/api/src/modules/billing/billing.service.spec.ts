import { EmployeeRole, OrderStatus } from '@smarttable/shared-types';
import { BillingActor, BillingService } from './billing.service';
import {
  BillGroupRow,
  BillingOrderItemRow,
  BillingOrderRow,
  BillingRepository,
  PaymentRow,
  RecordPaymentResult,
} from './billing.repository';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  PaymentAlreadyRecordedException,
  PaymentNotReadyException,
} from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the billing domain rules (Engineering Standards §10):
 *  - the D9 bill shape and the D1 billable gate (served-only totals,
 *    cancelled excluded, in-flight listed but not charged),
 *  - B3 tax math integration at the bill level,
 *  - payment outcome → exception mapping (404 / PAYMENT_NOT_READY /
 *    PAYMENT_ALREADY_RECORDED),
 *  - FR38 audits (payment_recorded, order_paid, order_completed) and
 *    Contract §4 after-commit events (order.status_changed ×2 per order,
 *    table.status_changed — and NO payment event, which doesn't exist).
 */
describe('BillingService', () => {
  let service: BillingService;
  let repository: jest.Mocked<BillingRepository>;
  let audit: jest.Mocked<AuditService>;
  let events: jest.Mocked<DomainEventsService>;

  const actor = (role: EmployeeRole = EmployeeRole.CASHIER, id = 'emp-cashier'): BillingActor => ({ id, role });

  const groupRow = (overrides: Partial<BillGroupRow> = {}): BillGroupRow => ({
    id: 'group-1',
    tableId: 'table-1',
    status: 'open',
    openedAt: 1000,
    closedAt: null,
    ...overrides,
  });

  const orderRow = (overrides: Partial<BillingOrderRow> = {}): BillingOrderRow => ({
    id: 'order-1',
    tableBillGroupId: 'group-1',
    tableId: 'table-1',
    channel: 'dine_in',
    isAddon: false,
    status: 'served',
    source: 'waiter_manual',
    createdByEmployeeId: 'emp-1',
    acceptedByEmployeeId: null,
    servedByEmployeeId: null,
    cancelledByEmployeeId: null,
    cancellationReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  const itemRow = (overrides: Partial<BillingOrderItemRow> = {}): BillingOrderItemRow => ({
    id: 'item-1',
    orderId: 'order-1',
    productId: 'product-1',
    nameSnapshot: 'شوربة',
    categorySnapshot: 'مقبلات',
    unitPriceMinorSnapshot: 25_000,
    quantity: 2,
    notes: null,
    ...overrides,
  });

  const paymentRow = (overrides: Partial<PaymentRow> = {}): PaymentRow => ({
    id: 'payment-1',
    tableBillGroupId: 'group-1',
    amountMinor: 59_500,
    method: 'cash',
    collectedByEmployeeId: 'emp-cashier',
    shiftId: null,
    createdAt: 2000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      findBillGroupById: jest.fn(),
      findOrdersWithItemsForGroup: jest.fn(),
      findPaymentForGroup: jest.fn(),
      getTaxRateBasisPoints: jest.fn(),
      recordPaymentTransaction: jest.fn(),
      openShiftTransaction: jest.fn(),
      findShiftById: jest.fn(),
      closeShiftTransaction: jest.fn(),
    } as jest.Mocked<BillingRepository>;
    audit = { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
    events = {
      emitOrderStatusChanged: jest.fn(),
      emitTableStatusChanged: jest.fn(),
    } as unknown as jest.Mocked<DomainEventsService>;
    service = new BillingService(repository, audit, events);
  });

  // ---------------------------------------------------------------- getBill

  describe('getBill', () => {
    it('rejects an unknown group with 404', async () => {
      repository.findBillGroupById.mockResolvedValue(undefined);
      await expect(service.getBill('ghost')).rejects.toThrow(EntityNotFoundException);
      expect(repository.findOrdersWithItemsForGroup).not.toHaveBeenCalled();
    });

    it('assembles the D9 shape: group, orders, totals, rate, null payment', async () => {
      repository.findBillGroupById.mockResolvedValue(groupRow());
      repository.findOrdersWithItemsForGroup.mockResolvedValue([{ order: orderRow(), items: [itemRow()] }]);
      repository.getTaxRateBasisPoints.mockResolvedValue(1900);
      repository.findPaymentForGroup.mockResolvedValue(undefined);

      const bill = await service.getBill('group-1');

      expect(bill.group).toEqual({ id: 'group-1', tableId: 'table-1', status: 'open', openedAt: 1000, closedAt: null });
      expect(bill.orders).toHaveLength(1);
      expect(bill.orders[0].items[0]).toMatchObject({ name: 'شوربة', unitPriceMinor: 25_000, quantity: 2 });
      expect(bill.subtotalMinor).toBe(50_000);
      expect(bill.taxMinor).toBe(9_500);
      expect(bill.totalMinor).toBe(59_500);
      expect(bill.taxRateBasisPoints).toBe(1900);
      expect(bill.payment).toBeNull();
    });

    it('D1: totals aggregate served/paid/completed only; an in-flight order is listed but NOT charged', async () => {
      repository.findBillGroupById.mockResolvedValue(groupRow());
      repository.findOrdersWithItemsForGroup.mockResolvedValue([
        { order: orderRow({ id: 'order-served', status: 'served' }), items: [itemRow({ id: 'i1', orderId: 'order-served' })] },
        {
          order: orderRow({ id: 'order-preparing', status: 'preparing', isAddon: true }),
          items: [itemRow({ id: 'i2', orderId: 'order-preparing', unitPriceMinorSnapshot: 99_000, quantity: 1 })],
        },
      ]);
      repository.getTaxRateBasisPoints.mockResolvedValue(0);
      repository.findPaymentForGroup.mockResolvedValue(undefined);

      const bill = await service.getBill('group-1');

      expect(bill.orders.map((order) => order.id)).toEqual(['order-served', 'order-preparing']);
      expect(bill.subtotalMinor).toBe(50_000); // the 99_000 preparing order is NOT in the totals
      expect(bill.totalMinor).toBe(50_000);
    });

    it('D1: cancelled orders are excluded from BOTH the list and the totals', async () => {
      repository.findBillGroupById.mockResolvedValue(groupRow());
      repository.findOrdersWithItemsForGroup.mockResolvedValue([
        { order: orderRow({ id: 'order-served', status: 'served' }), items: [itemRow({ id: 'i1', orderId: 'order-served' })] },
        {
          order: orderRow({ id: 'order-cancelled', status: 'cancelled', cancellationReason: 'mistake' }),
          items: [itemRow({ id: 'i3', orderId: 'order-cancelled', unitPriceMinorSnapshot: 77_000, quantity: 1 })],
        },
      ]);
      repository.getTaxRateBasisPoints.mockResolvedValue(0);
      repository.findPaymentForGroup.mockResolvedValue(undefined);

      const bill = await service.getBill('group-1');

      expect(bill.orders.map((order) => order.id)).toEqual(['order-served']);
      expect(bill.subtotalMinor).toBe(50_000);
    });

    it('a paid group shows its payment and keeps the same totals (completed stays billable)', async () => {
      repository.findBillGroupById.mockResolvedValue(groupRow({ status: 'closed', closedAt: 3000 }));
      repository.findOrdersWithItemsForGroup.mockResolvedValue([
        { order: orderRow({ status: 'completed' }), items: [itemRow()] },
      ]);
      repository.getTaxRateBasisPoints.mockResolvedValue(1900);
      repository.findPaymentForGroup.mockResolvedValue(paymentRow());

      const bill = await service.getBill('group-1');

      expect(bill.group.status).toBe('closed');
      expect(bill.totalMinor).toBe(59_500);
      expect(bill.payment).toMatchObject({ id: 'payment-1', amountMinor: 59_500, method: 'cash' });
    });
  });

  // --------------------------------------------------------- recordPayment

  describe('recordPayment', () => {
    it('maps not_found → 404', async () => {
      repository.recordPaymentTransaction.mockResolvedValue({ outcome: 'not_found' });
      await expect(service.recordPayment({ tableBillGroupId: 'ghost' }, actor())).rejects.toThrow(EntityNotFoundException);
    });

    it('maps not_ready → 409 PAYMENT_NOT_READY carrying the blocking order ids (D1)', async () => {
      repository.recordPaymentTransaction.mockResolvedValue({ outcome: 'not_ready', blockingOrderIds: ['order-9'] });
      const error: any = await service.recordPayment({ tableBillGroupId: 'group-1' }, actor()).catch((e) => e);
      expect(error).toBeInstanceOf(PaymentNotReadyException);
      expect(error.code).toBe('PAYMENT_NOT_READY');
      expect(error.details).toEqual({ tableBillGroupId: 'group-1', blockingOrderIds: ['order-9'] });
    });

    it('maps already_paid → 409 PAYMENT_ALREADY_RECORDED (D2 double-payment guard)', async () => {
      repository.recordPaymentTransaction.mockResolvedValue({ outcome: 'already_paid', paymentId: 'payment-0' });
      const error: any = await service.recordPayment({ tableBillGroupId: 'group-1' }, actor()).catch((e) => e);
      expect(error).toBeInstanceOf(PaymentAlreadyRecordedException);
      expect(error.code).toBe('PAYMENT_ALREADY_RECORDED');
    });

    const recordedResult = (): Extract<RecordPaymentResult, { outcome: 'recorded' }> => ({
      outcome: 'recorded',
      payment: paymentRow(),
      group: groupRow({ status: 'closed', closedAt: 3000 }),
      tableId: 'table-1',
      taxBasisPoints: 1900,
      perOrder: [
        {
          order: orderRow({ status: 'completed', updatedAt: 3000 }),
          items: [itemRow()],
          totals: { subtotalMinor: 50_000, taxMinor: 9_500, totalMinor: 59_500 },
        },
      ],
      billTotals: { subtotalMinor: 50_000, taxMinor: 9_500, totalMinor: 59_500 },
      shiftId: 'shift-1',
    });

    it('on recorded: audits payment_recorded + BOTH transitions per order (FR38, D3)', async () => {
      repository.recordPaymentTransaction.mockResolvedValue(recordedResult());

      await service.recordPayment({ tableBillGroupId: 'group-1' }, actor());

      const actions = audit.append.mock.calls.map((call) => call[0]);
      expect(actions[0]).toMatchObject({
        actorEmployeeId: 'emp-cashier',
        entityType: 'payment',
        entityId: 'payment-1',
        action: 'payment_recorded',
      });
      expect(JSON.parse(actions[0].newValueJson!)).toMatchObject({
        tableBillGroupId: 'group-1',
        amountMinor: 59_500,
        shiftId: 'shift-1',
      });
      expect(actions[1]).toMatchObject({ entityType: 'order', entityId: 'order-1', action: 'order_paid' });
      expect(JSON.parse(actions[1].oldValueJson!)).toEqual({ status: 'served' });
      expect(JSON.parse(actions[1].newValueJson!)).toEqual({ status: 'paid', paymentId: 'payment-1' });
      expect(actions[2]).toMatchObject({ entityType: 'order', entityId: 'order-1', action: 'order_completed' });
      expect(JSON.parse(actions[2].newValueJson!)).toEqual({ status: 'completed', paymentId: 'payment-1' });
    });

    it('on recorded: emits order.status_changed TWICE per order + table.status_changed — after commit, and NO payment event (Contract §4)', async () => {
      repository.recordPaymentTransaction.mockResolvedValue(recordedResult());

      const result = await service.recordPayment({ tableBillGroupId: 'group-1' }, actor());

      expect(events.emitOrderStatusChanged).toHaveBeenCalledTimes(2);
      expect(events.emitOrderStatusChanged).toHaveBeenNthCalledWith(1, {
        orderId: 'order-1',
        fromStatus: 'served',
        toStatus: 'paid',
      });
      expect(events.emitOrderStatusChanged).toHaveBeenNthCalledWith(2, {
        orderId: 'order-1',
        fromStatus: 'paid',
        toStatus: 'completed',
      });
      expect(events.emitTableStatusChanged).toHaveBeenCalledWith({
        tableId: 'table-1',
        fromStatus: 'occupied',
        toStatus: 'needs_cleaning',
      });

      expect(result.payment.id).toBe('payment-1');
      expect(result.bill.group.status).toBe('closed');
      expect(result.bill.orders[0].status).toBe(OrderStatus.COMPLETED);
      expect(result.bill.totalMinor).toBe(59_500);
      expect(result.bill.payment?.id).toBe('payment-1');
    });
  });
});
