import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { HealthRegistryService } from './health-registry.service';
import { DatabaseHealthCheck } from './checks/database.health-check';

@Module({
  controllers: [DiagnosticsController],
  providers: [HealthRegistryService, DatabaseHealthCheck],
  // Exported so subsystems that arrive in later steps can self-register
  // their checks (Monitoring §4 pluggable registry — first consumer: the
  // real-time bridge, Step 3.5).
  exports: [HealthRegistryService],
})
export class HealthModule {}
