import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { io, Socket } from 'socket.io-client';
import { NOTIFICATION_TYPE, STAFF_EVENT } from '@smarttable/shared-types';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — operational notifications through one whole guest visit (Step 3.6;
 * Engineering Standards §10 critical-path spirit). Against the FULL
 * application composition, a real visit is driven through the real REST
 * endpoints while authenticated staff sockets and the notifications REST
 * surface assert the frozen contract end to end:
 *  - B2/B3: order_created → kitchen only, order_ready → waiter only,
 *    invitation_accepted → owner + manager — live over the wire (B5(a)),
 *  - emit-after-commit one level down: a REJECTED transition produces no
 *    notification, and non-ready transitions produce none either,
 *  - B4(a)/D6/D7: the REST read surface — recipient scoping, 403/404,
 *    shared role read-state, idempotent mark-read,
 *  - D2/FR6: no money field appears in any notification on the wire.
 */
describe('Operational notifications over a full guest visit (E2E)', () => {
  let app: INestApplication;
  let port: number;
  const sockets: Socket[] = [];

  const db = () => getDb(app);
  const key = () => 'e2e-notif-' + randomBytes(12).toString('hex');

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
      deviceLabel: `${name} Terminal`,
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

  const collectFor = async (socket: Socket, event: string, ms = 600): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const handler = (payload: unknown) => seen.push(payload);
    socket.on(event, handler);
    await new Promise((r) => setTimeout(r, ms));
    socket.off(event, handler);
    return seen;
  };

  it('creates, delivers, and serves notifications through the whole visit', async () => {
    const server = app.getHttpServer();

    // ---- staff identities (all five roles)
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const managerToken = await pinLogin('Amina', 'manager', '1234');
    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine', 'cashier', '1234');

    const ownerSocket = await connectStaff(ownerToken);
    const managerSocket = await connectStaff(managerToken);
    const waiterSocket = await connectStaff(waiterToken);
    const kitchenSocket = await connectStaff(kitchenToken);
    const cashierSocket = await connectStaff(cashierToken);
    await settle();

    // ---- floor & menu fixtures via the real endpoints
    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة رئيسية' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: hall.body.data.id, label: 'طاولة ٣' })
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

    // ---- QR order arrives → order_created notification to the KITCHEN only (B2/B3)
    const kitchenNotification = nextEvent<Record<string, unknown>>(kitchenSocket, STAFF_EVENT.NOTIFICATION_CREATED);
    const waiterSilentOnCreate = collectFor(waiterSocket, STAFF_EVENT.NOTIFICATION_CREATED, 800);
    const ownerSilentOnCreate = collectFor(ownerSocket, STAFF_EVENT.NOTIFICATION_CREATED, 800);
    await request(server)
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', key())
      .send({ qrToken: table.body.data.qrToken, items: [{ productId: product.body.data.id, quantity: 2 }] })
      .expect(201);

    const created = await kitchenNotification;
    const orderId = (created['payload'] as Record<string, unknown>)['orderId'] as string;
    expect(created).toMatchObject({
      type: NOTIFICATION_TYPE.ORDER_CREATED,
      recipientRole: 'kitchen',
      recipientEmployeeId: null,
      payload: { orderId, tableId: table.body.data.id },
      readAt: null,
    });
    // D2/FR6 — no money field anywhere in the notification on the wire.
    expect(JSON.stringify(created)).not.toContain('PriceMinor');
    expect(await waiterSilentOnCreate).toEqual([]);
    expect(await ownerSilentOnCreate).toEqual([]);

    // ---- emit-after-commit, one level down: a REJECTED advance (pending →
    // advance is illegal) produces NO notification
    const silentOnReject = collectFor(kitchenSocket, STAFF_EVENT.NOTIFICATION_CREATED, 600);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(409);
    expect(await silentOnReject).toEqual([]);

    // ---- accept, then advance to PREPARING: the ready-only filter (B2)
    // stays silent for the waiter
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    const silentOnPreparing = collectFor(waiterSocket, STAFF_EVENT.NOTIFICATION_CREATED, 600);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    expect(await silentOnPreparing).toEqual([]);

    // ---- advance to READY → order_ready notification to the WAITER only
    const waiterNotification = nextEvent<Record<string, unknown>>(waiterSocket, STAFF_EVENT.NOTIFICATION_CREATED);
    const kitchenSilentOnReady = collectFor(kitchenSocket, STAFF_EVENT.NOTIFICATION_CREATED, 800);
    const cashierSilentOnReady = collectFor(cashierSocket, STAFF_EVENT.NOTIFICATION_CREATED, 800);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);

    const ready = await waiterNotification;
    expect(ready).toMatchObject({
      type: NOTIFICATION_TYPE.ORDER_READY,
      recipientRole: 'waiter',
      recipientEmployeeId: null,
      payload: { orderId, tableId: table.body.data.id },
      readAt: null,
    });
    expect(await kitchenSilentOnReady).toEqual([]);
    expect(await cashierSilentOnReady).toEqual([]);

    // ---- the REST read surface over the same rows (B1/B4(a))
    const kitchenList = await request(server)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${kitchenToken}`)
      .expect(200);
    expect(kitchenList.body.data).toHaveLength(1);
    expect(kitchenList.body.data[0]).toMatchObject({ type: NOTIFICATION_TYPE.ORDER_CREATED, payload: { orderId } });

    const waiterList = await request(server)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(200);
    expect(waiterList.body.data).toHaveLength(1);
    const waiterNotificationId = waiterList.body.data[0].id as string;

    // D6: the waiter may not touch the kitchen's row
    await request(server)
      .post(`/api/v1/notifications/${kitchenList.body.data[0].id}/read`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(403);

    // B4(a)/D7: the waiter marks the role-shared row; a repeat is a 200 no-op
    const marked = await request(server)
      .post(`/api/v1/notifications/${waiterNotificationId}/read`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(201);
    expect(marked.body.data.readAt).toEqual(expect.any(Number));
    const remarked = await request(server)
      .post(`/api/v1/notifications/${waiterNotificationId}/read`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(201);
    expect(remarked.body.data.readAt).toBe(marked.body.data.readAt);
    const waiterUnreadAfter = await request(server)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(200);
    expect(waiterUnreadAfter.body.data).toEqual([]);

    // ---- cashier received nothing at any point in the visit (B3)
    const cashierList = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    expect(cashierList.body.data).toEqual([]);

    // ---- invitation acceptance → owner AND manager, one row each (B3)
    const ownerInvite = nextEvent<Record<string, unknown>>(ownerSocket, STAFF_EVENT.NOTIFICATION_CREATED);
    const managerInvite = nextEvent<Record<string, unknown>>(managerSocket, STAFF_EVENT.NOTIFICATION_CREATED);
    const waiterSilentOnInvite = collectFor(waiterSocket, STAFF_EVENT.NOTIFICATION_CREATED, 800);
    const createdEmployee = await request(server)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Nadia', role: 'waiter' })
      .expect(201);
    const invitationToken = createdEmployee.body.data.invitation.token as string;
    await request(server)
      .post(`/api/v1/invitations/accept/${invitationToken}`)
      .send({ password: 'nadia-secret-1', pin: '5678', deviceLabel: 'Nadia Phone' })
      .expect(201);

    const ownerReceived = await ownerInvite;
    const managerReceived = await managerInvite;
    for (const [received, role] of [
      [ownerReceived, 'owner'],
      [managerReceived, 'manager'],
    ] as const) {
      expect(received).toMatchObject({
        type: NOTIFICATION_TYPE.INVITATION_ACCEPTED,
        recipientRole: role,
        recipientEmployeeId: null,
      });
      expect((received['payload'] as Record<string, unknown>)['invitationId']).toBeTruthy();
    }
    expect((ownerReceived['payload'] as Record<string, unknown>)['employeeId']).toBe(
      (managerReceived['payload'] as Record<string, unknown>)['employeeId'],
    );
    expect(await waiterSilentOnInvite).toEqual([]);

    // Both rows are persisted and scoped: each role sees exactly its own.
    const ownerList = await request(server).get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(ownerList.body.data).toHaveLength(1);
    expect(ownerList.body.data[0]).toMatchObject({ type: NOTIFICATION_TYPE.INVITATION_ACCEPTED, recipientRole: 'owner' });
    const managerList = await request(server).get('/api/v1/notifications').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(managerList.body.data).toHaveLength(1);
    expect(managerList.body.data[0]).toMatchObject({ type: NOTIFICATION_TYPE.INVITATION_ACCEPTED, recipientRole: 'manager' });
  }, 120_000);
});
