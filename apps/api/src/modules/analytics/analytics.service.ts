import { Inject, Injectable } from '@nestjs/common';
import {
  ANALYTICS_RANGE,
  AnalyticsKpisDto,
  EmployeeRole,
  OperationalEmployeeStatsDto,
  OperationalStatsDto,
  OrdersOverTimeDto,
  RevenueOverTimeDto,
  TopProductsDto,
} from '@smarttable/shared-types';
// Pure money functions imported (not re-implemented) so analytics revenue
// can never drift from the billing definitions (3.4 B3/D4) — the ES §2
// module rule governs injectable providers; billing-math is a pure,
// provider-free utility and the single source of truth for order totals.
import { computeOrderTotals, roundHalfUpDiv } from '../billing/billing-math';
import { rollupBucketFor } from '../../database/rollups';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { ANALYTICS_REPOSITORY, AnalyticsRepository, OrderItemRow } from './analytics.repository';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

const MS_PER_DAY = 86_400_000;
const TOP_PRODUCTS_LIMIT = 10; // D3

interface ResolvedRange {
  from: string; // 'YYYY-MM-DD', inclusive
  to: string; // 'YYYY-MM-DD', inclusive
  fromMs: number;
  toExclusiveMs: number;
  singleDay: boolean;
  includesToday: boolean;
  /** The pre-today portion served from rollups; null when the range is
   * today-only. */
  historicalFrom: string | null;
  historicalTo: string | null;
}

/** One completed order's analytics facts — post-tax total (3.4 B3) plus the
 * immutable item snapshots (FR40) at NET merchandise value (pre-tax). */
interface OrderFacts {
  orderId: string;
  channel: string;
  completedAtMs: number;
  totalMinor: number;
  items: { name: string; category: string; quantity: number; netMinor: number }[];
}

interface ProductAggregate {
  name: string;
  category: string;
  quantity: number;
  revenueMinor: number;
}

interface Aggregates {
  revenueMinor: number;
  dineInMinor: number;
  deliveryMinor: number;
  orders: number;
  cancelled: number;
  /** B2(a) note: a cancellation has no collecting employee — employeeId-
   * filtered queries cannot attribute cancellations, so the rate is null. */
  cancelledAttributable: boolean;
  productAgg: Map<string, ProductAggregate>;
  categoryAgg: Map<string, { quantity: number; revenueMinor: number }>;
  hourlyAgg: Map<number, { revenueMinor: number; orders: number }>;
  dailyAgg: Map<string, { revenueMinor: number; orders: number }>;
}

/**
 * Analytics domain — Step 3.7 (PRD §7 items 29–30, FR41–FR43, API Contract
 * §3 analytics + its frozen design note). READ-ONLY by construction: this
 * service writes nothing — rollups are written by the 3.4 transactions, raw
 * facts are permanent (FR44).
 *
 * The frozen hybrid branching (Contract §3 design note), generalized to one
 * engine: every resolved range is split into a pre-today portion (served
 * from the rollup tables) and an optional today portion (served live from
 * raw orders/payments); the two are merged with identical semantics, so
 * `today` is live-only, past ranges are rollup-only, and ranges spanning
 * today are a per-day hybrid (R4). EmployeeId-filtered financial queries
 * (B2(a): the COLLECTING employee) always read raw payments/orders — the
 * documented exception, since no frozen rollup carries an employee dimension
 * and FR44 guarantees the raw data is permanent.
 *
 * All calendar boundaries are server-local (3.4 ruling D4) via the same
 * `rollupBucketFor` the writers use (R2 — analytics can never disagree with
 * a rollup row about which day an order belongs to).
 */
