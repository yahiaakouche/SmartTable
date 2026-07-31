import { SetMetadata } from '@nestjs/common';

/**
 * Marks an endpoint as requiring the `Idempotency-Key` header (API Contract
 * §1: POST /orders, POST /orders/:id/addon, POST /public/orders — and POST
 * /payments when the billing step arrives). The global IdempotencyInterceptor
 * enforces the full memo/replay semantics only on routes carrying this mark.
 */
export const IDEMPOTENT_KEY = 'idempotentEndpoint';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
