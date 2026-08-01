import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import { BackupStatus } from '@smarttable/shared-types';
import { BackupService } from './backup.service';
import { BackupRepository } from './backup.repository';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { decryptBackup } from './backup-crypto';

/**
 * Unit tests for the verified-snapshot engine (Step 3.9): the frozen §2
 * sequence (VACUUM INTO → integrity_check on the new file → record on BOTH
 * outcomes), failure semantics (D13 delete, D3 app-log, B5(a) Owner signal,
 * then rethrow), the D1 filename, encrypted export shaping (B4(a)), and the
 * history cursor codec (D5). The live-DB VACUUM is mocked with a REAL valid
 * SQLite file at the target path, so the verification step itself runs for
 * real against a genuine snapshot-shaped artifact.
 */
describe('BackupService', () => {
  let service: BackupService;
  let backupDir: string;
  let run: jest.Mock;
  let repository: jest.Mocked<BackupRepository>;
  let events: { emitBackupFailed: jest.Mock };
  let audit: { append: jest.Mock };

  /** Makes the mocked VACUUM produce a REAL, integrity-check-passing SQLite file. */
  const vacuumProducesValidSnapshot = () =>
    run.mockImplementation(async (statement: { sql: string; params: unknown[] } | unknown) => {
      const target = extractTarget(statement);
      const db = new Database(target);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);');
      db.close();
    });

  const vacuumProducesGarbage = () =>
    run.mockImplementation(async (statement: unknown) => {
      await fs.writeFile(extractTarget(statement), Buffer.from('definitely not a sqlite database'));
    });

  const dialect = new SQLiteSyncDialect();

  const extractTarget = (statement: unknown): string => {
    // The drizzle sql template compiles to { sql, params } — the target path
    // must be the single BOUND parameter (D2: never concatenated).
    const compiled = dialect.sqlToQuery(statement as SQL);
    expect(compiled.sql).toContain('VACUUM INTO');
    expect(compiled.sql).not.toContain(backupDir); // proof of binding, not concatenation
    expect(compiled.params).toHaveLength(1);
    return compiled.params[0] as string;
  };

  const recordedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'history-1',
    filePath: 'x',
    sizeBytes: 0,
    status: BackupStatus.SUCCESS,
    trigger: 'manual',
    createdAt: 1000,
    ...overrides,
  });

  beforeEach(async () => {
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smarttable-backup-unit-'));
    run = jest.fn();
    repository = {
      record: jest.fn().mockImplementation(async (input: Record<string, unknown>) => recordedRow(input)),
      findPage: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BackupRepository>;
    events = { emitBackupFailed: jest.fn() };
    audit = { append: jest.fn().mockResolvedValue(undefined) };

    service = new BackupService(
      { run } as never,
      repository,
      { get: () => backupDir } as never,
      events as never,
      audit as never,
    );
  });

  afterEach(async () => {
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it('runs the frozen §2 sequence: VACUUM INTO → integrity_check → success row with real size (ADR-028/029)', async () => {
    vacuumProducesValidSnapshot();
    const backup = await service.createManualBackup('emp-owner');

    expect(run).toHaveBeenCalledTimes(1);
    expect(repository.record).toHaveBeenCalledWith({
      filePath: backup.serverFilePath,
      sizeBytes: expect.any(Number),
      status: BackupStatus.SUCCESS,
      trigger: 'manual',
    });
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.encryptedPayload).toBeNull();
    // D1 — the filename pattern.
    expect(path.basename(backup.serverFilePath)).toMatch(/^smarttable-backup-\d{8}-\d{6}-manual\.db$/);
    expect(path.dirname(backup.serverFilePath)).toBe(backupDir);
    // D8 — the export is audited with the actor and the encryption flag.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmployeeId: 'emp-owner', entityType: 'backup', action: 'backup_created' }),
    );
    expect(events.emitBackupFailed).not.toHaveBeenCalled();
  });

  it('on verification failure: deletes the partial file, records failed, signals the Owner, then rethrows (§2/D13/B5(a))', async () => {
    vacuumProducesGarbage();
    // Settle the promise manually instead of expect().rejects: the failure
    // can be a better-sqlite3 SqliteError, and native addons are cached
    // process-wide — when a worker ran another SQLite suite first, the
    // error's prototype chain belongs to that suite's realm, so
    // `instanceof Error` (which .rejects.toThrow relies on) is false here.
    // The message string is realm-independent.
    const failure = await service.createManualBackup('emp-owner').catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/file is not a database|integrity_check/);

    expect(repository.record).toHaveBeenCalledWith({
      filePath: expect.any(String),
      sizeBytes: 0,
      status: BackupStatus.FAILED,
      trigger: 'manual',
    });
    expect(events.emitBackupFailed).toHaveBeenCalledWith({ backupHistoryId: 'history-1' });
    // The corrupt artifact is gone — never restorable by accident.
    expect(await fs.readdir(backupDir)).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled(); // no successful export to audit
  });

  it('records failed and signals the Owner when VACUUM itself throws (e.g., unwritable directory)', async () => {
    run.mockRejectedValue(new Error('disk full'));
    await expect(service.createManualBackup('emp-owner')).rejects.toThrow('disk full');
    expect(repository.record).toHaveBeenCalledWith(expect.objectContaining({ status: BackupStatus.FAILED, sizeBytes: 0 }));
    expect(events.emitBackupFailed).toHaveBeenCalledTimes(1);
  });

  it('with a passphrase, the export is the encrypted container while the server keeps the verified plaintext (B4(a)/Security §4)', async () => {
    vacuumProducesValidSnapshot();
    const backup = await service.createManualBackup('emp-owner', 'my secret passphrase');

    expect(backup.downloadName).toMatch(/\.db\.enc$/);
    expect(backup.encryptedPayload).not.toBeNull();
    // The container decrypts back to EXACTLY the verified server-side snapshot.
    const plaintext = await fs.readFile(backup.serverFilePath);
    expect(decryptBackup(backup.encryptedPayload!, 'my secret passphrase')).toEqual(plaintext);
    // The server-side copy stays plaintext (the machine is FDE-protected).
    expect(plaintext.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ newValueJson: JSON.stringify({ trigger: 'manual', encrypted: true }) }),
    );
  });

  it('the engine is trigger-agnostic (B6(a)): automatic and pre_migration flow through the same path', async () => {
    vacuumProducesValidSnapshot();
    await service.createSnapshot('automatic');
    await service.createSnapshot('pre_migration');
    expect(repository.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ trigger: 'automatic' }));
    expect(repository.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ trigger: 'pre_migration' }));
  });

  it('history: cursor codec round-trips and malformed cursors are VALIDATION_FAILED (D5)', async () => {
    const rows = [recordedRow({ id: 'h3', createdAt: 300 }), recordedRow({ id: 'h2', createdAt: 200 }), recordedRow({ id: 'h1', createdAt: 100 })];
    repository.findPage.mockResolvedValue(rows);

    const page1 = await service.listHistory({ limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['h3', 'h2']);
    expect(repository.findPage).toHaveBeenCalledWith(null, 3);

    const decoded = JSON.parse(Buffer.from(page1.meta.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ c: 200, i: 'h2' });

    repository.findPage.mockResolvedValue([rows[2]]);
    const page2 = await service.listHistory({ limit: 2, cursor: page1.meta.nextCursor! });
    expect(repository.findPage).toHaveBeenLastCalledWith({ createdAt: 200, id: 'h2' }, 3);
    expect(page2.meta.nextCursor).toBeNull();

    await expect(service.listHistory({ cursor: 'garbage' })).rejects.toBeInstanceOf(ValidationFailedException);
  });
});
