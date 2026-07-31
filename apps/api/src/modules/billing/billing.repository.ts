import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import {
  orderItems,
  orders,
  orderStatusEvents,
  payments,
  restaurantProfile,
  shifts,
  tableBillGroups,
  tables,
} from '../../database/schema';
import { rollupBucketFor, upsertCompletedOrderRollup } from '../../database/rollups';
import { computeOrderTotals, MoneyTotals, sumTotals } from './billing-math';

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');

export type BillGroupRow = typeof tableBillGroups.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type ShiftRow = typeof shifts.$inferSelect;
export type BillingOrderRow = typeof orders.$inferSelect;
export type BillingOrderItemRow = typeof orderItems.$inferSelect;

export interface OrderWithItems {
  order: BillingOrderRow;
  items: BillingOrderItemRow[];
}

export interface CompletedOrderLine {
  order: BillingOrderRow;
  items: BillingOrderItemRow[];
  totals: MoneyTotals;
}

export type RecordPaymentResult =
  | {
      outcome: 'recorded';
      payment: PaymentRow;
      /** The group AFTER its open → closed flip (FR34 auto-close). */
      group: BillGroupRow;
      tableId: string;
      taxBasisPoints: number;
      /** Every order transitioned served → paid → completed, with its totals. */
      perOrder: CompletedOrderLine[];
      billTotals: MoneyTotals;
      /** The collector's open shift at collection time, or null (ruling D7). */
      shiftId: string | null;
    }
  | { outcome: 'not_found' }
  | { outcome: 'already_paid'; paymentId: string | null }
  | { outcome: 'not_ready'; blockingOrderIds: string[] };

export type OpenShiftResult =
  | { outcome: 'opened'; shift: ShiftRow }
  | { outcome: 'already_open'; existing: ShiftRow };

export type CloseShiftResult =
  | { outcome: 'closed'; shift: ShiftRow; paymentsCollected: number }
  | { outcome: 'not_found' }
  | { outcome: 'already_closed'; shift: ShiftRow };

/** Order statuses still moving through the lifecycle — payment is blocked
 * while ANY order of the group is in one of them (ruling D1). */
const IN_FLIGHT_STATUSES = ['pending', 'accepted', 'preparing', 'ready'] as const;

/**
 * Billing persistence — the only writer of `payments` and `shifts` rows, and
 * the only code path that moves orders to `paid`/`completed`, closes Table
 * Bill Groups, and drives tables to `needs_cleaning` (PRD §13).
 *
 * recordPaymentTransaction runs as ONE synchronous better-sqlite3 transaction
 * (precedent: orders Step 3.3): the bill recomputation, payment insert, both
 * per-order transitions, the frozen synchronous rollup updates (Schema §8),
 * the bill-group close and the table flip are atomic — a crash anywhere in
 * the middle leaves NO partial financial state behind (NFR6).
 */
export interface BillingRepository {
  findBillGroupById(id: string): Promise<BillGroupRow | undefined>;
  findOrdersWithItemsForGroup(groupId: string): Promise<OrderWithItems[]>;
  findPaymentForGroup(groupId: string): Promise<PaymentRow | undefined>;
  /** restaurant_profile.tax_rate_percent in integer basis points; 0 when no
   * profile row exists yet (PRD §7 item 25: 0% is the frozen default). */
  getTaxRateBasisPoints(): Promise<number>;
  recordPaymentTransaction(input: {
    tableBillGroupId: string;
    collectedByEmployeeId: string;
  }): Promise<RecordPaymentResult>;
  openShiftTransaction(input: { employeeId: string; openingCashMinor: number }): Promise<OpenShiftResult>;
  findShiftById(id: string): Promise<ShiftRow | undefined>;
  closeShiftTransaction(input: { shiftId: string; closingCashMinor: number }): Promise<CloseShiftResult>;
}

