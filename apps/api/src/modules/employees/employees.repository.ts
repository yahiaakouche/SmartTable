import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { employees } from '../../database/schema';

export const EMPLOYEES_REPOSITORY = Symbol('EMPLOYEES_REPOSITORY');

type EmployeeRow = typeof employees.$inferSelect;

export interface EmployeesRepository {
  list(page: number, pageSize: number): Promise<{ rows: EmployeeRow[]; total: number }>;
  findById(id: string): Promise<EmployeeRow | undefined>;
  insert(row: { name: string; role: string; email: string | null }): Promise<EmployeeRow>;
  update(id: string, changes: { role?: string; isActive?: boolean }): Promise<EmployeeRow | undefined>;
}

@Injectable()
export class DrizzleEmployeesRepository implements EmployeesRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async list(page: number, pageSize: number): Promise<{ rows: EmployeeRow[]; total: number }> {
    const rows = await this.db
      .select()
      .from(employees)
      .orderBy(employees.createdAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const countRows = await this.db.select({ total: sql<number>`count(*)` }).from(employees);
    return { rows, total: countRows[0]?.total ?? 0 };
  }

  async findById(id: string): Promise<EmployeeRow | undefined> {
    const rows = await this.db.select().from(employees).where(eq(employees.id, id));
    return rows[0];
  }

  async insert(row: { name: string; role: string; email: string | null }): Promise<EmployeeRow> {
    const rows = await this.db.insert(employees).values(row).returning();
    return rows[0];
  }

  async update(id: string, changes: { role?: string; isActive?: boolean }): Promise<EmployeeRow | undefined> {
    const rows = await this.db.update(employees).set(changes).where(eq(employees.id, id)).returning();
    return rows[0];
  }
}
