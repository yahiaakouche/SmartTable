import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, boolFlag, updatedAtColumn } from './_columns';

/** Section 1 of Database Schema Design — single logical row */
export const restaurantProfile = sqliteTable(
  'restaurant_profile',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    logoPath: text('logo_path'), // nullable
    primaryColor: text('primary_color').notNull(),
    secondaryColor: text('secondary_color').notNull(),
    currencyCode: text('currency_code').notNull().default('DZD'),
    // stored as integer basis points (1900 = 19.00%) — never a float, Appendix rule
    taxRatePercent: integer('tax_rate_percent').notNull().default(0),
    defaultLanguage: text('default_language').notNull().default('ar'),
    setupCompletedAt: integer('setup_completed_at'), // nullable until Setup Wizard finishes
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    languageCheck: check('chk_restaurant_profile_language', sql`${table.defaultLanguage} IN ('ar','fr')`),
    taxRateCheck: check('chk_restaurant_profile_tax_rate', sql`${table.taxRatePercent} >= 0`),
  }),
);

export const halls = sqliteTable('halls', {
  id: uuidPk(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolFlag('is_active').notNull().default(true),
});
