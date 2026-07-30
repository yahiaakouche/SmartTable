import { Controller, Get } from '@nestjs/common';
import { HealthRegistryService } from './health-registry.service';

/**
 * API Contract Design §3 — `diagnostics` module. This screen is deliberately
 * isolated from the daily Owner UI (Host Application design), intended for
 * support/engineering use, not day-to-day restaurant operation.
 */
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly healthRegistry: HealthRegistryService) {}

  @Get('health')
  async getHealth() {
    const result = await this.healthRegistry.getAggregateHealth();
    return { data: result };
  }
}
