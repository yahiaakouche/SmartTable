import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { io, Socket } from 'socket.io-client';
import { STAFF_EVENT } from '@smarttable/shared-types';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the staff real-time channel (Step 3.5; Engineering Standards §10
 * critical-path spirit: a REAL guest visit observed entirely over the wire).
 * Against the FULL application composition, one complete visit is driven
 * through the real REST endpoints while authenticated staff sockets assert
 * the frozen §4 contract live: per-room delivery (B2/B3), FR6/Q7 kitchen
 * price stripping on the wire (D5), the table flip events, invitation.accepted
 * to owner-room (D6), and the binding emit-after-commit rule (a rejected
 * transition must produce NO event).
 */
describe('Staff real-time channel over a full guest visit (E2E)', () => {
  let app: INestApplication;
  let port: number;
  const sockets: Socket[] = [];

  const db = () => getDb(app);
  const key = () => 'e2e-rt-' + randomBytes(12).toString('hex');

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
    for (const socket of sockets.splice(0)) socket.disconnect();
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

  const connectStaff = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  const nextEvent = <T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 5_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const collectFor = async (socket: Socket, event: string, ms = 500): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const handler = (payload: unknown) => seen.push(payload);
    socket.on(event, handler);
    await new Promise((r) => setTimeout(r, ms));
    socket.off(event, handler);
    return seen;
  };

  it('delivers the frozen §4 event surface live through one whole visit', async () => {
    const server = app.getHttpServer();

    // ---- staff identities
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine', 'cashier', '1234');

    // ---- connect the four role channels
    const ownerSocket = await connectStaff(ownerToken);
    const waiterSocket = await connectStaff(waiterToken);
    const kitchenSocket = await connectStaff(kitchenToken);
    const cashierSocket = await connectStaff(cashierToken);
    await settle();

    // ---- floor & menu fixtures via the real endpoints
    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة رئيسية' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: hall.body.data.id, label: 'طاولة ١' })
      .expect(201);
    const category = await request(server).post('/api/v1/categories').set('Authorization', `Bearer ${ownerToken}`).send({ nameAr: 'مقبلات', nameFr: 'Entrées' }).expect(201);
    const product = await request(server)
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('categoryId', category.body.data.id)
      .field('nameAr', 'شوربة عدس')
      .field('nameFr', 'Soupe de lentilles')
      .field('priceMinor', '25000')
      .expect(201);

    // ---- availability toggle (a real change — the bus only fires on
    // transitions) → every role hears restaurant-broadcast
    const availabilityAll = [ownerSocket, waiterSocket, kitchenSocket, cashierSocket].map((s) =>
      nextEvent(s, STAFF_EVENT.PRODUCT_AVAILABILITY_CHANGED),
    );
    await request(server)
      .patch(`/api/v1/products/${product.body.data.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isAvailable: false })
      .expect(200);
    for (const received of await Promise.all(availabilityAll)) {
      expect(received).toEqual({ productId: product.body.data.id, isAvailable: false });
    }
    // restore for the order below
    await request(server)
      .patch(`/api/v1/products/${product.body.data.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isAvailable: true })
      .expect(200);

    // ---- customer order arrives → kitchen sees NO price, waiter sees the full DTO
    const kitchenCreated = nextEvent<Record<string, unknown>>(kitchenSocket, STAFF_EVENT.ORDER_CREATED);
    const waiterCreated = nextEvent<Record<string, unknown>>(waiterSocket, STAFF_EVENT.ORDER_CREATED);
    const waiterTableFlip = nextEvent<Record<string, unknown>>(waiterSocket, STAFF_EVENT.TABLE_STATUS_CHANGED);
    const qrToken = table.body.data.qrToken;
    await request(server)
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', key())
      .send({ qrToken, items: [{ productId: product.body.data.id, quantity: 2 }] })
      .expect(201);

    const kitchenOrder = await kitchenCreated;
    const kitchenItems = kitchenOrder['items'] as Array<Record<string, unknown>>;
    expect(kitchenItems[0]).not.toHaveProperty('unitPriceMinor');
    expect(kitchenItems[0]).toMatchObject({ name: 'شوربة عدس', quantity: 2 });

    const waiterOrder = await waiterCreated;
    const orderId = waiterOrder['id'] as string;
    const tableBillGroupId = waiterOrder['tableBillGroupId'] as string;
    expect((waiterOrder['items'] as Array<Record<string, unknown>>)[0].unitPriceMinor).toBe(25000);

    expect(await waiterTableFlip).toEqual({ tableId: table.body.data.id, fromStatus: 'available', toStatus: 'occupied' });

    // ---- a REJECTED transition must produce NO event (emit-after-commit, §4)
    const silentWindow = collectFor(kitchenSocket, STAFF_EVENT.ORDER_STATUS_CHANGED, 600);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(409);
    expect(await silentWindow).toEqual([]);

    // ---- accept → order.accepted on kitchen/waiter/owner-room + status_changed (B3)
    const kitchenAccepted = nextEvent(kitchenSocket, STAFF_EVENT.ORDER_ACCEPTED);
    const ownerAccepted = nextEvent(ownerSocket, STAFF_EVENT.ORDER_ACCEPTED);
    const statusAccepted = [kitchenSocket, waiterSocket, cashierSocket, ownerSocket].map((s) =>
      nextEvent<Record<string, unknown>>(s, STAFF_EVENT.ORDER_STATUS_CHANGED),
    );
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await kitchenAccepted;
    await ownerAccepted;
    for (const received of await Promise.all(statusAccepted)) {
      expect(received).toEqual({ orderId, fromStatus: 'pending', toStatus: 'accepted' });
    }

    // ---- walk to served
    for (const _ of ['preparing', 'ready']) {
      await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    }
    await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);

    // ---- payment: cashier hears served→paid AND paid→completed (B3), then the table flip
    const shift = await request(server)
      .post('/api/v1/shifts/open')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ openingCashMinor: 20000 })
      .expect(201);
    expect(shift.body.data.status).toBe('open');

    const cashierPaid = nextEvent<Record<string, unknown>>(cashierSocket, STAFF_EVENT.ORDER_STATUS_CHANGED);
    const cashierCompleted = nextEvent<Record<string, unknown>>(cashierSocket, STAFF_EVENT.ORDER_STATUS_CHANGED);
    const ownerTableFlip = nextEvent<Record<string, unknown>>(ownerSocket, STAFF_EVENT.TABLE_STATUS_CHANGED);

    // collect the two paid/completed transitions in order via a queue
    const transitions: Array<Record<string, unknown>> = [];
    const transitionHandler = (p: Record<string, unknown>) => {
      if (p['orderId'] === orderId) transitions.push(p);
    };
    cashierSocket.on(STAFF_EVENT.ORDER_STATUS_CHANGED, transitionHandler);

    await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId })
      .expect(201);

    await cashierPaid;
    await cashierCompleted;
    expect(await ownerTableFlip).toEqual({ tableId: table.body.data.id, fromStatus: 'occupied', toStatus: 'needs_cleaning' });
    cashierSocket.off(STAFF_EVENT.ORDER_STATUS_CHANGED, transitionHandler);
    expect(transitions).toEqual([
      { orderId, fromStatus: 'served', toStatus: 'paid' },
      { orderId, fromStatus: 'paid', toStatus: 'completed' },
    ]);

    // ---- mark-cleaned closes the loop on the wire too
    const waiterCleaned = nextEvent<Record<string, unknown>>(waiterSocket, STAFF_EVENT.TABLE_STATUS_CHANGED);
    await request(server).post(`/api/v1/tables/${table.body.data.id}/mark-cleaned`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    expect(await waiterCleaned).toEqual({ tableId: table.body.data.id, fromStatus: 'needs_cleaning', toStatus: 'available' });

    // ---- invitation acceptance surfaces to owner-room live (D6)
    const ownerInviteEvent = nextEvent<Record<string, unknown>>(ownerSocket, STAFF_EVENT.INVITATION_ACCEPTED);
    const waiterInviteWindow = collectFor(waiterSocket, STAFF_EVENT.INVITATION_ACCEPTED, 800);
    const created = await request(server)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Nadia', role: 'waiter' })
      .expect(201);
    const invitationToken = created.body.data.invitation.token as string;
    await request(server)
      .post(`/api/v1/invitations/accept/${invitationToken}`)
      .send({ password: 'nadia-secret-1', pin: '5678', deviceLabel: 'Nadia Phone' })
      .expect(201);
    const invitePayload = await ownerInviteEvent;
    expect(invitePayload).toHaveProperty('invitationId');
    expect(invitePayload).toHaveProperty('employeeId');
    expect(await waiterInviteWindow).toEqual([]);
  }, 120_000);
});
