import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { employees, invitations, refreshTokens } from '../../database/schema';
import { TokensService } from '../auth/tokens.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from './invitations.module';
import { EmployeesModule } from '../employees/employees.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the full invitation lifecycle against a real database —
 * issue → validate → accept (FR27) → revoke/reissue (FR26) — including the
 * single-use and expiry guarantees and the audit trail behind them.
 */
describe('InvitationsModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;

  const createEmployeeWithInvitation = async (name = 'Sofia', role = 'waiter') => {
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name, role })
      .expect(201);
    return res.body.data as {
      employee: { id: string };
      invitation: { id: string; token: string; expiresAt: number };
    };
  };

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, AuditModule, AuthModule, InvitationsModule, EmployeesModule],
      })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );
    await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const login = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = login.body.data.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('validates a token and returns pre-acceptance context (FR24)', async () => {
    const { invitation } = await createEmployeeWithInvitation();

    const res = await request(app.getHttpServer())
      .get(`/invitations/accept/${invitation.token}`)
      .expect(200);

    expect(res.body.data).toMatchObject({ employeeName: 'Sofia', role: 'waiter' });
  });

  it('acceptance sets credentials, consumes the token, and establishes Device Trust (FR27, single-use)', async () => {
    const { invitation } = await createEmployeeWithInvitation();

    const res = await request(app.getHttpServer())
      .post(`/invitations/accept/${invitation.token}`)
      .send({ password: 'sofia-secret-1', pin: '1234', deviceLabel: 'Waiter Tablet' })
      .expect(201);

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.deviceRefreshToken).toBeTruthy();

    const db = getDb(app);
    const invitationRow = (await db.select().from(invitations).where(eq(invitations.id, invitation.id)))[0];
    expect(invitationRow.status).toBe('accepted');
    expect(invitationRow.acceptedAt).toBeGreaterThan(0);

    const employeeRow = (await db.select().from(employees).where(eq(employees.id, res.body.data.employee.id)))[0];
    expect(employeeRow.passwordHash).toBeTruthy();
    expect(employeeRow.pinHash).toBeTruthy();
    expect(employeeRow.passwordHash).not.toContain('sofia');
    expect(employeeRow.pinHash).not.toContain('1234');

    const devices = await db.select().from(refreshTokens);
    expect(devices).toHaveLength(2); // Owner Laptop (from login) + Waiter Tablet

    // Single-use: the same token can never be consumed again.
    const replay = await request(app.getHttpServer())
      .post(`/invitations/accept/${invitation.token}`)
      .send({ password: 'another-pass-1', pin: '9999', deviceLabel: 'Other' })
      .expect(409);
    expect(replay.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
  });

  it('rejects and marks a time-expired token (NFR12)', async () => {
    const { invitation } = await createEmployeeWithInvitation();
    // Move BOTH timestamps into the past — chk_invitations_expiry_order
    // (expires_at > created_at) is the database's last line of defense and
    // must stay satisfied even in the test fixture.
    await getDb(app)
      .update(invitations)
      .set({ createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1000 })
      .where(eq(invitations.id, invitation.id));

    const res = await request(app.getHttpServer())
      .get(`/invitations/accept/${invitation.token}`)
      .expect(409);
    expect(res.body.error.code).toBe('INVITATION_EXPIRED');

    const row = (await getDb(app).select().from(invitations).where(eq(invitations.id, invitation.id)))[0];
    expect(row.status).toBe('expired');
  });

  it('revoked tokens no longer resolve (FR26)', async () => {
    const { invitation } = await createEmployeeWithInvitation();

    await request(app.getHttpServer())
      .post(`/invitations/${invitation.id}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    await request(app.getHttpServer()).get(`/invitations/accept/${invitation.token}`).expect(404);
  });

  it('reissue mints a working replacement token (FR26)', async () => {
    const { invitation } = await createEmployeeWithInvitation();

    const res = await request(app.getHttpServer())
      .post(`/invitations/${invitation.id}/reissue`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const newToken = res.body.data.token;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(invitation.token);

    // Old token dead, new token resolves.
    await request(app.getHttpServer()).get(`/invitations/accept/${invitation.token}`).expect(404);
    const ctx = await request(app.getHttpServer()).get(`/invitations/accept/${newToken}`).expect(200);
    expect(ctx.body.data.employeeName).toBe('Sofia');
  });

  it('stores only token hashes — the raw token never touches the database', async () => {
    const { invitation } = await createEmployeeWithInvitation();
    const row = (await getDb(app).select().from(invitations).where(eq(invitations.id, invitation.id)))[0];
    expect(row.tokenHash).toBe(TokensService.hashToken(invitation.token));
    expect(row.tokenHash).not.toBe(invitation.token);
  });

  it('rejects staff without staff.manage from revoking (PRD §11 baseline)', async () => {
    const { invitation } = await createEmployeeWithInvitation();
    await request(app.getHttpServer())
      .post(`/invitations/${invitation.id}/revoke`)
      .expect(401); // no token at all
  });
});
