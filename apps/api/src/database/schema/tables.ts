import { sqliteTable, text, integer, check, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, boolFlag, updatedAtColumn } from './_columns';
import { halls } from './restaurant';

export const tables = sqliteTable(
  'tables',
  {
    id: uuidPk(),
    hallId: text('hall_id')
      .notNull()
      .references(() => halls.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    // Deliberately NOT the same as the UUID v7 primary key (which is time-ordered
    // and therefore unsuitable as a public, scannable token) — a separate,
    // cryptographically random, non-sequential value. ADR carried from PRD freeze.
    qrToken: text('qr_token').notNull(),
    status: text('status').notNull().default('available'),
    isActive: boolFlag('is_active').notNull().default(true),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    qrTokenUnique: uniqueIndex('idx_tables_qr_token').on(table.qrToken),
    statusCheck: check(
      'chk_tables_status',
      sql`${table.status} IN ('available','occupied','bill_requested','needs_cleaning')`,
    ),
  }),
);

export const tableBillGroups = sqliteTable(
  'table_bill_groups',
  {
    id: uuidPk(),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('open'),
    openedAt: integer('opened_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    closedAt: integer('closed_at'), // nullable
  },
  (table) => ({
    tableStatusIdx: index('idx_table_bill_groups_table_status').on(table.tableId, table.status),
    statusCheck: check('chk_table_bill_groups_status', sql`${table.status} IN ('open','closed')`),
    statusTimestampConsistency: check(
      'chk_table_bill_groups_status_closed_at',
      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL) OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL)`,
    ),
  }),
);
