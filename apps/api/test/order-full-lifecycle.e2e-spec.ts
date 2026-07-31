import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, orderStatusEvents, products, refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the Step 3.4 named critical path (Engineering Standards §10; Q12
 * ruling placed this path here, not in 3.3): "full order lifecycle
 * (Pending → Completed)", exercised against the FULL application composition:
 *
 *   one order walks every legal state — pending → accepted → preparing →
 *   ready → served → paid → completed — each transition performed by its
 *   frozen role (Q2/Q5/FR7/FR8), each step verified through BOTH the staff
 *   read and the customer's minimal public read (Q8), with the complete
 *   seven-row order_status_events trail as the operational record (D3: Paid
 *   and Completed are two RECORDED transitions). The path then proves the
 *   B2 lock: a completed order can never be cancelled.
 */
describe('Full order lifecycle Pending → Completed (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const key = () => 'e2e-' + randomBytes(12).toString('hex');

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
  }, 90_000);

  afterAll(async () => {
    await app.close();
  });

  const pinLogin = async (name: string, role: string, pin: string) => {
    const employeeId = await seedEmployee(db(), { name: `${name} ${randomBytes(3).toString('hex')}`, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: 'Floor Terminal',
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/pin-login')
      .send({ deviceRefreshToken: rawToken, employeeId, pin });
    return res.body.data.accessToken as string;
  };

  it('walks one order through every legal state to Completed', async () => {
    const server = app.getHttpServer();

    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine', 'cashier', '1234');

    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table 1', hallId: hall.body.data.id })
      .expect(201);
    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [product] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();

    // Pending — staff manual entry (FR3: every order starts Pending).
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: table.body.data.id, items: [{ productId: product.id, quantity: 2 }] })
      .expect(201);
    const orderId = created.body.data.id as string;
    const billGroupId = created.body.data.tableBillGroupId as string;
    expect(created.body.data.status).toBe('pending');

    /** Both reads agree on the status at every step (Q8 minimal public read). */
    const expectStatus = async (status: string) => {
      const staff = await request(server).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(staff.body.data.status).toBe(status);
      const publicRead = await request(server).get(`/api/v1/public/orders/${orderId}/status`).expect(200);
      expect(publicRead.body.data).toEqual({ id: orderId, status });
    };
    await expectStatus('pending');

    // Accepted (Q2: kitchen) → preparing → ready (Q5: kitchen) → served (FR7: waiter).
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await expectStatus('accepted');
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await expectStatus('preparing');
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await expectStatus('ready');
    await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    await expectStatus('served');

    // Paid → Completed (FR8: cashier, via the bill-group payment; D3: two
    // RECORDED transitions). No tax profile → the frozen 0% default applies.
    const paymentKey = key();
    const payment = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', paymentKey)
      .send({ tableBillGroupId: billGroupId })
      .expect(201);
    expect(payment.body.data.payment.amountMinor).toBe(50_000); // 2 × 25_000, tax 0
    await expectStatus('completed');

    // An idempotent replay of the payment adds NOTHING to the event trail.
    await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', paymentKey)
      .send({ tableBillGroupId: billGroupId })
      .expect(200);

    // The complete operational record: exactly seven status events in order,
    // with the payment's two transitions attributed to the collecting cashier.
    const events = await db().select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId));
    expect(events.map((e) => `${e.fromStatus ?? 'null'}->${e.toStatus}`)).toEqual([
      'null->pending',
      'pending->accepted',
      'accepted->preparing',
      'preparing->ready',
      'ready->served',
      'served->paid',
      'paid->completed',
    ]);
    const financialEvents = events.slice(-2);
    for (const event of financialEvents) expect(event.actorEmployeeId).toBeTruthy();

    // B2 — the lifecycle is final: a completed order can never be cancelled.
    const cancel = await request(server)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'too late' })
      .expect(409);
    expect(cancel.body.error.code).toBe('INVALID_ORDER_TRANSITION');
    expect(cancel.body.error.details.fromStatus).toBe('completed');
  }, 60_000);
});
