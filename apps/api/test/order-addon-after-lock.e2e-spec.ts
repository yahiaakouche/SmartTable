import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, orders, products, refreshTokens, tableBillGroups } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — the Step 3.3 named critical path (Q12 ruling): "Add-on Order
 * creation after lock", exercised against the FULL application composition
 * (all modules incl. global guards, throttling, envelope + idempotency
 * interceptors, real migrated database, /api/v1 prefix like main.ts):
 *
 *   owner sets up floor & menu → waiter opens the table's first order →
 *   kitchen accepts and starts preparing (order now LOCKED, FR5) →
 *   waiter adds more items ONLY via an add-on order → the add-on lands in
 *   the same Table Bill Group (FR34) with is_addon → idempotent retry of
 *   the add-on replays instead of duplicating (Q1) → the kitchen board
 *   never shows pricing (FR6/Q7) → the customer's status read is minimal
 *   (Q8).
 */
describe('Add-on Order creation after lock (E2E critical path)', () => {
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
    await seedEmployee(db(), { name: 'Sofia', role: 'waiter', pin: '1234' });
    await seedEmployee(db(), { name: 'Yanis', role: 'kitchen', pin: '1234' });
  }, 90_000);

  afterAll(async () => {
    await app.close();
  });

  const pinLogin = async (name: string, role: string, pin: string) => {
    const employee = await seedEmployee(db(), { name: `${name} ${randomBytes(3).toString('hex')}`, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId: employee,
      deviceLabel: 'Floor Terminal',
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/pin-login')
      .send({ deviceRefreshToken: rawToken, employeeId: employee, pin });
    return res.body.data.accessToken as string;
  };

  it('runs the complete add-on-after-lock flow end to end', async () => {
    const server = app.getHttpServer();

    // 1. Owner full login; floor + menu setup through the real APIs.
    const ownerLogin = await request(server)
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' })
      .expect(201);
    const ownerToken = ownerLogin.body.data.accessToken;

    const hall = await request(server)
      .post('/api/v1/halls')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'قاعة رئيسية' })
      .expect(201);
    const table = await request(server)
      .post('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table 7', hallId: hall.body.data.id })
      .expect(201);
    expect(table.body.data.status).toBe('available');

    const [category] = await db().insert(categories).values({ nameAr: 'أطباق رئيسية', nameFr: 'Plats' }).returning();
    const [product] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25000, imagePath: null })
      .returning();
    const [dessert] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'قلب اللوز', nameFr: 'Kalb el louz', priceMinor: 15000, imagePath: null })
      .returning();

    const waiterToken = await pinLogin('Sofia', 'waiter', '1234');
    const kitchenToken = await pinLogin('Yanis', 'kitchen', '1234');

    // 2. Waiter opens the table's first order → bill group auto-opens,
    //    table flips to occupied (FR34).
    const main = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: table.body.data.id, items: [{ productId: product.id, quantity: 2, notes: 'بدون بصل' }] })
      .expect(201);
    expect(main.body.data.isAddon).toBe(false);
    const billGroupId = main.body.data.tableBillGroupId as string;

    const tableAfterFirst = await request(server)
      .get('/api/v1/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(tableAfterFirst.body.data.find((t: { id: string }) => t.id === table.body.data.id).status).toBe('occupied');

    // 3. Kitchen accepts and starts preparing → the order is now LOCKED (FR5).
    const orderId = main.body.data.id as string;
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    const preparing = await request(server)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set('Authorization', `Bearer ${kitchenToken}`)
      .expect(201);
    expect(preparing.body.data.status).toBe('preparing');

    // 4. The guest asks for dessert — the ONLY path now is an Add-on Order
    //    against the same Table Bill Group.
    const addonKey = key();
    const addon = await request(server)
      .post(`/api/v1/orders/${orderId}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', addonKey)
      .send({ items: [{ productId: dessert.id, quantity: 1 }] })
      .expect(201);
    expect(addon.body.data.isAddon).toBe(true);
    expect(addon.body.data.tableBillGroupId).toBe(billGroupId);
    expect(addon.body.data.status).toBe('pending');
    expect(addon.body.data.items[0]).toMatchObject({ name: 'قلب اللوز', unitPriceMinor: 15000 });

    // 5. The terminal retries the add-on (network hiccup) — Q1: replayed,
    //    NOT duplicated.
    const retry = await request(server)
      .post(`/api/v1/orders/${orderId}/addon`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', addonKey)
      .send({ items: [{ productId: dessert.id, quantity: 1 }] })
      .expect(200);
    expect(retry.body).toEqual(addon.body);

    const groupOrders = await db().select().from(orders).where(eq(orders.tableBillGroupId, billGroupId));
    expect(groupOrders).toHaveLength(2); // main + exactly one add-on

    const [group] = await db().select().from(tableBillGroups).where(eq(tableBillGroups.id, billGroupId));
    expect(group.status).toBe('open'); // closing belongs to the billing step

    // 6. Kitchen board: both orders visible, pricing nowhere (FR6/Q7).
    const kitchenBoard = await request(server)
      .get(`/api/v1/orders?tableId=${table.body.data.id}`)
      .set('Authorization', `Bearer ${kitchenToken}`)
      .expect(200);
    expect(kitchenBoard.body.data).toHaveLength(2);
    for (const order of kitchenBoard.body.data) {
      for (const item of order.items) expect(item.unitPriceMinor).toBeUndefined();
    }

    // 7. The customer's own status read stays minimal (Q8).
    const publicStatus = await request(server).get(`/api/v1/public/orders/${addon.body.data.id}/status`).expect(200);
    expect(publicStatus.body.data).toEqual({ id: addon.body.data.id, status: 'pending' });
  }, 60_000);
});
