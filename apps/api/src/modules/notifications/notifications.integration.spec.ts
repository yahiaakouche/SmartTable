import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { EmployeeRole, NOTIFICATION_TYPE, OrderStatus } from '@smarttable/shared-types';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { halls, notifications, orders, refreshTokens, tableBillGroups, tables } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsModule } from './notifications.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the notifications module against a real, migrated SQLite
 * database (Engineering Standards §10) — the whole Step 3.6 slice over HTTP
 * and over the real bus:
 *  - creation side-effect: bus event → listener → row → REST visibility
 *    (B5(a)), with the frozen recipient map (B3) and ready-only filter (B2),
 *  - read surface: recipient scoping (B4(a)/D5), mark-read authorization
 *    and idempotency (D6/D7), unreadOnly, cursor pagination (D8), DTO
 *    validation, and the auth guard on both routes.
 */
describe('NotificationsModule (integration)', () => {
  let app: INestApplication;
  let events: DomainEventsService;

  const db = () => getDb(app);
  const authed = () => request(app.getHttpServer());
  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, OrdersModule, NotificationsModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
    events = app.get(DomainEventsService);
  });

  afterEach(async () => {
    await app.close();
  });

  const loginWithPin = async (name: string, role: string, pin = '1234') => {
    const employeeId = await seedEmployee(db(), { name, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: `${name} Terminal`,
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await authed().post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
    return { token: res.body.data.accessToken as string, employeeId };
  };

  const listNotifications = (token: string, query = '') =>
    authed().get(`/notifications${query}`).set('Authorization', `Bearer ${token}`);

  const seedOrder = async () => {
    const [hall] = await db().insert(halls).values({ name: 'Main Hall' }).returning();
    const [table] = await db()
      .insert(tables)
      .values({ hallId: hall.id, label: 'Table 7', qrToken: randomBytes(32).toString('base64url') })
      .returning();
    const [group] = await db().insert(tableBillGroups).values({ tableId: table.id }).returning();
    const [order] = await db()
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, source: 'qr', status: 'preparing' })
      .returning();
    return { table, order };
  };

  // ----------------------------------------------------------- creation

  it('order.created on the bus becomes a kitchen-only notification, visible via REST (B3/B5(a))', async () => {
    const kitchen = await loginWithPin('Yanis', 'kitchen');
    const waiter = await loginWithPin('Sofia', 'waiter');

    const emitted = new Promise<Record<string, unknown>>((resolve) => {
      const unsubscribe = events.on(DOMAIN_EVENT.NOTIFICATION_CREATED, (payload) => {
        unsubscribe();
        resolve(payload as Record<string, unknown>);
      });
    });
    events.emitOrderCreated({ id: 'order-1', tableId: 'table-1', items: [{ unitPriceMinor: 25000 }] });
    const body = await emitted;
    await settle();

    // The socket body IS the stored row's DTO (D9) — money-free (D2/FR6).
    expect(body).toMatchObject({
      type: NOTIFICATION_TYPE.ORDER_CREATED,
      recipientRole: EmployeeRole.KITCHEN,
      recipientEmployeeId: null,
      payload: { orderId: 'order-1', tableId: 'table-1' },
      readAt: null,
    });
    expect(JSON.stringify(body)).not.toContain('unitPriceMinor');

    const kitchenList = await listNotifications(kitchen.token).expect(200);
    expect(kitchenList.body.data).toHaveLength(1);
    expect(kitchenList.body.data[0]).toMatchObject({ type: NOTIFICATION_TYPE.ORDER_CREATED, payload: { orderId: 'order-1', tableId: 'table-1' } });

    const waiterList = await listNotifications(waiter.token).expect(200);
    expect(waiterList.body.data).toEqual([]);
  });

  it('ignores non-ready transitions and notifies waiters only on entry into ready (B2/B3)', async () => {
    const waiter = await loginWithPin('Sofia', 'waiter');
    const kitchen = await loginWithPin('Yanis', 'kitchen');
    const { table, order } = await seedOrder();

    events.emitOrderStatusChanged({ orderId: order.id, fromStatus: 'pending', toStatus: OrderStatus.ACCEPTED });
    events.emitOrderStatusChanged({ orderId: order.id, fromStatus: 'accepted', toStatus: OrderStatus.PREPARING });
    await settle();
    expect((await listNotifications(waiter.token)).body.data).toEqual([]);

    events.emitOrderStatusChanged({ orderId: order.id, fromStatus: 'preparing', toStatus: OrderStatus.READY });
    await settle();

    const waiterList = await listNotifications(waiter.token).expect(200);
    expect(waiterList.body.data).toHaveLength(1);
    expect(waiterList.body.data[0]).toMatchObject({
      type: NOTIFICATION_TYPE.ORDER_READY,
      recipientRole: EmployeeRole.WAITER,
      payload: { orderId: order.id, tableId: table.id },
    });
    expect((await listNotifications(kitchen.token)).body.data).toEqual([]);
  });

  it('invitation.accepted fans out to owner AND manager, one row each (B3/B4(a))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const manager = await loginWithPin('Amina', 'manager');
    const waiter = await loginWithPin('Sofia', 'waiter');

    events.emitInvitationAccepted({ invitationId: 'inv-1', employeeId: 'emp-new' });
    await settle();

    for (const login of [owner, manager]) {
      const list = await listNotifications(login.token).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        type: NOTIFICATION_TYPE.INVITATION_ACCEPTED,
        payload: { invitationId: 'inv-1', employeeId: 'emp-new' },
      });
    }
    // Two distinct persisted rows — one per role (B4(a)).
    const rows = await db().select().from(notifications);
    expect(rows.map((r) => r.recipientRole).sort()).toEqual([EmployeeRole.MANAGER, EmployeeRole.OWNER]);
    expect((await listNotifications(waiter.token)).body.data).toEqual([]);
  });

  // ---------------------------------------------------------- read surface

  it('marks read with shared role state, idempotently, and filters unreadOnly (B4(a)/D7)', async () => {
    const kitchen = await loginWithPin('Yanis', 'kitchen');
    events.emitOrderCreated({ id: 'order-1', tableId: 'table-1' });
    await settle();

    const before = await listNotifications(kitchen.token, '?unreadOnly=true').expect(200);
    expect(before.body.data).toHaveLength(1);
    const id = before.body.data[0].id as string;

    const marked = await authed().post(`/notifications/${id}/read`).set('Authorization', `Bearer ${kitchen.token}`).expect(201);
    expect(marked.body.data.readAt).toEqual(expect.any(Number));

    expect((await listNotifications(kitchen.token, '?unreadOnly=true')).body.data).toEqual([]);
    expect((await listNotifications(kitchen.token)).body.data).toHaveLength(1);

    // D7: a repeat mark returns 200 with the SAME first-read timestamp.
    const again = await authed().post(`/notifications/${id}/read`).set('Authorization', `Bearer ${kitchen.token}`).expect(201);
    expect(again.body.data.readAt).toBe(marked.body.data.readAt);
  });

  it('enforces mark-read authorization: 403 cross-role, 404 unknown (D6)', async () => {
    const kitchen = await loginWithPin('Yanis', 'kitchen');
    const waiter = await loginWithPin('Sofia', 'waiter');
    events.emitOrderCreated({ id: 'order-1', tableId: 'table-1' });
    await settle();

    const kitchenList = await listNotifications(kitchen.token);
    const id = kitchenList.body.data[0].id as string;

    const denied = await authed().post(`/notifications/${id}/read`).set('Authorization', `Bearer ${waiter.token}`).expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSION');

    const missing = await authed()
      .post(`/notifications/${crypto.randomUUID()}/read`)
      .set('Authorization', `Bearer ${kitchen.token}`)
      .expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('paginates by cursor, newest first (D8)', async () => {
    const waiter = await loginWithPin('Sofia', 'waiter');
    for (let i = 1; i <= 3; i++) {
      await db()
        .insert(notifications)
        .values({ recipientRole: 'waiter', type: NOTIFICATION_TYPE.ORDER_READY, payloadJson: JSON.stringify({ orderId: `o${i}`, tableId: 't1' }) });
      await new Promise((r) => setTimeout(r, 5)); // distinct created_at
    }

    const page1 = await listNotifications(waiter.token, '?limit=2').expect(200);
    expect(page1.body.data.map((n: Record<string, unknown>) => (n['payload'] as Record<string, unknown>)['orderId'])).toEqual(['o3', 'o2']);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const page2 = await listNotifications(waiter.token, `?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`).expect(200);
    expect(page2.body.data.map((n: Record<string, unknown>) => (n['payload'] as Record<string, unknown>)['orderId'])).toEqual(['o1']);
    expect(page2.body.meta.nextCursor).toBeNull();
  });

  it('validates the query DTO: malformed cursor and bad limit are 400', async () => {
    const waiter = await loginWithPin('Sofia', 'waiter');
    const bad1 = await listNotifications(waiter.token, '?cursor=garbage').expect(400);
    expect(bad1.body.error.code).toBe('VALIDATION_FAILED');
    await listNotifications(waiter.token, '?limit=0').expect(400);
    await listNotifications(waiter.token, '?limit=101').expect(400);
  });

  it('requires authentication on both routes', async () => {
    await authed().get('/notifications').expect(401);
    await authed().post(`/notifications/${crypto.randomUUID()}/read`).expect(401);
  });
});
