import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { auditLog } from '../src/database/schema';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the named critical path from Engineering Standards §10:
 * "employee invitation acceptance", exercised against the FULL application
 * composition (all Step 3.1 modules, real database, real guards):
 *
 *   Owner logs in → creates employee (+ invitation) → employee accepts with
 *   password + PIN → employee logs in via PIN on the now-trusted device →
 *   RBAC boundary verified (waiter cannot manage staff) → audit trail
 *   contains every step.
 */
describe('Employee Invitation Acceptance (E2E critical path)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(db),
      { globalPrefix: 'api/v1' }, // mirrors main.ts exactly
    );
    await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('runs the complete onboarding flow end to end', async () => {
    const server = app.getHttpServer();

    // 1. Owner full login on a new device → Device Trust established.
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    expect(ownerToken).toBeTruthy();

    // 2. Owner creates a waiter; invitation token returned exactly once.
    const created = await request(server)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Sofia', role: 'waiter' })
      .expect(201);
    const { employee, invitation } = created.body.data;
    expect(employee.invitationStatus).toBe('pending');

    // 3. Employee (unauthenticated, on the restaurant network) validates the
    // invitation and sees the pre-acceptance context.
    const context = await request(server)
      .get(`/api/v1/invitations/accept/${invitation.token}`)
      .expect(200);
    expect(context.body.data).toMatchObject({ employeeName: 'Sofia', role: 'waiter' });

    // 4. Employee accepts: sets password + PIN, device becomes trusted.
    const accepted = await request(server)
      .post(`/api/v1/invitations/accept/${invitation.token}`)
      .send({ password: 'sofia-secret-1', pin: '2468', deviceLabel: 'Waiter Tablet' })
      .expect(201);
    const deviceToken = accepted.body.data.deviceRefreshToken;

    // 5. From then on, fast PIN login on the trusted device is the daily flow.
    const pinLogin = await request(server)
      .post('/api/v1/auth/pin-login')
      .send({ deviceRefreshToken: deviceToken, employeeId: employee.id, pin: '2468' })
      .expect(201);
    const waiterToken = pinLogin.body.data.accessToken;

    // 6. RBAC boundary: the waiter can act as themselves…
    await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(201);

    // …but can NEVER manage staff (PRD §11 baseline), and the attempt is
    // audit-logged for the Owner to see.
    const denied = await request(server)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({ name: 'Intruder', role: 'owner' })
      .expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSION');

    // 7. The Owner's roster now shows the accepted invitation.
    const roster = await request(server)
      .get('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const sofia = roster.body.data.find((e: { name: string }) => e.name === 'Sofia');
    expect(sofia.invitationStatus).toBe('accepted');

    // 8. The audit trail tells the whole story (FR38, Security §9).
    const actions = (await getDb(app).select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['employee_created', 'invitation_created', 'invitation_accepted', 'permission_denied']),
    );
  });
});
