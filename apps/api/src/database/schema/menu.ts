import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, boolFlag, moneyMinor, createdAtColumn, updatedAtColumn } from './_columns';

export const categories = sqliteTable('categories', {
  id: uuidPk(),
  nameAr: text('name_ar').notNull(),
  nameFr: text('name_fr').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolFlag('is_active').notNull().default(true),
});

/** Hard delete permitted here — protected by the Order Item Snapshot strategy
 * (order_items carries its own immutable copy of name/price/category), so a
 * deleted product never corrupts historical reporting. ADR-012. */
export const products = sqliteTable(
  'products',
  {
    id: uuidPk(),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    nameAr: text('name_ar').notNull(),
    nameFr: text('name_fr').notNull(),
    priceMinor: moneyMinor('price_minor').notNull(),
    imagePath: text('image_path'), // nullable
    isAvailable: boolFlag('is_available').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    priceCheck: check('chk_products_price', sql`${table.priceMinor} >= 0`),
  }),
);
