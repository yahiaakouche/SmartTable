import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { ClientVersionGuard } from './client-version.guard';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp } from '../../../test/helpers/test-app';

/** Probe surface: one guarded route and one @Public route, so the suite
 * proves the guard applies uniformly to BOTH route classes (D3) and runs
 * ahead of the auth guards (B5(a)). */
@Controller('version-probe')
class VersionProbeController {
  @Get('guarded')
  guarded(): { probe: string } {
    return { probe: 'guarded' };
  }

  @Public()
  @Get('open')
  open(): { probe: string } {
    return { probe: 'open' };
  }
}

/**
 * Integration: the client/server version guard inside the real guard chain
 * (API Contract Design §1, Step 3.14 rulings B3(a)/B5(a)) — registered the
 * same way AppModule registers it (FIRST, then the auth module's guards),
 * so the suite proves: headerless requests pass, matching versions pass,
 * stale versions get the frozen 409 CLIENT_VERSION_STALE envelope on public
 * AND guarded routes alike, and a stale request with no credentials is told
 * to refresh (409) before authentication is even attempted (not 401).
 *
 * APP_VERSION is seeded as 0.0.0 by test/setup-env.ts.
 */
describe('ClientVersionGuard (integration)', () => {
  let app: INestApplication;

  const CURRENT = '0.0.0';
  const STALE = '0.0.1';

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, AuthModule],
        controllers: [VersionProbeController],
        providers: [{ provide: APP_GUARD, useClass: ClientVersionGuard }], // before AuthModule's guards — mirrors AppModule ordering
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('B3(a) — a headerless request passes unchecked', async () => {
    const res = await request(app.getHttpServer()).get('/version-probe/open').expect(200);
    expect(res.body).toEqual({ data: { probe: 'open' } });
  });

  it('a request declaring the current version passes on both route classes', async () => {
    await request(app.getHttpServer())
      .get('/version-probe/open')
      .set('X-Client-Version', CURRENT)
      .expect(200);
    // Guarded route: the version guard passes, then auth answers 401 — the
    // version check did not block it, and it ran before auth.
    const res = await request(app.getHttpServer())
      .get('/version-probe/guarded')
      .set('X-Client-Version', CURRENT);
    expect(res.status).toBe(401);
  });

  it('a stale version on a @Public route gets the exact frozen envelope (D1/D3)', async () => {
    const res = await request(app.getHttpServer())
      .get('/version-probe/open')
      .set('X-Client-Version', STALE)
      .expect(409);

    expect(res.body).toEqual({
      error: {
        code: 'CLIENT_VERSION_STALE',
        message: 'This page was loaded from an older version of SmartTable. Please refresh to continue.',
      },
    });
  });

  it('a stale version on an auth-guarded route also gets 409 (uniform application, D3)', async () => {
    const res = await request(app.getHttpServer())
      .get('/version-probe/guarded')
      .set('X-Client-Version', STALE)
      .expect(409);
    expect(res.body.error.code).toBe('CLIENT_VERSION_STALE');
  });

  it('B5(a) — a stale request with NO credentials is told to refresh (409), never asked to authenticate first (not 401)', async () => {
    const res = await request(app.getHttpServer())
      .get('/version-probe/guarded')
      .set('X-Client-Version', STALE)
      .expect(409);
    expect(res.body.error.code).toBe('CLIENT_VERSION_STALE');
  });
});
