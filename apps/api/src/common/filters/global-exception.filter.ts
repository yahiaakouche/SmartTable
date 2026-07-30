import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain.exception';

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
      // class-validator / Nest built-in exceptions (e.g., ValidationPipe failures)
      const status = exception.getStatus();
      response.status(status).json({
        error: {
          code: status === 400 ? 'VALIDATION_FAILED' : 'HTTP_ERROR',
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
