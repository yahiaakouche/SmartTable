import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { productSalesRollup, salesRollupDaily, salesRollupHourly } from './schema';

/**
 * THE single write path into the analytics rollup tables — Database Schema
 * Design §8 freezes the update mechanism: rollups are "updated synchronously,
 * in the same database transaction as the order's Completed transition — not
 * a nightly batch job". MVP Scope Freeze §6.6 adds that rollups are additive,
 * append-only structures no code path may bypass — concentrating every rollup
 * write in this one module is what makes that guarantee auditable.
 *
 * Used by exactly two writers:
 *  - the billing payment transaction (per-order Completed rollups), and
 *  - the orders cancel transition (the daily `cancelled_orders` counter, D5).
 *
 * Date/hour bucketing uses the SERVER-LOCAL clock (ruling D4): the machine
 * runs on the restaurant's premises in the restaurant's timezone, so local
 * calendar day boundaries are the business-meaningful ones for daily reports.
 */

/** A transaction-scoped drizzle client (better-sqlite3 sync driver). */
type Tx = Parameters<Parameters<import('./connection').DbClient['transaction']>[0]>[0];

export interface RollupBucket {
  date: string; // 'YYYY-MM-DD' — the ONE string-date exception (Schema §8)
  hour: number; // 0–23, server-local
}

/** Server-local calendar bucket for an epoch-ms timestamp (D4). */
export function rollupBucketFor(epochMs: number): RollupBucket {
  const d = new Date(epochMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { date: `${d.getFullYear()}-${month}-${day}`, hour: d.getHours() };
}

export interface CompletedOrderRollupInput {
  bucket: RollupBucket;
  now: number;
  /** The order's POST-TAX total (ruling B3: rollup revenue per order is
   * post-tax, so daily revenue reconciles exactly with Σ payments). */
  orderTotalMinor: number;
  /** The order's channel ('dine_in' in v1 — delivery revenue stays 0). */
  channel: string;
  /** Item snapshots for the product-level rollup. */
  items: { nameSnapshot: string; categorySnapshot: string; unitPriceMinorSnapshot: number; quantity: number }[];
}

/** Synchronous same-transaction rollup for ONE order reaching `completed`
 * (Schema §8). Daily + hourly counters are post-tax; product-level revenue is
 * the NET merchandise value (snapshot price × quantity, pre-tax): tax is a
 * bill-level levy with no meaningful per-item allocation, and product revenue
 * exists to rank merchandise (FR41 best-sellers), not to reconcile cash. */
export function upsertCompletedOrderRollup(tx: Tx, input: CompletedOrderRollupInput): void {
  const { date, hour } = input.bucket;
  const isDineIn = input.channel === 'dine_in';

  tx.insert(salesRollupDaily)
    .values({
      date,
      totalRevenueMinor: input.orderTotalMinor,
      dineInRevenueMinor: isDineIn ? input.orderTotalMinor : 0,
      deliveryRevenueMinor: isDineIn ? 0 : input.orderTotalMinor,
      totalOrders: 1,
      cancelledOrders: 0,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: salesRollupDaily.date,
      set: {
        totalRevenueMinor: sql`${salesRollupDaily.totalRevenueMinor} + ${input.orderTotalMinor}`,
        dineInRevenueMinor: sql`${salesRollupDaily.dineInRevenueMinor} + ${isDineIn ? input.orderTotalMinor : 0}`,
        deliveryRevenueMinor: sql`${salesRollupDaily.deliveryRevenueMinor} + ${isDineIn ? 0 : input.orderTotalMinor}`,
        totalOrders: sql`${salesRollupDaily.totalOrders} + 1`,
        updatedAt: input.now,
      },
    })
    .run();

  tx.insert(salesRollupHourly)
    .values({ date, hour, revenueMinor: input.orderTotalMinor, ordersCount: 1 })
    .onConflictDoUpdate({
      target: [salesRollupHourly.date, salesRollupHourly.hour],
      set: {
        revenueMinor: sql`${salesRollupHourly.revenueMinor} + ${input.orderTotalMinor}`,
        ordersCount: sql`${salesRollupHourly.ordersCount} + 1`,
      },
    })
    .run();

  // Product rollup: aggregate this order's items by their immutable snapshot
  // identity (Schema §8: grouped by snapshot name — a renamed product never
  // retroactively merges/splits its own sales history). The table's surrogate
  // id PK means the upsert is select-then-insert/update on the natural key.
  const aggregated = new Map<string, { name: string; category: string; quantity: number; revenueMinor: number }>();
  for (const item of input.items) {
    const key = `${item.nameSnapshot}${item.categorySnapshot}`;
    const bucket = aggregated.get(key) ?? {
      name: item.nameSnapshot,
      category: item.categorySnapshot,
      quantity: 0,
      revenueMinor: 0,
    };
    bucket.quantity += item.quantity;
    bucket.revenueMinor += item.unitPriceMinorSnapshot * item.quantity;
    aggregated.set(key, bucket);
  }
  for (const entry of aggregated.values()) {
    const existing = tx
      .select({ id: productSalesRollup.id, quantitySold: productSalesRollup.quantitySold, revenueMinor: productSalesRollup.revenueMinor })
      .from(productSalesRollup)
      .where(
        sql`${productSalesRollup.date} = ${date} AND ${productSalesRollup.productNameSnapshot} = ${entry.name} AND ${productSalesRollup.categorySnapshot} = ${entry.category}`,
      )
      .all()[0];
    if (existing) {
      tx.update(productSalesRollup)
        .set({ quantitySold: existing.quantitySold + entry.quantity, revenueMinor: existing.revenueMinor + entry.revenueMinor })
        .where(sql`${productSalesRollup.id} = ${existing.id}`)
        .run();
    } else {
      tx.insert(productSalesRollup)
        .values({
          id: uuidv7(), // surrogate row identity (schema has no natural PK)
          date,
          productNameSnapshot: entry.name,
          categorySnapshot: entry.category,
          quantitySold: entry.quantity,
          revenueMinor: entry.revenueMinor,
        })
        .run();
    }
  }
}

/** Ruling D5 — the daily `cancelled_orders` counter, incremented atomically
 * inside the SAME transaction as the cancel transition (crash-consistent with
 * the order row itself, matching the frozen synchronous-rollup mechanism).
 * Bucketed by the cancellation's server-local calendar day. */
export function incrementCancelledOrderRollup(tx: Tx, bucket: RollupBucket, now: number): void {
  tx.insert(salesRollupDaily)
    .values({
      date: bucket.date,
      totalRevenueMinor: 0,
      dineInRevenueMinor: 0,
      deliveryRevenueMinor: 0,
      totalOrders: 0,
      cancelledOrders: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: salesRollupDaily.date,
      set: {
        cancelledOrders: sql`${salesRollupDaily.cancelledOrders} + 1`,
        updatedAt: now,
      },
    })
    .run();
}
