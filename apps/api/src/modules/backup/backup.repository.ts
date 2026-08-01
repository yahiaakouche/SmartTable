import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { backupHistory } from '../../database/schema';

export const BACKUP_REPOSITORY = Symbol('BACKUP_REPOSITORY');

export type BackupHistoryRow = typeof backupHistory.$inferSelect;

export interface RecordBackupInput {
  filePath: string;
  sizeBytes: number;
  status: 'success' | 'failed';
  trigger: 'automatic' | 'manual' | 'pre_migration';
}

/**
 * The single write path into backup_history — mirroring the rollups/audit
 * single-writer pattern (MVP Scope Freeze §6.6's additive-structures rule).
 * Every row follows the Backup & Resilience §2 verification sequence; a
 * 'failed' row means verification ran and did not pass, never that recording
 * itself was skipped.
 */
export interface BackupRepository {
  record(input: RecordBackupInput): Promise<BackupHistoryRow>;
  /** One page, newest first (created_at DESC, id DESC) — the unbounded-growth
   * cursor convention (Contract §1, D5). */
  findPage(cursor: { createdAt: number; id: string } | null, limit: number): Promise<BackupHistoryRow[]>;
}

@Injectable()
export class DrizzleBackupRepository implements BackupRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async record(input: RecordBackupInput): Promise<BackupHistoryRow> {
    const [row] = await this.db
      .insert(backupHistory)
      .values({
        filePath: input.filePath,
        sizeBytes: input.sizeBytes,
        status: input.status,
        trigger: input.trigger,
      })
      .returning();
    return row!;
  }

  async findPage(cursor: { createdAt: number; id: string } | null, limit: number): Promise<BackupHistoryRow[]> {
    const conditions = cursor
      ? [
          or(
            lt(backupHistory.createdAt, cursor.createdAt),
            and(eq(backupHistory.createdAt, cursor.createdAt), lt(backupHistory.id, cursor.id)),
          )!,
        ]
      : [];
    return this.db
      .select()
      .from(backupHistory)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(backupHistory.createdAt), desc(backupHistory.id))
      .limit(limit);
  }
}
