import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { auditLog, refreshTokens } from '../../database/schema';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the audit query surface (Step 3.8) against a real, migrated
 * SQLite database (Engineering Standards §10). Entries are seeded through the
 * REAL append path (`AuditService.append`) wherever wall-clock timing allows;
 * date-window fixtures insert rows directly only to control `created_at`
 * explicitly (the append path owns no clock). Covered: DTO shaping with
 * parsed old/new values (D6), actor name resolution (B3(b)) incl. null-actor
 * system rows (D11), cursor pagination (D1–D3), all four frozen filters
 * (Contract §3, D4), the epoch-ms date range (B2(a)/D5), DTO validation, and
 * the B1 access matrix (Owner/Manager only) over real HTTP.
 */
describe('Audit query surface (integration)', () => {
  let app: INestApplication;
  let audit: AuditService;

  const db = () => getDb(app);
  const authed = () => request(app.getHttpServer());

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
    audit = app.get(AuditService);
  });

  afterEach(async () => {
    await app.close();
  });

  const loginWithPin = async (name: string, role: string, pin = '1234') => {
    const employeeId = await seedEmployee(db(), { name, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: `${name} Terminal`,
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await authed().post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
    return { token: res.body.data.accessToken as string, employeeId };
  };

  const get = (token: string, query = '') => authed().get(`/audit-log${query}`).set('Authorization', `Bearer ${token}`);

  it('lists entries written through the real append path, with parsed values and the actor name resolved (D6/B3(b))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await audit.append({
      actorEmployeeId: owner.employeeId,
      entityType: 'product',
      entityId: 'prod-1',
      action: 'price_changed',
      oldValueJson: JSON.stringify({ priceMinor: 25000 }),
      newValueJson: JSON.stringify({ priceMinor: 30000 }),
    });
    // A system row: no actor, no values (D11).
    await audit.append({ actorEmployeeId: null, entityType: 'order', entityId: 'order-1', action: 'auto_locked' });

    const res = await get(owner.token).expect(200);
    expect(res.body.data).toHaveLength(2);
    // Newest first (D2).
    expect(res.body.data[0]).toMatchObject({ entityType: 'order', actorEmployeeId: null, actorName: null, oldValue: null, newValue: null });
    expect(res.body.data[1]).toEqual({
      id: expect.any(String),
      actorEmployeeId: owner.employeeId,
      actorName: 'Karim',
      entityType: 'product',
      entityId: 'prod-1',
      action: 'price_changed',
      oldValue: { priceMinor: 25000 },
      newValue: { priceMinor: 30000 },
      createdAt: expect.any(Number),
    });
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('paginates by cursor, newest first, with the notifications-shaped meta (D1–D3)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    for (let i = 1; i <= 3; i++) {
      await db().insert(auditLog).values({ entityType: 'employee', entityId: `emp-${i}`, action: 'role_changed', createdAt: i * 1000 });
    }

    const page1 = await get(owner.token, '?limit=2').expect(200);
    expect(page1.body.data.map((e: { entityId: string }) => e.entityId)).toEqual(['emp-3', 'emp-2']);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const page2 = await get(owner.token, `?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`).expect(200);
    expect(page2.body.data.map((e: { entityId: string }) => e.entityId)).toEqual(['emp-1']);
    expect(page2.body.meta.nextCursor).toBeNull();
  });

  it('applies the four frozen filters, exact-match and AND-combined (Contract §3, D4)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const manager = await loginWithPin('Amina', 'manager');
    await db().insert(auditLog).values([
      { actorEmployeeId: owner.employeeId, entityType: 'product', entityId: 'prod-1', action: 'price_changed', createdAt: 1000 },
      { actorEmployeeId: manager.employeeId, entityType: 'product', entityId: 'prod-2', action: 'price_changed', createdAt: 2000 },
      { actorEmployeeId: owner.employeeId, entityType: 'table', entityId: 'table-1', action: 'qr_regenerated', createdAt: 3000 },
    ]);

    const byType = await get(owner.token, '?entityType=product').expect(200);
    expect(byType.body.data.map((e: { entityId: string }) => e.entityId)).toEqual(['prod-2', 'prod-1']);

    const byEntity = await get(owner.token, '?entityType=product&entityId=prod-1').expect(200);
    expect(byEntity.body.data).toHaveLength(1);

    const byActor = await get(owner.token, `?actorEmployeeId=${owner.employeeId}`).expect(200);
    expect(byActor.body.data.map((e: { action: string }) => e.action)).toEqual(['qr_regenerated', 'price_changed']);

    // Open vocabulary (D4): an unknown entity type is a legitimate empty page, not a 400.
    const empty = await get(owner.token, '?entityType=spaceship').expect(200);
    expect(empty.body.data).toEqual([]);
  });

  it('filters by the epoch-ms date range, bounds inclusive (B2(a)/D5)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await db().insert(auditLog).values([
      { entityType: 'employee', entityId: 'e1', action: 'a', createdAt: 1000 },
      { entityType: 'employee', entityId: 'e2', action: 'b', createdAt: 2000 },
      { entityType: 'employee', entityId: 'e3', action: 'c', createdAt: 3000 },
    ]);

    const windowed = await get(owner.token, '?from=2000&to=3000').expect(200);
    expect(windowed.body.data.map((e: { entityId: string }) => e.entityId)).toEqual(['e3', 'e2']); // both bounds inclusive

    const fromOnly = await get(owner.token, '?from=2500').expect(200);
    expect(fromOnly.body.data.map((e: { entityId: string }) => e.entityId)).toEqual(['e3']);

    const bad = await get(owner.token, '?from=3000&to=1000').expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('validates the query DTO (400 VALIDATION_FAILED)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const cases = [
      '?cursor=garbage',
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      '?actorEmployeeId=not-a-uuid',
      '?from=-5',
      '?to=abc',
    ];
    for (const query of cases) {
      const res = await get(owner.token, query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('enforces B1 over real HTTP: Owner + Manager read, floor roles 403, anonymous 401', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const manager = await loginWithPin('Amina', 'manager');
    const denied = [await loginWithPin('Sofia', 'waiter'), await loginWithPin('Yanis', 'kitchen'), await loginWithPin('Lina', 'cashier')];

    await get(owner.token).expect(200);
    await get(manager.token).expect(200);
    for (const login of denied) {
      const res = await get(login.token).expect(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
    }
    await authed().get('/audit-log').expect(401);
  });
});
