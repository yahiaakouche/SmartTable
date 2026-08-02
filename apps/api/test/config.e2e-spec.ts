import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as http from 'http';
import { io, Socket } from 'socket.io-client';
import { CUSTOMER_EVENT, STAFF_EVENT } from '@smarttable/shared-types';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, products, refreshTokens, restaurantProfile } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

interface CapturedEvent {
  event: string;
  data: string;
}

/**
 * E2E — Step 3.10 critical path (Engineering Standards §10), against the
 * FULL application composition (real migrated database, /api/v1 prefix, a
 * real listening port):
 *
 *   the Owner PATCHes the restaurant branding over real HTTP and the change
 *   propagates IMMEDIATELY through BOTH frozen channels — the staff
 *   Socket.IO `restaurant_profile.changed` broadcast and the customer SSE
 *   `menu_updated` cue (FR31) — with zero changes to the 3.5 bridge, and
 *   the customer menu refetch returns the new branding (B2(a)). The B1(a)/
 *   D6 access matrix is exercised over real HTTP.
 */
describe('Config (E2E critical path)', () => {
  let app: INestApplication;
  let port: number;
  const sockets: Socket[] = [];

  const db = () => getDb(app);

  let ownerToken: string;
  let managerToken: string;
  let waiterToken: string;
  let kitchenToken: string;
  let cashierToken: string;
  let qrToken: string;
  let orderId: string;

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
    await app.listen(0);
    port = app.getHttpServer().address().port;

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const ownerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = ownerLogin.body.data.accessToken;

    const pinLogin = async (name: string, role: string, pin: string) => {
      const employeeId = await seedEmployee(db(), { name, role, pin });
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
    managerToken = await pinLogin('Amina', 'manager', '1234');
    waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    cashierToken = await pinLogin('Lina', 'cashier', '1234');

    // The Setup Wizard's future job (B3(a)) — seeded directly, exactly the
    // way billing/analytics fixtures do.
    await db()
      .insert(restaurantProfile)
      .values({
        name: 'Restaurant El Djazair',
        logoPath: null,
        primaryColor: '#111111',
        secondaryColor: '#eeeeee',
        currencyCode: 'DZD',
        taxRatePercent: 1900,
        defaultLanguage: 'ar',
      });

    // A table (for the customer menu) and a live order (for the SSE stream).
    const server = app.getHttpServer();
    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة' }).expect(201);
    const table = (
      await request(server)
        .post('/api/v1/tables')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ label: 'Table A', hallId: hall.body.data.id })
        .expect(201)
    ).body.data as { id: string; qrToken: string };
    qrToken = table.qrToken;
    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [soup] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();
    const order = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', 'e2e-' + randomBytes(12).toString('hex'))
      .send({ tableId: table.id, items: [{ productId: soup.id, quantity: 1 }] })
      .expect(201);
    orderId = order.body.data.id;
  }, 90_000);

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await app?.close();
  });

  const connectStaff = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5_000 });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  const nextEvent = <T = unknown>(socket: Socket, event: string, timeoutMs = 4_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  /** Minimal SSE capture (the orders module's own pattern): parses
   * event/data blocks as they arrive over the real HTTP stream. */
  const captureStream = (id: string) => {
    const captured: CapturedEvent[] = [];
    let buffer = '';
    const req = http.get(`http://127.0.0.1:${port}/api/v1/public/orders/${id}/stream`, (res) => {
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
      waitFor: async (event: string, timeoutMs = 4_000): Promise<CapturedEvent> => {
        const start = Date.now();
        for (;;) {
          const found = captured.find((c) => c.event === event);
          if (found) return found;
          if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for SSE ${event}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      close: () => req.destroy(),
    };
  };

  it('FR31: an Owner branding PATCH propagates live to staff sockets AND the customer SSE channel, and the refetch sees it (B2(a))', async () => {
    const socket = await connectStaff(waiterToken);
    await new Promise((r) => setTimeout(r, 200)); // room join settles after the handshake
    const staffEvent = nextEvent(socket, STAFF_EVENT.RESTAURANT_PROFILE_CHANGED);
    const stream = captureStream(orderId);
    try {
      await stream.waitFor(CUSTOMER_EVENT.STATUS_CHANGED); // the stream is live before the change

      const patched = await request(app.getHttpServer())
        .patch('/api/v1/config/restaurant-profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ primaryColor: '#a1b2c3', name: 'مطعم الجزائر' })
        .expect(200);
      expect(patched.body.data).toMatchObject({ primaryColor: '#a1b2c3', name: 'مطعم الجزائر' });

      // Staff channel: the FULL updated profile DTO (Contract §4).
      const staffPayload = (await staffEvent) as Record<string, unknown>;
      expect(staffPayload).toEqual(patched.body.data);

      // Customer channel: the pre-wired menu_updated cue (zero 3.5 changes).
      const sseEvent = await stream.waitFor(CUSTOMER_EVENT.MENU_UPDATED);
      expect(JSON.parse(sseEvent.data)).toEqual(patched.body.data);

      // The refetch cue is meaningful: the customer menu now serves the new
      // branding, staff-only fields stripped.
      const menu = await request(app.getHttpServer()).get(`/api/v1/public/menu/${qrToken}`).expect(200);
      expect(menu.body.data.restaurant).toEqual({
        name: 'مطعم الجزائر',
        logoPath: null,
        primaryColor: '#a1b2c3',
        secondaryColor: '#eeeeee',
        currencyCode: 'DZD',
        defaultLanguage: 'ar',
      });
    } finally {
      stream.close();
    }
  }, 90_000);

  it('enforces B1(a)/D6 over real HTTP: mutation Owner-only, read for all staff, anonymous 401', async () => {
    const server = app.getHttpServer();
    for (const token of [ownerToken, managerToken, cashierToken, waiterToken, kitchenToken]) {
      await request(server).get('/api/v1/config/restaurant-profile').set('Authorization', `Bearer ${token}`).expect(200);
    }
    await request(server).get('/api/v1/config/restaurant-profile').expect(401);

    for (const token of [managerToken, cashierToken, waiterToken, kitchenToken]) {
      const res = await request(server)
        .patch('/api/v1/config/restaurant-profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ secondaryColor: '#000000' })
        .expect(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
    }
    await request(server).patch('/api/v1/config/restaurant-profile').send({ secondaryColor: '#000000' }).expect(401);

    const ok = await request(server)
      .patch('/api/v1/config/restaurant-profile')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ secondaryColor: '#dddddd' })
      .expect(200);
    expect(ok.body.data.secondaryColor).toBe('#dddddd');
  }, 30_000);
});
