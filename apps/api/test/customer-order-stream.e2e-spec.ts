import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { CUSTOMER_EVENT } from '@smarttable/shared-types';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

interface CapturedEvent {
  event: string;
  data: string;
}

/**
 * E2E — the customer real-time channel (Step 3.5; API Contract §5): a guest
 * orders via QR, opens the stream on their phone, and watches their order
 * progress live through the REAL staff workflow — snapshot first (D7), one
 * named status_changed per transition, a menu_updated refetch cue when the
 * manager hides a product mid-service (D8/FR31), all as plain JSON with no
 * REST envelope, from an unauthenticated read-only channel (Security §1).
 */
describe('Customer order stream (E2E)', () => {
  let app: INestApplication;
  let port: number;

  const db = () => getDb(app);
  const key = () => 'e2e-sse-' + randomBytes(12).toString('hex');

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;
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

  const captureStream = (orderId: string) => {
    const captured: CapturedEvent[] = [];
    let buffer = '';
    const req = http.get(`http://127.0.0.1:${port}/api/v1/public/orders/${orderId}/stream`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          captured.push({ event: eventLine ? eventLine.slice(6).trim() : 'message', data: dataLine ? dataLine.slice(5).trim() : '' });
        }
      });
    });
    return {
      captured,
      waitFor: async (n: number, timeoutMs = 6_000): Promise<CapturedEvent[]> => {
        const start = Date.now();
        while (captured.length < n) {
          if (Date.now() - start > timeoutMs) throw new Error(`expected ${n} SSE events, got ${captured.length}`);
          await new Promise((r) => setTimeout(r, 25));
        }
        return captured.slice(0, n);
      },
      close: () => req.destroy(),
    };
  };

  it('carries a guest visit live from snapshot to payment', async () => {
    const server = app.getHttpServer();

    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');

    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'تراس' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: hall.body.data.id, label: 'طاولة ٧' })
      .expect(201);
    const category = await request(server).post('/api/v1/categories').set('Authorization', `Bearer ${ownerToken}`).send({ nameAr: 'حلويات', nameFr: 'Desserts' }).expect(201);
    const product = await request(server)
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('categoryId', category.body.data.id)
      .field('nameAr', 'قلب اللوز')
      .field('nameFr', 'Cœur aux amandes')
      .field('priceMinor', '15000')
      .expect(201);

    // ---- the guest orders via QR, then opens the stream
    const order = await request(server)
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', key())
      .send({ qrToken: table.body.data.qrToken, items: [{ productId: product.body.data.id, quantity: 1 }] })
      .expect(201);
    const orderId = order.body.data.id as string;

    const stream = captureStream(orderId);
    try {
      // 1 — snapshot first, matching the Q8 public read exactly
      const [snapshot] = await stream.waitFor(1);
      expect(snapshot.event).toBe(CUSTOMER_EVENT.STATUS_CHANGED);
      expect(JSON.parse(snapshot.data)).toEqual({ id: orderId, status: 'pending' });
      const publicRead = await request(server).get(`/api/v1/public/orders/${orderId}/status`).expect(200);
      expect(publicRead.body.data).toEqual({ id: orderId, status: 'pending' });

      // 2 — staff accept → the guest sees it live
      await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      // 3 — a menu change mid-service → refetch cue for every connected guest
      await request(server)
        .patch(`/api/v1/products/${product.body.data.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ isAvailable: false })
        .expect(200);

      const events = await stream.waitFor(3);
      expect(events[1].event).toBe(CUSTOMER_EVENT.STATUS_CHANGED);
      expect(JSON.parse(events[1].data)).toEqual({ id: orderId, status: 'accepted' });
      expect(events[2].event).toBe(CUSTOMER_EVENT.MENU_UPDATED);
      expect(JSON.parse(events[2].data)).toEqual({ productId: product.body.data.id, isAvailable: false });
    } finally {
      stream.close();
    }

    // 5 — unknown order → a normal 404, never a dangling stream
    const missing = await request(server).get(`/api/v1/public/orders/${crypto.randomUUID()}/stream`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  }, 120_000);

  it('delivers paid and completed live to a guest who subscribed late (snapshot reflects current state)', async () => {
    const server = app.getHttpServer();
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const waiterToken = await pinLogin('Sofia2', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis2', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine2', 'cashier', '1234');

    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة ٢' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: hall.body.data.id, label: 'طاولة ٨' })
      .expect(201);
    const category = await request(server).post('/api/v1/categories').set('Authorization', `Bearer ${ownerToken}`).send({ nameAr: 'مشروبات', nameFr: 'Boissons' }).expect(201);
    const product = await request(server)
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('categoryId', category.body.data.id)
      .field('nameAr', 'قهوة')
      .field('nameFr', 'Café')
      .field('priceMinor', '8000')
      .expect(201);

    const order = await request(server)
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', key())
      .send({ qrToken: table.body.data.qrToken, items: [{ productId: product.body.data.id, quantity: 1 }] })
      .expect(201);
    const orderId = order.body.data.id as string;

    // Walk the order fully to served so payment is legal (D1 gate).
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);

    // The guest subscribes LATE — snapshot must show the current state (D7).
    const stream = captureStream(orderId);
    try {
      const [snapshot] = await stream.waitFor(1);
      expect(JSON.parse(snapshot.data)).toEqual({ id: orderId, status: 'served' });

      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ openingCashMinor: 5000 })
        .expect(201);
      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('Idempotency-Key', key())
        .send({ tableBillGroupId: order.body.data.tableBillGroupId })
        .expect(201);

      // served → paid → completed, both visible to the guest in order.
      const events = await stream.waitFor(3);
      expect(JSON.parse(events[1].data)).toEqual({ id: orderId, status: 'paid' });
      expect(JSON.parse(events[2].data)).toEqual({ id: orderId, status: 'completed' });

      // The public status read now agrees with the stream's final state.
      const publicRead = await request(server).get(`/api/v1/public/orders/${orderId}/status`).expect(200);
      expect(publicRead.body.data).toEqual({ id: orderId, status: 'completed' });
    } finally {
      stream.close();
    }
  }, 120_000);
});
