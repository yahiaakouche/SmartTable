import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import {
  halls,
  orderItems,
  orderStatusEvents,
  orders,
  payments,
  refreshTokens,
  shifts,
  tableBillGroups,
  tables,
} from '../../database/schema';
import { incrementCancelledOrderRollup, rollupBucketFor, upsertCompletedOrderRollup } from '../../database/rollups';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { AnalyticsModule } from './analytics.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the analytics module against a real, migrated SQLite database
 * (Engineering Standards §10). Historical fixtures are written through the
 * REAL 3.4 rollup writers (`upsertCompletedOrderRollup` /
 * `incrementCancelledOrderRollup`) — the same functions the payment and cancel
 * transactions call — so the read side is tested against production-shaped
 * rollup data, not hand-crafted rows. "Today" fixtures are raw facts, exactly
 * as the live path reads them (Contract §3 design note).
 *
 * Covered: all five endpoints over HTTP, the frozen live/rollup branching,
 * B1 (Owner+Manager only), B2(a) collector path, B3(a)/FR43 neutral
 * operational stats, B5(a) range vocabulary + validation.
 */
describe('AnalyticsModule (integration)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const authed = () => request(app.getHttpServer());

  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayStart = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getTime();
  };
  const atHour = (date: string, hour: number) => dayStart(date) + hour * 3_600_000;
  const today = fmt(Date.now());
  const yesterday = fmt(dayStart(today) - 86_400_000);

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, AnalyticsModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
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

  const get = (token: string, path: string) => authed().get(`/analytics${path}`).set('Authorization', `Bearer ${token}`);

  /** Historical fixture through the REAL 3.4 writer (synchronous, same-transaction). */
  const writeCompletedRollup = (atMs: number, orderTotalMinor: number, items: { nameSnapshot: string; categorySnapshot: string; unitPriceMinorSnapshot: number; quantity: number }[]) =>
    db().transaction((tx) => {
      upsertCompletedOrderRollup(tx, { bucket: rollupBucketFor(atMs), now: atMs, orderTotalMinor, channel: 'dine_in', items });
    });

  const writeCancelledRollup = (atMs: number) =>
    db().transaction((tx) => {
      incrementCancelledOrderRollup(tx, rollupBucketFor(atMs), atMs);
    });

  const seedVisit = async (opts: { tableStatus?: string } = {}) => {
    const [hall] = await db().insert(halls).values({ name: 'Main Hall' }).returning();
    const [table] = await db()
      .insert(tables)
      .values({ hallId: hall.id, label: 'Table 1', qrToken: randomBytes(32).toString('base64url'), ...(opts.tableStatus ? { status: opts.tableStatus } : {}) })
      .returning();
    const [group] = await db().insert(tableBillGroups).values({ tableId: table.id }).returning();
    return { hall, table, group };
  };

  // ---------------------------------------------------------- frozen branching

  it('historical ranges read the rollups written by the real 3.4 writers', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    writeCompletedRollup(atHour(yesterday, 12), 30000, [
      { nameSnapshot: 'كسكس', categorySnapshot: 'أطباق رئيسية', unitPriceMinorSnapshot: 10000, quantity: 2 },
      { nameSnapshot: 'شوربة', categorySnapshot: 'مقبلات', unitPriceMinorSnapshot: 5000, quantity: 1 },
    ]);
    writeCompletedRollup(atHour(yesterday, 19), 70000, [
      { nameSnapshot: 'كسكس', categorySnapshot: 'أطباق رئيسية', unitPriceMinorSnapshot: 10000, quantity: 3 },
    ]);
    writeCancelledRollup(atHour(yesterday, 20));

    const kpis = await get(owner.token, '/kpis?range=yesterday').expect(200);
    expect(kpis.body.data).toMatchObject({
      range: { from: yesterday, to: yesterday },
      totalRevenueMinor: 100000,
      dineInRevenueMinor: 100000,
      totalOrders: 2,
      averageOrderValueMinor: 50000,
      cancellationRate: 0.3333, // 1 cancelled / 3 outcomes, 4dp
      peakSalesHour: { hour: 19, revenueMinor: 70000 },
      peakSalesDay: { date: yesterday, revenueMinor: 100000 },
      bestSellingProduct: { name: 'كسكس', quantitySold: 5 },
      bestSellingCategory: { name: 'أطباق رئيسية', quantitySold: 5 },
    });
    // Product revenue is NET (pre-tax) merchandise — the 3.4 definition.
    expect(kpis.body.data.categoryMix).toEqual([
      { category: 'أطباق رئيسية', quantitySold: 5, revenueMinor: 50000 },
      { category: 'مقبلات', quantitySold: 1, revenueMinor: 5000 },
    ]);

    const revenue = await get(owner.token, '/revenue-over-time?range=yesterday').expect(200);
    expect(revenue.body.data.granularity).toBe('hour');
    expect(revenue.body.data.points).toHaveLength(24);
    expect(revenue.body.data.points[12]).toEqual({ bucket: '12', revenueMinor: 30000 });
    expect(revenue.body.data.points[19]).toEqual({ bucket: '19', revenueMinor: 70000 });

    const ordersSeries = await get(owner.token, `/orders-over-time?range=custom&from=${yesterday}&to=${today}`).expect(200);
    expect(ordersSeries.body.data.granularity).toBe('day');
    expect(ordersSeries.body.data.points).toEqual([
      { bucket: yesterday, ordersCount: 2 },
      { bucket: today, ordersCount: 0 },
    ]);

    const top = await get(owner.token, '/top-products?range=yesterday').expect(200);
    expect(top.body.data.products).toEqual([
      { name: 'كسكس', category: 'أطباق رئيسية', quantitySold: 5, revenueMinor: 50000 },
      { name: 'شوربة', category: 'مقبلات', quantitySold: 1, revenueMinor: 5000 },
    ]);
  });

  it('today reads raw facts live and a spanning range merges both sources', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const { table, group } = await seedVisit({ tableStatus: 'occupied' });
    const [order] = await db()
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, source: 'qr', status: 'completed', createdAt: atHour(today, 10) })
      .returning();
    const [cancelledOrder] = await db()
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, source: 'qr', status: 'cancelled', cancellationReason: 'customer left', createdAt: atHour(today, 10) })
      .returning();
    await db().insert(orderItems).values({
      orderId: order.id,
      nameSnapshot: 'طاجين',
      categorySnapshot: 'أطباق رئيسية',
      unitPriceMinorSnapshot: 20000,
      quantity: 2,
    });
    await db().insert(orderStatusEvents).values([
      { orderId: order.id, fromStatus: null, toStatus: 'pending', createdAt: atHour(today, 9) },
      { orderId: order.id, fromStatus: 'served', toStatus: 'completed', createdAt: atHour(today, 10) },
      { orderId: cancelledOrder.id, fromStatus: 'preparing', toStatus: 'cancelled', createdAt: atHour(today, 11) },
    ]);

    const kpis = await get(owner.token, '/kpis?range=today').expect(200);
    expect(kpis.body.data).toMatchObject({
      totalRevenueMinor: 40000, // live: computeOrderTotals over the raw items, default tax 0
      totalOrders: 1,
      averageOrderValueMinor: 40000,
      cancellationRate: 0.5, // one live cancellation today / two outcomes
      activeTables: 1,
      peakSalesHour: { hour: 10, revenueMinor: 40000 },
    });

    // Spanning range: yesterday via rollups (none here) + today live — the
    // hybrid seam stays invisible in the response shape.
    writeCompletedRollup(atHour(yesterday, 12), 30000, [
      { nameSnapshot: 'كسكس', categorySnapshot: 'أطباق رئيسية', unitPriceMinorSnapshot: 10000, quantity: 3 },
    ]);
    const merged = await get(owner.token, '/kpis?range=last7Days').expect(200);
    expect(merged.body.data.totalRevenueMinor).toBe(70000);
    expect(merged.body.data.totalOrders).toBe(2);
    // Quantity-first ranking across both sources: كسكس 3 (rollup) > طاجين 2 (live).
    expect(merged.body.data.bestSellingProduct).toEqual({ name: 'كسكس', quantitySold: 3 });
  });

  it('employeeId queries attribute revenue to the collecting employee (B2(a)) and null the cancellation rate', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const cashier = await loginWithPin('Lina', 'cashier');
    const { group, table } = await seedVisit();
    const [shift] = await db()
      .insert(shifts)
      .values({ employeeId: cashier.employeeId, openingCashMinor: 20000, openedAt: atHour(yesterday, 8) })
      .returning();
    const [order] = await db()
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, source: 'waiter_manual', status: 'completed', createdAt: atHour(yesterday, 11) })
      .returning();
    await db().insert(orderItems).values({
      orderId: order.id,
      nameSnapshot: 'طاجين',
      categorySnapshot: 'أطباق رئيسية',
      unitPriceMinorSnapshot: 20000,
      quantity: 2,
    });
    await db().insert(payments).values({
      tableBillGroupId: group.id,
      amountMinor: 40000,
      method: 'cash',
      collectedByEmployeeId: cashier.employeeId,
      shiftId: shift.id,
      createdAt: atHour(yesterday, 12),
    });

    const kpis = await get(owner.token, `/kpis?range=yesterday&employeeId=${cashier.employeeId}`).expect(200);
    expect(kpis.body.data).toMatchObject({
      totalRevenueMinor: 40000,
      totalOrders: 1,
      cancellationRate: null, // cancellations are not attributable to a collector
      revenueByShift: [
        { shiftId: shift.id, employeeId: cashier.employeeId, openedAt: atHour(yesterday, 8), closedAt: null, revenueMinor: 40000 },
      ],
    });
  });

  // ------------------------------------------------------------------- FR43

  it('operational stats attribute acceptance/preparation to the acting employees, name-sorted only (B3(a))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const kitchen = await loginWithPin('Yanis', 'kitchen');
    const waiter = await loginWithPin('Sofia', 'waiter');
    const { table, group } = await seedVisit();
    const [order] = await db()
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, source: 'qr', status: 'served', createdAt: atHour(yesterday, 12) })
      .returning();
    await db().insert(orderStatusEvents).values([
      { orderId: order.id, fromStatus: null, toStatus: 'pending', actorEmployeeId: waiter.employeeId, createdAt: atHour(yesterday, 12) },
      { orderId: order.id, fromStatus: 'pending', toStatus: 'accepted', actorEmployeeId: kitchen.employeeId, createdAt: atHour(yesterday, 12) + 120_000 },
      { orderId: order.id, fromStatus: 'preparing', toStatus: 'ready', actorEmployeeId: kitchen.employeeId, createdAt: atHour(yesterday, 12) + 720_000 },
      { orderId: order.id, fromStatus: 'ready', toStatus: 'served', actorEmployeeId: waiter.employeeId, createdAt: atHour(yesterday, 12) + 780_000 },
    ]);

    const stats = await get(owner.token, '/operational-stats?range=yesterday').expect(200);
    expect(stats.body.data.employees.map((e: { employeeName: string }) => e.employeeName)).toEqual(['Sofia', 'Yanis']);
    const [sofia, yanis] = stats.body.data.employees;
    expect(sofia).toMatchObject({ role: 'waiter', ordersHandled: 1, averageAcceptanceTimeMs: null, averagePreparationTimeMs: null });
    expect(yanis).toMatchObject({ role: 'kitchen', ordersHandled: 1, averageAcceptanceTimeMs: 120_000, averagePreparationTimeMs: 600_000 });

    const narrowed = await get(owner.token, `/operational-stats?range=yesterday&employeeId=${kitchen.employeeId}`).expect(200);
    expect(narrowed.body.data.employees).toHaveLength(1);
    expect(narrowed.body.data.employees[0].employeeId).toBe(kitchen.employeeId);
  });

  // -------------------------------------------------------------- B1 access

  it('denies waiter, kitchen and cashier on every endpoint (B1: Owner + Manager only)', async () => {
    const manager = await loginWithPin('Amina', 'manager');
    const denied = [await loginWithPin('Sofia', 'waiter'), await loginWithPin('Yanis', 'kitchen'), await loginWithPin('Lina', 'cashier')];
    const paths = ['/kpis', '/revenue-over-time', '/orders-over-time', '/top-products', '/operational-stats'];

    for (const login of denied) {
      for (const path of paths) {
        const res = await get(login.token, path).expect(403);
        expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
      }
    }
    for (const path of paths) {
      await get(manager.token, path).expect(200); // Manager is inside B1
    }
  });

  it('requires authentication', async () => {
    await authed().get('/analytics/kpis').expect(401);
    await authed().get('/analytics/operational-stats').expect(401);
  });

  // ---------------------------------------------------------- B5(a) validation

  it('validates range combinations and filter shapes (400)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const cases = [
      '/kpis?range=custom', // missing from/to
      '/kpis?range=custom&from=2025-01-10', // missing to
      '/kpis?range=today&from=2025-01-01&to=2025-01-02', // dates with a named range
      '/kpis?range=custom&from=2025-01-10&to=2025-01-01', // inverted
      '/kpis?range=custom&from=2025-02-30&to=2025-03-01', // impossible calendar date
      '/kpis?range=lastweek', // unknown vocabulary value
      '/kpis?from=01-01-2025&to=2025-01-02', // wrong date format
      '/kpis?employeeId=not-a-uuid',
      '/kpis?channel=drive_through',
      '/kpis?paymentMethod=card', // cash-only v1 vocabulary
    ];
    for (const path of cases) {
      const res = await get(owner.token, path).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});
