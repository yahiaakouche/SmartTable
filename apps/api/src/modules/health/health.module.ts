import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { HealthRegistryService } from './health-registry.service';
import { DatabaseHealthCheck } from './checks/database.health-check';

@Module({
  controllers: [DiagnosticsController],
  providers: [HealthRegistryService, DatabaseHealthCheck],
})
export class HealthModule {}
