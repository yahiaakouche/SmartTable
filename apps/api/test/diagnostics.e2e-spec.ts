import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs/promises';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

const BACKUP_DIR = process.env.BACKUP_DIRECTORY!;

/**
 * E2E — Step 3.12 critical path (Engineering Standards §10), against the
 * FULL application composition (real migrated database, /api/v1 prefix, a
 * real listening port so the realtime check genuinely attaches):
 *
 *  1. The backup-health chain (Monitoring §4): a fresh install reports
 *     backup DEGRADED ("no verified backup exists yet" — never critical,
 *     R3) with every other check healthy; the Owner then creates a REAL
 *     backup through the 3.9 API and the very next health read reports
 *     backup — and the aggregate — HEALTHY. Cross-step proof with zero
 *     behavior change to the backup module.
 *  2. The resources endpoint and the public/protected reachability
 *     matrix over the real /api/v1 surface (B1(a)/B2(a)).
 */
describe('Diagnostics (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const http = () => request(app.getHttpServer());

  let ownerToken: string;

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
    await app.listen(0);
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const ownerLogin = await http()
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = ownerLogin.body.data.accessToken;
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  });

  it('Monitoring §4 chain: fresh install reports backup degraded → a real backup through the 3.9 API flips the aggregate to healthy', async () => {
    const fresh = await http().get('/api/v1/diagnostics/health').expect(200);
    const { overall, checks } = fresh.body.data;
    expect(Object.keys(checks).sort()).toEqual(['backup', 'database', 'disk', 'realtime']);
    expect(checks.database.status).toBe('healthy');
    expect(checks.realtime.status).toBe('healthy'); // gateway genuinely attached (real port)
    expect(checks.disk.status).toBe('healthy');
    expect(checks.backup).toEqual({ status: 'degraded', detail: 'no verified backup exists yet' });
    expect(overall).toBe('degraded');

    await http()
      .post('/api/v1/backup/create')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(201);

    const after = await http().get('/api/v1/diagnostics/health').expect(200);
    expect(after.body.data.checks.backup).toEqual({
      status: 'healthy',
      detail: 'a verified backup exists within the last 7 days',
    });
    expect(after.body.data.overall).toBe('healthy');
  });

  it('B1(a)/B2(a): resources is public with the D2 shape; connected-devices is 404; protected routes still require auth', async () => {
    const resources = await http().get('/api/v1/diagnostics/resources').expect(200); // no token
    const { cpu, memory, disk, collectedAt } = resources.body.data;
    expect(cpu.coreCount).toBeGreaterThan(0);
    expect(cpu.loadAverage).toHaveLength(3);
    expect(memory.totalBytes).toBeGreaterThan(0);
    expect(memory.processRssBytes).toBeGreaterThan(0);
    expect(disk).not.toBeNull();
    expect(disk.usedPercent).toBeGreaterThanOrEqual(0);
    expect(disk.usedPercent).toBeLessThanOrEqual(100);
    expect(collectedAt).toEqual(expect.any(Number));

    await http().get('/api/v1/diagnostics/connected-devices').expect(404); // B2(a) — deferred
    await http().get('/api/v1/backup/history').expect(401); // still guarded
    await http().get('/api/v1/config/restaurant-profile').expect(401); // still guarded
  });
});
