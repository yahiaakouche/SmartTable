import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Live system snapshot for GET /diagnostics/resources (API Contract §3,
 * Monitoring Architecture §5's Resource Monitor). Module-local by the
 * diagnostics module's own precedent (AggregateHealth lives here too, not
 * in shared-types). */
export interface DiskResources {
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface SystemResources {
  cpu: {
    /** 1/5/15-minute load averages, exactly as the OS reports them. */
    loadAverage: [number, number, number];
    coreCount: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    /** Resident set of the API process itself — the figure that matters
     * for an embedded desktop app sharing the machine with the Host. */
    processRssBytes: number;
  };
  /** null when the probe fails (D2) — the endpoint must still answer. */
  disk: DiskResources | null;
  collectedAt: number;
}

/**
 * Step 3.12 (B1(a)/D1/D2): the technical resource view behind the Host's
 * Diagnostics page. Read LIVE at request time (D8 — no background
 * sampling, no persistence; Monitoring §7's "no metrics database" rule).
 */
@Injectable()
export class ResourcesService {
  constructor(private readonly config: ConfigService) {}

  async getResources(): Promise<SystemResources> {
    const [m1, m5, m15] = os.loadavg() as [number, number, number];
    return {
      cpu: { loadAverage: [m1, m5, m15], coreCount: os.cpus().length },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        processRssBytes: process.memoryUsage().rss,
      },
      disk: await this.probeDisk(),
      collectedAt: Date.now(),
    };
  }

  /** Same probe and volume choice as DiskSpaceHealthCheck (the data
   * volume holding DATABASE_FILE_PATH — D2), without the threshold
   * judgement: this endpoint reports, the health check evaluates. */
  private async probeDisk(): Promise<DiskResources | null> {
    try {
      const dataDirectory = path.dirname(this.config.get<string>('DATABASE_FILE_PATH')!);
      const stats = await statfs(dataDirectory);
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      return {
        totalBytes,
        freeBytes,
        usedPercent: totalBytes === 0 ? 0 : Math.round(((totalBytes - freeBytes) / totalBytes) * 100),
      };
    } catch {
      return null;
    }
  }
}
