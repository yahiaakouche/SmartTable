import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, products, refreshTokens, restaurantProfile } from '../src/database/schema';
import { incrementCancelledOrderRollup, rollupBucketFor, upsertCompletedOrderRollup } from '../src/database/rollups';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — Step 3.7 critical path (Engineering Standards §10), against the FULL
 * application composition (real migrated database, /api/v1 prefix):
 *
 *   a real guest visit (hall/table/product → waiter order → kitchen
 *   accept/prepare/ready → waiter serve → cashier payment) becomes visible in
 *   the TODAY analytics immediately — the Contract §3 live path — while a
 *   backdated fixture written through the REAL 3.4 rollup writers proves the
 *   historical path, and a spanning range proves the frozen hybrid merge.
 *   B1 access (Owner+Manager), B2(a) attribution and FR43 neutrality are
 *   exercised over real HTTP with real role tokens.
 */
describe('Analytics (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const key = () => 'e2e-' + randomBytes(12).toString('hex');

  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayStart = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getTime();
  };
  const today = fmt(Date.now());
  const yesterday = fmt(dayStart(today) - 86_400_000);

  let ownerToken: string;
  let managerToken: string;
  let waiterToken: string;
  let kitchenToken: string;
  let cashierToken: string;

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );

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
  }, 90_000);

  afterAll(async () => {
    await app.close();
  });

  const analytics = (token: string, path: string) =>
    request(app.getHttpServer()).get(`/api/v1/analytics${path}`).set('Authorization', `Bearer ${token}`);

  it('a full guest visit flows into Today analytics live; historical and spanning ranges read the rollup path', async () => {
    const server = app.getHttpServer();

    // ---- setup: hall, tables, menu, 19% tax ----
    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة' }).expect(201);
    const mkTable = async (label: string) =>
      (
        await request(server)
          .post('/api/v1/tables')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ label, hallId: hall.body.data.id })
          .expect(201)
      ).body.data.id as string;
    const tableA = await mkTable('Table A');
    const tableB = await mkTable('Table B');
    const tableC = await mkTable('Table C');

    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [soup] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();
    await db()
      .insert(restaurantProfile)
      .values({ name: 'Restaurant El Djazair', primaryColor: '#111111', secondaryColor: '#eeeeee', taxRatePercent: 1900 });

    // ---- visit A: complete and paid (2 × 25_000 + 19% = 59_500) ----
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: tableA, items: [{ productId: soup.id, quantity: 2 }] })
      .expect(201);
    const orderA = created.body.data.id as string;
    await request(server).post(`/api/v1/orders/${orderA}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderA}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderA}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderA}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId: created.body.data.tableBillGroupId })
      .expect(201);

    // ---- visit B: still open (keeps one table ACTIVE for the KPI) ----
    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: tableB, items: [{ productId: soup.id, quantity: 1 }] })
      .expect(201);

    // ---- visit C: cancelled before completion (live cancellation signal) ----
    const cancelled = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: tableC, items: [{ productId: soup.id, quantity: 1 }] })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${cancelled.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'guest walked out' })
      .expect(201);

    // ---- TODAY: the live path (Contract §3 design note) ----
    const currentHour = new Date().getHours();
    const kpis = await analytics(ownerToken, '/kpis?range=today').expect(200);
    expect(kpis.body.data).toMatchObject({
      range: { from: today, to: today },
      totalRevenueMinor: 59_500, // post-tax, single-sourced from computeOrderTotals
      dineInRevenueMinor: 59_500,
      deliveryRevenueMinor: 0,
      totalOrders: 1,
      averageOrderValueMinor: 59_500,
      cancellationRate: 0.5, // 1 live cancellation / 2 outcomes
      activeTables: 2, // visits B and C keep their tables active — range-independent
      bestSellingProduct: { name: 'شوربة عدس', quantitySold: 2 },
      bestSellingCategory: { name: 'أطباق', quantitySold: 2 },
      peakSalesHour: { hour: currentHour, revenueMinor: 59_500 },
      peakSalesDay: { date: today, revenueMinor: 59_500 },
      averagePreparationTimeMs: expect.any(Number),
      averageTableTurnoverMs: expect.any(Number), // visit A closed
    });
    // Payment was taken outside any shift → the null-shift bucket (3.4 shape).
    expect(kpis.body.data.revenueByShift).toEqual([
      { shiftId: null, employeeId: null, openedAt: null, closedAt: null, revenueMinor: 59_500 },
    ]);
    expect(kpis.body.data.categoryMix).toEqual([{ category: 'أطباق', quantitySold: 2, revenueMinor: 50_000 }]); // NET merchandise

    const revenueSeries = await analytics(ownerToken, '/revenue-over-time?range=today').expect(200);
    expect(revenueSeries.body.data.granularity).toBe('hour');
    expect(revenueSeries.body.data.points).toHaveLength(24);
    expect(revenueSeries.body.data.points[currentHour]).toEqual({ bucket: String(currentHour).padStart(2, '0'), revenueMinor: 59_500 });

    const ordersSeries = await analytics(ownerToken, '/orders-over-time?range=today').expect(200);
    expect(ordersSeries.body.data.points[currentHour]).toEqual({ bucket: String(currentHour).padStart(2, '0'), ordersCount: 1 });

    const topProducts = await analytics(ownerToken, '/top-products?range=today').expect(200);
    expect(topProducts.body.data.products).toEqual([{ name: 'شوربة عدس', category: 'أطباق', quantitySold: 2, revenueMinor: 50_000 }]);

    // ---- FR43: the acting employees, neutrally, name-sorted ----
    const stats = await analytics(ownerToken, '/operational-stats?range=today').expect(200);
    const names = stats.body.data.employees.map((e: { employeeName: string }) => e.employeeName);
    expect(names).toEqual(['Sofia', 'Yanis']); // the cashier never appears here
    const [sofia, yanis] = stats.body.data.employees;
    expect(sofia).toMatchObject({ role: 'waiter', ordersHandled: 3, averageAcceptanceTimeMs: null, averagePreparationTimeMs: null });
    expect(yanis).toMatchObject({
      role: 'kitchen',
      ordersHandled: 1,
      averageAcceptanceTimeMs: expect.any(Number),
      averagePreparationTimeMs: expect.any(Number),
    });

    // ---- HISTORICAL: fixtures through the REAL 3.4 writers ----
    const yesterdayNoon = dayStart(yesterday) + 12 * 3_600_000;
    db().transaction((tx) => {
      upsertCompletedOrderRollup(tx, {
        bucket: rollupBucketFor(yesterdayNoon),
        now: yesterdayNoon,
        orderTotalMinor: 30_000,
        channel: 'dine_in',
        items: [{ nameSnapshot: 'كسكس', categorySnapshot: 'أطباق رئيسية', unitPriceMinorSnapshot: 10_000, quantity: 3 }],
      });
      incrementCancelledOrderRollup(tx, rollupBucketFor(yesterdayNoon), yesterdayNoon);
    });

    const historical = await analytics(ownerToken, '/kpis?range=yesterday').expect(200);
    expect(historical.body.data).toMatchObject({
      range: { from: yesterday, to: yesterday },
      totalRevenueMinor: 30_000,
      totalOrders: 1,
      cancellationRate: 0.5,
      bestSellingProduct: { name: 'كسكس', quantitySold: 3 },
    });

    // ---- SPANNING: the frozen hybrid merge, invisible in the shape ----
    const merged = await analytics(ownerToken, '/kpis?range=last7Days').expect(200);
    expect(merged.body.data.totalRevenueMinor).toBe(89_500); // 30_000 rollup + 59_500 live
    expect(merged.body.data.totalOrders).toBe(2);
    expect(merged.body.data.bestSellingProduct).toEqual({ name: 'كسكس', quantitySold: 3 }); // qty-first across both sources

    const mergedSeries = await analytics(ownerToken, '/revenue-over-time?range=last7Days').expect(200);
    expect(mergedSeries.body.data.granularity).toBe('day');
    expect(mergedSeries.body.data.points).toHaveLength(7);
    expect(mergedSeries.body.data.points.at(-1)).toEqual({ bucket: today, revenueMinor: 59_500 });
    expect(mergedSeries.body.data.points.at(-2)).toEqual({ bucket: yesterday, revenueMinor: 30_000 });
  }, 90_000);

  it('enforces B1 over real HTTP: Owner + Manager read, floor roles are 403, anonymous is 401', async () => {
    await analytics(managerToken, '/kpis?range=today').expect(200);
    await analytics(managerToken, '/operational-stats?range=today').expect(200);
    for (const token of [waiterToken, kitchenToken, cashierToken]) {
      const res = await analytics(token, '/kpis?range=today').expect(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
    }
    await request(app.getHttpServer()).get('/api/v1/analytics/kpis').expect(401);
  }, 30_000);
});
