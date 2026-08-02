import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { AppLogger } from './app-logger.service';
import { runWithCorrelationId, wasRequestLogged } from './request-context';

/**
 * The earliest HTTP touchpoint (ES §8): generates the request's
 * correlation ID — a UUID v7, the project's ID convention — seeds the
 * AsyncLocalStorage context the rest of the pipeline inherits, and
 * echoes the ID in the X-Correlation-ID response header (ruling B3(a))
 * so a support call can name the exact request to search for. The ID is
 * always server-generated, never trusted from the client.
 *
 * It also owns the §7 COMPLETION fallback: guards reject (401/403/429)
 * before interceptors run, and unmatched routes (404) never reach the
 * Nest pipeline at all — the request-logging interceptor never sees them.
 * The 'finish' listener logs those requests with the identical line shape
 * the interceptor would have produced, but only when the interceptor did
 * not already mark the request as logged (exactly-once per request). The
 * correlation ID travels via the closure, not the async context, because
 * 'finish' fires outside the request's ALS scope.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger: AppLogger;

  constructor(appLogger: AppLogger) {
    this.logger = appLogger.child('http');
  }

  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = uuidv7();
    response.setHeader('X-Correlation-ID', correlationId);

    const start = performance.now();
    response.on('finish', () => {
      if (wasRequestLogged(request)) return; // the interceptor already emitted this request's line
      const status = response.statusCode;
      const durationMs = Math.round(performance.now() - start);
      runWithCorrelationId(correlationId, () =>
        this.logger.info(`HTTP ${request.method} ${request.originalUrl} → ${status}`, {
          method: request.method,
          route: request.originalUrl,
          status,
          durationMs,
        }),
      );
    });

    runWithCorrelationId(correlationId, () => next());
  }
}