@Injectable()
export class DrizzleBillingRepository implements BillingRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async findBillGroupById(id: string): Promise<BillGroupRow | undefined> {
    const rows = await this.db.select().from(tableBillGroups).where(eq(tableBillGroups.id, id));
    return rows[0];
  }

  async findOrdersWithItemsForGroup(groupId: string): Promise<OrderWithItems[]> {
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.tableBillGroupId, groupId))
      .orderBy(asc(orders.createdAt), asc(orders.id));
    if (orderRows.length === 0) return [];
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(
        sql`${orderItems.orderId} IN (${sql.join(
          orderRows.map((row) => sql`${row.id}`),
          sql`, `,
        )})`,
      );
    return orderRows.map((order) => ({ order, items: itemRows.filter((item) => item.orderId === order.id) }));
  }

  async findPaymentForGroup(groupId: string): Promise<PaymentRow | undefined> {
    const rows = await this.db.select().from(payments).where(eq(payments.tableBillGroupId, groupId));
    return rows[0];
  }

  async getTaxRateBasisPoints(): Promise<number> {
    const rows = await this.db.select({ taxRatePercent: restaurantProfile.taxRatePercent }).from(restaurantProfile);
    return rows[0]?.taxRatePercent ?? 0;
  }

  async recordPaymentTransaction(input: {
    tableBillGroupId: string;
    collectedByEmployeeId: string;
  }): Promise<RecordPaymentResult> {
    return this.db.transaction((tx) => {
      const now = Date.now();

      // 1. The group must exist and be OPEN — a closed group in v1 means
      //    "already paid" (the payment transaction is the only close path).
      const group = tx.select().from(tableBillGroups).where(eq(tableBillGroups.id, input.tableBillGroupId)).all()[0];
      if (!group) return { outcome: 'not_found' } as const;
      const existingPayment = tx.select().from(payments).where(eq(payments.tableBillGroupId, group.id)).all()[0];
      if (group.status !== 'open' || existingPayment) {
        return { outcome: 'already_paid', paymentId: existingPayment?.id ?? null } as const;
      }

      // 2. Ruling D1 — the billable gate, judged at write time inside this
      //    transaction: any in-flight order blocks payment; a group whose
      //    orders were all cancelled has nothing to pay.
      const groupOrders = tx
        .select()
        .from(orders)
        .where(eq(orders.tableBillGroupId, group.id))
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .all();
      const blockingOrderIds = groupOrders
        .filter((order) => (IN_FLIGHT_STATUSES as readonly string[]).includes(order.status))
        .map((order) => order.id);
      if (blockingOrderIds.length > 0) return { outcome: 'not_ready', blockingOrderIds } as const;
      const billable = groupOrders.filter((order) => order.status === 'served');
      if (billable.length === 0) return { outcome: 'not_ready', blockingOrderIds: [] } as const;

      // 3. Bill computation from immutable snapshots (FR40) with the profile's
      //    basis-point tax rate (B3) — the amount is server-computed (D2);
      //    the client never gets a say in it.
      const profile = tx.select({ taxRatePercent: restaurantProfile.taxRatePercent }).from(restaurantProfile).all()[0];
      const taxBasisPoints = profile?.taxRatePercent ?? 0;
      const billableIds = new Set(billable.map((order) => order.id));
      const allItems = tx
        .select()
        .from(orderItems)
        .where(
          sql`${orderItems.orderId} IN (${sql.join(
            billable.map((order) => sql`${order.id}`),
            sql`, `,
          )})`,
        )
        .all()
        .filter((item) => billableIds.has(item.orderId));
      const perOrderLines = billable.map((order) => ({
        order,
        items: allItems.filter((item) => item.orderId === order.id),
        totals: computeOrderTotals(
          allItems.filter((item) => item.orderId === order.id),
          taxBasisPoints,
        ),
      }));
      const billTotals = sumTotals(perOrderLines.map((line) => line.totals));

      // 4. Ruling D7 — link the collector's currently open shift if one
      //    exists; a payment NEVER requires an open shift (shift_id nullable).
      const openShift = tx
        .select()
        .from(shifts)
        .where(and(eq(shifts.employeeId, input.collectedByEmployeeId), eq(shifts.status, 'open')))
        .all()[0];

      // 5. The single full-total payment (D2).
      const payment = tx
        .insert(payments)
        .values({
          tableBillGroupId: group.id,
          amountMinor: billTotals.totalMinor,
          method: 'cash',
          collectedByEmployeeId: input.collectedByEmployeeId,
          shiftId: openShift?.id ?? null,
        })
        .returning()
        .all()[0];

      // 6. Ruling D3 — Paid and Completed are TWO recorded transitions per
      //    order (both status events, both audited by the service). The
      //    compare-and-set on the expected status is the frozen optimistic-
      //    locking pattern; a miss here means corrupted control flow, so it
      //    throws and rolls the whole transaction back.
      const bucket = rollupBucketFor(now);
      const perOrder: CompletedOrderLine[] = perOrderLines.map((line) => {
        const paid = tx
          .update(orders)
          .set({ status: 'paid', updatedAt: now })
          .where(and(eq(orders.id, line.order.id), eq(orders.status, 'served')))
          .returning()
          .all()[0];
        if (!paid) throw new Error(`payment transaction: order ${line.order.id} was not 'served' at paid transition`);
        tx.insert(orderStatusEvents)
          .values({
            orderId: line.order.id,
            fromStatus: 'served',
            toStatus: 'paid',
            actorEmployeeId: input.collectedByEmployeeId,
          })
          .run();

        const completed = tx
          .update(orders)
          .set({ status: 'completed', updatedAt: now })
          .where(and(eq(orders.id, line.order.id), eq(orders.status, 'paid')))
          .returning()
          .all()[0];
        if (!completed) throw new Error(`payment transaction: order ${line.order.id} was not 'paid' at completed transition`);
        tx.insert(orderStatusEvents)
          .values({
            orderId: line.order.id,
            fromStatus: 'paid',
            toStatus: 'completed',
            actorEmployeeId: input.collectedByEmployeeId,
          })
          .run();

        // 7. The FROZEN synchronous rollup mechanism (Schema §8): this order's
        //    Completed transition updates daily/hourly/product rollups in the
        //    same transaction — post-tax per order (B3), server-local day (D4).
        upsertCompletedOrderRollup(tx, {
          bucket,
          now,
          orderTotalMinor: line.totals.totalMinor,
          channel: line.order.channel,
          items: line.items,
        });
        return { order: completed, items: line.items, totals: line.totals };
      });

      // 8. FR34 — the Table Bill Group auto-closes as payment completes; the
      //    CAS on 'open' doubles as the definitive double-payment backstop.
      const closedGroup = tx
        .update(tableBillGroups)
        .set({ status: 'closed', closedAt: now })
        .where(and(eq(tableBillGroups.id, group.id), eq(tableBillGroups.status, 'open')))
        .returning()
        .all()[0];
      if (!closedGroup) throw new Error(`payment transaction: bill group ${group.id} was not 'open' at close`);

      // 9. PRD §13 — payment flips the table occupied → needs_cleaning
      //    (ruling B1: directly from `occupied`; `bill_requested` is unused
      //    in v1). Strict CAS: any other from-state is an integrity violation
      //    and rolls everything back.
      const flipped = tx
        .update(tables)
        .set({ status: 'needs_cleaning', updatedAt: now })
        .where(and(eq(tables.id, group.tableId), eq(tables.status, 'occupied')))
        .returning()
        .all();
      if (!flipped[0]) throw new Error(`payment transaction: table ${group.tableId} was not 'occupied' at needs_cleaning flip`);

      return {
        outcome: 'recorded',
        payment,
        group: closedGroup,
        tableId: group.tableId,
        taxBasisPoints,
        perOrder,
        billTotals,
        shiftId: openShift?.id ?? null,
      } as const;
    });
  }

  async openShiftTransaction(input: { employeeId: string; openingCashMinor: number }): Promise<OpenShiftResult> {
    return this.db.transaction((tx) => {
      // Ruling D6 — one open shift per employee; the check and the insert are
      // atomic so two concurrent opens by the same employee can't both win.
      const existing = tx
        .select()
        .from(shifts)
        .where(and(eq(shifts.employeeId, input.employeeId), eq(shifts.status, 'open')))
        .all()[0];
      if (existing) return { outcome: 'already_open', existing } as const;

      const shift = tx
        .insert(shifts)
        .values({ employeeId: input.employeeId, openingCashMinor: input.openingCashMinor })
        .returning()
        .all()[0];
      return { outcome: 'opened', shift } as const;
    });
  }

  async findShiftById(id: string): Promise<ShiftRow | undefined> {
    const rows = await this.db.select().from(shifts).where(eq(shifts.id, id));
    return rows[0];
  }

  async closeShiftTransaction(input: { shiftId: string; closingCashMinor: number }): Promise<CloseShiftResult> {
    return this.db.transaction((tx) => {
      const now = Date.now();
      const shift = tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).all()[0];
      if (!shift) return { outcome: 'not_found' } as const;
      if (shift.status !== 'open') return { outcome: 'already_closed', shift } as const;

      // Ruling D6 — expected = opening + Σ cash payments LINKED to this shift,
      // computed at close time inside the same transaction as the close.
      const aggregate = tx
        .select({
          paymentsCollected: sql<number>`count(*)`,
          collectedMinor: sql<number>`coalesce(sum(${payments.amountMinor}), 0)`,
        })
        .from(payments)
        .where(eq(payments.shiftId, shift.id))
        .all()[0];
      const expectedCashMinor = shift.openingCashMinor + (aggregate?.collectedMinor ?? 0);

      // CAS on 'open' — a double close can never silently recompute the
      // reconciliation; the loser reports already_closed.
      const closed = tx
        .update(shifts)
        .set({ status: 'closed', closingCashMinor: input.closingCashMinor, expectedCashMinor, closedAt: now })
        .where(and(eq(shifts.id, shift.id), eq(shifts.status, 'open')))
        .returning()
        .all()[0];
      if (!closed) return { outcome: 'already_closed', shift } as const;
      return { outcome: 'closed', shift: closed, paymentsCollected: aggregate?.paymentsCollected ?? 0 } as const;
    });
  }
}
