import { Controller, Get } from '@nestjs/common';
import { HealthRegistryService } from './health-registry.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * API Contract Design §3 — `diagnostics` module. This screen is deliberately
 * isolated from the daily Owner UI (Host Application design), intended for
 * support/engineering use, not day-to-day restaurant operation.
 *
 * Marked @Public(): the Electron Host itself polls this endpoint for its
 * Health Monitoring responsibility, and the Host holds no acting-employee
 * JWT. Exposure is the health aggregate only — no business data.
 */
@Public()
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly healthRegistry: HealthRegistryService) {}

  @Get('health')
  async getHealth() {
    const result = await this.healthRegistry.getAggregateHealth();
    return { data: result };
  }
}
