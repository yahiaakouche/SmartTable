import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { categories, products } from '../../database/schema';

export const MENU_REPOSITORY = Symbol('MENU_REPOSITORY');

type CategoryRow = typeof categories.$inferSelect;
type ProductRow = typeof products.$inferSelect;

export interface ProductFilter {
  categoryId?: string;
  isAvailable?: boolean;
}

export interface MenuRepository {
  // --- categories (soft delete — Cross-Cutting Rule 5) ---
  listCategories(): Promise<CategoryRow[]>;
  findCategoryById(id: string): Promise<CategoryRow | undefined>;
  insertCategory(row: { nameAr: string; nameFr: string; sortOrder: number }): Promise<CategoryRow>;
  updateCategory(
    id: string,
    changes: { nameAr?: string; nameFr?: string; sortOrder?: number; isActive?: boolean },
  ): Promise<CategoryRow | undefined>;

  // --- products (hard delete permitted — Snapshot-protected, ADR-012) ---
  listProducts(filter: ProductFilter, page: number, pageSize: number): Promise<{ rows: ProductRow[]; total: number }>;
  listAvailableProductsByCategory(): Promise<ProductRow[]>;
  findProductById(id: string): Promise<ProductRow | undefined>;
  insertProduct(row: {
    categoryId: string | null;
    nameAr: string;
    nameFr: string;
    priceMinor: number;
    imagePath: string | null;
    sortOrder: number;
  }): Promise<ProductRow>;
  updateProduct(
    id: string,
    changes: {
      categoryId?: string | null;
      nameAr?: string;
      nameFr?: string;
      priceMinor?: number;
      imagePath?: string | null;
      isAvailable?: boolean;
      sortOrder?: number;
    },
  ): Promise<ProductRow | undefined>;
  hardDeleteProduct(id: string): Promise<void>;
}

@Injectable()
export class DrizzleMenuRepository implements MenuRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async listCategories(): Promise<CategoryRow[]> {
    return this.db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.nameAr));
  }

  async findCategoryById(id: string): Promise<CategoryRow | undefined> {
    const rows = await this.db.select().from(categories).where(eq(categories.id, id));
    return rows[0];
  }

  async insertCategory(row: { nameAr: string; nameFr: string; sortOrder: number }): Promise<CategoryRow> {
    const rows = await this.db.insert(categories).values(row).returning();
    return rows[0];
  }

  async updateCategory(
    id: string,
    changes: { nameAr?: string; nameFr?: string; sortOrder?: number; isActive?: boolean },
  ): Promise<CategoryRow | undefined> {
    const rows = await this.db.update(categories).set(changes).where(eq(categories.id, id)).returning();
    return rows[0];
  }

  async listProducts(filter: ProductFilter, page: number, pageSize: number): Promise<{ rows: ProductRow[]; total: number }> {
    const conditions = [
      ...(filter.categoryId !== undefined ? [eq(products.categoryId, filter.categoryId)] : []),
      ...(filter.isAvailable !== undefined ? [eq(products.isAvailable, filter.isAvailable)] : []),
    ];
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await this.db
      .select()
      .from(products)
      .where(where)
      .orderBy(asc(products.sortOrder), asc(products.nameAr))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const countRows = await this.db.select({ total: sql<number>`count(*)` }).from(products).where(where);
    return { rows, total: countRows[0]?.total ?? 0 };
  }

  /** The customer-facing read: available products only (is_available drives
   * QR menu visibility — Database Schema Design §4), grouped by category. */
  async listAvailableProductsByCategory(): Promise<ProductRow[]> {
    return this.db
      .select()
      .from(products)
      .where(eq(products.isAvailable, true))
      .orderBy(asc(products.sortOrder), asc(products.nameAr));
  }

  async findProductById(id: string): Promise<ProductRow | undefined> {
    const rows = await this.db.select().from(products).where(eq(products.id, id));
    return rows[0];
  }

  async insertProduct(row: {
    categoryId: string | null;
    nameAr: string;
    nameFr: string;
    priceMinor: number;
    imagePath: string | null;
    sortOrder: number;
  }): Promise<ProductRow> {
    const rows = await this.db.insert(products).values(row).returning();
    return rows[0];
  }

  async updateProduct(
    id: string,
    changes: {
      categoryId?: string | null;
      nameAr?: string;
      nameFr?: string;
      priceMinor?: number;
      imagePath?: string | null;
      isAvailable?: boolean;
      sortOrder?: number;
    },
  ): Promise<ProductRow | undefined> {
    const rows = await this.db
      .update(products)
      .set({ ...changes, updatedAt: Date.now() })
      .where(eq(products.id, id))
      .returning();
    return rows[0];
  }

  async hardDeleteProduct(id: string): Promise<void> {
    await this.db.delete(products).where(eq(products.id, id));
  }
}
