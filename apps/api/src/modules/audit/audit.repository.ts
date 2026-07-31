import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { auditLog } from '../../database/schema';

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');

export interface AuditEntry {
  actorEmployeeId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  oldValueJson?: string | null;
  newValueJson?: string | null;
}

/**
 * Append-only by construction — Database Schema Design §7 / NFR16: this
 * interface exposes ONLY `append()`. No update/delete methods exist to call,
 * so no code path anywhere in the application can mutate or erase the audit
 * trail, regardless of what a future developer intends.
 */
export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
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
}
