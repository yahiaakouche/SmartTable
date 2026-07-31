import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { halls, orders, tables } from '../../database/schema';

export const TABLES_REPOSITORY = Symbol('TABLES_REPOSITORY');

type HallRow = typeof halls.$inferSelect;
type TableRow = typeof tables.$inferSelect;

/** Terminal order statuses — an order in ANY other status keeps its table
 * "active" for the TABLE_HAS_ACTIVE_ORDER removal guard (Step 3.2 ruling R7). */
const TERMINAL_ORDER_STATUSES = ['completed', 'cancelled'];

export interface TablesRepository {
  // --- halls ---
  listHalls(): Promise<HallRow[]>;
  findHallById(id: string): Promise<HallRow | undefined>;
  insertHall(row: { name: string; sortOrder: number }): Promise<HallRow>;

  // --- tables ---
  listTables(): Promise<TableRow[]>;
  findTableById(id: string): Promise<TableRow | undefined>;
  findTableByQrToken(qrToken: string): Promise<TableRow | undefined>;
  insertTable(row: { hallId: string; label: string; qrToken: string }): Promise<TableRow>;
  updateTable(
    id: string,
    changes: { label?: string; hallId?: string; qrToken?: string; status?: string; isActive?: boolean },
  ): Promise<TableRow | undefined>;

  /** Read-only cross-module guard query (precedent: invitations' read-join on
   * employees in Step 3.1) — the orders module owns order WRITES later; this
   * module only needs to know whether removal is safe. */
  countNonTerminalOrders(tableId: string): Promise<number>;
}

@Injectable()
export class DrizzleTablesRepository implements TablesRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async listHalls(): Promise<HallRow[]> {
    return this.db.select().from(halls).orderBy(asc(halls.sortOrder), asc(halls.name));
  }

  async findHallById(id: string): Promise<HallRow | undefined> {
    const rows = await this.db.select().from(halls).where(eq(halls.id, id));
    return rows[0];
  }

  async insertHall(row: { name: string; sortOrder: number }): Promise<HallRow> {
    const rows = await this.db.insert(halls).values(row).returning();
    return rows[0];
  }

  async listTables(): Promise<TableRow[]> {
    return this.db.select().from(tables).orderBy(asc(tables.label));
  }

  async findTableById(id: string): Promise<TableRow | undefined> {
    const rows = await this.db.select().from(tables).where(eq(tables.id, id));
    return rows[0];
  }

  async findTableByQrToken(qrToken: string): Promise<TableRow | undefined> {
    const rows = await this.db.select().from(tables).where(eq(tables.qrToken, qrToken));
    return rows[0];
  }

  async insertTable(row: { hallId: string; label: string; qrToken: string }): Promise<TableRow> {
    const rows = await this.db.insert(tables).values(row).returning();
    return rows[0];
  }

  async updateTable(
    id: string,
    changes: { label?: string; hallId?: string; qrToken?: string; status?: string; isActive?: boolean },
  ): Promise<TableRow | undefined> {
    const rows = await this.db
      .update(tables)
      .set({ ...changes, updatedAt: Date.now() })
      .where(eq(tables.id, id))
      .returning();
    return rows[0];
  }

  async countNonTerminalOrders(tableId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(orders)
      .where(and(eq(orders.tableId, tableId), notInArray(orders.status, TERMINAL_ORDER_STATUSES)));
    return rows[0]?.total ?? 0;
  }
}
