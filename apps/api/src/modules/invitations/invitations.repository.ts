import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { employees, invitations, refreshTokens } from '../../database/schema';

export const INVITATIONS_REPOSITORY = Symbol('INVITATIONS_REPOSITORY');

type InvitationRow = typeof invitations.$inferSelect;

/** The acceptance transaction writes all three atomically (Backup & Resilience
 * §7: multi-step writes either all succeed or all roll back). */
export interface AcceptanceWrite {
  invitationId: string;
  employeeId: string;
  passwordHash: string;
  pinHash: string;
  acceptedAt: number;
  refreshTokenRow: {
    employeeId: string;
    deviceLabel: string;
    tokenHash: string;
    lastUsedAt: number;
    expiresAt: number;
  };
}

export interface InvitationsRepository {
  insert(row: {
    employeeId: string;
    tokenHash: string;
    channel: string;
    expiresAt: number;
  }): Promise<InvitationRow>;
  findByTokenHash(tokenHash: string): Promise<InvitationRow | undefined>;
  findById(id: string): Promise<InvitationRow | undefined>;
  findPendingByEmployee(employeeId: string): Promise<InvitationRow[]>;
  /** Latest invitation per employee — backs the roster's FR28 status column. */
  findLatestByEmployeeIds(employeeIds: string[]): Promise<InvitationRow[]>;
  markStatus(id: string, status: string, acceptedAt?: number): Promise<void>;
  /** Employee name/role for the acceptance context screen (read-only join). */
  findEmployeeIdentity(employeeId: string): Promise<{ id: string; name: string; role: string } | undefined>;
  acceptTransaction(write: AcceptanceWrite): Promise<void>;
}

@Injectable()
export class DrizzleInvitationsRepository implements InvitationsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async insert(row: {
    employeeId: string;
    tokenHash: string;
    channel: string;
    expiresAt: number;
  }): Promise<InvitationRow> {
    const rows = await this.db.insert(invitations).values(row).returning();
    return rows[0];
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRow | undefined> {
    const rows = await this.db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
    return rows[0];
  }

  async findById(id: string): Promise<InvitationRow | undefined> {
    const rows = await this.db.select().from(invitations).where(eq(invitations.id, id));
    return rows[0];
  }

  async findPendingByEmployee(employeeId: string): Promise<InvitationRow[]> {
    return this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.employeeId, employeeId), eq(invitations.status, 'pending')))
      .orderBy(desc(invitations.createdAt));
  }

  async findLatestByEmployeeIds(employeeIds: string[]): Promise<InvitationRow[]> {
    if (employeeIds.length === 0) return [];
    return this.db
      .select()
      .from(invitations)
      .where(inArray(invitations.employeeId, employeeIds))
      .orderBy(desc(invitations.createdAt));
  }

  async markStatus(id: string, status: string, acceptedAt?: number): Promise<void> {
    await this.db
      .update(invitations)
      .set(acceptedAt !== undefined ? { status, acceptedAt } : { status })
      .where(eq(invitations.id, id));
  }

  async findEmployeeIdentity(employeeId: string): Promise<{ id: string; name: string; role: string } | undefined> {
    const rows = await this.db
      .select({ id: employees.id, name: employees.name, role: employees.role })
      .from(employees)
      .where(eq(employees.id, employeeId));
    return rows[0];
  }

  async acceptTransaction(write: AcceptanceWrite): Promise<void> {
    // better-sqlite3 transactions are strictly synchronous (the driver throws
    // if the callback returns a promise). Drizzle's better-sqlite3 query
    // builders execute immediately on .run(), so the three writes below still
    // happen inside one real SQLite transaction — atomically, per Backup &
    // Resilience §7.
    this.db.transaction((tx) => {
      tx.update(employees)
        .set({ passwordHash: write.passwordHash, pinHash: write.pinHash })
        .where(eq(employees.id, write.employeeId))
        .run();
      tx.update(invitations)
        .set({ status: 'accepted', acceptedAt: write.acceptedAt })
        .where(eq(invitations.id, write.invitationId))
        .run();
      tx.insert(refreshTokens).values(write.refreshTokenRow).run();
    });
  }
}
