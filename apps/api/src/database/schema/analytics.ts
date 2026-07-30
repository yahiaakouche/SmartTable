import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { moneyMinor } from './_columns';

/**
 * Hybrid Analytics Architecture (PRD §7 item 30 / Database Schema Design §8):
 * "Today" is queried live from the orders tables; any other date range reads
 * from these rollup tables, updated synchronously in the same transaction as
 * an order's Completed transition — never a nightly batch job at this scale.
 *
 * `date` is stored as a 'YYYY-MM-DD' string — the ONE deliberate exception to
 * "no string dates" (Database Schema Design §8): it's a grouping key, never
 * compared as a date object, so lexicographic string sort is correct and simplest.
 */

export const salesRollupDaily = sqliteTable('sales_rollup_daily', {
  date: text('date').primaryKey(),
  totalRevenueMinor: moneyMinor('total_revenue_minor').notNull().default(0),
  dineInRevenueMinor: moneyMinor('dine_in_revenue_minor').notNull().default(0),
  deliveryRevenueMinor: moneyMinor('delivery_revenue_minor').notNull().default(0), // 0 until Delivery ships
  totalOrders: integer('total_orders').notNull().default(0),
  cancelledOrders: integer('cancelled_orders').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const salesRollupHourly = sqliteTable(
  'sales_rollup_hourly',
  {
    date: text('date').notNull(),
    hour: integer('hour').notNull(), // 0–23
    revenueMinor: moneyMinor('revenue_minor').notNull().default(0),
    ordersCount: integer('orders_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.hour] }),
    dateIdx: index('idx_sales_rollup_hourly_date').on(table.date),
  }),
);

/** Powers Best Selling Product/Category without scanning all order_items
 * historically. Grouped by snapshot name, consistent with historical accuracy
 * (a renamed product doesn't retroactively merge/split its own sales history). */
export const productSalesRollup = sqliteTable(
  'product_sales_rollup',
  {
    id: text('id').primaryKey(), // composite-ish natural key handled at write time; simple UUID here for row identity
    date: text('date').notNull(),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    categorySnapshot: text('category_snapshot').notNull(),
    quantitySold: integer('quantity_sold').notNull().default(0),
    revenueMinor: moneyMinor('revenue_minor').notNull().default(0),
  },
  (table) => ({
    dateIdx: index('idx_product_sales_rollup_date').on(table.date),
  }),
);
