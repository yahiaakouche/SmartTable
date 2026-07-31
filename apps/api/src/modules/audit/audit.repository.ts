import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, or, lt, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { auditLog, employees } from '../../database/schema';

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');

export interface AuditEntry {
  actorEmployeeId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  oldValueJson?: string | null;
  newValueJson?: string | null;
}

export type AuditLogRow = typeof auditLog.$inferSelect;

/** A stored entry plus its actor's resolved name (Step 3.8 ruling B3(b)). */
export interface AuditLogRowWithActor extends AuditLogRow {
  actorName: string | null;
}

/** The four frozen filters (Contract §3) + the opaque cursor's decoded form.
 * `from`/`to` are epoch-ms bounds on created_at, inclusive (B2(a)/D5). */
export interface AuditLogPageFilters {
  entityType?: string;
  entityId?: string;
  actorEmployeeId?: string;
  from?: number;
  to?: number;
  cursor: { createdAt: number; id: string } | null;
  limit: number;
}

/**
 * Append-only by construction — Database Schema Design §7 / NFR16: this
 * interface exposes ONLY `append()` for writes. No update/delete methods
 * exist to call, so no code path anywhere in the application can mutate or
 * erase the audit trail, regardless of what a future developer intends.
 *
 * Step 3.8 added the READ side (`findPage`) — strictly additive: the
 * append-only guarantee is about mutation, not visibility, and reading the
 * trail is the FR38 review capability this table exists for.
 */
export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  /** One page, newest first (created_at DESC, id DESC), with the actor's
   * name resolved via a left join (employees are soft-deactivated, never
   * hard-deleted, so the join never silently drops an entry). */
  findPage(filters: AuditLogPageFilters): Promise<AuditLogRowWithActor[]>;
}

@Injectable()
export class DrizzleAuditRepository implements AuditRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      actorEmployeeId: entry.actorEmployeeId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      oldValueJson: entry.oldValueJson ?? null,
      newValueJson: entry.newValueJson ?? null,
    });
  }

  async findPage(filters: AuditLogPageFilters): Promise<AuditLogRowWithActor[]> {
    const conditions = [
      ...(filters.entityType !== undefined ? [eq(auditLog.entityType, filters.entityType)] : []),
      ...(filters.entityId !== undefined ? [eq(auditLog.entityId, filters.entityId)] : []),
      ...(filters.actorEmployeeId !== undefined ? [eq(auditLog.actorEmployeeId, filters.actorEmployeeId)] : []),
      ...(filters.from !== undefined ? [gte(auditLog.createdAt, filters.from)] : []),
      ...(filters.to !== undefined ? [lte(auditLog.createdAt, filters.to)] : []),
      ...(filters.cursor
        ? [
            or(
              lt(auditLog.createdAt, filters.cursor.createdAt),
              and(eq(auditLog.createdAt, filters.cursor.createdAt), lt(auditLog.id, filters.cursor.id)),
            )!,
          ]
        : []),
    ];

    const rows = await this.db
      .select({ entry: auditLog, actorName: employees.name })
      .from(auditLog)
      .leftJoin(employees, eq(auditLog.actorEmployeeId, employees.id))
      .where(conditions.length > 0 ? and(...conditions) : sql`1 = 1`)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(filters.limit);

    return rows.map((row) => ({ ...row.entry, actorName: row.actorName ?? null }));
  }
}
