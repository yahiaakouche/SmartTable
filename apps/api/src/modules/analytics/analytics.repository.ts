import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import {
  employees,
  orderItems,
  orderStatusEvents,
  orders,
  payments,
  productSalesRollup,
  restaurantProfile,
  salesRollupDaily,
  salesRollupHourly,
  shifts,
  tableBillGroups,
  tables,
} from '../../database/schema';

export const ANALYTICS_REPOSITORY = Symbol('ANALYTICS_REPOSITORY');

export type DailyRollupRow = typeof salesRollupDaily.$inferSelect;
export type HourlyRollupRow = typeof salesRollupHourly.$inferSelect;
export type ProductRollupRow = typeof productSalesRollup.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type StatusEventRow = typeof orderStatusEvents.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type ShiftRow = typeof shifts.$inferSelect;
export type BillGroupRow = typeof tableBillGroups.$inferSelect;
export type EmployeeRow = typeof employees.$inferSelect;

/**
 * Read-only analytics persistence (Step 3.7) — the query side of the Hybrid
 * Analytics Architecture (PRD §7 item 30, Database Schema §8). This module
 * owns NO writes: rollups are written solely by the 3.4 payment/cancel
 * transactions (`database/rollups.ts`), raw facts live in the permanent
 * order/payment tables (FR44). Three read sources, one repository:
 *  - rollup tables (historical ranges, the frozen fast path),
 *  - raw order/payment/status-event tables ("today" live per the Contract §3
 *    design note, and every employeeId-filtered query — the documented
 *    exception, since no rollup carries an employee dimension),
 *  - live tables status (Active Tables KPI — range-independent).
 */
export interface AnalyticsRepository {
  findDailyRollupRows(from: string, to: string): Promise<DailyRollupRow[]>;
  findHourlyRollupRows(from: string, to: string): Promise<HourlyRollupRow[]>;
  findProductRollupRows(from: string, to: string): Promise<ProductRollupRow[]>;
  /** Status events of one kind inside an epoch-ms window [fromMs, toMs). */
  findEventsByStatusInWindow(toStatus: string, fromMs: number, toMs: number): Promise<StatusEventRow[]>;
  /** Every actor-attributed event in a window (operational stats). */
  findActorEventsInWindow(fromMs: number, toMs: number): Promise<StatusEventRow[]>;
  /** Events of one kind for specific orders, regardless of window (the
   * accepted event that precedes a ready event can sit before the range). */
  findEventsByOrderIdsAndStatus(orderIds: string[], toStatus: string): Promise<StatusEventRow[]>;
  findOrdersByIds(ids: string[]): Promise<OrderRow[]>;
  findOrdersByBillGroupIds(groupIds: string[]): Promise<OrderRow[]>;
  findItemsByOrderIds(orderIds: string[]): Promise<OrderItemRow[]>;
  findPaymentsInWindow(fromMs: number, toMs: number, collectedByEmployeeId?: string): Promise<PaymentRow[]>;
  findPaymentsByBillGroupIds(groupIds: string[]): Promise<PaymentRow[]>;
  findShiftsByIds(ids: string[]): Promise<ShiftRow[]>;
  /** Visits CLOSED inside the window (table turnover KPI). */
  findClosedBillGroupsInWindow(fromMs: number, toMs: number): Promise<BillGroupRow[]>;
  /** Live tables currently hosting a visit (occupied + bill_requested). */
  countActiveTables(): Promise<number>;
  findActiveKitchenWaiterStaff(): Promise<EmployeeRow[]>;
  getTaxRateBasisPoints(): Promise<number>;
}

