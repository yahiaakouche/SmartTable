import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { auditLog, refreshTokens, restaurantProfile } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { TablesModule } from '../tables/tables.module';
import { RestaurantConfigModule } from './restaurant-config.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

const UPLOAD_DIR = process.env.UPLOAD_DIRECTORY!;

/**
 * Integration: the config module against a real, migrated SQLite database
 * and the real UPLOAD_DIRECTORY (Engineering Standards §10). Covered: the
 * D6 read matrix, the full PATCH flow (fields + real logo through the real
 * Security §6 pipeline, D4 ordering, D8 audit, D7 post-commit broadcast),
 * upload rejections, the B3(a) 404 semantics, the validation matrix, the
 * B1(a) Owner-only mutation matrix, the D3 no-op discipline, and the B2(a)
 * branding on the public customer menu.
 */
describe('RestaurantConfigModule (integration)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const authed = () => request(app.getHttpServer());

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, RestaurantConfigModule, TablesModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
    await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
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

  /** The Setup Wizard's future job (B3(a)) — done directly here exactly the
   * way billing/analytics fixtures seed the row. */
  const seedProfile = async (overrides: Record<string, unknown> = {}) => {
    const [row] = await db()
      .insert(restaurantProfile)
      .values({
        name: 'Restaurant El Djazair',
        logoPath: null,
        primaryColor: '#111111',
        secondaryColor: '#eeeeee',
        currencyCode: 'DZD',
        taxRatePercent: 1900,
        defaultLanguage: 'ar',
        ...overrides,
      })
      .returning();
    return row;
  };

  const makePng = (background = '#225533') => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();

  const profileAudits = () => db().select().from(auditLog).where(eq(auditLog.entityType, 'restaurant_profile'));

  it('GET is open to all five staff roles, 401 anonymous (D6)', async () => {
    await seedProfile();
    for (const [name, role] of [['Karim', 'owner'], ['Amina', 'manager'], ['Lina', 'cashier'], ['Sofia', 'waiter'], ['Yanis', 'kitchen']] as const) {
      const login = await loginWithPin(name, role);
      const res = await authed().get('/config/restaurant-profile').set('Authorization', `Bearer ${login.token}`).expect(200);
      expect(res.body.data).toMatchObject({ name: 'Restaurant El Djazair', taxRatePercent: 1900, currencyCode: 'DZD', defaultLanguage: 'ar' });
    }
    await authed().get('/config/restaurant-profile').expect(401);
  });

  it('PATCH (multipart fields + real logo) updates the row, audits the changed fields, broadcasts AFTER commit, serves the logo publicly', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await seedProfile();
    const events = app.get(DomainEventsService);
    const seen: unknown[] = [];
    events.on(DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED, (payload) => seen.push(payload));

    const res = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .field('name', 'مطعم الجزائر')
      .field('primaryColor', '#aabbcc')
      .field('taxRatePercent', '900')
      .field('defaultLanguage', 'fr')
      .attach('logo', await makePng(), 'logo.jpg') // sniffed as PNG despite the name
      .expect(200);

    expect(res.body.data).toMatchObject({ name: 'مطعم الجزائر', primaryColor: '#aabbcc', taxRatePercent: 900, defaultLanguage: 'fr' });
    expect(res.body.data.logoPath).toMatch(/^[0-9a-f-]{36}\.png$/);

    // The row itself moved (not just the response).
    const [row] = await db().select().from(restaurantProfile);
    expect(row).toMatchObject({ name: 'مطعم الجزائر', primaryColor: '#aabbcc', secondaryColor: '#eeeeee', currencyCode: 'DZD', taxRatePercent: 900, defaultLanguage: 'fr', logoPath: res.body.data.logoPath });

    // D8 — one audit row, changed fields only, actor attributed.
    const audits = await profileAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorEmployeeId: owner.employeeId, action: 'profile_updated' });
    expect(JSON.parse(audits[0].oldValueJson!)).toEqual({ name: 'Restaurant El Djazair', primaryColor: '#111111', logoPath: null, taxRatePercent: 1900, defaultLanguage: 'ar' });
    expect(JSON.parse(audits[0].newValueJson!)).toEqual({ name: 'مطعم الجزائر', primaryColor: '#aabbcc', logoPath: res.body.data.logoPath, taxRatePercent: 900, defaultLanguage: 'fr' });

    // D7 — exactly one broadcast, carrying the FULL updated DTO.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(res.body.data);

    // The logo is servable through the existing public upload endpoint.
    const upload = await authed().get(`/uploads/${res.body.data.logoPath}`).expect(200);
    expect(upload.headers['content-type']).toBe('image/png');
  });

  it('logo replacement releases the old file only after the new one commits (D4)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await seedProfile();

    const first = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('logo', await makePng('#111122'), 'a.png')
      .expect(200);
    const firstPath = first.body.data.logoPath as string;
    await fs.access(`${UPLOAD_DIR}/${firstPath}`); // stored for real

    const second = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('logo', await makePng('#334411'), 'b.png')
      .expect(200);
    const secondPath = second.body.data.logoPath as string;
    expect(secondPath).not.toBe(firstPath);

    await expect(fs.access(`${UPLOAD_DIR}/${firstPath}`)).rejects.toThrow(); // released
    await authed().get(`/uploads/${secondPath}`).expect(200); // served
  });

  it('upload rejections (SVG, oversize, fake magic) are 400s that persist nothing', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await seedProfile();

    const cases: Array<{ name: string; buffer: Buffer }> = [
      { name: 'svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
      { name: 'oversize', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]) },
      { name: 'fake-magic', buffer: Buffer.from('this is not an image at all') },
    ];
    for (const bad of cases) {
      const res = await authed()
        .patch('/config/restaurant-profile')
        .set('Authorization', `Bearer ${owner.token}`)
        .attach('logo', bad.buffer, `${bad.name}.png`)
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_FILE_UPLOAD');
    }

    // Row untouched, no audit trail, nothing stored.
    const [row] = await db().select().from(restaurantProfile);
    expect(row).toMatchObject({ name: 'Restaurant El Djazair', logoPath: null });
    expect(await profileAudits()).toHaveLength(0);
    await expect(fs.readdir(UPLOAD_DIR)).rejects.toThrow(); // directory never even created
  });

  it('B3(a): GET and PATCH are 404 NOT_FOUND while no profile row exists', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const get = await authed().get('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).expect(404);
    expect(get.body.error.code).toBe('NOT_FOUND');
    const patch = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Too Early' })
      .expect(404);
    expect(patch.body.error.code).toBe('NOT_FOUND');
    expect(await db().select().from(restaurantProfile)).toHaveLength(0); // never created
  });

  it('validates the PATCH DTO (400 VALIDATION_FAILED), including the wizard-owned field (D10)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await seedProfile();
    const cases = [
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ primaryColor: 'red' }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ secondaryColor: '#12345' }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ taxRatePercent: 10001 }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ taxRatePercent: -1 }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ currencyCode: 'dz' }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ defaultLanguage: 'de' }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({ setupCompletedAt: 123 }),
      () => authed().patch('/config/restaurant-profile').set('Authorization', `Bearer ${owner.token}`).send({}),
    ];
    for (const build of cases) {
      const res = await build().expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('enforces B1(a) over real HTTP: mutation is Owner-only; Manager and floor roles 403, anonymous 401', async () => {
    await seedProfile();
    const owner = await loginWithPin('Karim', 'owner');
    const denied = [await loginWithPin('Amina', 'manager'), await loginWithPin('Sofia', 'waiter'), await loginWithPin('Yanis', 'kitchen'), await loginWithPin('Lina', 'cashier')];
    for (const login of denied) {
      const res = await authed()
        .patch('/config/restaurant-profile')
        .set('Authorization', `Bearer ${login.token}`)
        .send({ primaryColor: '#000000' })
        .expect(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
    }
    await authed().patch('/config/restaurant-profile').send({ primaryColor: '#000000' }).expect(401);

    const ok = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ primaryColor: '#000000' })
      .expect(200);
    expect(ok.body.data.primaryColor).toBe('#000000');
  });

  it('a true no-op PATCH is a silent 200: no write, no audit, no broadcast (D3)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const seeded = await seedProfile();
    const events = app.get(DomainEventsService);
    const seen: unknown[] = [];
    events.on(DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED, (payload) => seen.push(payload));

    const res = await authed()
      .patch('/config/restaurant-profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Restaurant El Djazair', taxRatePercent: 1900 })
      .expect(200);
    expect(res.body.data.updatedAt).toBe(seeded.updatedAt); // row never rewritten
    expect(await profileAudits()).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('B2(a): the public customer menu carries the branding object — and still serves with restaurant null pre-setup', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const hall = await authed().post('/halls').set('Authorization', `Bearer ${owner.token}`).send({ name: 'قاعة' }).expect(201);
    const table = await authed()
      .post('/tables')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ label: 'Table A', hallId: hall.body.data.id })
      .expect(201);
    const qrToken = table.body.data.qrToken as string;

    // Pre-setup: menu serves, branding is explicitly null (fresh install).
    const preSetup = await authed().get(`/public/menu/${qrToken}`).expect(200);
    expect(preSetup.body.data.restaurant).toBeNull();

    await seedProfile({ logoPath: null, primaryColor: '#abcdef' });
    const menu = await authed().get(`/public/menu/${qrToken}`).expect(200);
    expect(menu.body.data.restaurant).toEqual({
      name: 'Restaurant El Djazair',
      logoPath: null,
      primaryColor: '#abcdef',
      secondaryColor: '#eeeeee',
      currencyCode: 'DZD',
      defaultLanguage: 'ar',
    });
    // The branding subset never leaks staff-only concerns.
    expect(menu.body.data.restaurant.taxRatePercent).toBeUndefined();
    expect(menu.body.data.restaurant.setupCompletedAt).toBeUndefined();
    expect(menu.body.data.restaurant.id).toBeUndefined();
  });
});
