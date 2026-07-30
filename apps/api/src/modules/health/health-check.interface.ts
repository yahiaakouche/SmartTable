export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export interface HealthResult {
  status: HealthStatus;
  detail?: string;
}

/**
 * Every subsystem (database, real-time channel, printer, disk space, backup
 * status, update status — Monitoring Architecture §4 table) implements this
 * once and registers itself. The Host aggregates all of them into one overall
 * status, rather than each subsystem inventing its own ad hoc health reporting.
 */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthResult>;
}
