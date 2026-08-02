import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { employees, halls, restaurantProfile, tables } from '../../database/schema';
import type { RestaurantProfileRow } from '../config/restaurant-config.repository';
import { SetupAlreadyCompletedException } from '../../common/exceptions/domain.exception';

export const SETUP_WIZARD_REPOSITORY = Symbol('SETUP_WIZARD_REPOSITORY');

export type HallRow = typeof halls.$inferSelect;
export type TableRow = typeof tables.$inferSelect;
export type EmployeeRow = typeof employees.$inferSelect;

/** Everything the atomic setup transaction writes, pre-computed by the
 * service (credential hashes, logo filename, completion timestamp) so the
 * transaction body itself is nothing but trivial inserts (R7). */
export interface SetupCompletionWrite {
  profile: {
    name: string;
    logoPath: string | null;
    primaryColor: string;
    secondaryColor: string;
    currencyCode: string;
    defaultLanguage: 'ar' | 'fr';
    setupCompletedAt: number;
  };
  hall: { name: string; sortOrder: number };
  tables: Array<{ label: string }>;
  owner: { name: string; passwordHash: string; pinHash: string };
}

export interface SetupCompletionResult {
  profile: RestaurantProfileRow;
  hall: HallRow;
  tables: TableRow[];
  owner: EmployeeRow;
}

export interface SetupWizardRepository {
  completeTransaction(write: SetupCompletionWrite): Promise<SetupCompletionResult>;
}

/** Identical entropy policy to TablesService (3.2): 256 bits of CSPRNG,
 * base64url — unguessable and non-sequential by construction (FR35), and
 * deliberately disjoint from the time-ordered UUIDv7 primary key. */
const QR_TOKEN_BYTES = 32;
/** Same ceiling as TablesService.QR_TOKEN_MAX_ATTEMPTS — a collision at
 * this entropy is not a realistic event; three attempts is a generous
 * ceiling before surfacing a genuine failure rather than looping. */
const QR_TOKEN_MAX_ATTEMPTS = 3;

/**
 * Step 3.11 ruling B5(a): the whole setup — profile, hall, table batch,
 * first Owner — commits in ONE synchronous better-sqlite3 transaction,
 * the exact invitations.repository.acceptTransaction precedent (which
 * likewise writes the employees table cross-module for atomicity). If any
 * statement fails, SQLite rolls back everything: a half-completed setup
 * can never exist (R3).
 *
 * The one-shot guard (B1(a)) lives INSIDE the transaction: better-sqlite3
 * is a single synchronous connection, so the existence check and the
 * inserts can never interleave with a concurrent request (D5/R4).
 */
@Injectable()
export class DrizzleSetupWizardRepository implements SetupWizardRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async completeTransaction(write: SetupCompletionWrite): Promise<SetupCompletionResult> {
    // The retry exists for exactly one failure mode: a qr_token unique
    // violation aborts the whole transaction (R5), so the ENTIRE batch is
    // retried with fresh tokens — mirroring TablesService's policy.
    for (let attempt = 1; ; attempt++) {
      try {
        return this.commitAttempt(write);
      } catch (error) {
        if (attempt >= QR_TOKEN_MAX_ATTEMPTS || !this.isQrTokenCollision(error)) throw error;
      }
    }
  }

  private commitAttempt(write: SetupCompletionWrite): SetupCompletionResult {
    // better-sqlite3 transactions are strictly synchronous (the driver
    // throws if the callback returns a promise). Drizzle's better-sqlite3
    // query builders execute immediately, so all writes below happen
    // inside one real SQLite transaction — atomically (Contract §3:
    // "Submits all wizard steps atomically").
    return this.db.transaction((tx) => {
      const existing = tx.select({ id: restaurantProfile.id }).from(restaurantProfile).limit(1).all();
      if (existing.length > 0) throw new SetupAlreadyCompletedException();

      const profile = tx.insert(restaurantProfile).values(write.profile).returning().all()[0]!;
      const hall = tx.insert(halls).values(write.hall).returning().all()[0]!;
      const tableRows = write.tables.map(
        (table) =>
          tx
            .insert(tables)
            .values({ hallId: hall.id, label: table.label, qrToken: this.generateQrToken() })
            .returning()
            .all()[0]!,
      );
      const owner = tx
        .insert(employees)
        .values({
          name: write.owner.name,
          role: 'owner',
          email: null,
          passwordHash: write.owner.passwordHash,
          pinHash: write.owner.pinHash,
        })
        .returning()
        .all()[0]!;

      return { profile, hall, tables: tableRows, owner };
    });
  }

  private generateQrToken(): string {
    return randomBytes(QR_TOKEN_BYTES).toString('base64url');
  }

  /** Unique-index violation on qr_token — the ONLY collision the retry
   * loop is allowed to swallow; every other error propagates (ES §7).
   * Same detection rule as TablesService.isQrTokenCollision. */
  private isQrTokenCollision(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed: tables\.qr_token/.test(error.message);
  }
}
