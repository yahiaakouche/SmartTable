import { Module } from '@nestjs/common';
import { IDEMPOTENCY_REPOSITORY, DrizzleIdempotencyRepository } from './idempotency.repository';

/**
 * Cross-cutting idempotency infrastructure (API Contract §1, ruling Q1).
 * Provides the repository only — the interceptor itself is registered in
 * app.module.ts, where its ordering relative to the response-envelope
 * interceptor is explicit and deterministic (it must be the outer one).
 */
@Module({
  providers: [{ provide: IDEMPOTENCY_REPOSITORY, useClass: DrizzleIdempotencyRepository }],
  exports: [IDEMPOTENCY_REPOSITORY],
})
export class IdempotencyModule {}