@Injectable()
export class AnalyticsService {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly analyticsRepository: AnalyticsRepository) {}

  // ------------------------------------------------------------- endpoints

  async getKpis(query: AnalyticsQueryDto): Promise<AnalyticsKpisDto> {
    const range = this.resolveRange(query);
    const aggregates = await this.aggregate(query, range);

    const averageOrderValueMinor = aggregates.orders > 0 ? roundHalfUpDiv(aggregates.revenueMinor, aggregates.orders) : null;
    const bestProduct = this.bestOf([...aggregates.productAgg.values()]);
    const bestCategory = this.bestOf(
      [...aggregates.categoryAgg.entries()].map(([name, value]) => ({ name, ...value })),
    );
    const peakSalesHour = this.peakHour(aggregates);
    const peakSalesDay = this.peakDay(aggregates);
    const cancellationRate = !aggregates.cancelledAttributable
      ? null
      : aggregates.orders + aggregates.cancelled > 0
        ? Math.round((aggregates.cancelled / (aggregates.orders + aggregates.cancelled)) * 10_000) / 10_000
        : null;

    const [averagePreparationTimeMs, activeTables, averageTableTurnoverMs, revenueByShift] = await Promise.all([
      this.averagePreparationTime(range),
      this.analyticsRepository.countActiveTables(),
      this.averageTableTurnover(range),
      this.revenueByShift(range, query.employeeId),
    ]);

    return {
      range: { from: range.from, to: range.to },
      totalRevenueMinor: aggregates.revenueMinor,
      dineInRevenueMinor: aggregates.dineInMinor,
      deliveryRevenueMinor: aggregates.deliveryMinor,
      totalOrders: aggregates.orders,
      averageOrderValueMinor,
      bestSellingProduct: bestProduct ? { name: bestProduct.name, quantitySold: bestProduct.quantity } : null,
      bestSellingCategory: bestCategory ? { name: bestCategory.name, quantitySold: bestCategory.quantity } : null,
      peakSalesHour,
      peakSalesDay,
      averagePreparationTimeMs,
      activeTables,
      cancellationRate,
      averageTableTurnoverMs,
      revenueByShift,
      categoryMix: [...aggregates.categoryAgg.entries()]
        .map(([category, value]) => ({ category, quantitySold: value.quantity, revenueMinor: value.revenueMinor }))
        .sort((a, b) => b.revenueMinor - a.revenueMinor || a.category.localeCompare(b.category)),
    };
  }

  async getRevenueOverTime(query: AnalyticsQueryDto): Promise<RevenueOverTimeDto> {
    const range = this.resolveRange(query);
    const aggregates = await this.aggregate(query, range);
    const { granularity, buckets } = this.seriesBuckets(range);
    return {
      range: { from: range.from, to: range.to },
      granularity,
      points: buckets.map((bucket) => ({
        bucket,
        revenueMinor: this.bucketValue(aggregates, granularity, bucket).revenueMinor,
      })),
    };
  }

  async getOrdersOverTime(query: AnalyticsQueryDto): Promise<OrdersOverTimeDto> {
    const range = this.resolveRange(query);
    const aggregates = await this.aggregate(query, range);
    const { granularity, buckets } = this.seriesBuckets(range);
    return {
      range: { from: range.from, to: range.to },
      granularity,
      points: buckets.map((bucket) => ({ bucket, ordersCount: this.bucketValue(aggregates, granularity, bucket).orders })),
    };
  }

  async getTopProducts(query: AnalyticsQueryDto): Promise<TopProductsDto> {
    const range = this.resolveRange(query);
    const aggregates = await this.aggregate(query, range);
    const products = [...aggregates.productAgg.values()]
      .sort((a, b) => b.quantity - a.quantity || b.revenueMinor - a.revenueMinor || a.name.localeCompare(b.name))
      .slice(0, TOP_PRODUCTS_LIMIT)
      .map((entry) => ({ name: entry.name, category: entry.category, quantitySold: entry.quantity, revenueMinor: entry.revenueMinor }));
    return { range: { from: range.from, to: range.to }, products };
  }

  /** B3(a)/FR43 — neutral per-employee metrics, sorted by NAME only. */
  async getOperationalStats(query: AnalyticsQueryDto): Promise<OperationalStatsDto> {
    const range = this.resolveRange(query);

    let staff = await this.analyticsRepository.findActiveKitchenWaiterStaff();
    if (query.employeeId !== undefined) {
      // A non-kitchen/waiter employeeId yields an empty result by design —
      // these metrics exist for kitchen/waiter roles only (FR43).
      staff = staff.filter((employee) => employee.id === query.employeeId);
    }
    if (staff.length === 0) {
      return { range: { from: range.from, to: range.to }, employees: [] };
    }

    const staffIds = new Set(staff.map((employee) => employee.id));
    const events = (await this.analyticsRepository.findActorEventsInWindow(range.fromMs, range.toExclusiveMs)).filter(
      (event) => event.actorEmployeeId !== null && staffIds.has(event.actorEmployeeId),
    );

    const acceptedEvents = events.filter((event) => event.toStatus === 'accepted');
    const readyEvents = events.filter((event) => event.toStatus === 'ready');
    const spanOrderIds = [...new Set([...acceptedEvents, ...readyEvents].map((event) => event.orderId))];
    const [orderRows, acceptedByOrder] = await Promise.all([
      this.analyticsRepository.findOrdersByIds(acceptedEvents.map((event) => event.orderId)),
      this.analyticsRepository.findEventsByOrderIdsAndStatus(spanOrderIds, 'accepted'),
    ]);
    const createdAtByOrder = new Map(orderRows.map((order) => [order.id, order.createdAt]));
    // Earliest accepted event per order is the prep clock's start (an order
    // legally transitions pending→accepted once; the earliest is defensive).
    const acceptedAtByOrder = new Map<string, number>();
    for (const event of acceptedByOrder) {
      const existing = acceptedAtByOrder.get(event.orderId);
      if (existing === undefined || event.createdAt < existing) acceptedAtByOrder.set(event.orderId, event.createdAt);
    }

    const employees: OperationalEmployeeStatsDto[] = staff.map((employee) => {
      const own = events.filter((event) => event.actorEmployeeId === employee.id);
      const acceptanceSpans = own
        .filter((event) => event.toStatus === 'accepted')
        .map((event) => event.createdAt - (createdAtByOrder.get(event.orderId) ?? event.createdAt))
        .filter((span) => span >= 0);
      const preparationSpans = own
        .filter((event) => event.toStatus === 'ready')
        .map((event) => {
          const acceptedAt = acceptedAtByOrder.get(event.orderId);
          return acceptedAt === undefined ? -1 : event.createdAt - acceptedAt;
        })
        .filter((span) => span >= 0);
      return {
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role as EmployeeRole.KITCHEN | EmployeeRole.WAITER,
        averageAcceptanceTimeMs:
          acceptanceSpans.length > 0 ? roundHalfUpDiv(acceptanceSpans.reduce((a, b) => a + b, 0), acceptanceSpans.length) : null,
        averagePreparationTimeMs:
          preparationSpans.length > 0 ? roundHalfUpDiv(preparationSpans.reduce((a, b) => a + b, 0), preparationSpans.length) : null,
        ordersHandled: new Set(own.map((event) => event.orderId)).size,
      };
    });

    // FR43 — sorted by employee NAME only: no rank, no metric ordering.
    employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    return { range: { from: range.from, to: range.to }, employees };
  }

  // -------------------------------------------------------- range handling

  /** B5(a) — the complete frozen vocabulary; custom = inclusive YYYY-MM-DD,
   * server-local. Cross-field rules are enforced here (ES §6). */
  private resolveRange(query: AnalyticsQueryDto): ResolvedRange {
    let range = query.range;
    if (range === undefined && (query.from !== undefined || query.to !== undefined)) range = ANALYTICS_RANGE.CUSTOM;
    range ??= ANALYTICS_RANGE.TODAY;

    if (range === ANALYTICS_RANGE.CUSTOM) {
      if (query.from === undefined || query.to === undefined) {
        throw new ValidationFailedException('range=custom requires both from and to (YYYY-MM-DD).');
      }
    } else if (query.from !== undefined || query.to !== undefined) {
      throw new ValidationFailedException('from/to are only accepted together with range=custom.');
    }

    const today = this.todayString();
    let from: string;
    let to: string;
    switch (range) {
      case ANALYTICS_RANGE.TODAY:
        from = to = today;
        break;
      case ANALYTICS_RANGE.YESTERDAY:
        from = to = this.addDays(today, -1);
        break;
      case ANALYTICS_RANGE.LAST_7_DAYS:
        from = this.addDays(today, -6);
        to = today;
        break;
      case ANALYTICS_RANGE.LAST_30_DAYS:
        from = this.addDays(today, -29);
        to = today;
        break;
      case ANALYTICS_RANGE.THIS_MONTH:
        from = `${today.slice(0, 7)}-01`;
        to = today;
        break;
      case ANALYTICS_RANGE.LAST_MONTH: {
        const firstOfThisMonth = this.dayStartMs(`${today.slice(0, 7)}-01`);
        to = this.formatLocalDate(firstOfThisMonth - MS_PER_DAY);
        from = `${to.slice(0, 7)}-01`;
        break;
      }
      case ANALYTICS_RANGE.THIS_YEAR:
        from = `${today.slice(0, 4)}-01-01`;
        to = today;
        break;
      case ANALYTICS_RANGE.CUSTOM:
        from = query.from!;
        to = query.to!;
        break;
    }

    if (!this.isValidCalendarDate(from) || !this.isValidCalendarDate(to)) {
      throw new ValidationFailedException('from/to must be real calendar dates (YYYY-MM-DD).');
    }
    if (from > to) throw new ValidationFailedException('from must not be after to.');

    const includesToday = to >= today;
    const historicalTo = includesToday ? this.addDays(today, -1) : to;
    const hasHistorical = from <= historicalTo;
    return {
      from,
      to,
      fromMs: this.dayStartMs(from),
      toExclusiveMs: this.dayStartMs(to) + MS_PER_DAY,
      singleDay: from === to,
      includesToday,
      historicalFrom: hasHistorical ? from : null,
      historicalTo: hasHistorical ? historicalTo : null,
    };
  }

  // ------------------------------------------------------------ aggregation

  private async aggregate(query: AnalyticsQueryDto, range: ResolvedRange): Promise<Aggregates> {
    if (query.employeeId !== undefined) {
      // B2(a) — the collecting employee; always the raw path (no frozen
      // rollup carries an employee dimension; FR44 covers permanence).
      const facts = await this.employeeFacts(range, query.employeeId);
      const aggregates = this.emptyAggregates(false);
      this.mergeFacts(aggregates, facts);
      return aggregates;
    }

    const aggregates = this.emptyAggregates(true);
    if (range.historicalFrom !== null && range.historicalTo !== null) {
      const [daily, hourly, product] = await Promise.all([
        this.analyticsRepository.findDailyRollupRows(range.historicalFrom, range.historicalTo),
        this.analyticsRepository.findHourlyRollupRows(range.historicalFrom, range.historicalTo),
        this.analyticsRepository.findProductRollupRows(range.historicalFrom, range.historicalTo),
      ]);
      this.mergeRollups(aggregates, daily, hourly, product);
    }
    if (range.includesToday) {
      this.mergeFacts(aggregates, await this.liveFacts(this.dayStartMs(this.todayString())));
      aggregates.cancelled += (
        await this.analyticsRepository.findEventsByStatusInWindow(
          'cancelled',
          this.dayStartMs(this.todayString()),
          this.dayStartMs(this.todayString()) + MS_PER_DAY,
        )
      ).length;
    }
    return aggregates;
  }

  private emptyAggregates(cancelledAttributable: boolean): Aggregates {
    return {
      revenueMinor: 0,
      dineInMinor: 0,
      deliveryMinor: 0,
      orders: 0,
      cancelled: 0,
      cancelledAttributable,
      productAgg: new Map(),
      categoryAgg: new Map(),
      hourlyAgg: new Map(),
      dailyAgg: new Map(),
    };
  }

  private mergeRollups(
    aggregates: Aggregates,
    daily: Awaited<ReturnType<AnalyticsRepository['findDailyRollupRows']>>,
    hourly: Awaited<ReturnType<AnalyticsRepository['findHourlyRollupRows']>>,
    product: Awaited<ReturnType<AnalyticsRepository['findProductRollupRows']>>,
  ): void {
    for (const row of daily) {
      aggregates.revenueMinor += row.totalRevenueMinor;
      aggregates.dineInMinor += row.dineInRevenueMinor;
      aggregates.deliveryMinor += row.deliveryRevenueMinor;
      aggregates.orders += row.totalOrders;
      aggregates.cancelled += row.cancelledOrders;
      const day = aggregates.dailyAgg.get(row.date) ?? { revenueMinor: 0, orders: 0 };
      day.revenueMinor += row.totalRevenueMinor;
      day.orders += row.totalOrders;
      aggregates.dailyAgg.set(row.date, day);
    }
    for (const row of hourly) {
      const bucket = aggregates.hourlyAgg.get(row.hour) ?? { revenueMinor: 0, orders: 0 };
      bucket.revenueMinor += row.revenueMinor;
      bucket.orders += row.ordersCount;
      aggregates.hourlyAgg.set(row.hour, bucket);
    }
    for (const row of product) {
      this.addProductFacts(aggregates, [
        { name: row.productNameSnapshot, category: row.categorySnapshot, quantity: row.quantitySold, netMinor: row.revenueMinor },
      ]);
    }
  }

  private mergeFacts(aggregates: Aggregates, facts: OrderFacts[]): void {
    for (const fact of facts) {
      aggregates.revenueMinor += fact.totalMinor;
      if (fact.channel === 'dine_in') aggregates.dineInMinor += fact.totalMinor;
      else aggregates.deliveryMinor += fact.totalMinor;
      aggregates.orders += 1;
      const bucket = rollupBucketFor(fact.completedAtMs); // same server-local rule as the writers (R2)
      const day = aggregates.dailyAgg.get(bucket.date) ?? { revenueMinor: 0, orders: 0 };
      day.revenueMinor += fact.totalMinor;
      day.orders += 1;
      aggregates.dailyAgg.set(bucket.date, day);
      const hour = aggregates.hourlyAgg.get(bucket.hour) ?? { revenueMinor: 0, orders: 0 };
      hour.revenueMinor += fact.totalMinor;
      hour.orders += 1;
      aggregates.hourlyAgg.set(bucket.hour, hour);
      this.addProductFacts(aggregates, fact.items);
    }
  }

  private addProductFacts(
    aggregates: Aggregates,
    items: { name: string; category: string; quantity: number; netMinor: number }[],
  ): void {
    for (const item of items) {
      const key = `${item.name} ${item.category}`; // same snapshot-identity key as the 3.4 writer
      const product = aggregates.productAgg.get(key) ?? { name: item.name, category: item.category, quantity: 0, revenueMinor: 0 };
      product.quantity += item.quantity;
      product.revenueMinor += item.netMinor;
      aggregates.productAgg.set(key, product);
      const category = aggregates.categoryAgg.get(item.category) ?? { quantity: 0, revenueMinor: 0 };
      category.quantity += item.quantity;
      category.revenueMinor += item.netMinor;
      aggregates.categoryAgg.set(item.category, category);
    }
  }

  // ---------------------------------------------------------- fact sources

  /** Live "today" facts (Contract §3 design note): orders whose Completed
   * event falls inside the given server-local day, with post-tax totals
   * recomputed by the SAME billing function the 3.4 rollup writer used. */
  private async liveFacts(dayStartMs: number): Promise<OrderFacts[]> {
    const completedEvents = await this.analyticsRepository.findEventsByStatusInWindow(
      'completed',
      dayStartMs,
      dayStartMs + MS_PER_DAY,
    );
    if (completedEvents.length === 0) return [];
    const orders = await this.analyticsRepository.findOrdersByIds(completedEvents.map((event) => event.orderId));
    const items = await this.analyticsRepository.findItemsByOrderIds(orders.map((order) => order.id));
    const taxBasisPoints = await this.analyticsRepository.getTaxRateBasisPoints();
    const completedAtByOrder = new Map(completedEvents.map((event) => [event.orderId, event.createdAt]));
    const itemsByOrder = this.groupItemsByOrder(items);

    const facts: OrderFacts[] = [];
    for (const order of orders) {
      const orderItems = itemsByOrder.get(order.id) ?? [];
      const totals = computeOrderTotals(orderItems, taxBasisPoints);
      facts.push({
        orderId: order.id,
        channel: order.channel,
        completedAtMs: completedAtByOrder.get(order.id)!,
        totalMinor: totals.totalMinor,
        items: this.toItemFacts(orderItems),
      });
    }
    return facts;
  }

  /** B2(a) — orders attributed to the COLLECTING employee: every completed
   * order of every bill group they took payment for in the window. Per-order
   * post-tax totals via the same billing function (Σ equals the payment,
   * 3.4 B3/D4), so employee revenue reconciles with cash exactly. */
  private async employeeFacts(range: ResolvedRange, employeeId: string): Promise<OrderFacts[]> {
    const payments = await this.analyticsRepository.findPaymentsInWindow(range.fromMs, range.toExclusiveMs, employeeId);
    if (payments.length === 0) return [];
    const orders = (
      await this.analyticsRepository.findOrdersByBillGroupIds(payments.map((payment) => payment.tableBillGroupId))
    ).filter((order) => order.status === 'completed');
    if (orders.length === 0) return [];
    const items = await this.analyticsRepository.findItemsByOrderIds(orders.map((order) => order.id));
    const taxBasisPoints = await this.analyticsRepository.getTaxRateBasisPoints();
    const paidAtByGroup = new Map(payments.map((payment) => [payment.tableBillGroupId, payment.createdAt]));
    const itemsByOrder = this.groupItemsByOrder(items);

    return orders.map((order) => {
      const orderItems = itemsByOrder.get(order.id) ?? [];
      const totals = computeOrderTotals(orderItems, taxBasisPoints);
      return {
        orderId: order.id,
        channel: order.channel,
        // Payment and completion are one transaction (3.4) — the payment's
        // timestamp IS the order's completion instant.
        completedAtMs: paidAtByGroup.get(order.tableBillGroupId)!,
        totalMinor: totals.totalMinor,
        items: this.toItemFacts(orderItems),
      };
    });
  }

  private groupItemsByOrder(items: OrderItemRow[]): Map<string, OrderItemRow[]> {
    const map = new Map<string, OrderItemRow[]>();
    for (const item of items) {
      const list = map.get(item.orderId) ?? [];
      list.push(item);
      map.set(item.orderId, list);
    }
    return map;
  }

  private toItemFacts(items: OrderItemRow[]): OrderFacts['items'] {
    return items.map((item) => ({
      name: item.nameSnapshot,
      category: item.categorySnapshot,
      quantity: item.quantity,
      netMinor: item.unitPriceMinorSnapshot * item.quantity,
    }));
  }

  // --------------------------------------------------------- derived values

  private bestOf(entries: { name: string; quantity: number; revenueMinor: number }[]):
    | { name: string; quantity: number; revenueMinor: number }
    | null {
    if (entries.length === 0) return null;
    return [...entries].sort((a, b) => b.quantity - a.quantity || b.revenueMinor - a.revenueMinor || a.name.localeCompare(b.name))[0];
  }

  /** D1 — hour-of-day with the highest summed revenue across the range;
   * deterministic (lowest hour wins a tie); null when the range is empty. */
  private peakHour(aggregates: Aggregates): { hour: number; revenueMinor: number } | null {
    let best: { hour: number; revenueMinor: number } | null = null;
    for (let hour = 0; hour < 24; hour++) {
      const bucket = aggregates.hourlyAgg.get(hour);
      if (bucket && (best === null || bucket.revenueMinor > best.revenueMinor)) best = { hour, revenueMinor: bucket.revenueMinor };
    }
    return best;
  }

  private peakDay(aggregates: Aggregates): { date: string; revenueMinor: number } | null {
    let best: { date: string; revenueMinor: number } | null = null;
    for (const date of [...aggregates.dailyAgg.keys()].sort()) {
      const bucket = aggregates.dailyAgg.get(date)!;
      if (best === null || bucket.revenueMinor > best.revenueMinor) best = { date, revenueMinor: bucket.revenueMinor };
    }
    return best;
  }

  private async averagePreparationTime(range: ResolvedRange): Promise<number | null> {
    const readyEvents = await this.analyticsRepository.findEventsByStatusInWindow('ready', range.fromMs, range.toExclusiveMs);
    if (readyEvents.length === 0) return null;
    const acceptedEvents = await this.analyticsRepository.findEventsByOrderIdsAndStatus(
      readyEvents.map((event) => event.orderId),
      'accepted',
    );
    const acceptedAtByOrder = new Map<string, number>();
    for (const event of acceptedEvents) {
      const existing = acceptedAtByOrder.get(event.orderId);
      if (existing === undefined || event.createdAt < existing) acceptedAtByOrder.set(event.orderId, event.createdAt);
    }
    const spans = readyEvents
      .map((event) => {
        const acceptedAt = acceptedAtByOrder.get(event.orderId);
        return acceptedAt === undefined ? -1 : event.createdAt - acceptedAt;
      })
      .filter((span) => span >= 0);
    return spans.length > 0 ? roundHalfUpDiv(spans.reduce((a, b) => a + b, 0), spans.length) : null;
  }

  private async averageTableTurnover(range: ResolvedRange): Promise<number | null> {
    const groups = await this.analyticsRepository.findClosedBillGroupsInWindow(range.fromMs, range.toExclusiveMs);
    const spans = groups
      .map((group) => (group.closedAt ?? 0) - group.openedAt)
      .filter((span) => span >= 0);
    return spans.length > 0 ? roundHalfUpDiv(spans.reduce((a, b) => a + b, 0), spans.length) : null;
  }

  /** Payments grouped by shift (payments.shiftId; null = payment with no
   * open shift, 3.4 D7), chronological by shift open. */
  private async revenueByShift(range: ResolvedRange, employeeId?: string): Promise<AnalyticsKpisDto['revenueByShift']> {
    const payments = await this.analyticsRepository.findPaymentsInWindow(range.fromMs, range.toExclusiveMs, employeeId);
    const byShift = new Map<string | null, number>();
    for (const payment of payments) {
      byShift.set(payment.shiftId, (byShift.get(payment.shiftId) ?? 0) + payment.amountMinor);
    }
    const shiftIds = [...byShift.keys()].filter((id): id is string => id !== null);
    const shiftRows = await this.analyticsRepository.findShiftsByIds(shiftIds);
    const shiftById = new Map(shiftRows.map((shift) => [shift.id, shift]));
    return [...byShift.entries()]
      .map(([shiftId, revenueMinor]) => ({
        shiftId,
        employeeId: shiftId !== null ? (shiftById.get(shiftId)?.employeeId ?? null) : null,
        openedAt: shiftId !== null ? (shiftById.get(shiftId)?.openedAt ?? null) : null,
        closedAt: shiftId !== null ? (shiftById.get(shiftId)?.closedAt ?? null) : null,
        revenueMinor,
      }))
      .sort((a, b) => (a.openedAt ?? Number.MAX_SAFE_INTEGER) - (b.openedAt ?? Number.MAX_SAFE_INTEGER));
  }

  // ------------------------------------------------------------- utilities

  /** D2 — hourly buckets for single-day ranges, daily buckets otherwise;
   * zero-filled over the whole range. */
  private seriesBuckets(range: ResolvedRange): { granularity: 'hour' | 'day'; buckets: string[] } {
    if (range.singleDay) {
      return { granularity: 'hour', buckets: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')) };
    }
    const buckets: string[] = [];
    for (let date = range.from; date <= range.to; date = this.addDays(date, 1)) buckets.push(date);
    return { granularity: 'day', buckets };
  }

  private bucketValue(aggregates: Aggregates, granularity: 'hour' | 'day', bucket: string): { revenueMinor: number; orders: number } {
    if (granularity === 'hour') return aggregates.hourlyAgg.get(Number(bucket)) ?? { revenueMinor: 0, orders: 0 };
    return aggregates.dailyAgg.get(bucket) ?? { revenueMinor: 0, orders: 0 };
  }

  private todayString(): string {
    return this.formatLocalDate(Date.now());
  }

  private formatLocalDate(epochMs: number): string {
    const d = new Date(epochMs);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  }

  private dayStartMs(date: string): number {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getTime();
  }

  private addDays(date: string, days: number): string {
    return this.formatLocalDate(this.dayStartMs(date) + days * MS_PER_DAY);
  }

  private isValidCalendarDate(date: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return false;
    const [, y, m, d] = match.map(Number);
    if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return false;
    const parsed = new Date(y!, m! - 1, d!);
    return parsed.getFullYear() === y && parsed.getMonth() === m! - 1 && parsed.getDate() === d;
  }
}
