import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { auditLog, categories, orderItems, orders, products, refreshTokens, tableBillGroups, tables, halls } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { MenuModule } from './menu.module';
import { DOMAIN_EVENT, DomainEventsService, ProductAvailabilityChangedPayload } from '../../common/events/domain-events.service';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the menu module against a real, migrated SQLite database
 * (Engineering Standards §10 — mandatory for persistence modules). Covers
 * CRUD with the frozen delete semantics (soft categories / hard products),
 * FR38 price auditing, the Contract §4 availability event, RBAC (FR19),
 * DTO validation, and the Security §6 multipart upload pipeline end to end.
 */
describe('MenuModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let waiterToken: string;

  const makePng = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#225533' } }).png().toBuffer();

  const createCategory = async (nameFr = 'Boissons') => {
    const res = await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ nameAr: 'مشروبات', nameFr })
      .expect(201);
    return res.body.data as { id: string };
  };

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, MenuModule],
      })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );

    await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = ownerLogin.body.data.accessToken;

    // Waiter on a trusted device (PIN path) — for the RBAC boundary tests.
    const waiterId = await seedEmployee(getDb(app), { name: 'Sofia', role: 'waiter', pin: '1234' });
    const rawToken = randomBytes(48).toString('base64url');
    await getDb(app)
      .insert(refreshTokens)
      .values({
        employeeId: waiterId,
        deviceLabel: 'Waiter Tablet',
        tokenHash: TokensService.hashToken(rawToken),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 30 * 86_400_000,
      });
    const pinLogin = await request(app.getHttpServer())
      .post('/auth/pin-login')
      .send({ deviceRefreshToken: rawToken, employeeId: waiterId, pin: '1234' });
    waiterToken = pinLogin.body.data.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates categories and products and reads them back through the envelope', async () => {
    const category = await createCategory();

    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'قهوة')
      .field('nameFr', 'Café')
      .field('priceMinor', '15000')
      .field('categoryId', category.id)
      .expect(201);
    expect(created.body.data).toMatchObject({
      nameFr: 'Café',
      priceMinor: 15000,
      categoryId: category.id,
      isAvailable: true,
      imagePath: null,
    });

    const list = await request(app.getHttpServer())
      .get('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(list.body.meta.total).toBe(1);

    const filtered = await request(app.getHttpServer())
      .get(`/products?categoryId=${category.id}&isAvailable=true`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(filtered.body.data).toHaveLength(1);

    const emptyFilter = await request(app.getHttpServer())
      .get('/products?isAvailable=false')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(emptyFilter.body.data).toHaveLength(0);
  });

  it('audits a price change with old/new values in the real audit_log (FR38)', async () => {
    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'شاي')
      .field('nameFr', 'Thé')
      .field('priceMinor', '8000')
      .expect(201);
    const productId = created.body.data.id;

    await request(app.getHttpServer())
      .patch(`/products/${productId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('priceMinor', '9500')
      .expect(200);

    const rows = await getDb(app).select().from(auditLog).where(eq(auditLog.action, 'price_changed'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'product',
      entityId: productId,
      oldValueJson: JSON.stringify({ priceMinor: 8000 }),
      newValueJson: JSON.stringify({ priceMinor: 9500 }),
    });
  });

  it('emits product.availability_changed on the internal bus only when availability flips', async () => {
    const received: ProductAvailabilityChangedPayload[] = [];
    app.get(DomainEventsService).on(DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED, (p) =>
      received.push(p as ProductAvailabilityChangedPayload),
    );

    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'عصير')
      .field('nameFr', 'Jus')
      .field('priceMinor', '5000')
      .expect(201);
    const productId = created.body.data.id;

    await request(app.getHttpServer())
      .patch(`/products/${productId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('isAvailable', 'false')
      .expect(200);
    // same value again → no second event
    await request(app.getHttpServer())
      .patch(`/products/${productId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('isAvailable', 'false')
      .expect(200);

    expect(received).toEqual([{ productId, isAvailable: false }]);
  });

  it('enforces FR19: waiters may VIEW the menu but every mutation is 403 + audited', async () => {
    await request(app.getHttpServer()).get('/products').set('Authorization', `Bearer ${waiterToken}`).expect(200);
    await request(app.getHttpServer()).get('/categories').set('Authorization', `Bearer ${waiterToken}`).expect(200);

    const denied = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${waiterToken}`)
      .field('nameAr', 'x')
      .field('nameFr', 'x')
      .field('priceMinor', '100')
      .expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSION');

    const rows = await getDb(app).select().from(auditLog).where(eq(auditLog.action, 'permission_denied'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('runs the Security §6 pipeline end to end: upload → re-encode → public read', async () => {
    const png = await makePng();
    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'بيتزا')
      .field('nameFr', 'Pizza')
      .field('priceMinor', '45000')
      .attach('image', png, 'photo-from-phone.jpg') // declared name/extension deliberately wrong — content wins
      .expect(201);

    const imagePath = created.body.data.imagePath as string;
    expect(imagePath).toMatch(/^[0-9a-f-]{36}\.png$/); // sniffed as PNG despite .jpg name

    // served publicly (customer QR menu shows images without auth)
    const served = await request(app.getHttpServer()).get(`/uploads/${imagePath}`).expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    const meta = await sharp(served.body).metadata();
    expect(meta.format).toBe('png');
  });

  it('rejects an SVG upload even with an image filename (Security §6)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'x')
      .field('nameFr', 'x')
      .field('priceMinor', '100')
      .attach('image', svg, 'logo.png')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_FILE_UPLOAD');

    expect(await getDb(app).select().from(products)).toHaveLength(0); // no partial row left behind
  });

  it('rejects bad DTO shapes (float money, unknown fields, negative price)', async () => {
    const post = () =>
      request(app.getHttpServer()).post('/products').set('Authorization', `Bearer ${ownerToken}`);

    const asFloat = await post().field('nameAr', 'x').field('nameFr', 'x').field('priceMinor', '19.99').expect(400);
    expect(asFloat.body.error.code).toBe('VALIDATION_FAILED');

    const unknown = await post()
      .field('nameAr', 'x')
      .field('nameFr', 'x')
      .field('priceMinor', '100')
      .field('hackerField', 'boo')
      .expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_FAILED');

    const negative = await post().field('nameAr', 'x').field('nameFr', 'x').field('priceMinor', '-5').expect(400);
    expect(negative.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('hard-deletes products; order_items snapshots survive with product_id SET NULL (ADR-012)', async () => {
    const category = await createCategory();
    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'قهوة')
      .field('nameFr', 'Café')
      .field('priceMinor', '15000')
      .field('categoryId', category.id)
      .expect(201);
    const productId = created.body.data.id;

    // Fixture: a historical order line referencing this product (as the
    // orders step will write it — snapshot fields carry the truth).
    const [hall] = await getDb(app).insert(halls).values({ name: 'Main', sortOrder: 0 }).returning();
    const [table] = await getDb(app)
      .insert(tables)
      .values({ hallId: hall.id, label: 'T1', qrToken: randomBytes(32).toString('base64url') })
      .returning();
    const [group] = await getDb(app).insert(tableBillGroups).values({ tableId: table.id }).returning();
    const [order] = await getDb(app)
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId: table.id, channel: 'dine_in', isAddon: false, status: 'completed', source: 'qr' })
      .returning();
    await getDb(app).insert(orderItems).values({
      orderId: order.id,
      productId,
      nameSnapshot: 'Café',
      categorySnapshot: 'Boissons',
      unitPriceMinorSnapshot: 15000,
      quantity: 2,
    });

    await request(app.getHttpServer())
      .delete(`/products/${productId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(await getDb(app).select().from(products)).toHaveLength(0); // truly gone (hard delete)
    const itemRows = await getDb(app).select().from(orderItems);
    expect(itemRows[0].productId).toBeNull(); // FK SET NULL fired
    expect(itemRows[0].nameSnapshot).toBe('Café'); // snapshot untouched — history intact
    expect(itemRows[0].unitPriceMinorSnapshot).toBe(15000);
  });

  it('soft-deletes categories — row remains for referential integrity', async () => {
    const category = await createCategory('Pâtisserie');

    await request(app.getHttpServer())
      .delete(`/categories/${category.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const rows = await getDb(app).select().from(categories).where(eq(categories.id, category.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(false);

    // and an inactive category can no longer receive products
    await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('nameAr', 'x')
      .field('nameFr', 'x')
      .field('priceMinor', '100')
      .field('categoryId', category.id)
      .expect(404);
  });

  it('returns NOT_FOUND for unknown category/product ids', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const res = await request(app.getHttpServer())
      .patch(`/products/${missing}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('priceMinor', '100')
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    await request(app.getHttpServer())
      .delete(`/categories/${missing}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });
});
