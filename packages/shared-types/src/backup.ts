/**
 * Backup contract — Step 3.9 (FR13, Backup & Resilience Architecture §1–§3,
 * API Contract §3 `backup`). This step ships POST /backup/create (B2(a): the
 * verified snapshot streams back as an HTTP attachment, so the Owner's
 * Save-As dialog IS "choose destination") and GET /backup/history. Restore
 * is deliberately absent — it belongs to the Host/Electron phase (B1(a));
 * the automatic scheduler, shutdown hook and rolling retention likewise
 * (B6(a)), which is why the trigger vocabulary below already covers them.
 */

import { BackupStatus } from './enums';

/** Frozen trigger vocabulary — the backup_history CHECK constraint
 * (Database Schema §9). 'automatic' and 'pre_migration' have no emitter in
 * this step; they exist because the schema and the Installer & Auto-Update
 * Architecture §6 already freeze them. (The STATUS half of the vocabulary is
 * the pre-existing frozen `BackupStatus` enum in ./enums — reused, never
 * redefined.) */
export const BACKUP_TRIGGER = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual',
  PRE_MIGRATION: 'pre_migration',
} as const;

export type BackupTrigger = (typeof BACKUP_TRIGGER)[keyof typeof BACKUP_TRIGGER];

export { BackupStatus };

/** GET /backup/history item — mirrors the frozen backup_history schema one
 * to one (the failure reason lives in the structured app-log, D3: the frozen
 * table has no reason column and the schema does not change). */
export interface BackupHistoryEntryDto {
  id: string;
  filePath: string;
  sizeBytes: number;
  status: BackupStatus;
  trigger: BackupTrigger;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** GET /backup/history response — cursor pagination (Contract §1,
 * unbounded-growth convention; D5). */
export interface ListBackupHistoryResponse {
  data: BackupHistoryEntryDto[];
  meta: { nextCursor: string | null };
}
