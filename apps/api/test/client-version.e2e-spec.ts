import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp } from './helpers/test-app';

const LOG_DIR = process.env.LOG_DIRECTORY!;
const CURRENT = process.env.APP_VERSION!; // seeded as 0.0.0 by test/setup-env.ts

/**
 * E2E — Step 3.14 critical path (API Contract Design §1/§2), against the
 * FULL application composition over /api/v1:
 *
 *  1. A customer-facing public route answers a STALE X-Client-Version with
 *     the exact frozen 409 CLIENT_VERSION_STALE envelope — before the
 *     handler, before auth, before any DB work (B5(a)) — and answers the
 *     CURRENT version normally (the guard steps aside; the unknown QR
 *     token's 404 proves the request reached the handler).
 *  2. Cross-step proof with 3.13: the guard rejection (which never reaches
 *     the request-logging interceptor — guards run first) is logged as
 *     exactly one standard http line with status 409 via the middleware
 *     finish fallback, keyed by the response's X-Correlation-ID.
 *  3. B3(a): the Host-style headerless diagnostics poll is unaffected.
 */
describe('Client Version Guard (E2E critical path)', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer());
  const unknownQrToken = uuidv4();

  const todayFile = (): string => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return path.join(LOG_DIR, `app-${stamp}.log`);
  };

  const waitForRequestLines = async (correlationId: string): Promise<Array<Record<string, unknown>>> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (fs.existsSync(todayFile())) {
        const lines = fs
          .readFileSync(todayFile(), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((line) => line.correlationId === correlationId);
        if (lines.length > 0) return lines;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no log line for correlation ID ${correlationId}`);
  };

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
    await app.listen(0);
  }, 90_000);

  afterAll(async () => {
    await app.close();
  });

  it('a stale X-Client-Version on a public customer route gets the frozen 409 CLIENT_VERSION_STALE envelope — before the handler runs', async () => {
    const res = await http()
      .get(`/api/v1/public/menu/${unknownQrToken}`)
      .set('X-Client-Version', '0.0.1') // any version that is not the running one
      .expect(409);

    expect(res.body).toEqual({
      error: {
        code: 'CLIENT_VERSION_STALE',
        message: 'This page was loaded from an older version of SmartTable. Please refresh to continue.',
      },
    });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('the current version passes the guard — the request reaches the handler (unknown QR token answers 404, not 409)', async () => {
    const res = await http()
      .get(`/api/v1/public/menu/${unknownQrToken}`)
      .set('X-Client-Version', CURRENT)
      .expect(404);
    expect(res.body.error.code).not.toBe('CLIENT_VERSION_STALE');
  });

  it('the 409 rejection is logged as exactly one 3.13 http line with status 409, keyed by the echoed correlation ID (Monitoring §1/§7)', async () => {
    const res = await http()
      .get(`/api/v1/public/menu/${unknownQrToken}`)
      .set('X-Client-Version', '0.0.1')
      .expect(409);

    const correlationId = res.headers['x-correlation-id'];
    const lines = await waitForRequestLines(correlationId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      module: 'http',
      correlationId,
      message: `HTTP GET /api/v1/public/menu/${unknownQrToken} → 409`,
      context: { method: 'GET', route: `/api/v1/public/menu/${unknownQrToken}`, status: 409, durationMs: expect.any(Number) },
    });
  });

  it('B3(a) — the Host-style headerless diagnostics poll is completely unaffected', async () => {
    const res = await http().get('/api/v1/diagnostics/health').expect(200); // no X-Client-Version at all
    expect(res.body.data.checks).toBeDefined();
  });
});
