import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk, createdAtColumn } from './_columns';

/**
 * Idempotency key store — API Contract Design §1 (Step 3.3 ruling Q1).
 *
 * Backs the `Idempotency-Key` header required on POST /orders, POST
 * /orders/:id/addon, POST /public/orders (and POST /payments when the billing
 * step arrives): a retry with the same key on the same endpoint must never
 * execute the domain operation twice (Q1: "guarantee safe retries and prevent
 * duplicate order creation"). Instead the ORIGINAL response is replayed
 * (Contract §2: `IDEMPOTENCY_KEY_REUSED`, HTTP 200 — a distinct response path).
 *
 * Semantics of the columns:
 *  - `key` + `endpoint`: the identity of a memoized request. `endpoint` is the
 *    concrete request path (method + path with real ids), so the same key on
 *    a different path is a different memo entry entirely.
 *  - `request_hash`: SHA-256 of the JSON request body. Same key with a
 *    DIFFERENT body is a client bug → 409 `IDEMPOTENCY_KEY_CONFLICT`.
 *  - `response_json`: NULL while the first request is still in flight (the
 *    row is inserted BEFORE the handler runs — this is what makes a
 *    concurrent duplicate wait-and-replay instead of executing twice);
 *    populated with the exact enveloped response body once it completes.
 *    A row whose handler failed is deleted again, so only SUCCESSFUL
 *    operations are memoized and failed requests may be retried freely.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: uuidPk(),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: text('response_json'), // nullable — in-flight marker, see above
    createdAt: createdAtColumn(),
  },
  (table) => ({
    keyEndpointUnique: uniqueIndex('uq_idempotency_keys_key_endpoint').on(table.key, table.endpoint),
  }),
);
