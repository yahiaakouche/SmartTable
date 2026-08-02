import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HealthModule } from '../health/health.module';
import { BackupController } from './backup.controller';
import { BACKUP_REPOSITORY, DrizzleBackupRepository } from './backup.repository';
import { BackupService } from './backup.service';
import { BackupHealthCheck } from './backup.health-check';

/**
 * Backup domain — Step 3.9 (FR13, Backup & Resilience §1–§3). Ships the
 * verified-snapshot engine (trigger-agnostic, B6(a)) and the two frozen
 * routes of this step; restore, the automatic scheduler/shutdown hook and
 * rolling retention all belong to the Host/Electron phase (B1(a)/B6(a)) and
 * will call this same engine.
 */
@Module({
  // HealthModule joined in Step 3.12 (B3(a)): the backup domain registers
  // its "age of last successful verified backup" check into the Monitoring
  // §4 registry, the same self-registration idiom as 3.5's realtime check.
  imports: [AuditModule, HealthModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    { provide: BACKUP_REPOSITORY, useClass: DrizzleBackupRepository },
    BackupHealthCheck,
  ],
  exports: [BackupService],
})
export class BackupModule {}
