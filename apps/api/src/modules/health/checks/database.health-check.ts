import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../../database/database.module';
import type { DbClient } from '../../../database/connection';
import { HealthCheck, HealthResult } from '../health-check.interface';

@Injectable()
export class DatabaseHealthCheck implements HealthCheck {
  readonly name = 'database';

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async check(): Promise<HealthResult> {
    try {
      await this.db.run(sql`SELECT 1`);
      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'critical',
        detail: error instanceof Error ? error.message : 'Unknown database error',
      };
    }
  }
}
