import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { auditLog, categories, halls, orders, products, refreshTokens, tableBillGroups, tables } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { MenuModule } from '../menu/menu.module';
import { TablesModule } from './tables.module';
import { DOMAIN_EVENT, DomainEventsService, TableStatusChangedPayload } from '../../common/events/domain-events.service';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

/**
 * Integration: the tables module against a real, migrated SQLite database
 * (Engineering Standards §10). Covers the QR token lifecycle (FR16, FR21,
 * FR32, FR35), the removal guard with real orders fixtures (Contract §2),
 * mark-cleaned transitions and their post-commit event, the unauthenticated
 * customer menu resolution (FR2), and the PRD §11 permission boundaries.
 */
describe('TablesModule (integration)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;
  let waiterToken: string;
  let kitchenToken: string;

  const loginOwnerManager = async (name: string, password: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/password-login')
      .send({ name, password, deviceLabel: `${name} Laptop` });
    return res.body.data.accessToken as string;
  };

  const loginWithPin = async (name: string, role: string, pin: string) => {
    const employeeId = await seedEmployee(getDb(app), { name, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await getDb(app)
      .insert(refreshTokens)
      .values({
        employeeId,
        deviceLabel: `${name} Terminal`,
        tokenHash: TokensService.hashToken(rawToken),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 30 * 86_400_000,
      });
    const res = await request(app.getHttpServer())
      .post('/auth/pin-login')
      .send({ deviceRefreshToken: rawToken, employeeId, pin });
    return res.body.data.accessToken as string;
  };

  const createHall = async (name = 'Main Hall') => {
    const res = await request(app.getHttpServer())
      .post('/halls')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name })
      .expect(201);
    return res.body.data as { id: string };
  };

  const createTable = async (hallId: string, label = 'Table 1') => {
    const res = await request(app.getHttpServer())
      .post('/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label, hallId })
      .expect(201);
    return res.body.data as { id: string; qrToken: string; status: string };
  };

  /** Fixture order chain (bill group → order) exactly as the orders step
   * will write it — used to exercise the removal guard honestly. */
  const seedOrderForTable = async (tableId: string, status: string) => {
    const [group] = await getDb(app).insert(tableBillGroups).values({ tableId }).returning();
    const [order] = await getDb(app)
      .insert(orders)
      .values({ tableBillGroupId: group.id, tableId, channel: 'dine_in', isAddon: false, status, source: 'qr' })
      .returning();
    return order;
  };

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, MenuModule, TablesModule],
      })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );

    await seedEmployee(getDb(app), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    ownerToken = await loginOwnerManager('Karim', 'owner-secret-1');
    await seedEmployee(getDb(app), { name: 'Amina', role: 'manager', password: 'manager-secret-1' });
    managerToken = await loginOwnerManager('Amina', 'manager-secret-1');
    cashierToken = await loginWithPin('Yacine', 'cashier', '1234');
    waiterToken = await loginWithPin('Sofia', 'waiter', '1234');
    kitchenToken = await loginWithPin('Yanis', 'kitchen', '1234');
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates halls and tables — every table is born with an unguessable QR token (FR16, FR35)', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    expect(table.status).toBe('available');
    expect(table.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = await createTable(hall.id, 'Table 2');
    expect(second.qrToken).not.toBe(table.qrToken); // FR32: tokens are per-table, never reused

    const list = await request(app.getHttpServer())
      .get('/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(2);
  });

  it('rejects table creation under a missing hall and bad DTO shapes', async () => {
    await request(app.getHttpServer())
      .post('/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Orphan', hallId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);

    const bad = await request(app.getHttpServer())
      .post('/tables')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: 'not-a-uuid' })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('renames and reassigns tables; rejects reassignment to an inactive hall', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    const renamed = await request(app.getHttpServer())
      .patch(`/tables/${table.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'Table 1 (Window)' })
      .expect(200);
    expect(renamed.body.data.label).toBe('Table 1 (Window)');

    // fixture: a soft-deleted hall cannot receive tables
    const [deadHall] = await getDb(app)
      .insert(halls)
      .values({ name: 'Closed Hall', sortOrder: 9, isActive: false })
      .returning();
    await request(app.getHttpServer())
      .patch(`/tables/${table.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ hallId: deadHall.id })
      .expect(404);
  });

  it('blocks removal with 409 TABLE_HAS_ACTIVE_ORDER until every order is terminal', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);
    const order = await seedOrderForTable(table.id, 'served');

    const blocked = await request(app.getHttpServer())
      .delete(`/tables/${table.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(blocked.body.error.code).toBe('TABLE_HAS_ACTIVE_ORDER');

    await getDb(app).update(orders).set({ status: 'completed' }).where(eq(orders.id, order.id));

    await request(app.getHttpServer())
      .delete(`/tables/${table.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const rows = await getDb(app).select().from(tables).where(eq(tables.id, table.id));
    expect(rows[0].isActive).toBe(false); // soft delete — the row (and its history) stays
  });

  it('regenerate-qr invalidates the old token and writes the FR38 audit row', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    await request(app.getHttpServer()).get(`/public/menu/${table.qrToken}`).expect(200); // old token works

    const regenerated = await request(app.getHttpServer())
      .post(`/tables/${table.id}/regenerate-qr`)
      .set('Authorization', `Bearer ${managerToken}`) // Manager allowed per ruling R2
      .expect(201);
    const newToken = regenerated.body.data.qrToken;
    expect(newToken).not.toBe(table.qrToken);

    await request(app.getHttpServer()).get(`/public/menu/${table.qrToken}`).expect(404); // invalidated (FR21)
    await request(app.getHttpServer()).get(`/public/menu/${newToken}`).expect(200);

    const rows = await getDb(app).select().from(auditLog).where(eq(auditLog.action, 'qr_regenerated'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'table',
      entityId: table.id,
      oldValueJson: JSON.stringify({ qrToken: table.qrToken }),
      newValueJson: JSON.stringify({ qrToken: newToken }),
    });
  });

  it('mark-cleaned closes the loop needs_cleaning → available and emits post-commit', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    const received: TableStatusChangedPayload[] = [];
    app.get(DomainEventsService).on(DOMAIN_EVENT.TABLE_STATUS_CHANGED, (p) =>
      received.push(p as TableStatusChangedPayload),
    );

    // from 'available' — illegal (ruling R6)
    const illegal = await request(app.getHttpServer())
      .post(`/tables/${table.id}/mark-cleaned`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(409);
    expect(illegal.body.error.code).toBe('INVALID_TABLE_STATUS_TRANSITION');
    expect(received).toHaveLength(0);

    // move the fixture to needs_cleaning (as payment completion will do)
    await getDb(app).update(tables).set({ status: 'needs_cleaning' }).where(eq(tables.id, table.id));

    const cleaned = await request(app.getHttpServer())
      .post(`/tables/${table.id}/mark-cleaned`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .expect(201);
    expect(cleaned.body.data.status).toBe('available');
    expect(received).toEqual([{ tableId: table.id, fromStatus: 'needs_cleaning', toStatus: 'available' }]);
  });

  it('public menu resolves unauthenticated and exposes ONLY available products of active categories (FR2, FR31)', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    // fixtures: one available + one hidden product, one inactive category
    const [category] = await getDb(app).insert(categories).values({ nameAr: 'مشروبات', nameFr: 'Boissons', sortOrder: 0 }).returning();
    const [hiddenCategory] = await getDb(app)
      .insert(categories)
      .values({ nameAr: 'مخفي', nameFr: 'Hidden', sortOrder: 1, isActive: false })
      .returning();
    await getDb(app).insert(products).values([
      { categoryId: category.id, nameAr: 'قهوة', nameFr: 'Café', priceMinor: 15000, isAvailable: true, sortOrder: 0 },
      { categoryId: category.id, nameAr: 'شاي', nameFr: 'Thé', priceMinor: 8000, isAvailable: false, sortOrder: 1 },
      { categoryId: hiddenCategory.id, nameAr: 'x', nameFr: 'Secret', priceMinor: 100, isAvailable: true, sortOrder: 0 },
    ]);

    const res = await request(app.getHttpServer()).get(`/public/menu/${table.qrToken}`).expect(200);

    expect(res.body.data.table).toMatchObject({ label: 'Table 1', hallName: 'Main Hall' });
    expect(res.body.data.categories).toHaveLength(1); // inactive category gone
    expect(res.body.data.categories[0].products.map((p: { nameFr: string }) => p.nameFr)).toEqual(['Café']);
    expect(res.body.data.categories[0].products[0]).not.toHaveProperty('isAvailable');

    // unknown token → identical 404, no oracle
    const unknown = await request(app.getHttpServer()).get('/public/menu/definitely-not-a-real-token').expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
  });

  it('enforces the PRD §11 boundaries: Kitchen cannot view the map, Cashier cannot manage, Waiter can mark-cleaned', async () => {
    const hall = await createHall();
    const table = await createTable(hall.id);

    // Kitchen: no floor-map access at all (matrix row "View table map" ❌)
    const kitchenDenied = await request(app.getHttpServer())
      .get('/tables')
      .set('Authorization', `Bearer ${kitchenToken}`)
      .expect(403);
    expect(kitchenDenied.body.error.code).toBe('INSUFFICIENT_PERMISSION');

    // Cashier: can view (payment view) but not manage
    await request(app.getHttpServer()).get('/tables').set('Authorization', `Bearer ${cashierToken}`).expect(200);
    await request(app.getHttpServer())
      .post('/tables')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ label: 'Nope', hallId: hall.id })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/tables/${table.id}/mark-cleaned`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(403);

    // Manager: full table management per ruling R2
    await request(app.getHttpServer())
      .post('/tables')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ label: 'Manager Table', hallId: hall.id })
      .expect(201);

    const deniedRows = await getDb(app).select().from(auditLog).where(eq(auditLog.action, 'permission_denied'));
    expect(deniedRows.length).toBeGreaterThanOrEqual(3);
  });
});
