import { Controller, Get } from '@nestjs/common';
import { HealthRegistryService } from './health-registry.service';
import { ResourcesService } from './resources.service';
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
  constructor(
    private readonly healthRegistry: HealthRegistryService,
    private readonly resourcesService: ResourcesService,
  ) {}

  @Get('health')
  async getHealth() {
    const result = await this.healthRegistry.getAggregateHealth();
    return { data: result };
  }

  /** GET /diagnostics/resources — CPU/memory/disk, read live (Step 3.12,
   * ruling B1(a): same @Public exposure class as the health aggregate —
   * OS-level figures, no business data). The third frozen route,
   * /diagnostics/connected-devices, is deliberately absent: its
   * definition lives in the Host Application design (ruling B2(a)). */
  @Get('resources')
  async getResources() {
    const result = await this.resourcesService.getResources();
    return { data: result };
  }
}
