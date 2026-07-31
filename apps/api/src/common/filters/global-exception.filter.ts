import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DomainException, IdempotencyKeyReusedException } from '../exceptions/domain.exception';

/**
 * Every error response in the system passes through here — the single place
 * that produces the standard envelope defined in API Contract Design §1:
 *   { "error": { "code", "message", "details"? } }
 *
 * Expected business errors (DomainException) → 4xx, logged at most at info level.
 * Unexpected errors → 500, always logged with full stack trace (Engineering
 * Standards §7) and surfaced into Health Monitoring per the Monitoring Architecture.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // API Contract §2 — IDEMPOTENCY_KEY_REUSED is "not an error per se":
    // a distinct response path that returns HTTP 200 with the ORIGINAL
    // (already-enveloped) response body, verbatim — never the error envelope.
    if (exception instanceof IdempotencyKeyReusedException) {
      this.logger.log('Idempotent replay — returning the original response (200).');
      response.status(200).json(exception.replayBody);
      return;
    }

    if (exception instanceof DomainException) {
      this.logger.log(`Domain exception: ${exception.code} — ${exception.message}`);
      response.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      // class-validator / Nest built-in exceptions (e.g., ValidationPipe failures),
      // and ThrottlerException — Security Architecture §5 requires the 429
      // response to carry the frozen RATE_LIMITED code, not a generic one.
      const status = exception.getStatus();
      response.status(status).json({
        error: {
          code: status === 400 ? 'VALIDATION_FAILED' : status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          message: exception.message,
        },
      });
      return;
    }

    // Truly unexpected — always logged with stack trace, never silently swallowed
    // (Engineering Standards §7 — "no silent catches").
    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  }
}
