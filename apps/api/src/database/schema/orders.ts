import { sqliteTable, text, integer, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, boolFlag, moneyMinor, createdAtColumn, updatedAtColumn } from './_columns';
import { tableBillGroups, tables } from './tables';
import { employees } from './people';
import { products } from './menu';

export const orders = sqliteTable(
  'orders',
  {
    id: uuidPk(),
    tableBillGroupId: text('table_bill_group_id')
      .notNull()
      .references(() => tableBillGroups.id, { onDelete: 'restrict' }),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'restrict' }), // denormalized for query convenience
    channel: text('channel').notNull().default('dine_in'),
    isAddon: boolFlag('is_addon').notNull().default(false),
    status: text('status').notNull().default('pending'),
    source: text('source').notNull(),
    createdByEmployeeId: text('created_by_employee_id').references(() => employees.id), // nullable if source = qr
    acceptedByEmployeeId: text('accepted_by_employee_id'),
    servedByEmployeeId: text('served_by_employee_id'),
    cancelledByEmployeeId: text('cancelled_by_employee_id'),
    cancellationReason: text('cancellation_reason'), // nullable
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    statusIdx: index('idx_orders_status').on(table.status),
    billGroupIdx: index('idx_orders_bill_group').on(table.tableBillGroupId),
    tableStatusIdx: index('idx_orders_table_status').on(table.tableId, table.status),
    channelCheck: check('chk_orders_channel', sql`${table.channel} IN ('dine_in','delivery')`),
    sourceCheck: check('chk_orders_source', sql`${table.source} IN ('qr','waiter_manual')`),
    statusCheck: check(
      'chk_orders_status',
      sql`${table.status} IN ('pending','accepted','preparing','ready','served','paid','completed','cancelled')`,
    ),
    // FR10 as a database-enforced guarantee, not just an API-layer convention —
    // the final backstop named explicitly in Database Schema Design, Appendix A.
    cancellationReasonRequired: check(
      'chk_orders_cancellation_reason',
      sql`(${table.status} = 'cancelled' AND ${table.cancellationReason} IS NOT NULL) OR ${table.status} != 'cancelled'`,
    ),
  }),
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: uuidPk(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    // Immutable copies — FR40. Never re-read from the live `products` row for
    // display or historical reporting.
    nameSnapshot: text('name_snapshot').notNull(),
    categorySnapshot: text('category_snapshot').notNull(),
    unitPriceMinorSnapshot: moneyMinor('unit_price_minor_snapshot').notNull(),
    quantity: integer('quantity').notNull(),
    notes: text('notes'), // nullable
  },
  (table) => ({
    orderIdx: index('idx_order_items_order').on(table.orderId),
    quantityCheck: check('chk_order_items_quantity', sql`${table.quantity} > 0`),
    priceCheck: check('chk_order_items_price', sql`${table.unitPriceMinorSnapshot} >= 0`),
  }),
);

/** High-frequency operational event stream — deliberately separate from
 * `audit_log` (Database Schema Design §7 reasoning: different query patterns,
 * different volume, different consumers). Feeds Average Prep Time analytics. */
export const orderStatusEvents = sqliteTable(
  'order_status_events',
  {
    id: uuidPk(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'), // nullable — null for the initial "created" event
    toStatus: text('to_status').notNull(),
    actorEmployeeId: text('actor_employee_id'), // nullable — null for system-driven transitions
    createdAt: createdAtColumn(),
  },
  (table) => ({
    orderCreatedIdx: index('idx_order_status_events_order').on(table.orderId, table.createdAt),
  }),
);
