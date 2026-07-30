import { Injectable } from '@nestjs/common';
import { HealthCheck, HealthResult, HealthStatus } from './health-check.interface';
import { DatabaseHealthCheck } from './checks/database.health-check';

export interface AggregateHealth {
  overall: HealthStatus;
  checks: Record<string, HealthResult>;
}

/**
 * Aggregates every registered HealthCheck into one overall status
 * (Monitoring Architecture §4). This aggregate feeds two very different
 * surfaces deliberately:
 *  - a simple ambient indicator on the Owner's main dashboard (just the
 *    overall color, never the detail — NFR4, keep daily use simple)
 *  - the full technical breakdown on the isolated Diagnostics page
 *
 * Additional checks (real-time channel, printer, disk space, backup status,
 * update status — per the Monitoring Architecture §4 table) register here as
 * they're implemented in later steps; this module is deliberately open for
 * that extension without needing to change the aggregation logic itself.
 */
@Injectable()
export class HealthRegistryService {
  private readonly checks: HealthCheck[];

  constructor(databaseCheck: DatabaseHealthCheck) {
    this.checks = [databaseCheck];
  }

  async getAggregateHealth(): Promise<AggregateHealth> {
    const results: Record<string, HealthResult> = {};

    for (const check of this.checks) {
      results[check.name] = await check.check();
    }

    const statuses = Object.values(results).map((r) => r.status);
    const overall: HealthStatus = statuses.includes('critical')
      ? 'critical'
      : statuses.includes('degraded')
        ? 'degraded'
        : 'healthy';

    return { overall, checks: results };
  }
}
