import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { auditLog, employees, halls, restaurantProfile, tables } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TablesModule } from '../tables/tables.module';
import { RestaurantConfigModule } from '../config/restaurant-config.module';
import { SetupWizardModule } from './setup-wizard.module';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb } from '../../../test/helpers/test-app';

const UPLOAD_DIR = process.env.UPLOAD_DIRECTORY!;

/**
 * Integration: the setup wizard against a real, migrated SQLite database
 * and the real UPLOAD_DIRECTORY (Engineering Standards §10). Covered: the
 * public status endpoint before/after (B1(a)), the full atomic completion
 * with a real logo through the Security §6 pipeline (B5(a)), the FR15
 * defaults, the B2(a) hall/table batch with FR16 QR tokens, the Argon2id
 * first-Owner credentials (B4(a)), the D9 audit row, the one-shot guard
 * including the concurrent double-submit race (D5), the validation
 * matrix, upload rejection rollback, and the post-setup login + public
 * menu branding chain (D11, 3.10 B2(a)).
 */
describe('SetupWizardModule (integration)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [
          ConfigModule,
          DatabaseModule,
          EventsModule,
          AuditModule,
          AuthModule,
          RestaurantConfigModule,
          TablesModule,
          SetupWizardModule,
        ],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
    await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
  });

  const makePng = (background = '#225533') =>
    sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();

  /** Builds a complete-request thunk. Requests are built INSIDE loops —
   * supertest's serverAddress() binds lazily per build and awaiting closes
   * the server, so eager batching breaks (the audit suite's pattern). */
  const completeRequest = (fields: Record<string, string> = {}) => {
    const merged: Record<string, string> = {
      name: 'Restaurant El Djazair',
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      tableCount: '3',
      ownerName: 'Karim',
      ownerPassword: 'sup3rsecret',
      ownerPin: '1234',
      ...fields,
    };
    let req = http().post('/setup/complete');
    for (const [key, value] of Object.entries(merged)) req = req.field(key, value);
    return req;
  };

  const setupAudits = () => db().select().from(auditLog).where(eq(auditLog.entityType, 'setup'));

  it('GET /setup/status is PUBLIC: false on a fresh DB, true with the timestamp after completion (B1(a), D3)', async () => {
    const before = await http().get('/setup/status').expect(200); // no Authorization header at all
    expect(before.body.data).toEqual({ completed: false, completedAt: null });

    await completeRequest().expect(201);

    const after = await http().get('/setup/status').expect(200);
    expect(after.body.data.completed).toBe(true);
    expect(after.body.data.completedAt).toEqual(expect.any(Number));
  });

  it('POST /setup/complete commits profile + Main Hall + Table 1..N with QR tokens + first Owner atomically, audits the bootstrap, serves the logo', async () => {
    const res = await completeRequest({ currencyCode: 'EUR', defaultLanguage: 'fr' })
      .attach('logo', await makePng(), 'logo.jpg') // sniffed as PNG despite the name
      .expect(201);

    const { profile, owner, hall, tables: tableDtos } = res.body.data;
    expect(profile).toMatchObject({
      name: 'Restaurant El Djazair',
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      currencyCode: 'EUR',
      defaultLanguage: 'fr',
      taxRatePercent: 0, // DB default — FR15 does not collect tax (D6)
    });
    expect(profile.setupCompletedAt).toEqual(expect.any(Number));
    expect(profile.logoPath).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(owner).toMatchObject({ name: 'Karim', role: 'owner', email: null, isActive: true, invitationStatus: null });
    expect(owner).not.toHaveProperty('passwordHash');
    expect(owner).not.toHaveProperty('pinHash');
    expect(hall).toMatchObject({ name: 'Main Hall', sortOrder: 0, isActive: true });
    expect(tableDtos).toHaveLength(3);
    expect(tableDtos.map((t: { label: string }) => t.label)).toEqual(['Table 1', 'Table 2', 'Table 3']);

    // The rows themselves, not just the response (B5(a)).
    const [profileRow] = await db().select().from(restaurantProfile);
    expect(profileRow).toMatchObject({ name: 'Restaurant El Djazair', currencyCode: 'EUR', defaultLanguage: 'fr', taxRatePercent: 0 });
    expect(profileRow.setupCompletedAt).toEqual(expect.any(Number));
    const hallRows = await db().select().from(halls);
    expect(hallRows).toHaveLength(1);
    const tableRows = await db().select().from(tables);
    expect(tableRows).toHaveLength(3);
    for (const row of tableRows) {
      expect(row.hallId).toBe(hallRows[0]!.id);
      expect(row.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // FR16/FR35 — 256-bit CSPRNG
      expect(row.status).toBe('available');
    }
    expect(new Set(tableRows.map((row) => row.qrToken)).size).toBe(3);

    // First Owner: Argon2id for BOTH credentials (B4(a), Security §1).
    const [ownerRow] = await db().select().from(employees);
    expect(ownerRow).toMatchObject({ name: 'Karim', role: 'owner', email: null, isActive: true });
    expect(await argon2.verify(ownerRow.passwordHash!, 'sup3rsecret')).toBe(true);
    expect(await argon2.verify(ownerRow.pinHash!, '1234')).toBe(true);

    // D9 — one bootstrap audit row, null actor, no credential material.
    const audits = await setupAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorEmployeeId: null, entityId: profileRow.id, action: 'setup_completed' });
    const payload = JSON.parse(audits[0]!.newValueJson!);
    expect(payload).toEqual({
      profileId: profileRow.id,
      hallId: hallRows[0]!.id,
      tableCount: 3,
      ownerEmployeeId: ownerRow.id,
    });
    expect(audits[0]!.newValueJson).not.toMatch(/sup3rsecret|1234/);

    // The logo went through the real §6 pipeline and is publicly served.
    const upload = await http().get(`/uploads/${profile.logoPath}`).expect(200);
    expect(upload.headers['content-type']).toBe('image/png');
  });

  it('FR15 defaults: omitted currency/language become DZD / Arabic', async () => {
    const res = await completeRequest().expect(201);
    expect(res.body.data.profile).toMatchObject({ currencyCode: 'DZD', defaultLanguage: 'ar' });
    const [row] = await db().select().from(restaurantProfile);
    expect(row).toMatchObject({ currencyCode: 'DZD', defaultLanguage: 'ar' });
  });

  it('B1(a): a second completion is 409 SETUP_ALREADY_COMPLETED and changes nothing — including the logo file (D8 cleanup)', async () => {
    await completeRequest().attach('logo', await makePng('#111122'), 'first.png').expect(201);

    const res = await completeRequest({ name: 'Hostile Takeover', tableCount: '50' })
      .attach('logo', await makePng('#ff0000'), 'evil.png')
      .expect(409);
    expect(res.body.error.code).toBe('SETUP_ALREADY_COMPLETED');

    expect(await db().select().from(restaurantProfile)).toHaveLength(1);
    expect(await db().select().from(halls)).toHaveLength(1);
    expect(await db().select().from(tables)).toHaveLength(3);
    expect(await db().select().from(employees)).toHaveLength(1);
    expect(await setupAudits()).toHaveLength(1);
    // Only the FIRST logo survives — the second request's stored file was released.
    expect(await fs.readdir(UPLOAD_DIR)).toHaveLength(1);
  });

  it('D5 race: two concurrent completions settle to exactly one 201 and one 409, one profile row, one Owner', async () => {
    const [first, second] = await Promise.all([
      completeRequest().then((res) => res.status),
      completeRequest({ ownerName: 'Late Rival', ownerPin: '9999' }).then((res) => res.status),
    ]);
    expect([first, second].sort()).toEqual([201, 409]);

    expect(await db().select().from(restaurantProfile)).toHaveLength(1);
    expect(await db().select().from(employees)).toHaveLength(1);
    expect(await db().select().from(halls)).toHaveLength(1);
    expect(await db().select().from(tables)).toHaveLength(3);
  });

  it('validation matrix: malformed submissions are 400s that persist nothing', async () => {
    const cases: Array<{ fields: Record<string, string>; note: string }> = [
      { fields: { name: '' }, note: 'empty name' },
      { fields: { primaryColor: 'red' }, note: 'non-hex color' },
      { fields: { currencyCode: 'dzd' }, note: 'lowercase currency' },
      { fields: { defaultLanguage: 'en' }, note: 'unsupported language' },
      { fields: { tableCount: '0' }, note: 'zero tables (R6)' },
      { fields: { tableCount: '201' }, note: 'above the 200 ceiling (R6)' },
      { fields: { tableCount: '2.5' }, note: 'non-integer tableCount' },
      { fields: { ownerPassword: 'short12' }, note: 'password under 8 (B4(a))' },
      { fields: { ownerPin: '123' }, note: 'PIN under 4 digits' },
      { fields: { ownerPin: '1234567' }, note: 'PIN over 6 digits' },
      { fields: { setupCompletedAt: '123' }, note: 'non-whitelisted field (D10-style)' },
    ];
    for (const testCase of cases) {
      const res = await completeRequest(testCase.fields).expect(400);
      // case: ${testCase.note}
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }

    expect(await db().select().from(restaurantProfile)).toHaveLength(0);
    expect(await db().select().from(employees)).toHaveLength(0);
    expect(await db().select().from(tables)).toHaveLength(0);
    expect(await setupAudits()).toHaveLength(0);
  });

  it('logo rejection (SVG) is a 400 that persists nothing — no rows, no upload directory', async () => {
    const res = await completeRequest()
      .attach('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_FILE_UPLOAD');

    expect(await db().select().from(restaurantProfile)).toHaveLength(0);
    expect(await db().select().from(employees)).toHaveLength(0);
    expect(await setupAudits()).toHaveLength(0);
    await expect(fs.readdir(UPLOAD_DIR)).rejects.toThrow(); // never even created
  });

  it('D11: the wizard returns NO tokens — the Owner logs in via the existing password-login and reaches the 3.10 profile chain', async () => {
    const setup = await completeRequest().expect(201);
    expect(setup.body.data).not.toHaveProperty('accessToken');
    expect(setup.body.data).not.toHaveProperty('deviceRefreshToken');

    // Security §1 — password login on the new device issues device trust.
    const login = await http()
      .post('/auth/password-login')
      .send({ name: 'Karim', password: 'sup3rsecret', deviceLabel: 'Back-Office Laptop' })
      .expect(201);
    expect(login.body.data.accessToken).toEqual(expect.any(String));
    expect(login.body.data.deviceRefreshToken).toEqual(expect.any(String));

    const profile = await http()
      .get('/config/restaurant-profile')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200);
    expect(profile.body.data).toMatchObject({ name: 'Restaurant El Djazair', setupCompletedAt: expect.any(Number) });

    // PIN login works on the trusted device too (B4(a) — both credentials).
    const pinLogin = await http()
      .post('/auth/pin-login')
      .send({
        deviceRefreshToken: login.body.data.deviceRefreshToken,
        employeeId: setup.body.data.owner.id,
        pin: '1234',
      })
      .expect(201);
    expect(pinLogin.body.data.accessToken).toEqual(expect.any(String));
  });

  it('3.10 B2(a) chain: a generated table QR token serves the public menu with the wizard branding', async () => {
    const setup = await completeRequest().expect(201);
    const qrToken = setup.body.data.tables[0].qrToken as string;

    const menu = await http().get(`/public/menu/${qrToken}`).expect(200);
    expect(menu.body.data.table).toMatchObject({ label: 'Table 1' });
    expect(menu.body.data.restaurant).toEqual({
      name: 'Restaurant El Djazair',
      logoPath: null,
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      currencyCode: 'DZD',
      defaultLanguage: 'ar',
    });
    expect(menu.body.data.restaurant).not.toHaveProperty('taxRatePercent');
    expect(menu.body.data.restaurant).not.toHaveProperty('setupCompletedAt');
  });

  it('pre-setup isolation: protected endpoints still 401 and customer tokens still 404 while nothing exists', async () => {
    await http().get('/config/restaurant-profile').expect(401);
    await http().get('/public/menu/not-a-real-token').expect(404);
    const status = await http().get('/setup/status').expect(200);
    expect(status.body.data).toEqual({ completed: false, completedAt: null });
  });
});
