import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { employees, refreshTokens } from '../../database/schema';

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

type EmployeeRow = typeof employees.$inferSelect;
type RefreshTokenRow = typeof refreshTokens.$inferSelect;

/**
 * Persistence for the auth domain: credential reads/writes on `employees`
 * (password/PIN hashes are owned here — they are authentication material,
 * not profile data) and the `refresh_tokens` Device Trust table.
 * Repositories sit behind an interface per Engineering Standards §5.
 */
export interface AuthRepository {
  findEmployeeById(id: string): Promise<EmployeeRow | undefined>;
  findActiveEmployeesByName(name: string): Promise<EmployeeRow[]>;
  setCredentials(employeeId: string, passwordHash: string, pinHash: string): Promise<void>;
  setPinHash(employeeId: string, pinHash: string): Promise<void>;
  recordLogin(employeeId: string, atEpochMs: number): Promise<void>;
  insertRefreshToken(row: {
    employeeId: string;
    deviceLabel: string;
    tokenHash: string;
    lastUsedAt: number;
    expiresAt: number;
  }): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | undefined>;
  renewRefreshToken(id: string, lastUsedAt: number, expiresAt: number): Promise<void>;
  findRefreshTokensByEmployee(employeeId: string): Promise<RefreshTokenRow[]>;
  findRefreshTokenById(id: string): Promise<RefreshTokenRow | undefined>;
  revokeRefreshToken(id: string, revokedAt: number): Promise<void>;
}

@Injectable()
export class DrizzleAuthRepository implements AuthRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async findEmployeeById(id: string): Promise<EmployeeRow | undefined> {
    const rows = await this.db.select().from(employees).where(eq(employees.id, id));
    return rows[0];
  }

  async findActiveEmployeesByName(name: string): Promise<EmployeeRow[]> {
    return this.db.select().from(employees).where(eq(employees.name, name));
  }

  async setCredentials(employeeId: string, passwordHash: string, pinHash: string): Promise<void> {
    await this.db.update(employees).set({ passwordHash, pinHash }).where(eq(employees.id, employeeId));
  }

  async setPinHash(employeeId: string, pinHash: string): Promise<void> {
    await this.db.update(employees).set({ pinHash }).where(eq(employees.id, employeeId));
  }

  async recordLogin(employeeId: string, atEpochMs: number): Promise<void> {
    await this.db.update(employees).set({ lastLoginAt: atEpochMs }).where(eq(employees.id, employeeId));
  }

  async insertRefreshToken(row: {
    employeeId: string;
    deviceLabel: string;
    tokenHash: string;
    lastUsedAt: number;
    expiresAt: number;
  }): Promise<void> {
    await this.db.insert(refreshTokens).values(row);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | undefined> {
    const rows = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    return rows[0];
  }

  async renewRefreshToken(id: string, lastUsedAt: number, expiresAt: number): Promise<void> {
    await this.db.update(refreshTokens).set({ lastUsedAt, expiresAt }).where(eq(refreshTokens.id, id));
  }

  async findRefreshTokensByEmployee(employeeId: string): Promise<RefreshTokenRow[]> {
    return this.db.select().from(refreshTokens).where(eq(refreshTokens.employeeId, employeeId));
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRow | undefined> {
    const rows = await this.db.select().from(refreshTokens).where(eq(refreshTokens.id, id));
    return rows[0];
  }

  async revokeRefreshToken(id: string, revokedAt: number): Promise<void> {
    await this.db.update(refreshTokens).set({ revokedAt }).where(eq(refreshTokens.id, id));
  }
}
