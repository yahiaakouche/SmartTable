import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import Database from 'better-sqlite3';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';
import * as path from 'path';
import type { BackupHistoryEntryDto, BackupTrigger, ListBackupHistoryResponse } from '@smarttable/shared-types';
import { BACKUP_TRIGGER, BackupStatus } from '@smarttable/shared-types';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { DomainEventsService } from '../../common/events/domain-events.service';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { AuditService } from '../audit/audit.service';
import { encryptBackup } from './backup-crypto';
import { BACKUP_REPOSITORY, BackupHistoryRow, BackupRepository } from './backup.repository';
import { ListBackupHistoryQueryDto } from './dto/list-backup-history-query.dto';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/** What the controller needs to stream the export back to the Owner (B2(a)). */
export interface BackupExport {
  /** Absolute path of the verified server-side snapshot (the history row's
   * file_path) — the manual backup also stays on the machine per §1. */
  serverFilePath: string;
  /** Suggested download filename ('.db', or '.db.enc' when encrypted). */
  downloadName: string;
  /** Plaintext: stream from serverFilePath. Encrypted (B4(a)): this buffer —
   * produced from the verified plaintext snapshot, never stored server-side
   * (encryption protects the artifact OFF the machine, Security §4). */
  encryptedPayload: Buffer | null;
  sizeBytes: number;
  /** The backup_history row id (audit entry's entityId, D8). */
  historyId: string;
}

