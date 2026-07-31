import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { io, Socket } from 'socket.io-client';
import { EmployeeRole, STAFF_EVENT } from '@smarttable/shared-types';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { employees } from '../../database/schema';
import { refreshTokens } from '../../database/schema';
import { EventsModule } from '../events/events.module';
import { DomainEventsService } from '../events/domain-events.service';
import { AuditModule } from '../../modules/audit/audit.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { HealthModule } from '../../modules/health/health.module';
import { HealthRegistryService } from '../../modules/health/health-registry.service';
import { TokensService } from '../../modules/auth/tokens.service';
import { RealtimeModule } from './realtime.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the staff Socket.IO bridge over REAL sockets against a real,
 * migrated database (Engineering Standards §10) — the one place handshake
 * auth (D2), room membership (B2), event routing (§4/B3), FR6/Q7 wire-level
 * price stripping (D5), notification pre-wiring (D9), presence transitions
 * (B1) and the health check (D10) are verified end to end. Domain events
 * are emitted straight onto the internal bus; the modules that emit them in
 * production are already covered by their own suites.
 */
describe('StaffRealtimeGateway (integration)', () => {
  let app: INestApplication;
  let port: number;
  let events: DomainEventsService;
  const sockets: Socket[] = [];

  const tokens: Partial<Record<EmployeeRole, string>> = {};
  const employeeIds: Partial<Record<EmployeeRole, string>> = {};

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
    return { token: res.body.data.accessToken as string, employeeId };
  };

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    const builder = Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, HealthModule, RealtimeModule],
    })
      .overrideProvider(DRIZZLE_CLIENT)
      .useValue(isolatedDb);
    app = await createTestApp(builder);
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;
    events = app.get(DomainEventsService);

    for (const [name, role] of [
      ['Yanis', EmployeeRole.KITCHEN],
      ['Sofia', EmployeeRole.WAITER],
      ['Yacine', EmployeeRole.CASHIER],
      ['Amine', EmployeeRole.OWNER],
      ['Lina', EmployeeRole.MANAGER],
    ] as const) {
      const { token, employeeId } = await loginWithPin(name, role, '1234');
      tokens[role] = token;
      employeeIds[role] = employeeId;
    }
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await app?.close();
  });

  // ------------------------------------------------------------- helpers

  const connectStaff = (token?: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  /** Server-side room join happens after the protocol connect (async JWT
   * verification) — give the handshake a moment to settle before emitting. */
  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  /** A rejected handshake disconnects within the same event-loop turn as the
   * protocol connect — the disconnect listener must be attached from t=0,
   * never awaited after 'connect' (the event would already be gone). */
  const expectRejected = async (token?: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
      });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('socket was NOT rejected — still connected')), 3_000);
      socket.on('disconnect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', reject);
    });
  };

  const nextEvent = <T = unknown>(socket: Socket, event: string, timeoutMs = 4_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const collectFor = async (socket: Socket, event: string, ms = 400): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const handler = (payload: unknown) => seen.push(payload);
    socket.on(event, handler);
    await new Promise((r) => setTimeout(r, ms));
    socket.off(event, handler);
    return seen;
  };

  const orderPayload = {
    id: 'order-rt-1',
    tableBillGroupId: 'group-1',
    tableId: 'table-1',
    channel: 'dine_in',
    isAddon: false,
    status: 'pending',
    source: 'qr',
    items: [{ id: 'item-1', productId: 'p1', name: 'شوربة', category: 'مقبلات', unitPriceMinor: 2500, quantity: 2, notes: null }],
    createdByEmployeeId: null,
    acceptedByEmployeeId: null,
    servedByEmployeeId: null,
    cancelledByEmployeeId: null,
    cancellationReason: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  // --------------------------------------------------------------- tests

  describe('handshake authentication (D2)', () => {
    it('rejects a connection without a token', async () => {
      await expectRejected();
    });

    it('rejects a connection with a garbage token', async () => {
      await expectRejected('not-a-jwt');
    });

    it('rejects a connection whose employee was deactivated after token issuance', async () => {
      const { token, employeeId } = await loginWithPin('Karim', 'waiter', '1234');
      await db().update(employees).set({ isActive: false }).where(eq(employees.id, employeeId));
      await expectRejected(token);
    });

    it('accepts a connection with a valid acting-employee JWT', async () => {
      const socket = await connectStaff(tokens[EmployeeRole.WAITER]);
      expect(socket.connected).toBe(true);
    });
  });

  describe('event routing and FR6/Q7 shaping (Contract §4, B2, B3, D5)', () => {
    it('order.created → kitchen receives items WITHOUT pricing; waiter receives the full DTO', async () => {
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      await settle();
      const kitchenEvent = nextEvent<typeof orderPayload>(kitchen, STAFF_EVENT.ORDER_CREATED);
      const waiterEvent = nextEvent<typeof orderPayload>(waiter, STAFF_EVENT.ORDER_CREATED);
      events.emitOrderCreated({ ...orderPayload });
      const kitchenPayload = await kitchenEvent;
      const waiterPayload = await waiterEvent;
      expect(kitchenPayload.items[0]).not.toHaveProperty('unitPriceMinor');
      expect(kitchenPayload.items[0]).toMatchObject({ name: 'شوربة', quantity: 2 });
      expect(waiterPayload.items[0].unitPriceMinor).toBe(2500);
    });

    it('order.created does NOT reach owner-room or cashier', async () => {
      const owner = await connectStaff(tokens[EmployeeRole.OWNER]);
      const cashier = await connectStaff(tokens[EmployeeRole.CASHIER]);
      await settle();
      const ownerSeen = collectFor(owner, STAFF_EVENT.ORDER_CREATED);
      const cashierSeen = collectFor(cashier, STAFF_EVENT.ORDER_CREATED);
      events.emitOrderCreated({ ...orderPayload });
      expect(await ownerSeen).toEqual([]);
      expect(await cashierSeen).toEqual([]);
    });

    it('order.accepted → kitchen (stripped), waiter, owner AND manager (owner-room, B2) receive it', async () => {
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      const owner = await connectStaff(tokens[EmployeeRole.OWNER]);
      const manager = await connectStaff(tokens[EmployeeRole.MANAGER]);
      await settle();
      const kitchenEvent = nextEvent<typeof orderPayload>(kitchen, STAFF_EVENT.ORDER_ACCEPTED);
      const ownerEvent = nextEvent(owner, STAFF_EVENT.ORDER_ACCEPTED);
      const managerEvent = nextEvent(manager, STAFF_EVENT.ORDER_ACCEPTED);
      events.emitOrderAccepted({ ...orderPayload });
      const kitchenPayload = await kitchenEvent;
      expect(kitchenPayload.items[0]).not.toHaveProperty('unitPriceMinor');
      await ownerEvent;
      await managerEvent;
    });

    it('order.status_changed reaches kitchen, waiter, cashier, owner-room (B3) with the §4 payload', async () => {
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      const cashier = await connectStaff(tokens[EmployeeRole.CASHIER]);
      const manager = await connectStaff(tokens[EmployeeRole.MANAGER]);
      await settle();
      const payload = { orderId: 'order-rt-1', fromStatus: 'served', toStatus: 'paid' };
      const all = [kitchen, waiter, cashier, manager].map((s) => nextEvent(s, STAFF_EVENT.ORDER_STATUS_CHANGED));
      events.emitOrderStatusChanged(payload);
      for (const received of await Promise.all(all)) {
        expect(received).toEqual(payload);
      }
    });

    it('table.status_changed reaches waiter/cashier/owner-room but NOT the kitchen (D12 passthrough)', async () => {
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      const cashier = await connectStaff(tokens[EmployeeRole.CASHIER]);
      await settle();
      const cashierEvent = nextEvent(cashier, STAFF_EVENT.TABLE_STATUS_CHANGED);
      const kitchenSeen = collectFor(kitchen, STAFF_EVENT.TABLE_STATUS_CHANGED);
      const payload = { tableId: 'table-1', fromStatus: 'occupied', toStatus: 'needs_cleaning' };
      events.emitTableStatusChanged(payload);
      expect(await cashierEvent).toEqual(payload);
      expect(await kitchenSeen).toEqual([]);
    });

    it('product.availability_changed reaches EVERY staff role (restaurant-broadcast)', async () => {
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      const cashier = await connectStaff(tokens[EmployeeRole.CASHIER]);
      await settle();
      const all = [kitchen, waiter, cashier].map((s) => nextEvent(s, STAFF_EVENT.PRODUCT_AVAILABILITY_CHANGED));
      const payload = { productId: 'p1', isAvailable: false };
      events.emitProductAvailabilityChanged(payload);
      for (const received of await Promise.all(all)) {
        expect(received).toEqual(payload);
      }
    });

    it('invitation.accepted reaches owner-room (Owner AND Manager) and no one else', async () => {
      const owner = await connectStaff(tokens[EmployeeRole.OWNER]);
      const manager = await connectStaff(tokens[EmployeeRole.MANAGER]);
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      await settle();
      const ownerEvent = nextEvent(owner, STAFF_EVENT.INVITATION_ACCEPTED);
      const managerEvent = nextEvent(manager, STAFF_EVENT.INVITATION_ACCEPTED);
      const waiterSeen = collectFor(waiter, STAFF_EVENT.INVITATION_ACCEPTED);
      const payload = { invitationId: 'inv-1', employeeId: 'emp-new' };
      events.emitInvitationAccepted(payload);
      expect(await ownerEvent).toEqual(payload);
      expect(await managerEvent).toEqual(payload);
      expect(await waiterSeen).toEqual([]);
    });

    it('notification.created (D9 pre-wiring) routes to the targeted role room only', async () => {
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      const kitchen = await connectStaff(tokens[EmployeeRole.KITCHEN]);
      await settle();
      const waiterEvent = nextEvent(waiter, STAFF_EVENT.NOTIFICATION_CREATED);
      const kitchenSeen = collectFor(kitchen, STAFF_EVENT.NOTIFICATION_CREATED);
      const payload = { recipientRole: 'waiter', recipientEmployeeId: null, type: 'order_ready', orderId: 'order-rt-1' };
      events.emitNotificationCreated(payload);
      expect(await waiterEvent).toEqual(payload);
      expect(await kitchenSeen).toEqual([]);
    });

    it('notification.created routes to a targeted employee across roles', async () => {
      const waiter = await connectStaff(tokens[EmployeeRole.WAITER]);
      const cashier = await connectStaff(tokens[EmployeeRole.CASHIER]);
      await settle();
      const waiterEvent = nextEvent(waiter, STAFF_EVENT.NOTIFICATION_CREATED);
      const cashierSeen = collectFor(cashier, STAFF_EVENT.NOTIFICATION_CREATED);
      const payload = { recipientRole: null, recipientEmployeeId: employeeIds[EmployeeRole.WAITER]!, type: 'note' };
      events.emitNotificationCreated(payload);
      expect(await waiterEvent).toEqual(payload);
      expect(await cashierSeen).toEqual([]);
    });
  });

  describe('presence (B1 ruling: gateway-originated, owner-room only)', () => {
    it('emits online on first socket and offline on last socket — never per-socket noise', async () => {
      const observer = await connectStaff(tokens[EmployeeRole.OWNER]);
      const outsider = await connectStaff(tokens[EmployeeRole.WAITER]);
      await settle();

      // A brand-new employee guarantees zero pre-existing sockets for them.
      const { token: mouradToken, employeeId: mouradId } = await loginWithPin('Mourad', 'kitchen', '1234');

      // First socket → online, to owner-room only.
      const onlineEvent = nextEvent<{ employeeId: string; online: boolean }>(observer, STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED);
      const outsiderSeen = collectFor(outsider, STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED);
      const firstSocket = await connectStaff(mouradToken);
      expect(await onlineEvent).toEqual({ employeeId: mouradId, online: true });
      expect(await outsiderSeen).toEqual([]);

      // A second socket for the SAME employee: no new event.
      const noEvent = collectFor(observer, STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED);
      const secondSocket = await connectStaff(mouradToken);
      await settle();
      expect(await noEvent).toEqual([]);

      // Dropping one of two sockets: still online, no event.
      const stillNoEvent = collectFor(observer, STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED);
      secondSocket.disconnect();
      await settle();
      expect(await stillNoEvent).toEqual([]);

      // Last socket drops → offline for that employee.
      const offlineEvent = nextEvent<{ employeeId: string; online: boolean }>(observer, STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED);
      firstSocket.disconnect();
      expect(await offlineEvent).toEqual({ employeeId: mouradId, online: false });
    });
  });

  describe('health check (D10, Monitoring §4)', () => {
    it('reports the realtime channel healthy with live connection detail', async () => {
      const registry = app.get(HealthRegistryService);
      const health = await registry.getAggregateHealth();
      expect(health.checks['realtime'].status).toBe('healthy');
      expect(health.checks['realtime'].detail).toMatch(/connection\(s\) online/);
    });
  });
});
