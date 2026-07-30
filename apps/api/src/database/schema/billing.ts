import { sqliteTable, text, integer, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, moneyMinor, createdAtColumn } from './_columns';
import { tableBillGroups } from './tables';
import { employees } from './people';

export const shifts = sqliteTable(
  'shifts',
  {
    id: uuidPk(),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    openingCashMinor: moneyMinor('opening_cash_minor').notNull(),
    closingCashMinor: moneyMinor('closing_cash_minor'), // nullable
    expectedCashMinor: moneyMinor('expected_cash_minor'), // nullable — computed at close
    status: text('status').notNull().default('open'),
    openedAt: integer('opened_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    closedAt: integer('closed_at'), // nullable
  },
  (table) => ({
    statusCheck: check('chk_shifts_status', sql`${table.status} IN ('open','closed')`),
  }),
);

/** Payment is against the consolidated Table Bill Group, not a single order —
 * this is what makes "main order + all add-ons, one bill" actually work. */
export const payments = sqliteTable(
  'payments',
  {
    id: uuidPk(),
    tableBillGroupId: text('table_bill_group_id')
      .notNull()
      .references(() => tableBillGroups.id, { onDelete: 'restrict' }),
    amountMinor: moneyMinor('amount_minor').notNull(),
    method: text('method').notNull().default('cash'),
    collectedByEmployeeId: text('collected_by_employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    shiftId: text('shift_id').references(() => shifts.id),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    billGroupIdx: index('idx_payments_bill_group').on(table.tableBillGroupId),
    amountCheck: check('chk_payments_amount', sql`${table.amountMinor} > 0`),
    // Intentionally restrictive in v1 — extending this list is a one-line
    // migration when digital payments ship (v3), not a redesign.
    methodCheck: check('chk_payments_method', sql`${table.method} IN ('cash')`),
  }),
);
