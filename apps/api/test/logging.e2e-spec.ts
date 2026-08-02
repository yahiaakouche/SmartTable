import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp } from './helpers/test-app';

const LOG_DIR = process.env.LOG_DIRECTORY!;

/**
 * E2E — Step 3.13 critical path (Monitoring Architecture §2/§7,
 * Engineering Standards §8), against the FULL application composition
 * (real migrated database, /api/v1 prefix, real listening port): a public
 * request and an auth-rejected request each produce exactly one structured
 * JSON line in the real daily log file, carrying the five mandatory §2
 * fields plus durationMs, keyed by the correlation ID that the response
 * echoes in its X-Correlation-ID header (B3(a)).
 *
 * LOG_DIRECTORY is shared per process (the validated config snapshot is
 * frozen at module import), so assertions filter the file by each
 * request's own correlation ID — precisely the read pattern the Host's
 * Diagnostics page will use.
 */
describe('Unified Application Logging (E2E critical path)', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer());

  const todayFile = (): string => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return path.join(LOG_DIR, `app-${stamp}.log`);
  };

  const currentLines = (): Array<Record<string, unknown>> => {
    if (!fs.existsSync(todayFile())) return [];
    const raw = fs.readFileSync(todayFile(), 'utf8').trim();
    return raw.length === 0 ? [] : raw.split('\n').map((line) => JSON.parse(line));
  };

  const waitForRequestLines = async (correlationId: string): Promise<Array<Record<string, unknown>>> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const lines = currentLines().filter((line) => line.correlationId === correlationId);
      if (lines.length > 0) return lines;
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

  it('a public request over /api/v1 lands in the real daily file as one §2 line with durationMs, keyed by the echoed correlation ID', async () => {
    const res = await http().get('/api/v1/diagnostics/health').expect(200);

    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // §3 daily rotation naming — the file this line must appear in.
    expect(path.basename(todayFile())).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log$/);

    const lines = await waitForRequestLines(correlationId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      timestamp: expect.any(Number),
      level: 'info',
      module: 'http',
      correlationId,
      message: `HTTP GET /api/v1/diagnostics/health → 200`,
      context: { method: 'GET', route: '/api/v1/diagnostics/health', status: 200, durationMs: expect.any(Number) },
    });
  });

  it('an auth-rejected request is logged as its 401 request line only (expected rejection — no error line), with its own correlation ID', async () => {
    const res = await http().get('/api/v1/config/restaurant-profile').expect(401);

    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).toMatch(/^[0-9a-f]{8}-/);

    const lines = await waitForRequestLines(correlationId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      module: 'http',
      correlationId,
      message: `HTTP GET /api/v1/config/restaurant-profile → 401`,
      context: { method: 'GET', route: '/api/v1/config/restaurant-profile', status: 401, durationMs: expect.any(Number) },
    });
  });
});
