import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import {
  auditLog,
  categories,
  halls,
  idempotencyKeys,
  orders,
  orderStatusEvents,
  products,
  refreshTokens,
  salesRollupDaily,
  tableBillGroups,
  tables,
} from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OrdersModule } from './orders.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the orders module against a real, migrated SQLite database
 * (Engineering Standards §10). Covers the full Step 3.3 slice over HTTP:
 * creation (staff + public QR), bill-group auto-open (FR34), immutable
 * snapshots (FR40), the lifecycle up to Served with the Q2/Q3/Q5 role
 * rulings, idempotent retries (Q1), whole-order availability rejection (Q9),
 * kitchen price stripping (FR6/Q7), the minimal public status payload (Q8),
 * cursor pagination (Contract §1) and the FR10 cancel-reason DB backstop.
 */
describe('OrdersModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;
  let waiterToken: string;
  let kitchenToken: string;
  let waiterEmployeeId: string;

  const db = () => getDb(app);

  const loginOwnerManager = async (name: string, password: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name, password, deviceLabel: `${name} Laptop` });
    return res.body.data.accessToken as string;
  };

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
    const res = await request(app.getHttpServer())
      .post('/auth/pin-login')
      .send({ deviceRefreshToken: rawToken, employeeId, pin });
    return { token: res.body.data.accessToken as string, employeeId };
  };

  // ------------------------------------------------------------ fixtures

  const seedTable = async (overrides: Record<string, unknown> = {}) => {
    const [hall] = await db().insert(halls).values({ name: 'Main Hall' }).returning();
    const [table] = await db()
      .insert(tables)
      .values({ hallId: hall.id, label: 'Table 1', qrToken: randomBytes(32).toString('base64url'), ...overrides })
      .returning();
    return table;
  };

  const seedCategory = async (overrides: Record<string, unknown> = {}) => {
    const [category] = await db()
      .insert(categories)
      .values({ nameAr: 'مقبلات', nameFr: 'Entrées', sortOrder: 0, ...overrides })
      .returning();
    return category;
  };

  const seedProduct = async (overrides: Record<string, unknown> = {}) => {
    const [product] = await db()
      .insert(products)
      .values({
        categoryId: null,
        nameAr: 'شوربة عدس',
        nameFr: 'Soupe de lentilles',
        priceMinor: 25000,
        imagePath: null,
        sortOrder: 0,
        ...overrides,
      })
      .returning();
    return product;
  };

  const staffCreateOrder = async (token: string, tableId: string, items: unknown[], key?: string) =>
    request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key ?? randomBytes(16).toString('hex'))
      .send({ tableId, items });

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    const builder = Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, OrdersModule, IdempotencyModule],
    })
      .overrideProvider(DRIZZLE_CLIENT)
      .useValue(isolatedDb);
    app = await createTestApp(builder);

    await seedEmployee(db(), { name: 'Kamel', role: 'owner', password: 'owner-pass-1' });
    ownerToken = await loginOwnerManager('Kamel', 'owner-pass-1');
    await seedEmployee(db(), { name: 'Nadia', role: 'manager', password: 'manager-pass-1' });
    managerToken = await loginOwnerManager('Nadia', 'manager-pass-1');
    cashierToken = (await loginWithPin('Yacine', 'cashier', '1234')).token;
    const waiter = await loginWithPin('Sofia', 'waiter', '1234');
    waiterToken = waiter.token;
    waiterEmployeeId = waiter.employeeId;
    kitchenToken = (await loginWithPin('Yanis', 'kitchen', '1234')).token;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ----------------------------------------------------------- creation

  it('staff order: 201, auto-opens the bill group, flips the table, snapshots items, writes the initial event', async () => {
    const table = await seedTable();
    const category = await seedCategory();
    const product = await seedProduct({ categoryId: category.id });

    const res = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 2, notes: 'بدون بصل' }]);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.isAddon).toBe(false);
    expect(res.body.data.source).toBe('waiter_manual');
    expect(res.body.data.createdByEmployeeId).toBe(waiterEmployeeId);
    expect(res.body.data.items[0]).toMatchObject({
      name: 'شوربة عدس', // FR40 snapshot, not a live join
      category: 'مقبلات',
      unitPriceMinor: 25000,
      quantity: 2,
      notes: 'بدون بصل',
    });

    const orderId = res.body.data.id as string;
    const [group] = await db().select().from(tableBillGroups).where(eq(tableBillGroups.id, res.body.data.tableBillGroupId));
    expect(group.status).toBe('open'); // FR34 auto-open

    const [updatedTable] = await db().select().from(tables).where(eq(tables.id, table.id));
    expect(updatedTable.status).toBe('occupied'); // first order flips the table

    const events = await db().select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: 'pending', actorEmployeeId: waiterEmployeeId });

    const auditRows = await db().select().from(auditLog).where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderId)));
    expect(auditRows.map((r) => r.action)).toContain('order_created');
  });

  it('second order on the same table joins the open group as an Add-on and does not re-flip the table', async () => {
    const table = await seedTable();
    const product = await seedProduct();

    const first = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    const second = await staffCreateOrder(managerToken, table.id, [{ productId: product.id, quantity: 1 }]);

    expect(second.status).toBe(201);
    expect(second.body.data.isAddon).toBe(true);
    expect(second.body.data.tableBillGroupId).toBe(first.body.data.tableBillGroupId);
    const groups = await db().select().from(tableBillGroups).where(eq(tableBillGroups.tableId, table.id));
    expect(groups).toHaveLength(1); // still exactly one open group
  });

  it('rejects the WHOLE order with 409 PRODUCT_UNAVAILABLE when any item is unavailable — nothing persists (Q9)', async () => {
    const table = await seedTable();
    const available = await seedProduct();
    const unavailable = await seedProduct({ nameAr: 'بيتزا', nameFr: 'Pizza', isAvailable: false });

    const res = await staffCreateOrder(waiterToken, table.id, [
      { productId: available.id, quantity: 1 },
      { productId: unavailable.id, quantity: 1 },
    ]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect(res.body.error.details.unavailableProductIds).toEqual([unavailable.id]);
    // Whole-order rejection: no order, no group, the table stays available.
    expect(await db().select().from(orders).where(eq(orders.tableId, table.id))).toHaveLength(0);
    expect(await db().select().from(tableBillGroups).where(eq(tableBillGroups.tableId, table.id))).toHaveLength(0);
    const [unchanged] = await db().select().from(tables).where(eq(tables.id, table.id));
    expect(unchanged.status).toBe('available');
  });

  it('rejects products under an inactive category with the same 409', async () => {
    const table = await seedTable();
    const inactiveCategory = await seedCategory({ isActive: false });
    const product = await seedProduct({ categoryId: inactiveCategory.id });

    const res = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('rejects unknown products with 404 and unknown tables with 404', async () => {
    const table = await seedTable();
    const ghostProduct = await staffCreateOrder(waiterToken, table.id, [
      { productId: '00000000-0000-0000-0000-000000000000', quantity: 1 },
    ]);
    expect(ghostProduct.status).toBe(404);
    expect(ghostProduct.body.error.code).toBe('NOT_FOUND');

    const product = await seedProduct();
    const ghostTable = await staffCreateOrder(waiterToken, '00000000-0000-0000-0000-000000000000', [
      { productId: product.id, quantity: 1 },
    ]);
    expect(ghostTable.status).toBe(404);
  });

  it.each([
    ['kitchen', () => kitchenToken],
    ['cashier', () => cashierToken],
  ])('refuses staff order creation to %s (Q6 baseline: Owner/Manager/Waiter)', async (_role, token) => {
    const table = await seedTable();
    const product = await seedProduct();
    const res = await staffCreateOrder(token(), table.id, [{ productId: product.id, quantity: 1 }]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
  });

  // ---------------------------------------------------------- idempotency

  it('replaying the same key+body returns HTTP 200 with the ORIGINAL body and creates exactly ONE order (Q1)', async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const key = 'retry-key-' + randomBytes(8).toString('hex');
    const payload = { tableId: table.id, items: [{ productId: product.id, quantity: 1 }] };

    const first = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key)
      .send(payload);
    const replay = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200); // Contract §2 distinct response path
    expect(replay.body).toEqual(first.body);
    expect(await db().select().from(orders).where(eq(orders.tableId, table.id))).toHaveLength(1);
    // Exactly one memo row for THIS key (the suite's DB is shared across tests).
    expect(await db().select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).toHaveLength(1);
  });

  it('two CONCURRENT submissions with the same key produce exactly one order (NFR3 + Q1)', async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const key = 'race-key-' + randomBytes(8).toString('hex');
    const payload = { tableId: table.id, items: [{ productId: product.id, quantity: 1 }] };
    const fire = () =>
      request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${waiterToken}`)
        .set('Idempotency-Key', key)
        .send(payload);

    const [a, b] = await Promise.all([fire(), fire()]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(await db().select().from(orders).where(eq(orders.tableId, table.id))).toHaveLength(1);
  });

  it('requires the Idempotency-Key header (400) and rejects key reuse with a different body (409)', async () => {
    const table = await seedTable();
    const product = await seedProduct();

    const missing = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({ tableId: table.id, items: [{ productId: product.id, quantity: 1 }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = 'conflict-key-' + randomBytes(8).toString('hex');
    await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }], key);
    const conflict = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 99 }], key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('the add-on endpoint enforces the same idempotency contract', async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const parent = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    const key = 'addon-key-' + randomBytes(8).toString('hex');
    const fire = () =>
      request(app.getHttpServer())
        .post(`/orders/${parent.body.data.id}/addon`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: product.id, quantity: 3 }] });

    const first = await fire();
    const replay = await fire();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(
      (await db().select().from(orders).where(eq(orders.tableBillGroupId, first.body.data.tableBillGroupId))).length,
    ).toBe(2); // parent + exactly one add-on
  });

  // --------------------------------------------------------- public channel

  it('public QR order: unauthenticated 201, source qr, null employee, source IP audited (Security §7)', async () => {
    const table = await seedTable();
    const product = await seedProduct();

    const res = await request(app.getHttpServer())
      .post('/public/orders')
      .set('Idempotency-Key', 'pub-' + randomBytes(8).toString('hex'))
      .send({ qrToken: table.qrToken, items: [{ productId: product.id, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.source).toBe('qr');
    expect(res.body.data.createdByEmployeeId).toBeNull();

    const auditRows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, res.body.data.id)));
    expect(auditRows[0].action).toBe('public_order_submitted');
    expect(auditRows[0].actorEmployeeId).toBeNull();
    expect(JSON.parse(auditRows[0].newValueJson!).sourceIp).toBeTruthy();
  });

  it('public channel: unknown and deactivated tokens get the identical 404 (no oracle)', async () => {
    const product = await seedProduct();
    const deactivated = await seedTable({ isActive: false });

    const unknown = await request(app.getHttpServer())
      .post('/public/orders')
      .set('Idempotency-Key', 'pub-' + randomBytes(8).toString('hex'))
      .send({ qrToken: randomBytes(32).toString('base64url'), items: [{ productId: product.id, quantity: 1 }] });
    const inactive = await request(app.getHttpServer())
      .post('/public/orders')
      .set('Idempotency-Key', 'pub-' + randomBytes(8).toString('hex'))
      .send({ qrToken: deactivated.qrToken, items: [{ productId: product.id, quantity: 1 }] });

    expect(unknown.status).toBe(404);
    expect(inactive.status).toBe(404);
    // No oracle: the response shape reveals NOTHING about whether the token
    // was ever issued — same code, same message form, same fields; the only
    // difference is the token the caller itself supplied.
    for (const body of [unknown.body, inactive.body]) {
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toMatch(/^table .+ does not exist\.$/);
      expect(body.error.details.entityType).toBe('table');
      expect(Object.keys(body.error.details).sort()).toEqual(['entityId', 'entityType']);
    }
  });

  it('public status read returns exactly { id, status } (Q8) and 404s unknown ids', async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const created = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);

    const res = await request(app.getHttpServer()).get(`/public/orders/${created.body.data.id}/status`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['id', 'status']);
    expect(res.body.data).toEqual({ id: created.body.data.id, status: 'pending' });

    const ghost = await request(app.getHttpServer()).get('/public/orders/00000000-0000-0000-0000-000000000000/status');
    expect(ghost.status).toBe(404);
  });

  // ----------------------------------------------------------- lifecycle

  const createPendingOrder = async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const res = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    return res.body.data.id as string;
  };

  it('accept: kitchen can, waiter CANNOT (Q2); writes event + audit; second accept 409s', async () => {
    const orderId = await createPendingOrder();

    const waiterAttempt = await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${waiterToken}`);
    expect(waiterAttempt.status).toBe(403); // Q2 — Waiter refused by the baseline guard

    const accepted = await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.status).toBe('accepted');
    expect(accepted.body.data.acceptedByEmployeeId).toBeTruthy();

    const events = await db().select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId));
    expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual(['null->pending', 'pending->accepted']);

    const auditRows = await db().select().from(auditLog).where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderId)));
    expect(auditRows.map((r) => r.action)).toContain('order_accepted');

    const duplicate = await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('INVALID_ORDER_TRANSITION');
  });

  it('advance: accepted→preparing→ready only (Q5); 409 from pending/ready; waiter refused', async () => {
    const orderId = await createPendingOrder();

    const tooEarly = await request(app.getHttpServer())
      .post(`/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(tooEarly.status).toBe(409);

    await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${managerToken}`);

    const waiterAdvance = await request(app.getHttpServer())
      .post(`/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${waiterToken}`);
    expect(waiterAdvance.status).toBe(403);

    const preparing = await request(app.getHttpServer())
      .post(`/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(preparing.body.data.status).toBe('preparing');

    const ready = await request(app.getHttpServer())
      .post(`/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(ready.body.data.status).toBe('ready');

    const beyond = await request(app.getHttpServer())
      .post(`/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(beyond.status).toBe(409); // ready → served is the serve endpoint's job
  });

  it('serve: waiter can serve a ready order; kitchen cannot (FR7)', async () => {
    const orderId = await createPendingOrder();
    await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
    const early = await request(app.getHttpServer())
      .post(`/orders/${orderId}/serve`)
      .set('Authorization', `Bearer ${waiterToken}`);
    expect(early.status).toBe(409); // not ready yet

    await request(app.getHttpServer()).post(`/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);
    await request(app.getHttpServer()).post(`/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);

    const kitchenServe = await request(app.getHttpServer())
      .post(`/orders/${orderId}/serve`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(kitchenServe.status).toBe(403);

    const served = await request(app.getHttpServer())
      .post(`/orders/${orderId}/serve`)
      .set('Authorization', `Bearer ${waiterToken}`);
    expect(served.status).toBe(201);
    expect(served.body.data.status).toBe('served');
    expect(served.body.data.servedByEmployeeId).toBe(waiterEmployeeId);
  });

  it('cancel: waiter pending-only (Q3); owner unrestricted; reason mandatory (FR10) with DB CHECK backstop', async () => {
    // Waiter cancels a pending order — allowed.
    const pendingOrder = await createPendingOrder();
    const noReason = await request(app.getHttpServer())
      .post(`/orders/${pendingOrder}/cancel`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({});
    expect(noReason.status).toBe(400); // FR10 at the DTO layer

    const cancelled = await request(app.getHttpServer())
      .post(`/orders/${pendingOrder}/cancel`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({ reason: 'الزبون غيّر رأيه' });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancellationReason).toBe('الزبون غيّر رأيه');
    expect(cancelled.body.data.cancelledByEmployeeId).toBe(waiterEmployeeId);

    const auditRows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, pendingOrder)));
    expect(auditRows.map((r) => r.action)).toContain('order_cancelled');

    // Waiter cannot cancel once accepted (Q3).
    const acceptedOrder = await createPendingOrder();
    await request(app.getHttpServer()).post(`/orders/${acceptedOrder}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
    const waiterLateCancel = await request(app.getHttpServer())
      .post(`/orders/${acceptedOrder}/cancel`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({ reason: 'mistake' });
    expect(waiterLateCancel.status).toBe(403);

    // Owner can cancel even a ready order (unrestricted).
    await request(app.getHttpServer()).post(`/orders/${acceptedOrder}/advance`).set('Authorization', `Bearer ${kitchenToken}`);
    const ownerCancel = await request(app.getHttpServer())
      .post(`/orders/${acceptedOrder}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'owner discretion' });
    expect(ownerCancel.status).toBe(201);

    // Double cancel → 409.
    const again = await request(app.getHttpServer())
      .post(`/orders/${acceptedOrder}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'again' });
    expect(again.status).toBe(409);

    // The DB CHECK is the final FR10 backstop — a reason-less cancellation
    // cannot exist no matter what code path attempts it.
    const raw = (db() as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).$client;
    expect(() =>
      raw.prepare(`UPDATE orders SET status = 'cancelled', cancellation_reason = NULL WHERE id = ?`).run(pendingOrder),
    ).toThrow(/CHECK constraint failed: chk_orders_cancellation_reason/);
  });

  it('D5: a cancellation increments the daily cancelled_orders rollup atomically with the transition', async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const [before] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, today));

    const orderId = await createPendingOrder();
    const cancelled = await request(app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'D5 counter check' });
    expect(cancelled.status).toBe(201);

    const [after] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, today));
    expect(after.cancelledOrders).toBe((before?.cancelledOrders ?? 0) + 1);
    // A cancellation carries no revenue and does not count as a completed order.
    expect(after.totalRevenueMinor).toBe(before?.totalRevenueMinor ?? 0);
    expect(after.totalOrders).toBe(before?.totalOrders ?? 0);
  });

  it('D8: tables in bill_requested or needs_cleaning accept no new orders (409 INVALID_TABLE_STATUS_TRANSITION)', async () => {
    const product = await seedProduct();
    for (const status of ['bill_requested', 'needs_cleaning']) {
      const table = await seedTable({ status });
      const res = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TABLE_STATUS_TRANSITION');
      expect(res.body.error.details).toMatchObject({ fromStatus: status, attemptedAction: 'create-order' });
      // Nothing persists: no order, no bill group, table status untouched.
      expect(await db().select().from(orders).where(eq(orders.tableId, table.id))).toHaveLength(0);
      expect(await db().select().from(tableBillGroups).where(eq(tableBillGroups.tableId, table.id))).toHaveLength(0);
    }
  });

  it('cashier and kitchen cannot cancel at all (baseline)', async () => {
    const orderId = await createPendingOrder();
    for (const token of [cashierToken, kitchenToken]) {
      const res = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'not allowed' });
      expect(res.status).toBe(403);
    }
  });

  // ------------------------------------------------------------------ addon

  it('add-on after lock: same bill group, is_addon, parent cancelled → 409', async () => {
    const table = await seedTable();
    const product = await seedProduct();
    const parent = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    const parentId = parent.body.data.id as string;
    await request(app.getHttpServer()).post(`/orders/${parentId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
    await request(app.getHttpServer()).post(`/orders/${parentId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);

    // Parent is now preparing — locked (FR5). Items arrive only as an add-on.
    const addon = await request(app.getHttpServer())
      .post(`/orders/${parentId}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', 'addon-' + randomBytes(8).toString('hex'))
      .send({ items: [{ productId: product.id, quantity: 2 }] });

    expect(addon.status).toBe(201);
    expect(addon.body.data.isAddon).toBe(true);
    expect(addon.body.data.tableBillGroupId).toBe(parent.body.data.tableBillGroupId);
    expect(addon.body.data.status).toBe('pending');

    const cancelled = await request(app.getHttpServer())
      .post(`/orders/${parentId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'closing out' });
    expect(cancelled.status).toBe(201);
    const orphanAddon = await request(app.getHttpServer())
      .post(`/orders/${parentId}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', 'addon-' + randomBytes(8).toString('hex'))
      .send({ items: [{ productId: product.id, quantity: 1 }] });
    expect(orphanAddon.status).toBe(409);
  });

  // ------------------------------------------------------------------ reads

  it('GET /orders paginates by cursor (Contract §1) and filters by status/tableId/channel', async () => {
    const table = await seedTable();
    const otherTable = await seedTable();
    const product = await seedProduct();
    for (let i = 0; i < 3; i++) {
      await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    }
    await staffCreateOrder(waiterToken, otherTable.id, [{ productId: product.id, quantity: 1 }]);

    const page1 = await request(app.getHttpServer())
      .get('/orders?limit=2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const page2 = await request(app.getHttpServer())
      .get(`/orders?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(page2.body.data.length).toBeGreaterThanOrEqual(2); // earlier tests' orders share this DB
    const page1Ids = new Set(page1.body.data.map((o: { id: string }) => o.id));
    for (const row of page2.body.data) expect(page1Ids.has(row.id)).toBe(false); // keyset: no overlap

    const filtered = await request(app.getHttpServer())
      .get(`/orders?tableId=${table.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(filtered.body.data).toHaveLength(3);

    const byStatus = await request(app.getHttpServer())
      .get('/orders?status=pending')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(byStatus.body.data.every((o: { status: string }) => o.status === 'pending')).toBe(true);

    const byChannel = await request(app.getHttpServer())
      .get('/orders?channel=delivery')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(byChannel.body.data).toHaveLength(0); // v1 activates dine_in only (FR39)

    const badCursor = await request(app.getHttpServer())
      .get('/orders?cursor=%%%')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(badCursor.status).toBe(400);
  });

  it('GET /orders/:id strips pricing for Kitchen viewers only (FR6/Q7)', async () => {
    const orderId = await createPendingOrder();

    const kitchenView = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${kitchenToken}`);
    expect(kitchenView.status).toBe(200);
    expect(kitchenView.body.data.items[0].unitPriceMinor).toBeUndefined();
    expect(kitchenView.body.data.items[0].name).toBe('شوربة عدس');

    const ownerView = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerView.body.data.items[0].unitPriceMinor).toBe(25000);

    const unauthenticated = await request(app.getHttpServer()).get(`/orders/${orderId}`);
    expect(unauthenticated.status).toBe(401);
  });

  it('emits order.created and order.status_changed only after commit (Contract §4)', async () => {
    const events = app.get(DomainEventsService);
    const received: Array<{ event: string; payload: unknown }> = [];
    events.on(DOMAIN_EVENT.ORDER_CREATED, (payload) => received.push({ event: DOMAIN_EVENT.ORDER_CREATED, payload }));
    events.on(DOMAIN_EVENT.ORDER_STATUS_CHANGED, (payload) =>
      received.push({ event: DOMAIN_EVENT.ORDER_STATUS_CHANGED, payload }),
    );
    events.on(DOMAIN_EVENT.TABLE_STATUS_CHANGED, (payload) =>
      received.push({ event: DOMAIN_EVENT.TABLE_STATUS_CHANGED, payload }),
    );

    const table = await seedTable();
    const product = await seedProduct();
    const created = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
    const orderId = created.body.data.id as string;
    await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);

    const names = received.map((r) => r.event);
    expect(names).toContain(DOMAIN_EVENT.ORDER_CREATED);
    expect(names).toContain(DOMAIN_EVENT.ORDER_STATUS_CHANGED);
    expect(names).toContain(DOMAIN_EVENT.TABLE_STATUS_CHANGED); // available → occupied
    const statusPayload = received.find((r) => r.event === DOMAIN_EVENT.ORDER_STATUS_CHANGED)!.payload as {
      orderId: string;
      fromStatus: string;
      toStatus: string;
    };
    expect(statusPayload).toEqual({ orderId, fromStatus: 'pending', toStatus: 'accepted' });
  });
});
