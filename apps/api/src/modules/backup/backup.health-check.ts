import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { backupHistory } from '../../database/schema';
import { HealthCheck, HealthResult } from '../health/health-check.interface';
import { HealthRegistryService } from '../health/health-registry.service';

/** Step 3.12 ruling B3(a)/D4 — Monitoring Architecture §4's "Backup status"
 * row judges the "age of last successful verified backup". Seven days is a
 * generous frozen default for a manual-backup product rhythm; it becomes
 * Owner-configurable via the Host's Diagnostics UI in the Host phase (D7). */
const SUCCESS_WITHIN_MS = 7 * 86_400_000;

/**
 * Registers itself into the open Health Check Registry the moment the
 * module initializes — the exact Step 3.5 D10 idiom the real-time channel
 * established (Monitoring §4's pluggable registry working as designed).
 *
 * Semantics (frozen per §4 — "age of last successful VERIFIED backup"):
 *  - a success within the window → healthy
 *  - none yet, or the latest success is older → degraded (NEVER critical
 *    on a fresh installation — a day-one restaurant must not show red, R3)
 *  - the history itself being unreadable → critical (the subsystem that
 *    would warn about every other failure is itself broken)
 *
 * 'failed' rows deliberately do NOT affect the result: the frozen metric
 * is success-age, and a 'failed' row already produced its Owner-facing
 * BACKUP_FAILED notification at write time (Step 3.9 B5(a)).
 */
@Injectable()
export class BackupHealthCheck implements HealthCheck, OnModuleInit {
  readonly name = 'backup';

  constructor(
    private readonly registry: HealthRegistryService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DbClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async check(): Promise<HealthResult> {
    try {
      const [latestSuccess] = await this.db
        .select({ createdAt: backupHistory.createdAt })
        .from(backupHistory)
        .where(eq(backupHistory.status, 'success'))
        .orderBy(desc(backupHistory.createdAt), desc(backupHistory.id))
        .limit(1);

      if (!latestSuccess) {
        return { status: 'degraded', detail: 'no verified backup exists yet' };
      }
      const ageMs = Date.now() - latestSuccess.createdAt;
      if (ageMs > SUCCESS_WITHIN_MS) {
        return {
          status: 'degraded',
          detail: `last verified backup is ${Math.floor(ageMs / 86_400_000)} day(s) old`,
        };
      }
      return { status: 'healthy', detail: 'a verified backup exists within the last 7 days' };
    } catch (error) {
      return {
        status: 'critical',
        detail: `backup history unreadable: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }
}
