import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp } from './helpers/test-app';

/**
 * E2E — Step 3.11 critical path (Engineering Standards §10), against the
 * FULL application composition (real migrated database, /api/v1 prefix):
 *
 *  1. FR15/FR16/NFR9 bootstrap proof — a fresh installation goes from
 *     "setup not completed" to a fully working restaurant over real HTTP:
 *     status → atomic complete (real logo through the §6 pipeline) →
 *     status → password-login (device trust, Security §1) → the 3.10
 *     profile chain → the generated table's QR token serving the public
 *     menu with the wizard branding (3.10 B2(a) chain).
 *  2. The B1(a) one-shot guard and the public/protected reachability
 *     matrix over the real /api/v1 surface.
 */
describe('SetupWizard (E2E critical path)', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
  });

  afterEach(async () => {
    await app.close();
  });

  const makePng = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: '#225533' } }).png().toBuffer();

  it('FR15/FR16/NFR9: fresh install → wizard → login → branded public menu on a generated QR token', async () => {
    const before = await http().get('/api/v1/setup/status').expect(200);
    expect(before.body.data).toEqual({ completed: false, completedAt: null });

    const setup = await http()
      .post('/api/v1/setup/complete')
      .field('name', 'مطعم الجزائر')
      .field('primaryColor', '#0a5c36')
      .field('secondaryColor', '#f5efe0')
      .field('tableCount', '4')
      .field('ownerName', 'Karim')
      .field('ownerPassword', 'owner-secret-1')
      .field('ownerPin', '4321')
      .attach('logo', await makePng(), 'logo.jpg')
      .expect(201);

    const { profile, owner, hall, tables } = setup.body.data;
    expect(profile).toMatchObject({
      name: 'مطعم الجزائر',
      currencyCode: 'DZD', // FR15 default
      defaultLanguage: 'ar', // FR15 default
      taxRatePercent: 0,
      setupCompletedAt: expect.any(Number),
    });
    expect(owner).toMatchObject({ name: 'Karim', role: 'owner', invitationStatus: null });
    expect(hall).toMatchObject({ name: 'Main Hall' });
    expect(tables.map((t: { label: string }) => t.label)).toEqual(['Table 1', 'Table 2', 'Table 3', 'Table 4']);
    for (const table of tables) expect(table.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const after = await http().get('/api/v1/setup/status').expect(200);
    expect(after.body.data).toEqual({ completed: true, completedAt: profile.setupCompletedAt });

    // D11 — no tokens in the wizard response; password-login issues device trust.
    const login = await http()
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Back-Office Laptop' })
      .expect(201);
    const token = login.body.data.accessToken as string;

    // The 3.10 chain: the Owner reads the profile the wizard created.
    const fetched = await http()
      .get('/api/v1/config/restaurant-profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(fetched.body.data).toEqual(profile);

    // The 3.10 B2(a) chain: a generated QR token serves the branded public menu.
    const menu = await http().get(`/api/v1/public/menu/${tables[0].qrToken}`).expect(200);
    expect(menu.body.data.restaurant).toEqual({
      name: 'مطعم الجزائر',
      logoPath: profile.logoPath,
      primaryColor: '#0a5c36',
      secondaryColor: '#f5efe0',
      currencyCode: 'DZD',
      defaultLanguage: 'ar',
    });

    // The wizard logo is publicly servable.
    const upload = await http().get(`/api/v1/uploads/${profile.logoPath}`).expect(200);
    expect(upload.headers['content-type']).toBe('image/png');
  });

  it('B1(a): repeat completion is 409 SETUP_ALREADY_COMPLETED; setup routes are public while protected routes still require auth', async () => {
    const fields = {
      name: 'Restaurant El Djazair',
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      tableCount: '2',
      ownerName: 'Karim',
      ownerPassword: 'owner-secret-1',
      ownerPin: '1234',
    };
    let first = http().post('/api/v1/setup/complete');
    for (const [key, value] of Object.entries(fields)) first = first.field(key, value);
    await first.expect(201);

    let second = http().post('/api/v1/setup/complete');
    for (const [key, value] of Object.entries({ ...fields, name: 'Hostile Takeover' })) second = second.field(key, value);
    const repeat = await second.expect(409);
    expect(repeat.body.error.code).toBe('SETUP_ALREADY_COMPLETED');

    // Reachability matrix over the real /api/v1 surface.
    await http().get('/api/v1/setup/status').expect(200); // public
    await http().get('/api/v1/config/restaurant-profile').expect(401); // still guarded
    await http().get('/api/v1/employees').expect(401); // still guarded
  });
});
