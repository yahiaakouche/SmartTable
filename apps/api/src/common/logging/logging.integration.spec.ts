import { Controller, Get, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigModule } from '../../config/config.module';
import { LoggingModule } from './logging.module';
import { createTestApp } from '../../../test/helpers/test-app';

/** Minimal probe surface so the suite exercises the FULL request pipeline
 * (middleware → interceptor → handler/filter) without pulling in any
 * feature module. */
@Controller('probe')
class LoggingProbeController {
  @Get('ok')
  ok(): { probe: string } {
    return { probe: 'ok' };
  }

  @Get('error')
  boom(): never {
    throw new Error('probe boom');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('probe missing');
  }
}

/**
 * Integration: Unified Application Logging over the real HTTP pipeline
 * (Monitoring Architecture §2/§3/§7, Step 3.13 rulings B2(a)/B3(a)) —
 * one JSON line per request carrying the five mandatory fields plus
 * durationMs, the correlation ID echoed in the X-Correlation-ID response
 * header and identical across every line a request produces, unexpected
 * errors logged with their stack trace while expected 4xx stay out of the
 * file, and the §3 startup retention sweep running at boot.
 *
 * The suite writes to the per-process scratch LOG_DIRECTORY seeded by
 * test/setup-env.ts (the validated config snapshot is frozen at module
 * import, so a spec cannot swap directories per test) — every assertion
 * therefore filters today's file by the request's own correlation ID,
 * which is exactly how the Host will read the stream.
 */
describe('Unified Application Logging (integration)', () => {
  let app: INestApplication;

  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const logDirectory = process.env.LOG_DIRECTORY!;

  const boot = async (): Promise<void> => {
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, LoggingModule],
        controllers: [LoggingProbeController],
      }),
    );
  };

  const todayFile = (): string => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return path.join(logDirectory, `app-${stamp}.log`);
  };

  const currentLines = (): Array<Record<string, unknown>> => {
    if (!fs.existsSync(todayFile())) return [];
    const raw = fs.readFileSync(todayFile(), 'utf8').trim();
    return raw.length === 0 ? [] : raw.split('\n').map((line) => JSON.parse(line));
  };

  /** Writes are fire-and-forget by design; tests flush via a short poll. */
  const waitForLines = async (predicate: (lines: Array<Record<string, unknown>>) => boolean) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const lines = currentLines();
      if (predicate(lines)) return lines;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('expected log line never appeared');
  };

  afterEach(async () => {
    await app.close();
  });

  it('a 200 request emits one §2 line with the mandatory fields + durationMs, and echoes the correlation ID in the response header (B3(a))', async () => {
    await boot();

    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);
    expect(res.body).toEqual({ data: { probe: 'ok' } });

    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).toMatch(UUID_V7);

    const lines = await waitForLines((all) => all.some((line) => line.correlationId === correlationId));
    const httpLine = lines.find((line) => line.correlationId === correlationId)!;
    expect(httpLine).toEqual({
      timestamp: expect.any(Number),
      level: 'info',
      module: 'http',
      correlationId,
      message: 'HTTP GET /probe/ok → 200',
      context: { method: 'GET', route: '/probe/ok', status: 200, durationMs: expect.any(Number) },
    });
  });

  it('an unexpected error emits the request line AND an error line with the stack trace, all sharing the request correlation ID (§2/§7, ES §7)', async () => {
    await boot();

    const res = await request(app.getHttpServer()).get('/probe/error').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const correlationId = res.headers['x-correlation-id'];

    const lines = await waitForLines((all) => all.filter((line) => line.correlationId === correlationId).length === 2);
    const requestLines = lines.filter((line) => line.correlationId === correlationId);

    const httpLine = requestLines.find((line) => line.module === 'http')!;
    expect(httpLine).toMatchObject({
      level: 'info',
      message: 'HTTP GET /probe/error → 500',
      context: { method: 'GET', route: '/probe/error', status: 500, durationMs: expect.any(Number) },
    });

    const errorLine = requestLines.find((line) => line.level === 'error')!;
    expect(errorLine).toMatchObject({
      module: 'ExceptionFilter',
      message: 'Unhandled exception',
    });
    expect((errorLine.context as { stack: string }).stack).toContain('probe boom');
  });

  it('an expected 4xx is logged as its request line only — no error line (expected business errors stay out of the file)', async () => {
    await boot();

    const res = await request(app.getHttpServer()).get('/probe/missing').expect(404);
    const correlationId = res.headers['x-correlation-id'];

    const lines = await waitForLines((all) => all.some((line) => line.correlationId === correlationId));
    const requestLines = lines.filter((line) => line.correlationId === correlationId);
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({
      level: 'info',
      module: 'http',
      context: { status: 404 },
    });
  });

  it('an unmatched route is logged by the middleware finish fallback with the identical line shape (§7 — every request)', async () => {
    await boot();

    const res = await request(app.getHttpServer()).get('/probe/no-such-route').expect(404);
    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).toMatch(UUID_V7); // middleware runs even when no route does

    const lines = await waitForLines((all) => all.some((line) => line.correlationId === correlationId));
    const requestLines = lines.filter((line) => line.correlationId === correlationId);
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({
      level: 'info',
      module: 'http',
      message: 'HTTP GET /probe/no-such-route → 404',
      context: { method: 'GET', route: '/probe/no-such-route', status: 404, durationMs: expect.any(Number) },
    });
  });

  it('each request gets its own correlation ID, grouping exactly its own lines (ES §8)', async () => {
    await boot();

    const first = await request(app.getHttpServer()).get('/probe/ok').expect(200);
    const second = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    const firstId = first.headers['x-correlation-id'];
    const secondId = second.headers['x-correlation-id'];
    expect(firstId).not.toEqual(secondId);

    const lines = await waitForLines(
      (all) => all.some((line) => line.correlationId === firstId) && all.some((line) => line.correlationId === secondId),
    );
    expect(lines.filter((line) => line.correlationId === firstId)).toHaveLength(1);
    expect(lines.filter((line) => line.correlationId === secondId)).toHaveLength(1);
  });

  it('the §3 startup sweep deletes expired daily files at boot, preserves everything else, and logs what it removed (B1(a)/R5)', async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000);
    const expiredStamp = `${fifteenDaysAgo.getFullYear()}-${String(fifteenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(fifteenDaysAgo.getDate()).padStart(2, '0')}`;
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(path.join(logDirectory, `app-${expiredStamp}.log`), 'old line\n');
    fs.writeFileSync(path.join(logDirectory, 'not-a-log-file.txt'), 'untouched\n');

    await boot();

    const lines = await waitForLines((all) =>
      all.some(
        (line) => line.module === 'logging' && (line.context as { deleted?: string[] })?.deleted?.includes(`app-${expiredStamp}.log`),
      ),
    );
    const sweepLine = lines.find(
      (line) => line.module === 'logging' && (line.context as { deleted?: string[] })?.deleted?.includes(`app-${expiredStamp}.log`),
    )!;
    expect(sweepLine).toMatchObject({
      level: 'info',
      message: 'log retention sweep removed 1 expired file(s)',
    });
    // The sweep line is emitted outside any request — it carries the stable
    // process-scope fallback correlation ID.
    expect(sweepLine.correlationId).toEqual(expect.any(String));

    expect(fs.existsSync(path.join(logDirectory, `app-${expiredStamp}.log`))).toBe(false);
    expect(fs.readFileSync(path.join(logDirectory, 'not-a-log-file.txt'), 'utf8')).toBe('untouched\n');
  });
});
