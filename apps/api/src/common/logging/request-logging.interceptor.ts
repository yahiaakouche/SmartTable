import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { catchError, finalize, Observable, tap, throwError } from 'rxjs';
import { AppLogger } from './app-logger.service';
import { markRequestLogged } from './request-context';

/**
 * Monitoring Architecture §7 — every API request's duration in its
 * structured log line, keyed by the correlation ID the middleware already
 * seeded (the AppLogger stamps it automatically). One `info` line per
 * request, emitted in `finalize` so failures are logged too, with the
 * status taken from the response on success or from the exception on
 * failure.
 *
 * The never-logged list (ES §8) is structural here: this interceptor reads
 * the method, route, and status only — request and response BODIES are
 * never touched. For SSE/stream routes (`@Res`) the duration measures the
 * synchronous handling; the stream's lifetime is the connection's, not
 * the handler's (§6 of the Step 3.13 review).
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger: AppLogger;

  constructor(appLogger: AppLogger) {
    this.logger = appLogger.child('http');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = performance.now();
    const request = context.switchToHttp().getRequest<Request>();
    let status = 200;

    return next.handle().pipe(
      tap(() => {
        status = context.switchToHttp().getResponse().statusCode;
      }),
      catchError((error: unknown) => {
        status = error instanceof HttpException ? error.getStatus() : 500;
        return throwError(() => error);
      }),
      finalize(() => {
        const durationMs = Math.round(performance.now() - start);
        markRequestLogged(request); // tells the middleware fallback this request already has its line
        this.logger.info(`HTTP ${request.method} ${request.originalUrl} → ${status}`, {
          method: request.method,
          route: request.originalUrl,
          status,
          durationMs,
        });
      }),
    );
  }
}
