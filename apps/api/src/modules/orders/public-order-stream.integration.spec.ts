import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { CUSTOMER_EVENT } from '@smarttable/shared-types';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { categories, halls, products, refreshTokens, tables } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OrdersModule } from './orders.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

interface CapturedEvent {
  event: string;
  data: string;
}

/**
 * Integration: the customer SSE stream (API Contract §5, rulings D7/D8)
 * against a real, migrated database and a real HTTP server — the one place
 * the actual wire format is asserted: named `status_changed` / `menu_updated`
 * events, initial snapshot first, plain JSON payloads with NO REST envelope,
 * 404 before streaming starts, per-order filtering, and the read-only
 * channel's 60/min public class placement.
 */
describe('Public order SSE stream (integration)', () => {
  let app: INestApplication;
  let port: number;
  let kitchenToken: string;
  let waiterToken: string;

  const db = () => getDb(app);

  const loginWithPin = async (name: string, role: string, pin: string) => {
    const employeeId = await seedEmployee(db(), { name, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: `${name} Terminal`,
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await request(app.getHttpServer()).post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
    return res.body.data.accessToken as string;
  };

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    const builder = Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, IdempotencyModule, OrdersModule],
    })
      .overrideProvider(DRIZZLE_CLIENT)
      .useValue(isolatedDb);
    app = await createTestApp(builder);
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;
    kitchenToken = await loginWithPin('Yanis', 'kitchen', '1234');
    waiterToken = await loginWithPin('Sofia', 'waiter', '1234');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------- helpers

  /** Opens the SSE stream and parses the wire format event-by-event. */
  const captureStream = (orderId: string) => {
    const captured: CapturedEvent[] = [];
    let buffer = '';
    let statusCode = 0;
    let contentType = '';
    const req = http.get(`http://127.0.0.1:${port}/public/orders/${orderId}/stream`, (res) => {
      statusCode = res.statusCode ?? 0;
      contentType = String(res.headers['content-type'] ?? '');
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
      meta: () => ({ statusCode, contentType }),
      waitFor: async (n: number, timeoutMs = 4_000): Promise<CapturedEvent[]> => {
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

  const seedTable = async () => {
    const [hall] = await db().insert(halls).values({ name: 'Main Hall' }).returning();
    const [table] = await db()
      .insert(tables)
      .values({ hallId: hall.id, label: 'Table 1', qrToken: randomBytes(32).toString('base64url') })
      .returning();
    return table;
  };

  const seedProduct = async () => {
    const [category] = await db().insert(categories).values({ nameAr: 'مقبلات', nameFr: 'Entrées' }).returning();
    const [product] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe de lentilles', priceMinor: 25000, imagePath: null })
      .returning();
    return product;
  };

  const createPublicOrder = async (): Promise<string> => {
    const table = await seedTable();
    const product = await seedProduct();
    const res = await request(app.getHttpServer())
      .post('/public/orders')
      .set('Idempotency-Key', 'qr-' + randomBytes(10).toString('hex'))
      .send({ qrToken: table.qrToken, items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  // --------------------------------------------------------------- tests

  it('404s on an unknown order BEFORE the stream starts (normal error envelope)', async () => {
    const res = await request(app.getHttpServer()).get(`/public/orders/${crypto.randomUUID()}/stream`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sends the current status as the FIRST event (D7 snapshot) on a text/event-stream response', async () => {
    const orderId = await createPublicOrder();
    const stream = captureStream(orderId);
    try {
      const [snapshot] = await stream.waitFor(1);
      expect(stream.meta().statusCode).toBe(200);
      expect(stream.meta().contentType).toContain('text/event-stream');
      expect(snapshot.event).toBe(CUSTOMER_EVENT.STATUS_CHANGED);
      // Plain JSON payload with the Q8 minimal shape — NOT wrapped in the
      // REST envelope ({data: ...} would surface a `data` key here).
      const data = JSON.parse(snapshot.data);
      expect(data).toEqual({ id: orderId, status: 'pending' });
      expect(data).not.toHaveProperty('data');
    } finally {
      stream.close();
    }
  });

  it('streams each lifecycle transition as a named status_changed event', async () => {
    const orderId = await createPublicOrder();
    const stream = captureStream(orderId);
    try {
      await stream.waitFor(1); // snapshot: pending
      await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
      await request(app.getHttpServer()).post(`/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);
      const events = await stream.waitFor(3);
      expect(events.map((e) => e.event)).toEqual([CUSTOMER_EVENT.STATUS_CHANGED, CUSTOMER_EVENT.STATUS_CHANGED, CUSTOMER_EVENT.STATUS_CHANGED]);
      expect(JSON.parse(events[1].data)).toEqual({ id: orderId, status: 'accepted' });
      expect(JSON.parse(events[2].data)).toEqual({ id: orderId, status: 'preparing' });
    } finally {
      stream.close();
    }
  });

  it('emits menu_updated when product availability changes (D8 refetch cue)', async () => {
    const orderId = await createPublicOrder();
    const stream = captureStream(orderId);
    try {
      await stream.waitFor(1);
      const events = app.get(DomainEventsService);
      events.emitProductAvailabilityChanged({ productId: 'product-1', isAvailable: false });
      const [, menuUpdated] = await stream.waitFor(2);
      expect(menuUpdated.event).toBe(CUSTOMER_EVENT.MENU_UPDATED);
      expect(JSON.parse(menuUpdated.data)).toEqual({ productId: 'product-1', isAvailable: false });
    } finally {
      stream.close();
    }
  });

  it('only streams transitions for ITS order, never another table’s', async () => {
    const orderA = await createPublicOrder();
    const orderB = await createPublicOrder();
    const stream = captureStream(orderA);
    try {
      await stream.waitFor(1); // snapshot for A
      await request(app.getHttpServer()).post(`/orders/${orderB}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
      await new Promise((r) => setTimeout(r, 400));
      expect(stream.captured).toHaveLength(1); // still only the snapshot
      await request(app.getHttpServer()).post(`/orders/${orderA}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
      const events = await stream.waitFor(2);
      expect(JSON.parse(events[1].data)).toEqual({ id: orderA, status: 'accepted' });
    } finally {
      stream.close();
    }
  });

  it('snapshot reflects the CURRENT status when subscribing mid-lifecycle', async () => {
    const orderId = await createPublicOrder();
    await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
    const stream = captureStream(orderId);
    try {
      const [snapshot] = await stream.waitFor(1);
      expect(JSON.parse(snapshot.data)).toEqual({ id: orderId, status: 'accepted' });
    } finally {
      stream.close();
    }
  });

  it('stays open after a terminal transition (D7 — the client closes, EventSource would storm a server-closed stream)', async () => {
    const orderId = await createPublicOrder();
    const stream = captureStream(orderId);
    try {
      await stream.waitFor(1);
      await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ reason: 'الزبون غادر' });
      const events = await stream.waitFor(2);
      expect(JSON.parse(events[1].data)).toEqual({ id: orderId, status: 'cancelled' });
      // The stream is still usable: a later menu change still arrives.
      const events2 = app.get(DomainEventsService);
      events2.emitProductAvailabilityChanged({ productId: 'product-2', isAvailable: true });
      const extended = await stream.waitFor(3);
      expect(extended[2].event).toBe(CUSTOMER_EVENT.MENU_UPDATED);
    } finally {
      stream.close();
    }
  });

  it('a second status listener unsubscribes cleanly on disconnect (no bus listener leak)', async () => {
    const orderId = await createPublicOrder();
    const events = app.get(DomainEventsService);
    const countListeners = () => (events as unknown as { emitter: { listenerCount(e: string): number } }).emitter.listenerCount(DOMAIN_EVENT.ORDER_STATUS_CHANGED);
    const before = countListeners();
    const stream = captureStream(orderId);
    await stream.waitFor(1);
    expect(countListeners()).toBe(before + 1);
    stream.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(countListeners()).toBe(before);
  });
});
