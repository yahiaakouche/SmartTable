import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { idempotencyKeys } from '../../database/schema';

export const IDEMPOTENCY_REPOSITORY = Symbol('IDEMPOTENCY_REPOSITORY');

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;

/**
 * Persistence for the Contract §1 idempotency convention (Step 3.3 ruling
 * Q1). Cross-cutting infrastructure — orders today, payments next; not a
 * domain module of its own (it appears in no frozen module list).
 */
export interface IdempotencyRepository {
  findByKeyAndEndpoint(key: string, endpoint: string): Promise<IdempotencyKeyRow | undefined>;
  /** Insert the in-flight marker (response_json NULL). The UNIQUE index on
   * (key, endpoint) is the race backstop: the loser of a concurrent pair
   * fails here and falls back to reading the winner's row. */
  insertPending(key: string, endpoint: string, requestHash: string): Promise<void>;
  storeResponse(id: string, responseJson: string): Promise<void>;
  /** Removes the in-flight marker when (and only when) it is still pending —
   * used when the handler failed, so failed requests may be retried freely;
   * a completed memo is NEVER deletable through this interface. */
  deleteIfPending(key: string, endpoint: string): Promise<void>;
}

@Injectable()
export class DrizzleIdempotencyRepository implements IdempotencyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async findByKeyAndEndpoint(key: string, endpoint: string): Promise<IdempotencyKeyRow | undefined> {
    const rows = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.endpoint, endpoint)));
    return rows[0];
  }

  async insertPending(key: string, endpoint: string, requestHash: string): Promise<void> {
    await this.db.insert(idempotencyKeys).values({ key, endpoint, requestHash });
  }

  async storeResponse(id: string, responseJson: string): Promise<void> {
    await this.db.update(idempotencyKeys).set({ responseJson }).where(eq(idempotencyKeys.id, id));
  }

  async deleteIfPending(key: string, endpoint: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.endpoint, endpoint), isNull(idempotencyKeys.responseJson)));
  }
}
