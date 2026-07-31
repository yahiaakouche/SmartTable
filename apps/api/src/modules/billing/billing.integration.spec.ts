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
  orders,
  orderStatusEvents,
  payments,
  productSalesRollup,
  products,
  refreshTokens,
  restaurantProfile,
  salesRollupDaily,
  salesRollupHourly,
  shifts,
  tableBillGroups,
  tables,
} from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OrdersModule } from '../orders/orders.module';
import { BillingModule } from './billing.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the billing module against a real, migrated SQLite database
 * (Engineering Standards §10). Covers the full Step 3.4 slice over HTTP:
 * the consolidated bill (FR9, D9 shape, B3 tax math, D1 billable gate),
 * the payment transaction (D2 single payment, D3 dual transitions, FR34
 * group close, PRD §13 table flip, the frozen synchronous rollups, D7 shift
 * link), idempotent retries and double-payment races (Contract §1, NFR3),
 * shift open/close with the D6 rules, and the B2 cancellation lock on
 * paid/completed orders.
 */
describe('BillingModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;
  let cashierEmployeeId: string;
  let secondCashierToken: string;
  let waiterToken: string;
  let kitchenToken: string;

  const db = () => getDb(app);

  const loginOwnerManager = async (name: string, password: string) => {
    const res = await request(app.getHttpServer()).post('/auth/password-login').send({ name, password, deviceLabel: `${name} Laptop` });
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
    const res = await request(app.getHttpServer()).post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
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

  const seedProduct = async (overrides: Record<string, unknown> = {}) => {
    const [category] = await db().insert(categories).values({ nameAr: 'مقبلات', nameFr: 'Entrées' }).returning();
    const [product] = await db()
      .insert(products)
      .values({
        categoryId: category.id,
        nameAr: 'شوربة عدس',
        nameFr: 'Soupe de lentilles',
        priceMinor: 25000,
        imagePath: null,
        ...overrides,
      })
      .returning();
    return product;
  };

  const seedTaxRate = async (basisPoints: number) => {
    await db()
      .insert(restaurantProfile)
      .values({ name: 'Restaurant El Djazair', primaryColor: '#111111', secondaryColor: '#eeeeee', taxRatePercent: basisPoints });
  };

  const key = () => 'pay-' + randomBytes(10).toString('hex');

  const staffCreateOrder = async (token: string, tableId: string, items: unknown[]) =>
    request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'ord-' + randomBytes(10).toString('hex'))
      .send({ tableId, items });

  /** Walks an order pending → served through the real endpoints. */
  const moveToServed = async (orderId: string) => {
    await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`);
    await request(app.getHttpServer()).post(`/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);
    await request(app.getHttpServer()).post(`/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`);
    await request(app.getHttpServer()).post(`/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`);
  };

  /** Creates a table + product + one served order; returns the visit context. */
  const servedVisit = async (productOverrides: Record<string, unknown> = {}) => {
    const table = await seedTable();
    const product = await seedProduct(productOverrides);
    const created = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 2 }]);
    const orderId = created.body.data.id as string;
    await moveToServed(orderId);
    return { table, product, orderId, billGroupId: created.body.data.tableBillGroupId as string };
  };

  const getBill = (token: string, groupId: string) =>
    request(app.getHttpServer()).get(`/billing/table-bill-groups/${groupId}`).set('Authorization', `Bearer ${token}`);

  const postPayment = (token: string, groupId: string, idempotencyKey?: string) => {
    const req = request(app.getHttpServer()).post('/payments').set('Authorization', `Bearer ${token}`);
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send({ tableBillGroupId: groupId });
  };

  /** Independent server-local date/hour computation (same wall clock the
   * rollup writer uses — D4) for asserting rollup buckets. */
  const localBucket = () => {
    const d = new Date();
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      hour: d.getHours(),
    };
  };

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    const builder = Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, OrdersModule, BillingModule, IdempotencyModule],
    })
      .overrideProvider(DRIZZLE_CLIENT)
      .useValue(isolatedDb);
    app = await createTestApp(builder);

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-pass-1' });
    ownerToken = await loginOwnerManager('Karim', 'owner-pass-1');
    await seedEmployee(db(), { name: 'Amina', role: 'manager', password: 'manager-pass-1' });
    managerToken = await loginOwnerManager('Amina', 'manager-pass-1');
    const cashier = await loginWithPin('Yacine', 'cashier', '1234');
    cashierToken = cashier.token;
    cashierEmployeeId = cashier.employeeId;
    secondCashierToken = (await loginWithPin('Rachid', 'cashier', '1234')).token;
    waiterToken = (await loginWithPin('Sofia', 'waiter', '1234')).token;
    kitchenToken = (await loginWithPin('Yanis', 'kitchen', '1234')).token;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------- the bill

  describe('GET /billing/table-bill-groups/:id', () => {
    it('404s an unknown group; refuses Waiter/Kitchen (D10 baseline: O/M/C only)', async () => {
      const ghost = '00000000-0000-0000-0000-000000000000';
      expect((await getBill(cashierToken, ghost)).status).toBe(404);
      expect((await getBill(waiterToken, ghost)).status).toBe(403);
      expect((await getBill(kitchenToken, ghost)).status).toBe(403);
      const unauthenticated = await request(app.getHttpServer()).get(`/billing/table-bill-groups/${ghost}`);
      expect(unauthenticated.status).toBe(401);
    });

    it('consolidates main + add-on into ONE bill with B3 tax math (FR9, D9 shape)', async () => {
      await seedTaxRate(1900); // 19.00%
      const table = await seedTable();
      const soup = await seedProduct(); // 25_000
      const dessert = await seedProduct({ nameAr: 'قلب اللوز', nameFr: 'Kalb el louz', priceMinor: 15_000 });

      const main = await staffCreateOrder(waiterToken, table.id, [{ productId: soup.id, quantity: 2 }]);
      const mainId = main.body.data.id as string;
      await moveToServed(mainId);
      const addon = await request(app.getHttpServer())
        .post(`/orders/${mainId}/addon`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .set('Idempotency-Key', 'addon-' + randomBytes(8).toString('hex'))
        .send({ items: [{ productId: dessert.id, quantity: 1 }] });
      await moveToServed(addon.body.data.id as string);

      const res = await getBill(cashierToken, main.body.data.tableBillGroupId);

      expect(res.status).toBe(200);
      expect(res.body.data.group.status).toBe('open');
      expect(res.body.data.orders).toHaveLength(2);
      expect(res.body.data.orders[0].isAddon).toBe(false);
      expect(res.body.data.orders[1].isAddon).toBe(true);
      // main: 2 × 25_000 = 50_000 → tax 9_500; addon: 1 × 15_000 = 15_000 → tax 2_850
      expect(res.body.data.subtotalMinor).toBe(65_000);
      expect(res.body.data.taxMinor).toBe(12_350);
      expect(res.body.data.totalMinor).toBe(77_350);
      expect(res.body.data.taxRateBasisPoints).toBe(1900);
      expect(res.body.data.payment).toBeNull();
    });

    it('D1: an in-flight order appears in the bill but is NOT charged; a cancelled order appears nowhere', async () => {
      const table = await seedTable();
      const product = await seedProduct();

      const first = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 2 }]);
      const firstId = first.body.data.id as string;
      await moveToServed(firstId);
      const second = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 3 }]); // stays pending
      const third = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      await request(app.getHttpServer())
        .post(`/orders/${third.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ reason: 'guest changed mind' });

      const res = await getBill(ownerToken, first.body.data.tableBillGroupId);

      expect(res.status).toBe(200);
      expect(res.body.data.orders.map((order: { id: string }) => order.id).sort()).toEqual([firstId, second.body.data.id].sort());
      expect(res.body.data.subtotalMinor).toBe(50_000); // only the served order; the pending 75_000 is not charged
      expect(res.body.data.taxMinor).toBe(9_500); // profile from the previous test persists in this suite DB
    });
  });

  // ------------------------------------------------------------- the payment

  describe('POST /payments', () => {
    it('records the full-total cash payment and completes the WHOLE visit atomically (D2/D3, FR34, PRD §13, rollups)', async () => {
      const { table, product, orderId, billGroupId } = await servedVisit();
      const billBefore = await getBill(cashierToken, billGroupId);
      const expectedTotal = billBefore.body.data.totalMinor as number; // 50_000 + 19% = 59_500
      expect(expectedTotal).toBe(59_500);

      const res = await postPayment(cashierToken, billGroupId, key());

      expect(res.status).toBe(201);
      expect(res.body.data.payment).toMatchObject({
        tableBillGroupId: billGroupId,
        amountMinor: 59_500,
        method: 'cash',
        collectedByEmployeeId: cashierEmployeeId,
        shiftId: null, // D7 — no open shift for this cashier right now
      });
      expect(res.body.data.bill.group.status).toBe('closed');
      expect(res.body.data.bill.orders[0].status).toBe('completed');
      expect(res.body.data.bill.payment.id).toBe(res.body.data.payment.id);

      // DB truth: one payment row; order completed; group closed with
      // closed_at (the schema CHECK pair); table needs_cleaning.
      const paymentRows = await db().select().from(payments).where(eq(payments.tableBillGroupId, billGroupId));
      expect(paymentRows).toHaveLength(1);
      const [orderRow] = await db().select().from(orders).where(eq(orders.id, orderId));
      expect(orderRow.status).toBe('completed');
      const [group] = await db().select().from(tableBillGroups).where(eq(tableBillGroups.id, billGroupId));
      expect(group.status).toBe('closed');
      expect(group.closedAt).not.toBeNull();
      const [tableRow] = await db().select().from(tables).where(eq(tables.id, table.id));
      expect(tableRow.status).toBe('needs_cleaning');

      // D3 — both transitions are RECORDED status events.
      const events = await db().select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId));
      expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        'null->pending',
        'pending->accepted',
        'accepted->preparing',
        'preparing->ready',
        'ready->served',
        'served->paid',
        'paid->completed',
      ]);

      // FR38 — payment_recorded + order_paid + order_completed audits.
      const paymentAudits = await db().select().from(auditLog).where(eq(auditLog.entityId, paymentRows[0].id));
      expect(paymentAudits.map((r) => r.action)).toContain('payment_recorded');
      const orderAudits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderId)));
      expect(orderAudits.map((r) => r.action)).toEqual(expect.arrayContaining(['order_paid', 'order_completed']));

      // The FROZEN synchronous rollups (Schema §8) — same transaction, exact
      // post-tax values (B3), server-local bucket (D4).
      const bucket = localBucket();
      const [daily] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, bucket.date));
      expect(daily.totalRevenueMinor).toBeGreaterThanOrEqual(59_500);
      expect(daily.dineInRevenueMinor).toBe(daily.totalRevenueMinor);
      expect(daily.deliveryRevenueMinor).toBe(0);
      const [hourly] = await db()
        .select()
        .from(salesRollupHourly)
        .where(and(eq(salesRollupHourly.date, bucket.date), eq(salesRollupHourly.hour, bucket.hour)));
      expect(hourly.revenueMinor).toBeGreaterThanOrEqual(59_500);
      const productRows = await db()
        .select()
        .from(productSalesRollup)
        .where(and(eq(productSalesRollup.date, bucket.date), eq(productSalesRollup.productNameSnapshot, product.nameAr)));
      expect(productRows[0].quantitySold).toBeGreaterThanOrEqual(2);
      expect(productRows[0].revenueMinor).toBeGreaterThanOrEqual(50_000); // net merchandise value
    });

    it('emits order.status_changed (twice per order) + table.status_changed after commit — and NO payment event (Contract §4)', async () => {
      // Set up the served visit FIRST, then start observing: the interesting
      // emissions are the payment transaction's own, nothing earlier.
      const { table, orderId, billGroupId } = await servedVisit();

      const received: Array<{ event: string; payload: unknown }> = [];
      const events = app.get(DomainEventsService);
      events.on(DOMAIN_EVENT.ORDER_STATUS_CHANGED, (payload) => received.push({ event: DOMAIN_EVENT.ORDER_STATUS_CHANGED, payload }));
      events.on(DOMAIN_EVENT.TABLE_STATUS_CHANGED, (payload) => received.push({ event: DOMAIN_EVENT.TABLE_STATUS_CHANGED, payload }));

      await postPayment(cashierToken, billGroupId, key());

      const orderEvents = received
        .filter((r) => r.event === DOMAIN_EVENT.ORDER_STATUS_CHANGED)
        .map((r) => r.payload as { orderId: string; fromStatus: string; toStatus: string })
        .filter((p) => p.orderId === orderId);
      expect(orderEvents).toEqual([
        { orderId, fromStatus: 'served', toStatus: 'paid' },
        { orderId, fromStatus: 'paid', toStatus: 'completed' },
      ]);
      const tableEvents = received
        .filter((r) => r.event === DOMAIN_EVENT.TABLE_STATUS_CHANGED)
        .map((r) => r.payload as { tableId: string; fromStatus: string; toStatus: string })
        .filter((p) => p.tableId === table.id);
      expect(tableEvents).toEqual([{ tableId: table.id, fromStatus: 'occupied', toStatus: 'needs_cleaning' }]);
    });

    it('requires the Idempotency-Key header (400) and replays the same key as 200 with ONE payment row (Contract §1)', async () => {
      const { billGroupId } = await servedVisit();

      const missing = await postPayment(cashierToken, billGroupId);
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const idempotencyKey = key();
      const first = await postPayment(cashierToken, billGroupId, idempotencyKey);
      const replay = await postPayment(cashierToken, billGroupId, idempotencyKey);
      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(await db().select().from(payments).where(eq(payments.tableBillGroupId, billGroupId))).toHaveLength(1);
    });

    it('two CONCURRENT same-key submissions settle the group exactly once (NFR3)', async () => {
      const { billGroupId } = await servedVisit();
      const idempotencyKey = key();
      const [a, b] = await Promise.all([
        postPayment(cashierToken, billGroupId, idempotencyKey),
        postPayment(cashierToken, billGroupId, idempotencyKey),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.data.payment.id).toBe(b.body.data.payment.id);
      expect(await db().select().from(payments).where(eq(payments.tableBillGroupId, billGroupId))).toHaveLength(1);
    });

    it('a second payment with a DIFFERENT key conflicts with 409 PAYMENT_ALREADY_RECORDED (D2)', async () => {
      const { billGroupId } = await servedVisit();
      const first = await postPayment(cashierToken, billGroupId, key());
      expect(first.status).toBe(201);

      const second = await postPayment(managerToken, billGroupId, key());
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('PAYMENT_ALREADY_RECORDED');
      expect(second.body.error.details.paymentId).toBe(first.body.data.payment.id);
      expect(await db().select().from(payments).where(eq(payments.tableBillGroupId, billGroupId))).toHaveLength(1);
    });

    it('D1: 409 PAYMENT_NOT_READY while any order is in flight — and NOTHING is written (atomicity)', async () => {
      const table = await seedTable();
      const product = await seedProduct();
      const served = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      await moveToServed(served.body.data.id as string);
      const pending = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      const billGroupId = served.body.data.tableBillGroupId as string;
      const bucket = localBucket();
      const [dailyBefore] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, bucket.date));

      const res = await postPayment(cashierToken, billGroupId, key());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_READY');
      expect(res.body.error.details.blockingOrderIds).toEqual([pending.body.data.id]);
      // Atomicity: no payment, no status events beyond creation, group open,
      // table occupied, rollups untouched.
      expect(await db().select().from(payments).where(eq(payments.tableBillGroupId, billGroupId))).toHaveLength(0);
      const [group] = await db().select().from(tableBillGroups).where(eq(tableBillGroups.id, billGroupId));
      expect(group.status).toBe('open');
      const [tableRow] = await db().select().from(tables).where(eq(tables.id, table.id));
      expect(tableRow.status).toBe('occupied');
      const [dailyAfter] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, bucket.date));
      expect(dailyAfter?.totalRevenueMinor ?? 0).toBe(dailyBefore?.totalRevenueMinor ?? 0);
    });

    it('D1: a group whose orders were all cancelled has nothing to pay (409 PAYMENT_NOT_READY)', async () => {
      const table = await seedTable();
      const product = await seedProduct();
      const created = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      await request(app.getHttpServer())
        .post(`/orders/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ reason: 'guest left' });

      const res = await postPayment(cashierToken, created.body.data.tableBillGroupId, key());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_READY');
      expect(res.body.error.details.blockingOrderIds).toEqual([]);
    });

    it('404s an unknown group and refuses Waiter/Kitchen (FR8: O/M/C only)', async () => {
      const ghost = '00000000-0000-0000-0000-000000000000';
      expect((await postPayment(cashierToken, ghost, key())).status).toBe(404);
      expect((await postPayment(waiterToken, ghost, key())).status).toBe(403);
      expect((await postPayment(kitchenToken, ghost, key())).status).toBe(403);
    });

    it('B2: a completed order CANNOT be cancelled — 409 INVALID_ORDER_TRANSITION even for the Owner', async () => {
      const { orderId, billGroupId } = await servedVisit();
      await postPayment(cashierToken, billGroupId, key());

      const res = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: 'refund attempt' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_ORDER_TRANSITION');
      expect(res.body.error.details.fromStatus).toBe('completed');
    });

    it('D8: a needs_cleaning table accepts NO new orders (409 INVALID_TABLE_STATUS_TRANSITION)', async () => {
      const { table, product, billGroupId } = await servedVisit();
      await postPayment(cashierToken, billGroupId, key());

      const res = await staffCreateOrder(waiterToken, table.id, [{ productId: product.id, quantity: 1 }]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TABLE_STATUS_TRANSITION');
      expect(res.body.error.details.fromStatus).toBe('needs_cleaning');
    });

    it('D7: the payment links the collector\'s open shift when one exists', async () => {
      const opened = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ openingCashMinor: 10_000 });
      expect(opened.status).toBe(201);

      const { billGroupId } = await servedVisit();
      const res = await postPayment(cashierToken, billGroupId, key());
      expect(res.status).toBe(201);
      expect(res.body.data.payment.shiftId).toBe(opened.body.data.id);
      // Leave the shift open — the shifts suite below closes it.
    });
  });

  // ----------------------------------------------------------------- shifts

  describe('shifts (D6)', () => {
    it('open: 201 with the acting employee bound; validation 400 on negative cash; waiter refused (403)', async () => {
      const negative = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${secondCashierToken}`)
        .send({ openingCashMinor: -1 });
      expect(negative.status).toBe(400);

      const opened = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${secondCashierToken}`)
        .send({ openingCashMinor: 5_000 });
      expect(opened.status).toBe(201);
      expect(opened.body.data).toMatchObject({ status: 'open', openingCashMinor: 5_000, closingCashMinor: null });
      expect(opened.body.data.employeeId).toBeTruthy();

      const waiterOpen = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ openingCashMinor: 0 });
      expect(waiterOpen.status).toBe(403);
    });

    it('double open conflicts with 409 SHIFT_ALREADY_OPEN', async () => {
      // The first cashier already has an open shift from the D7 test above.
      const res = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ openingCashMinor: 1_000 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SHIFT_ALREADY_OPEN');
      expect(res.body.error.details.openShiftId).toBeTruthy();
    });

    it('close: expected = opening + Σ linked cash payments; returns the reconciliation; audits shift_closed', async () => {
      // The first cashier's open shift collected exactly one payment (59_500)
      // in the D7 test; opening was 10_000.
      const openShiftRows = await db()
        .select()
        .from(shifts)
        .where(and(eq(shifts.employeeId, cashierEmployeeId), eq(shifts.status, 'open')));
      const shiftId = openShiftRows[0].id;

      const res = await request(app.getHttpServer())
        .post(`/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ closingCashMinor: 70_000 });

      expect(res.status).toBe(201);
      expect(res.body.data.shift.status).toBe('closed');
      expect(res.body.data.shift.expectedCashMinor).toBe(69_500); // 10_000 + 59_500
      expect(res.body.data.shift.closingCashMinor).toBe(70_000);
      expect(res.body.data.paymentsCollected).toBe(1);
      expect(res.body.data.differenceMinor).toBe(500);

      const audits = await db().select().from(auditLog).where(and(eq(auditLog.entityType, 'shift'), eq(auditLog.entityId, shiftId)));
      expect(audits.map((r) => r.action)).toEqual(expect.arrayContaining(['shift_opened', 'shift_closed']));

      // Closing again conflicts — the reconciliation is never recomputed.
      const again = await request(app.getHttpServer())
        .post(`/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ closingCashMinor: 0 });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('SHIFT_ALREADY_CLOSED');
    });

    it('a cashier cannot close another cashier\'s shift (403); a Manager can (supervisor override)', async () => {
      const opened = await request(app.getHttpServer())
        .post('/shifts/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ openingCashMinor: 2_000 });
      const shiftId = opened.body.data.id as string;

      const otherCashier = await request(app.getHttpServer())
        .post(`/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${secondCashierToken}`)
        .send({ closingCashMinor: 2_000 });
      expect(otherCashier.status).toBe(403);
      expect(otherCashier.body.error.code).toBe('INSUFFICIENT_PERMISSION');

      const manager = await request(app.getHttpServer())
        .post(`/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ closingCashMinor: 2_000 });
      expect(manager.status).toBe(201);
      expect(manager.body.data.differenceMinor).toBe(0);
    });

    it('GET /shifts/:id — cashier sees own only; Owner/Manager any; 404 unknown; waiter refused', async () => {
      // Both closed shifts so far belong to the first cashier (deterministic).
      const [closedShift] = await db()
        .select()
        .from(shifts)
        .where(and(eq(shifts.status, 'closed'), eq(shifts.employeeId, cashierEmployeeId)));

      const own = await request(app.getHttpServer())
        .get(`/shifts/${closedShift.id}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(own.status).toBe(200);
      expect(own.body.data.id).toBe(closedShift.id);

      // The second cashier is refused: not their shift (PRD §11 "Own shift only").
      const otherCashier = await request(app.getHttpServer())
        .get(`/shifts/${closedShift.id}`)
        .set('Authorization', `Bearer ${secondCashierToken}`);
      expect(otherCashier.status).toBe(403);

      const owner = await request(app.getHttpServer())
        .get(`/shifts/${closedShift.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(owner.status).toBe(200);

      const ghost = await request(app.getHttpServer())
        .get('/shifts/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(ghost.status).toBe(404);

      const waiter = await request(app.getHttpServer())
        .get(`/shifts/${closedShift.id}`)
        .set('Authorization', `Bearer ${waiterToken}`);
      expect(waiter.status).toBe(403);
    });
  });
});