/**
 * The verified-snapshot engine — Step 3.9 (FR13, Backup & Resilience §1–§2,
 * ADR-028/ADR-029). Trigger-agnostic by ruling B6(a): the Host phase's
 * automatic scheduler, shutdown hook and pre-migration safety net will call
 * this same service with their own trigger value; this step wires only the
 * manual route.
 *
 * The frozen verification sequence (§2), on every snapshot:
 *   1. VACUUM INTO a new file (parameterized — the ES "no raw SQL
 *      concatenation" rule holds; the live drizzle client never opens the
 *      snapshot afterwards),
 *   2. PRAGMA integrity_check against the NEW file via a separate read-only
 *      connection,
 *   3. record success/failed in backup_history — a row is written on BOTH
 *      outcomes (a silently-failing backup is worse than no backup, §2),
 *   4. on failure: the partial file is deleted (D13 — a corrupt artifact
 *      must never be restorable by accident), the reason goes to the
 *      structured app-log (D3), and the Owner is notified via the internal
 *      backup.failed signal (B5(a)).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  /** In-process serialization for snapshot creation (see createSnapshot). */
  private snapshotQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DbClient,
    @Inject(BACKUP_REPOSITORY) private readonly backupRepository: BackupRepository,
    private readonly config: ConfigService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditService,
  ) {}

  /** POST /backup/create — manual trigger, optional passphrase (B4(a)). */
  async createManualBackup(actorEmployeeId: string, passphrase?: string): Promise<BackupExport> {
    const snapshot = await this.createSnapshot(BACKUP_TRIGGER.MANUAL);

    let downloadName = path.basename(snapshot.serverFilePath);
    let encryptedPayload: Buffer | null = null;
    if (passphrase !== undefined) {
      encryptedPayload = encryptBackup(await fs.readFile(snapshot.serverFilePath), passphrase);
      downloadName = `${downloadName}.enc`;
    }

    // D8 — Security §9's "every security-relevant action": a full-data export
    // leaving the machine is exactly that (FR38's list predates this module).
    await this.audit.append({
      actorEmployeeId,
      entityType: 'backup',
      entityId: snapshot.historyId,
      action: 'backup_created',
      newValueJson: JSON.stringify({ trigger: BACKUP_TRIGGER.MANUAL, encrypted: passphrase !== undefined }),
    });

    return { ...snapshot, downloadName, encryptedPayload };
  }

  /** The engine itself — used by the manual route now, by the Host phase's
   * automatic/pre-migration triggers later (B6(a)). Throws after recording
   * and reporting any failure: callers see a 500 with the standard envelope
   * while the failed row + notification stand as the durable record. */
  async createSnapshot(trigger: BackupTrigger): Promise<BackupExport> {
    // Serialize snapshot creation in-process: D1's stamp has second
    // resolution, and VACUUM INTO refuses to overwrite — two concurrent
    // triggers landing in the same second would otherwise collide on one
    // file name. (The throttle limits rate, not concurrency.)
    const run = this.snapshotQueue.then(() => this.createSnapshotSerialized(trigger));
    this.snapshotQueue = run.catch(() => undefined);
    return run;
  }

  private async createSnapshotSerialized(trigger: BackupTrigger): Promise<BackupExport> {
    const backupDirectory = this.config.get<string>('BACKUP_DIRECTORY')!;
    const filePath = await this.nextAvailableSnapshotPath(backupDirectory, trigger);

    try {
      await fs.mkdir(backupDirectory, { recursive: true });
      // VACUUM INTO (ADR-028) — consistent, compacted, safe on a live
      // database; the target path is a BOUND parameter, never concatenated.
      await this.db.run(sql`VACUUM INTO ${filePath}`);
      this.verifySnapshot(filePath);
      const { size } = await fs.stat(filePath);
      const row = await this.backupRepository.record({
        filePath,
        sizeBytes: size,
        status: BackupStatus.SUCCESS,
        trigger,
      });
      this.logger.log(`Backup snapshot verified and recorded: ${filePath} (${size} bytes, trigger=${trigger})`);
      return { serverFilePath: filePath, downloadName: path.basename(filePath), encryptedPayload: null, sizeBytes: size, historyId: row.id };
    } catch (error) {
      const reason = (error as Error).message;
      // D13 — a failed/partial artifact is deleted, never left restorable.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      const row = await this.backupRepository.record({
        filePath,
        sizeBytes: 0,
        status: BackupStatus.FAILED,
        trigger,
      });
      // D3 — the frozen history table has no reason column; the structured
      // app-log (Monitoring §1) carries it.
      this.logger.error(`Backup FAILED verification/creation (trigger=${trigger}, history=${row.id}): ${reason}`, (error as Error).stack);
      // B5(a) — the Owner is told immediately; emit-after-commit: the row
      // exists before the signal references it.
      this.events.emitBackupFailed({ backupHistoryId: row.id });
      throw error;
    }
  }

  /** GET /backup/history — cursor pagination (D5), Owner/Manager only (B3). */
  async listHistory(query: ListBackupHistoryQueryDto): Promise<ListBackupHistoryResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const cursor = query.cursor !== undefined ? this.decodeCursor(query.cursor) : null;

    const rows = await this.backupRepository.findPage(cursor, limit + 1);
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toDto(row)),
      meta: { nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null },
    };
  }

  // ------------------------------------------------------------- internals

  /** §2 step 2 — integrity_check against the NEW file only, on its own
   * short-lived read-only connection. Throws on any non-'ok' result. */
  private verifySnapshot(filePath: string): void {
    const connection = new Database(filePath, { readonly: true });
    try {
      const result = connection.pragma('integrity_check', { simple: true }) as string;
      if (result !== 'ok') {
        throw new Error(`Snapshot failed integrity_check: ${result}`);
      }
    } finally {
      connection.close();
    }
  }

  /** D1's stamp has second resolution; VACUUM INTO refuses to overwrite an
   * existing file. If this second's name is taken, wait for the next second
   * boundary and re-derive the SAME D1 pattern — never a different one.
   * (Called under the snapshot queue, so the existence check is reliable.) */
  private async nextAvailableSnapshotPath(backupDirectory: string, trigger: BackupTrigger): Promise<string> {
    for (;;) {
      const filePath = path.join(backupDirectory, this.snapshotFileName(trigger));
      if (!existsSync(filePath)) return filePath;
      await sleep(1000 - (Date.now() % 1000) + 10);
    }
  }

  /** D1 — `smarttable-backup-YYYYMMDD-HHmmss-<trigger>.db`. */
  private snapshotFileName(trigger: BackupTrigger): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `smarttable-backup-${stamp}-${trigger}.db`;
  }

  private toDto(row: BackupHistoryRow): BackupHistoryEntryDto {
    return {
      id: row.id,
      filePath: row.filePath,
      sizeBytes: row.sizeBytes,
      status: row.status as BackupHistoryEntryDto['status'],
      trigger: row.trigger as BackupHistoryEntryDto['trigger'],
      createdAt: row.createdAt,
    };
  }

  private encodeCursor(row: BackupHistoryRow): string {
    return Buffer.from(JSON.stringify({ c: row.createdAt, i: row.id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
      if (typeof parsed.c !== 'number' || typeof parsed.i !== 'string') throw new Error('bad shape');
      return { createdAt: parsed.c, id: parsed.i };
    } catch {
      throw new ValidationFailedException('Malformed pagination cursor.');
    }
  }
}