@Injectable()
export class DrizzleAnalyticsRepository implements AnalyticsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async findDailyRollupRows(from: string, to: string): Promise<DailyRollupRow[]> {
    return this.db
      .select()
      .from(salesRollupDaily)
      .where(and(gte(salesRollupDaily.date, from), lt(salesRollupDaily.date, this.nextDay(to))));
  }

  async findHourlyRollupRows(from: string, to: string): Promise<HourlyRollupRow[]> {
    return this.db
      .select()
      .from(salesRollupHourly)
      .where(and(gte(salesRollupHourly.date, from), lt(salesRollupHourly.date, this.nextDay(to))));
  }

  async findProductRollupRows(from: string, to: string): Promise<ProductRollupRow[]> {
    return this.db
      .select()
      .from(productSalesRollup)
      .where(and(gte(productSalesRollup.date, from), lt(productSalesRollup.date, this.nextDay(to))));
  }

  async findEventsByStatusInWindow(toStatus: string, fromMs: number, toMs: number): Promise<StatusEventRow[]> {
    return this.db
      .select()
      .from(orderStatusEvents)
      .where(
        and(
          eq(orderStatusEvents.toStatus, toStatus),
          gte(orderStatusEvents.createdAt, fromMs),
          lt(orderStatusEvents.createdAt, toMs),
        ),
      );
  }

  async findActorEventsInWindow(fromMs: number, toMs: number): Promise<StatusEventRow[]> {
    return this.db
      .select()
      .from(orderStatusEvents)
      .where(
        and(
          isNotNull(orderStatusEvents.actorEmployeeId),
          gte(orderStatusEvents.createdAt, fromMs),
          lt(orderStatusEvents.createdAt, toMs),
        ),
      );
  }

  async findEventsByOrderIdsAndStatus(orderIds: string[], toStatus: string): Promise<StatusEventRow[]> {
    if (orderIds.length === 0) return [];
    return this.db
      .select()
      .from(orderStatusEvents)
      .where(and(inArray(orderStatusEvents.orderId, orderIds), eq(orderStatusEvents.toStatus, toStatus)));
  }

  async findOrdersByIds(ids: string[]): Promise<OrderRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(orders).where(inArray(orders.id, ids));
  }

  async findOrdersByBillGroupIds(groupIds: string[]): Promise<OrderRow[]> {
    if (groupIds.length === 0) return [];
    return this.db.select().from(orders).where(inArray(orders.tableBillGroupId, groupIds));
  }

  async findItemsByOrderIds(orderIds: string[]): Promise<OrderItemRow[]> {
    if (orderIds.length === 0) return [];
    return this.db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
  }

  async findPaymentsInWindow(fromMs: number, toMs: number, collectedByEmployeeId?: string): Promise<PaymentRow[]> {
    const conditions = [
      gte(payments.createdAt, fromMs),
      lt(payments.createdAt, toMs),
      ...(collectedByEmployeeId !== undefined ? [eq(payments.collectedByEmployeeId, collectedByEmployeeId)] : []),
    ];
    return this.db.select().from(payments).where(and(...conditions));
  }

  async findPaymentsByBillGroupIds(groupIds: string[]): Promise<PaymentRow[]> {
    if (groupIds.length === 0) return [];
    return this.db.select().from(payments).where(inArray(payments.tableBillGroupId, groupIds));
  }

  async findShiftsByIds(ids: string[]): Promise<ShiftRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(shifts).where(inArray(shifts.id, ids));
  }

  async findClosedBillGroupsInWindow(fromMs: number, toMs: number): Promise<BillGroupRow[]> {
    return this.db
      .select()
      .from(tableBillGroups)
      .where(
        and(
          eq(tableBillGroups.status, 'closed'),
          isNotNull(tableBillGroups.closedAt),
          gte(tableBillGroups.closedAt, fromMs),
          lt(tableBillGroups.closedAt, toMs),
        ),
      );
  }

  async countActiveTables(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(tables)
      .where(and(eq(tables.isActive, true), sql`${tables.status} IN ('occupied','bill_requested')`));
    return rows[0]?.count ?? 0;
  }

  async findActiveKitchenWaiterStaff(): Promise<EmployeeRow[]> {
    return this.db
      .select()
      .from(employees)
      .where(and(eq(employees.isActive, true), sql`${employees.role} IN ('kitchen','waiter')`));
  }

  async getTaxRateBasisPoints(): Promise<number> {
    const rows = await this.db.select({ taxRatePercent: restaurantProfile.taxRatePercent }).from(restaurantProfile).limit(1);
    return rows[0]?.taxRatePercent ?? 0;
  }

  /** Inclusive-end helper: rollup dates are 'YYYY-MM-DD' strings compared
   * lexicographically (the frozen string-date exception, Schema §8). */
  private nextDay(date: string): string {
    const [y, m, d] = date.split('-').map(Number);
    const next = new Date(y!, m! - 1, d! + 1);
    const month = String(next.getMonth() + 1).padStart(2, '0');
    const day = String(next.getDate()).padStart(2, '0');
    return `${next.getFullYear()}-${month}-${day}`;
  }
}
