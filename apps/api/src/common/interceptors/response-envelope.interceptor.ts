import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { map, Observable } from 'rxjs';

/**
 * Enforces the success envelope from API Contract Design §1 —
 *   { "data": ..., "meta"?: {...} }
 * — for every response, so the frontend always parses success the same way
 * regardless of which module produced it. Controllers that already return an
 * envelope (pagination meta, the diagnostics module) pass through untouched;
 * controllers returning a bare payload get it wrapped in `data`.
 *
 * Binary downloads (StreamableFile — e.g. re-encoded upload serving) are NOT
 * JSON and pass through untouched: the envelope contract governs JSON API
 * responses only.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        if (body instanceof StreamableFile) {
          return body;
        }
        if (body !== null && typeof body === 'object' && ('data' in body || 'error' in body)) {
          return body;
        }
        return { data: body };
      }),
    );
  }
}
