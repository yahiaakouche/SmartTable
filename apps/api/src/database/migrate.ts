import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as path from 'path';
import { openDatabase, DatabaseIntegrityError } from './connection';

/**
 * Migration runner — the piece of the Host boot sequence (Backup & Resilience
 * Architecture §5) that this Step 3.0 deliverable owns:
 *
 *   2. Open the database  → openDatabase() applies WAL mode, enforces
 *      `PRAGMA foreign_keys = ON`, and runs the every-startup `quick_check`
 *      (halting loudly, never guessing, if it fails).
 *   4. Apply pending migrations → plain, version-controlled SQL files
 *      (Drizzle Kit output, Database Schema Design — "Migration & Startup
 *      Integrity"), applied in journal order. Drizzle's migrator records
 *      applied migrations in its own bookkeeping table, so re-running this
 *      against an up-to-date database is a safe no-op.
 *   5. Full `PRAGMA integrity_check` → runs here only AFTER migrations,
 *      exactly as the frozen boot sequence specifies (the slower full check
 *      is not part of every startup — `quick_check` covers that).
 *
 * Steps 1, 3 (recovery choices) and 7 (service recovery) belong to the
 * Electron Host, not to this runner — this file deliberately detects and
 * reports, and never makes recovery decisions on the Owner's behalf.
 *
 * The same function is what `apps/host` will call before the API layer
 * accepts any connection; the CLI entrypoint below exists so the step can
 * also be run standalone (`npm run db:migrate`) during development and
 * deployment verification.
 */
export async function runMigrations(databaseFilePath: string): Promise<void> {
  const migrationsFolder = path.join(__dirname, 'migrations');

  console.log(`[migrate] Opening database: ${databaseFilePath}`);
  const db = openDatabase(databaseFilePath); // WAL + foreign_keys + quick_check inside

  console.log(`[migrate] Applying pending migrations from: ${migrationsFolder}`);
  migrate(db, { migrationsFolder });

  // Boot sequence step 5 — full structural check, post-migration only.
  const integrityResult = (db as unknown as { $client: { pragma: (s: string, o?: object) => unknown } })
    .$client.pragma('integrity_check', { simple: true });
  if (integrityResult !== 'ok') {
    throw new DatabaseIntegrityError(
      `Database failed integrity_check after migrations: ${integrityResult}. ` +
        `Halting — see Backup & Resilience Architecture §5.`,
    );
  }

  console.log('[migrate] Migrations applied. Post-migration integrity_check: ok.');
}

/** Standalone CLI entrypoint — `npm run db:migrate` (ts-node). */
if (require.main === module) {
  // Bootstrap-level value, consistent with AppConfig (Engineering Standards §9):
  // supplied by the Host / environment — never hardcoded to a deployed path.
  // The local fallback exists for developer convenience only.
  const databaseFilePath = process.env.DATABASE_FILE_PATH ?? path.join(process.cwd(), 'smarttable-dev.db');

  runMigrations(databaseFilePath).catch((error) => {
    console.error('[migrate] FAILED — startup must not continue against this database.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
