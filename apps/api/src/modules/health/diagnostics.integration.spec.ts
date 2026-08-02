import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { backupHistory } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { BackupModule } from '../backup/backup.module';
import { HealthModule } from './health.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb } from '../../../test/helpers/test-app';

/**
 * Integration: the diagnostics API slice against a real, migrated SQLite
 * database and the real filesystem (Engineering Standards §10). Covers
 * the Step 3.12 additions AND backfills the zero-coverage foundation
 * endpoint (D6): the aggregate's fresh-install semantics (database +
 * disk healthy, backup degraded — never critical on day one, R3), the
 * backup check reacting to real backup_history rows, the live resources
 * payload (D2), the public access model (B1(a)), and the proof that the
 * deferred routes do not exist (B2(a)/B4(a)). The realtime check is
 * covered by the E2E suite, where the gateway genuinely attaches.
 */
describe('Diagnostics (integration)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, HealthModule, BackupModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /diagnostics/health is PUBLIC and reports the fresh-install aggregate: database + disk healthy, backup degraded, overall degraded — never critical (B1(a)/D6/R3)', async () => {
    const res = await http().get('/diagnostics/health').expect(200); // no Authorization header at all

    // The module's manual envelope — exactly one `data` level (no double-wrap).
    expect(res.body.data).toBeDefined();
    expect(res.body.data.data).toBeUndefined();

    const { overall, checks } = res.body.data;
    expect(Object.keys(checks).sort()).toEqual(['backup', 'database', 'disk']);
    expect(checks.database).toEqual({ status: 'healthy' });
    expect(checks.disk.status).toBe('healthy');
    expect(checks.disk.detail).toMatch(/% of the data volume is used/);
    expect(checks.backup).toEqual({ status: 'degraded', detail: 'no verified backup exists yet' });
    expect(overall).toBe('degraded'); // degraded propagates; a day-one install must not be critical
  });

  it('the backup check reacts to real backup_history rows (D4): a recent success turns backup — and the aggregate — healthy', async () => {
    await db()
      .insert(backupHistory)
      .values({ filePath: '/backups/snapshot.db', sizeBytes: 12345, status: 'success', trigger: 'manual' });

    const res = await http().get('/diagnostics/health').expect(200);
    expect(res.body.data.checks.backup).toEqual({
      status: 'healthy',
      detail: 'a verified backup exists within the last 7 days',
    });
    expect(res.body.data.overall).toBe('healthy');

    // An 8-day-old success ages the check back to degraded (success-age semantics).
    await db().delete(backupHistory);
    await db()
      .insert(backupHistory)
      .values({
        filePath: '/backups/old.db',
        sizeBytes: 12345,
        status: 'success',
        trigger: 'manual',
        createdAt: Date.now() - 8 * 86_400_000,
      });
    const aged = await http().get('/diagnostics/health').expect(200);
    expect(aged.body.data.checks.backup.status).toBe('degraded');
    expect(aged.body.data.checks.backup.detail).toBe('last verified backup is 8 day(s) old');
  });

  it('GET /diagnostics/resources is PUBLIC and serves the live D2 payload with a consistent disk figure (B1(a))', async () => {
    const res = await http().get('/diagnostics/resources').expect(200);

    const { cpu, memory, disk, collectedAt } = res.body.data;
    expect(res.body.data.data).toBeUndefined(); // single envelope level

    expect(cpu.coreCount).toBeGreaterThan(0);
    expect(cpu.loadAverage).toHaveLength(3);
    for (const value of cpu.loadAverage) expect(value).toEqual(expect.any(Number));

    expect(memory.totalBytes).toBeGreaterThan(0);
    expect(memory.freeBytes).toBeGreaterThan(0);
    expect(memory.processRssBytes).toBeGreaterThan(0);

    expect(disk).not.toBeNull();
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.freeBytes).toBeGreaterThan(0);
    // usedPercent is consistent with the raw figures (±1 for rounding).
    const recomputed = Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
    expect(Math.abs(disk.usedPercent - recomputed)).toBeLessThanOrEqual(1);

    expect(collectedAt).toEqual(expect.any(Number));
  });

  it('the deferred routes do not exist (B2(a)/B4(a)): no connected-devices, no printer/update checks in the aggregate', async () => {
    await http().get('/diagnostics/connected-devices').expect(404);

    const res = await http().get('/diagnostics/health').expect(200);
    expect(res.body.data.checks).not.toHaveProperty('printer');
    expect(res.body.data.checks).not.toHaveProperty('update');
  });
});
