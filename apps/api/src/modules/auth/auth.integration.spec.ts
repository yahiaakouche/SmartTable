import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { employees, refreshTokens, auditLog } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from './auth.module';
import { TokensService } from './tokens.service';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the auth module against a real database — login flows,
 * Device Trust validation/renewal, PIN lockout, and the audit trail they
 * produce (Security Architecture §1, §9).
 */
describe('AuthModule (integration)', () => {
  let app: INestApplication;
  const PIN = '1234';
  const WRONG_PIN = '0000';

  const seedTrustedDevice = async (employeeId: string): Promise<string> => {
    const rawToken = randomBytes(48).toString('base64url');
    await getDb(app)
      .insert(refreshTokens)
      .values({
        employeeId,
        deviceLabel: 'Cashier Station',
        tokenHash: TokensService.hashToken(rawToken),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 30 * 86_400_000,
      });
    return rawToken;
  };

  const pinLogin = (deviceRefreshToken: string, employeeId: string, pin: string) =>
    request(app.getHttpServer())
      .post('/auth/pin-login')
      .send({ deviceRefreshToken, employeeId, pin });

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [ConfigModule, DatabaseModule, AuditModule, AuthModule] })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it('PIN login succeeds on a trusted device with the correct PIN', async () => {
    const employeeId = await seedEmployee(getDb(app), { name: 'Sofia', role: 'waiter', pin: PIN });
    const deviceToken = await seedTrustedDevice(employeeId);

    const res = await pinLogin(deviceToken, employeeId, PIN).expect(201);

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.employee).toMatchObject({ id: employeeId, name: 'Sofia', role: 'waiter' });
  });

  it('locks the account after 5 consecutive wrong PINs and audit-logs failures + lockout', async () => {
    const employeeId = await seedEmployee(getDb(app), { name: 'Yacine', role: 'cashier', pin: PIN });
    const deviceToken = await seedTrustedDevice(employeeId);

    for (let i = 0; i < 4; i++) {
      const res = await pinLogin(deviceToken, employeeId, WRONG_PIN).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }

    // 5th consecutive failure triggers the lockout (Security §1).
    const fifth = await pinLogin(deviceToken, employeeId, WRONG_PIN).expect(401);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    // While locked, even the CORRECT PIN is refused before any credential work.
    const sixth = await pinLogin(deviceToken, employeeId, PIN).expect(401);
    expect(sixth.body.error.code).toBe('ACCOUNT_LOCKED');

    const auditRows = await getDb(app).select().from(auditLog);
    expect(auditRows.filter((r) => r.action === 'login_failed')).toHaveLength(5);
    expect(auditRows.filter((r) => r.action === 'account_locked')).toHaveLength(1);
  });

  it('refresh exchanges a valid Device Trust token for a new access token and renews it', async () => {
    const employeeId = await seedEmployee(getDb(app), { name: 'Amina', role: 'manager', pin: PIN });
    const deviceToken = await seedTrustedDevice(employeeId);

    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: deviceToken })
      .expect(201);
    expect(res.body.data.accessToken).toBeTruthy();

    const rows = await getDb(app).select().from(refreshTokens);
    expect(rows[0].lastUsedAt).toBeGreaterThan(Date.now() - 10_000);
  });

  it('rejects refresh with a revoked device (stolen device → revocation → dead)', async () => {
    const employeeId = await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', pin: PIN });
    const deviceToken = await seedTrustedDevice(employeeId);
    const tokens = app.get(TokensService);
    const rows = await getDb(app).select().from(refreshTokens);
    await tokens.revokeDevice(rows[0].id);

    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: deviceToken })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects PIN login when the device trust belongs to another employee', async () => {
    const sofia = await seedEmployee(getDb(app), { name: 'Sofia', role: 'waiter', pin: PIN });
    const yacine = await seedEmployee(getDb(app), { name: 'Yacine', role: 'cashier', pin: PIN });
    const sofiasDevice = await seedTrustedDevice(sofia);

    await pinLogin(sofiasDevice, yacine, PIN).expect(401);
  });

  it('password login succeeds only for Owner/Manager and establishes Device Trust', async () => {
    await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });

    const res = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.deviceRefreshToken).toBeTruthy();

    // The new device is now trusted: PIN login must work against it.
    const ownerId = res.body.data.employee.id;
    await getDb(app)
      .update(employees)
      .set({ pinHash: await argon2.hash('5678') })
      .where(eq(employees.id, ownerId));
    const pinRes = await pinLogin(res.body.data.deviceRefreshToken, ownerId, '5678').expect(201);
    expect(pinRes.body.data.accessToken).toBeTruthy();
  });

  it('rejects password login for non-Owner/Manager roles and audit-logs the failure', async () => {
    await seedEmployee(getDb(app), { name: 'Sofia', role: 'waiter', password: 'waiter-secret-1' });

    const res = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name: 'Sofia', password: 'waiter-secret-1', deviceLabel: 'Tablet' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');

    const auditRows = await getDb(app).select().from(auditLog);
    expect(auditRows.some((r) => r.action === 'login_failed')).toBe(true);
  });

  it('rejects malformed payloads at the DTO boundary (400 VALIDATION_FAILED)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/pin-login')
      .send({ deviceRefreshToken: 'x', employeeId: 'not-a-uuid', pin: '12' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
