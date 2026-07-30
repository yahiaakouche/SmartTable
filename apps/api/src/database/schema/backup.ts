import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, createdAtColumn } from './_columns';

/** Backs the Host's "Backup status monitoring" responsibility with real data
 * instead of just filesystem inspection (Host Application design). Every row
 * here follows the verification sequence in Backup & Resilience Architecture §2:
 * VACUUM INTO → integrity_check on the new file → recorded here. */
export const backupHistory = sqliteTable(
  'backup_history',
  {
    id: uuidPk(),
    filePath: text('file_path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').notNull(),
    // 'automatic' (safety-net) vs 'manual' (Owner-triggered) vs 'pre_migration'
    // (Installer & Auto-Update Architecture §6) — distinguishes the three
    // triggers that all funnel into this same table.
    trigger: text('trigger').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    statusCheck: check('chk_backup_history_status', sql`${table.status} IN ('success','failed')`),
    triggerCheck: check(
      'chk_backup_history_trigger',
      sql`${table.trigger} IN ('automatic','manual','pre_migration')`,
    ),
  }),
);
