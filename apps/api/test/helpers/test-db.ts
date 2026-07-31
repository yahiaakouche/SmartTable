import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runMigrations } from '../../src/database/migrate';
import { openDatabase } from '../../src/database/connection';
import type { DbClient } from '../../src/database/connection';

/**
 * Integration/E2E test support (Engineering Standards §10 — "real test
 * database"): every test gets its own freshly-migrated SQLite file,
 * exercising the exact same migration runner the Host uses at startup.
 *
 * Note on wiring: the fail-fast AppConfig schema (Step 3.0) validates
 * environment variables once, at ConfigModule load time — which happens
 * when a test file first imports application modules. The required
 * variables are therefore set globally in test/setup-env.ts (registered
 * as a Jest setupFile). Per-test database isolation is achieved by
 * overriding the DRIZZLE_CLIENT provider with a client opened on the
 * per-test file (see openIsolatedTestDb below), never by mutating
 * process.env mid-run.
 */
export async function createMigratedTestDbPath(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'smarttable-test-'));
  const dbPath = path.join(dir, 'test.db');
  await runMigrations(dbPath);
  return dbPath;
}

/** Runs migrations on a fresh temp file, then opens a production-grade
 * client on it (same pragmas as the Host: WAL + foreign_keys + quick_check). */
export async function openIsolatedTestDb(): Promise<DbClient> {
  return openDatabase(await createMigratedTestDbPath());
}
