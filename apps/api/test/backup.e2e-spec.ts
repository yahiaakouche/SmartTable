import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { categories, products, refreshTokens, restaurantProfile } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

const BACKUP_DIR = process.env.BACKUP_DIRECTORY!;

/**
 * E2E — Step 3.9 critical path (Engineering Standards §10), against the FULL
 * application composition (real migrated database, /api/v1 prefix):
 *
 *   a real guest visit (hall/table/product → waiter order → kitchen
 *   accept/prepare/ready → waiter serve → cashier payment) is taken through
 *   the live API; the Owner then exports a backup over real HTTP and the
 *   downloaded attachment is opened as a REAL database — the visit must be
 *   inside it (the strongest possible proof that the snapshot engine captures
 *   the live business data, FR13/§2). The B3 access matrix (Owner+Manager,
 *   floor roles 403, anonymous 401) is exercised over real HTTP.
 */
describe('Backup (E2E critical path)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const key = () => 'e2e-' + randomBytes(12).toString('hex');

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
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });

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
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  });

  it('a full paid guest visit survives into the Owner-downloaded snapshot, opened as a real database (§2/B2(a))', async () => {
    const server = app.getHttpServer();

    // ---- a real guest visit through the live API ----
    const hall = await request(server).post('/api/v1/halls').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'قاعة' }).expect(201);
    const table = (
      await request(server)
        .post('/api/v1/tables')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ label: 'Table A', hallId: hall.body.data.id })
        .expect(201)
    ).body.data.id as string;
    const [category] = await db().insert(categories).values({ nameAr: 'أطباق', nameFr: 'Plats' }).returning();
    const [soup] = await db()
      .insert(products)
      .values({ categoryId: category.id, nameAr: 'شوربة عدس', nameFr: 'Soupe', priceMinor: 25_000, imagePath: null })
      .returning();
    await db()
      .insert(restaurantProfile)
      .values({ name: 'Restaurant El Djazair', primaryColor: '#111111', secondaryColor: '#eeeeee', taxRatePercent: 1900 });

    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('Idempotency-Key', key())
      .send({ tableId: table, items: [{ productId: soup.id, quantity: 2 }] })
      .expect(201);
    const orderId = created.body.data.id as string;
    await request(server).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/advance`).set('Authorization', `Bearer ${kitchenToken}`).expect(201);
    await request(server).post(`/api/v1/orders/${orderId}/serve`).set('Authorization', `Bearer ${waiterToken}`).expect(201);
    await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key())
      .send({ tableBillGroupId: created.body.data.tableBillGroupId })
      .expect(201);

    // ---- the Owner exports a backup over real HTTP (B2(a) attachment) ----
    const backup = await request(server).post('/api/v1/backup/create').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    expect(backup.headers['content-disposition']).toMatch(/^attachment; filename="smarttable-backup-\d{8}-\d{6}-manual\.db"$/);
    expect(backup.headers['content-type']).toContain('application/octet-stream');

    // ---- the attachment opens as a REAL database and the visit is inside ----
    const downloaded = backup.body as Buffer;
    expect(downloaded.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    const probe = new Database(Buffer.from(downloaded) as never, { readonly: true });
    expect(probe.pragma('integrity_check', { simple: true })).toBe('ok');
    const row = probe
      .prepare(`SELECT o.status AS status, oi.name_snapshot AS nameSnapshot, oi.quantity AS quantity, oi.unit_price_minor_snapshot AS unitPrice
                FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.id = ?`)
      .get(orderId) as { status: string; nameSnapshot: string; quantity: number; unitPrice: number };
    probe.close();
    expect(row).toMatchObject({ nameSnapshot: 'شوربة عدس', quantity: 2, unitPrice: 25_000 });
    expect(['paid', 'completed']).toContain(row.status);

    // ---- the server-side copy and the history row agree (D4) ----
    const files = await fs.readdir(BACKUP_DIR);
    expect(files).toHaveLength(1);
    const history = await request(server).get('/api/v1/backup/history').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      status: 'success',
      trigger: 'manual',
      sizeBytes: (await fs.stat(`${BACKUP_DIR}/${files[0]}`)).size,
      filePath: `${BACKUP_DIR}/${files[0]}`,
    });
  }, 90_000);

  it('enforces B3 over real HTTP: Owner + Manager, floor roles 403, anonymous 401', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/backup/history').set('Authorization', `Bearer ${managerToken}`).expect(200);
    for (const token of [waiterToken, kitchenToken, cashierToken]) {
      const create = await request(server).post('/api/v1/backup/create').set('Authorization', `Bearer ${token}`).expect(403);
      expect(create.body.error.code).toBe('INSUFFICIENT_PERMISSION');
      await request(server).get('/api/v1/backup/history').set('Authorization', `Bearer ${token}`).expect(403);
    }
    await request(server).post('/api/v1/backup/create').expect(401);
    await request(server).get('/api/v1/backup/history').expect(401);
  }, 30_000);
});
