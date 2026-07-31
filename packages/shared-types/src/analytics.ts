/**
 * Analytics contract — API Contract Design §3 (`analytics` section: the five
 * BI endpoints), PRD §7 item 29 (the KPI/chart set), Step 3.7.
 *
 * Step 3.7 rulings baked into this file:
 *  - B5(a): the complete frozen range vocabulary; custom ranges are inclusive
 *    YYYY-MM-DD dates with server-local calendar semantics (3.4 ruling D4).
 *  - B2(a): `employeeId` scopes financial endpoints by the COLLECTING
 *    employee (payments.collectedByEmployeeId) and operational-stats by the
 *    transition actor.
 *  - B3(a)/FR43: operational stats are neutral per-employee metrics — the
 *    response is sorted by employee NAME, never by any metric; there is no
 *    rank field and no implicit "best".
 *  - D1: money is integer minor units (FR36); durations are integer
 *    milliseconds; ratio/rate fields are null when their denominator is zero
 *    (never a fake 0); delivery revenue is 0 until Delivery ships (schema).
 *  - D2: series granularity — hourly points for single-day ranges, daily
 *    points for multi-day ranges; buckets are zero-filled over the range.
 */
import { EmployeeRole } from './enums';

/** Frozen named ranges — PRD §7 item 29 (B5(a)). */
export const ANALYTICS_RANGE = {
  TODAY: 'today',
  YESTERDAY: 'yesterday',
  LAST_7_DAYS: 'last7Days',
  LAST_30_DAYS: 'last30Days',
  THIS_MONTH: 'thisMonth',
  LAST_MONTH: 'lastMonth',
  THIS_YEAR: 'thisYear',
  CUSTOM: 'custom',
} as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGE)[keyof typeof ANALYTICS_RANGE];

/** The resolved window every response echoes back (inclusive dates,
 * server-local). */
export interface AnalyticsRangeInfo {
  from: string; // 'YYYY-MM-DD'
  to: string; // 'YYYY-MM-DD'
}

// ------------------------------------------------------------------- KPIs

export interface AnalyticsKpisDto {
  range: AnalyticsRangeInfo;
  totalRevenueMinor: number;
  dineInRevenueMinor: number;
  /** Always 0 in v1 — reserved for Delivery (schema comment, PRD item 29). */
  deliveryRevenueMinor: number;
  totalOrders: number;
  /** Integer minor units, round-half-up; null when totalOrders = 0 (D1). */
  averageOrderValueMinor: number | null;
  bestSellingProduct: { name: string; quantitySold: number } | null;
  bestSellingCategory: { name: string; quantitySold: number } | null;
  /** Hour-of-day (0–23, server-local) with the highest summed revenue in the
   * range; null when the range has no completed orders. */
  peakSalesHour: { hour: number; revenueMinor: number } | null;
  peakSalesDay: { date: string; revenueMinor: number } | null;
  /** Mean accepted→ready span across the range; null when no order reached
   * ready in range. Not employee-scoped on this endpoint — the per-employee
   * view lives in operational-stats (B2(a)). */
  averagePreparationTimeMs: number | null;
  /** LIVE count of tables hosting a visit right now (occupied +
   * bill_requested) — range-independent by definition (D1). */
  activeTables: number;
  /** cancelled ÷ (completed + cancelled) as a 0–1 ratio (4dp); null when the
   * denominator is 0 — and null when an employeeId filter is applied, because
   * a cancellation has no collecting employee to attribute to (B2(a) note). */
  cancellationRate: number | null;
  /** Mean table-bill-group open→close span for visits closed in range. */
  averageTableTurnoverMs: number | null;
  /** Payments grouped by shift (payments.shiftId; null shift = payment taken
   * with no open shift — 3.4 ruling D7). */
  revenueByShift: {
    shiftId: string | null;
    employeeId: string | null;
    openedAt: number | null;
    closedAt: number | null;
    revenueMinor: number;
  }[];
  /** Net merchandise value (pre-tax) and quantity per category, revenue
   * desc — a category ranking is not an employee ranking (FR43). */
  categoryMix: { category: string; quantitySold: number; revenueMinor: number }[];
}

// ----------------------------------------------------------------- series

/** One point of a time series. `bucket` is 'YYYY-MM-DD' when granularity is
 * 'day', or the zero-padded hour '00'…'23' (server-local) when 'hour'. */
export interface RevenueSeriesPoint {
  bucket: string;
  revenueMinor: number;
}

export interface OrdersSeriesPoint {
  bucket: string;
  ordersCount: number;
}

export interface RevenueOverTimeDto {
  range: AnalyticsRangeInfo;
  granularity: 'hour' | 'day';
  points: RevenueSeriesPoint[];
}

export interface OrdersOverTimeDto {
  range: AnalyticsRangeInfo;
  granularity: 'hour' | 'day';
  points: OrdersSeriesPoint[];
}

// ------------------------------------------------------------ top products

export interface TopProductsDto {
  range: AnalyticsRangeInfo;
  /** Quantity desc, then net revenue desc, then name asc (deterministic);
   * capped at 10 (D3). revenueMinor is the NET merchandise value (pre-tax) —
   * product revenue exists to rank merchandise, never to reconcile cash
   * (3.4 rollup ruling). */
  products: { name: string; category: string; quantitySold: number; revenueMinor: number }[];
}

// ------------------------------------------------------- operational stats

/** B3(a)/FR43 — neutral per-employee operational metrics. Sorted by
 * employeeName ONLY; no rank, no performance framing, no totals row. */
export interface OperationalEmployeeStatsDto {
  employeeId: string;
  employeeName: string;
  role: EmployeeRole.KITCHEN | EmployeeRole.WAITER;
  /** Mean order-created → accepted span over orders the employee accepted in
   * range; null when they accepted none. */
  averageAcceptanceTimeMs: number | null;
  /** Mean accepted → ready span over orders the employee brought to ready in
   * range; null when none. */
  averagePreparationTimeMs: number | null;
  /** Distinct orders on which the employee was the actor of any transition
   * in range. */
  ordersHandled: number;
}

export interface OperationalStatsDto {
  range: AnalyticsRangeInfo;
  employees: OperationalEmployeeStatsDto[];
}
