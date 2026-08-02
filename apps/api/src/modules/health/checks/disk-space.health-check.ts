import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'fs/promises';
import * as path from 'path';
import { HealthCheck, HealthResult } from '../health-check.interface';

/**
 * Monitoring Architecture §4 — the "Disk space" row of the frozen Health
 * Check Registry table: free space vs. a warning threshold (the document's
 * own example figure, 85%). Step 3.12 ruling B3(a)/D3 freezes these
 * defaults; they become Owner-configurable via the Host's Diagnostics UI
 * in the Host phase (D7 — thresholds live HERE, inside the check, never
 * in the controller, so that phase injects configuration without
 * refactoring).
 */
const DEGRADED_USED_PERCENT = 85;
const CRITICAL_USED_PERCENT = 95;

@Injectable()
export class DiskSpaceHealthCheck implements HealthCheck {
  readonly name = 'disk';

  constructor(private readonly config: ConfigService) {}

  async check(): Promise<HealthResult> {
    try {
      const probe = await this.probeDataVolume();
      if (probe.usedPercent >= CRITICAL_USED_PERCENT) {
        return { status: 'critical', detail: `${probe.usedPercent}% of the data volume is used` };
      }
      if (probe.usedPercent >= DEGRADED_USED_PERCENT) {
        return { status: 'degraded', detail: `${probe.usedPercent}% of the data volume is used` };
      }
      return { status: 'healthy', detail: `${probe.usedPercent}% of the data volume is used` };
    } catch (error) {
      // D3/R3 — a failed probe DEGRADES the aggregate; it must never take
      // the diagnostics endpoint down with it.
      return {
        status: 'degraded',
        detail: `disk probe failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }

  /** The DATA volume (the database file's directory) — where this product's
   * growth actually happens: the database itself, backups, uploads, logs.
   * `bavail` (not `bfree`) is the honest figure: space actually available
   * to an unprivileged writer. */
  private async probeDataVolume(): Promise<{ usedPercent: number }> {
    const dataDirectory = path.dirname(this.config.get<string>('DATABASE_FILE_PATH')!);
    const stats = await statfs(dataDirectory);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    return {
      usedPercent: totalBytes === 0 ? 0 : Math.round(((totalBytes - freeBytes) / totalBytes) * 100),
    };
  }
}
