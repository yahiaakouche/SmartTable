import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap, map, mergeMap } from 'rxjs/operators';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IDEMPOTENCY_REPOSITORY, IdempotencyKeyRow, IdempotencyRepository } from './idempotency.repository';
import {
  IdempotencyKeyConflictException,
  IdempotencyKeyRequiredException,
  IdempotencyKeyReusedException,
} from '../exceptions/domain.exception';

/** Bounded wait for a concurrent in-flight twin request to finish writing its
 * response. better-sqlite3 is fully synchronous, so the winner's writes are
 * fast; 40 × 25ms = 1s is a generous ceiling, not an expected duration. */
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enforces the frozen `Idempotency-Key` convention (API Contract §1/§2,
 * Step 3.3 ruling Q1) on every route marked @Idempotent():
 *
 *  1. Missing key → 400 IDEMPOTENCY_KEY_REQUIRED.
 *  2. Same key + same endpoint + same body → the operation is NOT executed
 *     again; the stored ORIGINAL response is replayed via
 *     IdempotencyKeyReusedException (200 — Contract §2's distinct path).
 *  3. Same key + different body → 409 IDEMPOTENCY_KEY_CONFLICT.
 *  4. First sight of a key: an in-flight marker row is inserted BEFORE the
 *     handler runs (the UNIQUE(key, endpoint) index is the backstop), so a
 *     concurrent duplicate can never execute the domain operation twice —
 *     it waits for the winner and replays instead. This is the Q1 guarantee
 *     against duplicate order creation.
 *  5. A handler that FAILS has its marker row removed again: only successful
 *     operations are memoized, and the key becomes free for a real retry.
 *
 * Registration order matters: this interceptor must run OUTSIDE
 * ResponseEnvelopeInterceptor so the stored response is the exact enveloped
 * body the client received, making the replay byte-identical.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_REPOSITORY) private readonly idempotencyRepository: IdempotencyRepository,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const required = this.reflector.get<boolean>(IDEMPOTENT_KEY, context.getHandler());
    if (!required || context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const keyHeader = request.headers['idempotency-key'];
    const endpoint = `${request.method} ${request.originalUrl.split('?')[0]}`;
    if (typeof keyHeader !== 'string' || keyHeader.length === 0) {
      throw new IdempotencyKeyRequiredException(endpoint);
    }

    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    const existing = await this.idempotencyRepository.findByKeyAndEndpoint(keyHeader, endpoint);
    if (existing) return this.handleExisting(existing, requestHash);

    let pendingRow: IdempotencyKeyRow;
    try {
      await this.idempotencyRepository.insertPending(keyHeader, endpoint, requestHash);
      pendingRow = (await this.idempotencyRepository.findByKeyAndEndpoint(keyHeader, endpoint))!;
    } catch (error) {
      // Lost the insert race against a concurrent twin — the UNIQUE index is
      // the only collision this path is allowed to swallow (ES §7).
      if (error instanceof Error && /UNIQUE constraint failed: idempotency_keys\./.test(error.message)) {
        const winner = await this.awaitCompletedResponse(keyHeader, endpoint);
        return this.handleExisting(winner, requestHash);
      }
      throw error;
    }

    return next.handle().pipe(
      concatMap((body) =>
        from(this.idempotencyRepository.storeResponse(pendingRow.id, JSON.stringify(body ?? null))).pipe(map(() => body)),
      ),
      // Only successful operations are memoized: a failed handler frees the
      // key so the client's genuine retry executes normally.
      catchError((error) =>
        from(this.idempotencyRepository.deleteIfPending(keyHeader, endpoint).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private handleExisting(row: IdempotencyKeyRow, requestHash: string): Observable<never> {
    if (row.requestHash !== requestHash) {
      throw new IdempotencyKeyConflictException(
        'This idempotency key was already used with a different request body. Do not reuse keys across different requests.',
      );
    }
    if (row.responseJson !== null) {
      return throwError(() => new IdempotencyKeyReusedException(JSON.parse(row.responseJson!)));
    }
    // Marker exists but no response yet — a concurrent twin is in flight.
    return from(this.awaitCompletedResponse(row.key, row.endpoint)).pipe(
      mergeMap((completed) => this.handleExisting(completed, requestHash)),
    );
  }

  private async awaitCompletedResponse(key: string, endpoint: string): Promise<IdempotencyKeyRow> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const row = await this.idempotencyRepository.findByKeyAndEndpoint(key, endpoint);
      if (row && row.responseJson !== null) return row;
      if (!row) {
        // The twin failed and its marker was cleaned up — the key is free
        // again; tell the caller to retry rather than guessing here.
        throw new IdempotencyKeyConflictException(
          'The first request with this idempotency key did not complete. Safe to retry with the same key.',
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new IdempotencyKeyConflictException('A request with this idempotency key is still in progress. Retry shortly.');
  }
}
