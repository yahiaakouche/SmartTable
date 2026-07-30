import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type DbClient = BetterSQLite3Database<typeof schema>;

export class DatabaseIntegrityError extends Error {}

/**
 * Opens the SQLite database and applies every cross-cutting rule frozen in
 * the Database Schema Design and Backup & Resilience Architecture documents:
 *
 *  - WAL mode (ADR-003) — required for crash recovery guarantees.
 *  - `PRAGMA foreign_keys = ON` on every single connection — SQLite disables
 *    this by default, and forgetting it silently turns every FK constraint
 *    in the schema into decoration only (Database Schema Design, Cross-Cutting
 *    Rule 4). This is the single most important line in this file.
 *  - `PRAGMA quick_check` on every startup — the fast structural check from
 *    the Backup & Resilience Architecture §5 boot sequence. The slower, full
 *    `integrity_check` runs on a periodic schedule elsewhere, not here.
 */
export function openDatabase(filePath: string): DbClient {
  const sqlite = new Database(filePath);

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const quickCheckResult = sqlite.pragma('quick_check', { simple: true });
  if (quickCheckResult !== 'ok') {
    // Per Backup & Resilience Architecture §5: the Host must never silently
    // start against data it isn't confident about. The caller (Host bootstrap)
    // is responsible for catching this and routing to the recovery/restore flow
    // — this function's job is only to detect and report, never to guess.
    throw new DatabaseIntegrityError(
      `Database failed quick_check: ${quickCheckResult}. Startup halted — see Backup & Resilience Architecture §5.`,
    );
  }

  return drizzle(sqlite, { schema });
}
