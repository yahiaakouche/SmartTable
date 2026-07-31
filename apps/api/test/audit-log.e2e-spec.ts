import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, products, refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — Step 3.8 critical path (Engineering Standards §10), against the FULL
 * application composition (real migrated database, /api/v1 prefix):
 *
 *   real business actions driven over REST (a product price change and an
 *   employee+invitation creation — two FR38-mandated triggers) are recorded
 *   by the existing append path and become readable through GET /audit-log
 *   with the actor's id AND name (B3(b)), parsed old/new values (D6), the
 *   frozen filters (Contract §3), and the B1 access matrix (Owner/Manager
 *   only) enforced over real HTTP.
 */
describe('Audit log query surface (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);

  let ownerId: string;
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

    ownerId = await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
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

  it('FR38-mandated actions over REST become readable, filterable audit entries (B3(b)/D6)', async () => {
    const server = app.getHttpServer();

    // Two real FR38 triggers driven over REST: a price change and an
    // employee + invitation creation.
    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [product] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();
    await request(server)
      .patch(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ priceMinor: 30_000 })
      .expect(200);
    const createdEmployee = await request(server)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Nour', role: 'waiter' })
      .expect(201);

    const audit = (token: string, query = '') =>
      request(server).get(`/api/v1/audit-log${query}`).set('Authorization', `Bearer ${token}`);

    const res = await audit(ownerToken).expect(200);
    const entries = res.body.data as {
      actorEmployeeId: string | null;
      actorName: string | null;
      entityType: string;
      entityId: string;
      action: string;
      oldValue: unknown;
      newValue: unknown;
      createdAt: number;
    }[];

    const priceChange = entries.find((e) => e.action === 'price_changed' && e.entityId === product.id);
    expect(priceChange).toMatchObject({
      actorEmployeeId: ownerId,
      actorName: 'Karim', // B3(b) — resolved via the read-side join
      entityType: 'product',
      oldValue: { priceMinor: 25_000 }, // D6 — parsed, never raw strings
      newValue: { priceMinor: 30_000 },
      createdAt: expect.any(Number),
    });

    const employeeCreated = entries.find((e) => e.action === 'employee_created');
    expect(employeeCreated).toMatchObject({
      actorEmployeeId: ownerId,
      actorName: 'Karim',
      entityType: 'employee',
      entityId: createdEmployee.body.data.employee.id,
      newValue: { name: 'Nour', role: 'waiter' },
    });

    // The frozen filters work end-to-end (Contract §3).
    const productsOnly = await audit(ownerToken, '?entityType=product').expect(200);
    expect(productsOnly.body.data.every((e: { entityType: string }) => e.entityType === 'product')).toBe(true);
    const byActor = await audit(ownerToken, `?actorEmployeeId=${ownerId}`).expect(200);
    expect(byActor.body.data.length).toBeGreaterThanOrEqual(2);
    const byWindow = await audit(ownerToken, `?to=${Date.now()}`).expect(200);
    expect(byWindow.body.data.length).toBe(entries.length);

    // B1 over real HTTP: Owner + Manager read; floor roles 403; anonymous 401.
    await audit(managerToken).expect(200);
    for (const token of [waiterToken, kitchenToken, cashierToken]) {
      const denied = await audit(token).expect(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSION');
    }
    await request(server).get('/api/v1/audit-log').expect(401);
  }, 90_000);
});
