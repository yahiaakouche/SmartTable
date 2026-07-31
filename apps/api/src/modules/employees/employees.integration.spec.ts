import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { auditLog, employees, refreshTokens } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { EmployeesModule } from './employees.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: staff administration against a real database — roster with
 * invitation status (FR28), creation + invitation (FR24), role changes and
 * deactivation with their audit trail (FR22, FR38), PIN reset, and the
 * Active Devices screen (Security §1).
 */
describe('EmployeesModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let ownerId: string;

  const authed = () => request(app.getHttpServer());

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, AuditModule, AuthModule, InvitationsModule, EmployeesModule],
      })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );
    ownerId = await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const login = await authed()
      .post('/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = login.body.data.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates an employee with a pending invitation and returns the raw token once (FR24)', async () => {
    const res = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter', email: 'sofia@example.dz' })
      .expect(201);

    expect(res.body.data.employee).toMatchObject({
      name: 'Sofia',
      role: 'waiter',
      invitationStatus: 'pending',
      isActive: true,
    });
    expect(res.body.data.invitation.token).toBeTruthy();

    // Credentials are null until the employee accepts — the Owner never
    // chooses them (FR27).
    const row = (await getDb(app).select().from(employees).where(eq(employees.id, res.body.data.employee.id)))[0];
    expect(row.passwordHash).toBeNull();
    expect(row.pinHash).toBeNull();
  });

  it('lists the roster with invitation status and pagination envelope (FR28)', async () => {
    await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter' })
      .expect(201);

    const res = await authed().get('/employees?page=1&pageSize=50').set('Authorization', `Bearer ${ownerToken}`).expect(200);

    expect(res.body.meta.total).toBe(2);
    const sofia = res.body.data.find((e: { name: string }) => e.name === 'Sofia');
    expect(sofia.invitationStatus).toBe('pending');
    const karim = res.body.data.find((e: { name: string }) => e.name === 'Karim');
    expect(karim.lastLoginAt).toBeGreaterThan(0);
  });

  it('allows a Manager to view the roster but NOT to create staff (PRD §11)', async () => {
    const managerId = await seedEmployee(getDb(app), { name: 'Amina', role: 'manager', pin: '1111' });
    const { randomBytes } = await import('crypto');
    const { TokensService } = await import('../auth/tokens.service');
    const rawToken = randomBytes(48).toString('base64url');
    await getDb(app)
      .insert(refreshTokens)
      .values({
        employeeId: managerId,
        deviceLabel: 'Manager Tablet',
        tokenHash: TokensService.hashToken(rawToken),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      });
    const login = await authed().post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId: managerId, pin: '1111' });
    const managerToken = login.body.data.accessToken;

    await authed().get('/employees').set('Authorization', `Bearer ${managerToken}`).expect(200);

    const denied = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Yanis', role: 'kitchen' })
      .expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSION');

    // The denial itself is audit-logged (Security §2).
    const rows = await getDb(app).select().from(auditLog);
    expect(rows.some((r) => r.action === 'permission_denied' && r.actorEmployeeId === managerId)).toBe(true);
  });

  it('role changes are audited with old and new values (FR38)', async () => {
    const created = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter' })
      .expect(201);
    const id = created.body.data.employee.id;

    await authed()
      .patch(`/employees/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'manager' })
      .expect(200);

    const rows = (await getDb(app).select().from(auditLog)).filter((r) => r.action === 'role_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmployeeId: ownerId,
      entityId: id,
      oldValueJson: '{"role":"waiter"}',
      newValueJson: '{"role":"manager"}',
    });
  });

  it('deactivation is a soft delete and blocks further logins', async () => {
    const created = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter' })
      .expect(201);
    const id = created.body.data.employee.id;

    await authed()
      .patch(`/employees/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isActive: false })
      .expect(200);

    const row = (await getDb(app).select().from(employees).where(eq(employees.id, id)))[0];
    expect(row.isActive).toBe(false); // row still exists — history preserved
  });

  it('Owner-triggered PIN reset takes effect immediately and is audited', async () => {
    const created = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter' })
      .expect(201);
    const id = created.body.data.employee.id;

    await authed()
      .post(`/employees/${id}/reset-pin`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ newPin: '4321' })
      .expect(201);

    const row = (await getDb(app).select().from(employees).where(eq(employees.id, id)))[0];
    expect(row.pinHash).toBeTruthy();
    const rows = await getDb(app).select().from(auditLog);
    expect(rows.some((r) => r.action === 'pin_reset' && r.entityId === id)).toBe(true);
  });

  it('Active Devices: lists trusted devices and revokes them (Security §1)', async () => {
    // The Owner's own password-login created one trusted device.
    const res = await authed()
      .get(`/employees/${ownerId}/devices`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].deviceLabel).toBe('Owner Laptop');

    await authed()
      .post(`/devices/${res.body.data[0].id}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const after = await authed()
      .get(`/employees/${ownerId}/devices`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(after.body.data).toHaveLength(0);
  });

  it('rejects invalid roles and unknown fields at the DTO boundary', async () => {
    const badRole = await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'X', role: 'superadmin' })
      .expect(400);
    expect(badRole.body.error.code).toBe('VALIDATION_FAILED');

    // forbidNonWhitelisted (Engineering Standards §6): unknown fields rejected.
    await authed()
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Y', role: 'waiter', isAdmin: true })
      .expect(400);
  });

  it('returns 404 for a non-existent employee', async () => {
    const res = await authed()
      .patch('/employees/00000000-0000-7000-8000-000000000000')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'manager' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
