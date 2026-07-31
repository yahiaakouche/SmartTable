import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, products, refreshTokens, restaurantProfile, tableBillGroups, tables } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the Step 3.4 named critical path (Engineering Standards §10):
 * "Table Bill Group consolidation at payment", exercised against the FULL
 * application composition (all modules, global guards, throttling, envelope +
 * idempotency interceptors, real migrated database, /api/v1 prefix):
 *
 *   owner sets up floor, menu and tax → waiter's main order → kitchen locks
 *   it → add-on order joins the SAME group → both served → the cashier sees
 *   ONE consolidated bill (main + add-on, FR9) with tax computed at bill time
 *   (B3) → ONE full-total cash payment (D2) settles the whole visit: both
 *   orders Paid → Completed (D3), the group auto-closes (FR34), the table
 *   flips to needs_cleaning (PRD §13) → idempotent retry replays (Q1) → a
 *   second payment conflicts (D2) → the table is cleaned and the NEXT visit
 *   opens a fresh group (full table lifecycle loop).
 */
describe('Table Bill Group consolidation at payment (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const key = () => 'e2e-' + randomBytes(12).toString('hex');

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true }, // mirrors main.ts exactly
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

  it('runs the complete consolidated-billing visit end to end', async () => {
    const server = app.getHttpServer();

    // 1. Owner full login; floor setup through the real APIs; menu + a 19%
    //    tax rate seeded (the Setup Wizard step arrives later in Phase 3).
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;

    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة رئيسية' }).expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table 3', hallId: hall.body.data.id })
      .expect(201);

    const [category] = await db().insert(categories).values({ nameAr: 'أطباق رئيسية', nameFr: 'Plats' }).returning();
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

    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');
    const cashierToken = await pinLogin('Yacine', 'cashier', '1234');

    // 2. Main order; kitchen locks it; the guest's dessert arrives as an
    //    Add-on Order in the SAME Table Bill Group; both are served.
    const main = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: table.body.data.id, items: [{ productId: soup.id, quantity: 2 }] })
      .expect(201);
    const billGroupId = main.body.data.tableBillGroupId as string;

    const addon = await request(server)
      .post(`/api/v1/orders/${main.body.data.id}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ items: [{ productId: dessert.id, quantity: 1 }] })
      .expect(201);

    for (const orderId of [main.body.data.id, addon.body.data.id] as string[]) {
      await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
      await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    }

    // 3. The cashier opens the CONSOLIDATED bill: one group, two orders, one
    //    total; tax computed at bill time per order and summed (B3).
    const bill = await request(server)
      .get(`/api/v1/billing/table-bill-groups/${billGroupId}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    expect(bill.body.data.orders).toHaveLength(2);
    expect(bill.body.data.subtotalMinor).toBe(65_000); // 2×25_000 + 1×15_000
    expect(bill.body.data.taxMinor).toBe(12_350); // 9_500 + 2_850
    expect(bill.body.data.totalMinor).toBe(77_350);
    expect(bill.body.data.taxRateBasisPoints).toBe(1900);
    expect(bill.body.data.payment).toBeNull();

    // 4. ONE full-total cash payment settles the WHOLE group (D2).
    const paymentKey = key();
    const payment = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', paymentKey)
      .send({ tableBillGroupId: billGroupId })
      .expect(201);
    expect(payment.body.data.payment.amountMinor).toBe(77_350);
    expect(payment.body.data.bill.group.status).toBe('closed');
    expect(payment.body.data.bill.orders.map((order: { status: string }) => order.status)).toEqual(['completed', 'completed']);

    const [group] = await db().select().from(tableBillGroups).where(eq(tableBillGroups.id, billGroupId));
    expect(group.status).toBe('closed'); // FR34 auto-close at payment
    const [tableRow] = await db().select().from(tables).where(eq(tables.id, table.body.data.id));
    expect(tableRow.status).toBe('needs_cleaning'); // PRD §13

    // 5. Terminal retry (network hiccup): replayed, NOT double-charged (Q1).
    const retry = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', paymentKey)
      .send({ tableBillGroupId: billGroupId })
      .expect(200);
    expect(retry.body).toEqual(payment.body);

    // A genuinely second payment conflicts (D2).
    const second = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId: billGroupId })
      .expect(409);
    expect(second.body.error.code).toBe('PAYMENT_ALREADY_RECORDED');

    // The customer's own status read now shows the completed order (Q8 shape).
    const publicStatus = await request(server).get(`/api/v1/public/orders/${main.body.data.id}/status`).expect(200);
    expect(publicStatus.body.data).toEqual({ id: main.body.data.id, status: 'completed' });

    // 6. The loop closes: the waiter marks the table cleaned → available
    //    (Contract §3), and the NEXT visit opens a FRESH bill group.
    await request(server)
      .post(`/api/v1/tables/${table.body.data.id}/mark-cleaned`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(201);
    const nextVisit = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: table.body.data.id, items: [{ productId: soup.id, quantity: 1 }] })
      .expect(201);
    expect(nextVisit.body.data.tableBillGroupId).not.toBe(billGroupId);
    expect(nextVisit.body.data.isAddon).toBe(false);

    const groupCount = await db().select().from(tableBillGroups).where(eq(tableBillGroups.tableId, table.body.data.id));
    expect(groupCount).toHaveLength(2); // one closed visit + one fresh open visit
  }, 60_000);
});
