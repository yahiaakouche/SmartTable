import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import {
  categories,
  products,
  productSalesRollup,
  refreshTokens,
  restaurantProfile,
  salesRollupDaily,
  salesRollupHourly,
} from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the Step 3.4 named critical path (Engineering Standards §10):
 * "the daily rollup trigger on order completion", exercised against the FULL
 * application composition (real migrated database, /api/v1 prefix):
 *
 *   two separate guest visits complete through real payments + one order is
 *   cancelled → the rollup tables reflect every event EXACTLY, synchronously
 *   (Schema §8: same transaction as the Completed transition — never a batch
 *   job): daily revenue is post-tax per order (B3) and reconciles exactly
 *   with Σ payments, counters split completed vs cancelled (D5), the hourly
 *   bucket matches, and the product rollup carries net merchandise value.
 */
describe('Daily rollup trigger on order completion (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const key = () => 'e2e-' + randomBytes(12).toString('hex');

  const localBucket = () => {
    const d = new Date();
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      hour: d.getHours(),
    };
  };

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
  }, 90_000);

  afterAll(async () => {
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

  it('accumulates exact rollup values across completed and cancelled orders', async () => {
    const server = app.getHttpServer();
    const bucket = localBucket();

    // No completions yet → no rollup row exists at all (no phantom zeros).
    expect(await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, bucket.date))).toHaveLength(0);

    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;
    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine', 'cashier', '1234');

    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة' }).expect(201);
    const tableA = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table A', hallId: hall.body.data.id })
      .expect(201);
    const tableB = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table B', hallId: hall.body.data.id })
      .expect(201);

    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [soup] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();
    const [dessert] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'قلب اللوز', nameFr: 'Kalb el louz', priceMinor: 15_000, imagePath: null })
      .returning();
    await db()
      .insert(restaurantProfile)
      .values({ name: 'Restaurant El Djazair', primaryColor: '#111111', secondaryColor: '#eeeeee', taxRatePercent: 1900 });

    const completeVisit = async (tableId: string, items: { productId: string; quantity: number }[]) => {
      const created = await request(server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${waiterToken}`)
        .set('Idempotency-Key', key())
        .send({ tableId, items })
        .expect(201);
      const orderId = created.body.data.id as string;
      await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
      return created.body.data;
    };

    // Visit A: one order, 2 × 25_000 = 50_000 + 19% = 59_500.
    const visitA = await completeVisit(tableA.body.data.id, [{ productId: soup.id, quantity: 2 }]);
    const payA = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId: visitA.tableBillGroupId })
      .expect(201);

    // Visit B: main (soup ×2) + add-on (dessert ×1) = 65_000 + 12_350 = 77_350.
    const visitBMain = await completeVisit(tableB.body.data.id, [{ productId: soup.id, quantity: 2 }]);
    const visitBAddon = await request(server)
      .post(`/api/v1/orders/${visitBMain.id}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ items: [{ productId: dessert.id, quantity: 1 }] })
      .expect(201);
    for (const action of ['accept', 'advance', 'advance']) {
      await request(server).post(`/api/v1/orders/${visitBAddon.body.data.id}/${action}`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    }
    await request(server).post(`/api/v1/orders/${visitBAddon.body.data.id}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    const payB = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId: visitBMain.tableBillGroupId })
      .expect(201);

    // One cancellation on a third visit (D5).
    const tableC = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table C', hallId: hall.body.data.id })
      .expect(201);
    const cancelled = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: tableC.body.data.id, items: [{ productId: soup.id, quantity: 1 }] })
      .expect(201);
    await request(server)
      .post(`/api/v1/orders/${cancelled.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'guest walked out' })
      .expect(201);

    // ---- EXACT rollup truth (fresh database: no other writes exist) ----

    const [daily] = await db().select().from(salesRollupDaily).where(eq(salesRollupDaily.date, bucket.date));
    const expectedRevenue = 59_500 + 77_350; // post-tax per order (B3)
    expect(daily).toMatchObject({
      totalRevenueMinor: expectedRevenue,
      dineInRevenueMinor: expectedRevenue,
      deliveryRevenueMinor: 0,
      totalOrders: 3, // three COMPLETED orders across the two paid visits
      cancelledOrders: 1, // D5
    });
    // Reconciliation: daily rollup revenue == Σ payment amounts exactly.
    expect(daily.totalRevenueMinor).toBe(payA.body.data.payment.amountMinor + payB.body.data.payment.amountMinor);

    const [hourly] = await db()
      .select()
      .from(salesRollupHourly)
      .where(and(eq(salesRollupHourly.date, bucket.date), eq(salesRollupHourly.hour, bucket.hour)));
    expect(hourly).toMatchObject({ revenueMinor: expectedRevenue, ordersCount: 3 });

    const productRows = await db().select().from(productSalesRollup).where(eq(productSalesRollup.date, bucket.date));
    const byName = new Map(productRows.map((row) => [row.productNameSnapshot, row]));
    expect(byName.get('شوربة عدس')).toMatchObject({ categorySnapshot: 'أطباق', quantitySold: 4, revenueMinor: 100_000 });
    expect(byName.get('قلب اللوز')).toMatchObject({ categorySnapshot: 'أطباق', quantitySold: 1, revenueMinor: 15_000 });
  }, 90_000);
});
