import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BackupController } from './backup.controller';
import { BACKUP_REPOSITORY, DrizzleBackupRepository } from './backup.repository';
import { BackupService } from './backup.service';

/**
 * Backup domain — Step 3.9 (FR13, Backup & Resilience §1–§3). Ships the
 * verified-snapshot engine (trigger-agnostic, B6(a)) and the two frozen
 * routes of this step; restore, the automatic scheduler/shutdown hook and
 * rolling retention all belong to the Host/Electron phase (B1(a)/B6(a)) and
 * will call this same engine.
 */
@Module({
  imports: [AuditModule],
  controllers: [BackupController],
  providers: [BackupService, { provide: BACKUP_REPOSITORY, useClass: DrizzleBackupRepository }],
  exports: [BackupService],
})
export class BackupModule {}
