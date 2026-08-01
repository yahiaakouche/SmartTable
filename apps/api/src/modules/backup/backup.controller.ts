import { Body, Controller, Get, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { PermissionKey } from '@smarttable/shared-types';
import type { ListBackupHistoryResponse } from '@smarttable/shared-types';
import { ActingEmployee, CurrentEmployee } from '../auth/decorators/current-employee.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { BackupService } from './backup.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import { ListBackupHistoryQueryDto } from './dto/list-backup-history-query.dto';

/**
 * Backup endpoints (API Contract Design §3 — exactly the two routes this
 * step ships; POST /backup/restore is the Host/Electron phase, ruling B1(a)).
 * Thin translation layer only: the verification sequence, history recording
 * and export shaping live in BackupService (Engineering Standards §3).
 *
 * Ruling B3: BACKUP_MANAGE = Owner + Manager (FR13). Throttle: 5/min — the
 * Security §5 pattern for expensive operations (snapshotting is real I/O).
 * No Idempotency-Key (D6 — not a financial mutation; a duplicate snapshot is
 * harmless). Binary downloads pass through the response envelope untouched
 * (the envelope governs JSON only).
 */
@Controller('backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  /** B2(a): the verified snapshot is created server-side AND streamed straight
   * back as an attachment — the Owner's Save-As dialog is "choose destination"
   * (FR13/§1). With a passphrase (B4(a)), the attachment is the encrypted
   * '.db.enc' container while the verified plaintext snapshot stays on the
   * machine (encryption protects the artifact OFF the machine, Security §4). */
  @RequirePermission(PermissionKey.BACKUP_MANAGE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('create')
  async createBackup(
    @Body() dto: CreateBackupDto,
    @CurrentEmployee() actor: ActingEmployee,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const backup = await this.backupService.createManualBackup(actor.id, dto.passphrase ?? undefined);
    response.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${backup.downloadName}"`,
    });
    if (backup.encryptedPayload !== null) {
      return new StreamableFile(backup.encryptedPayload);
    }
    return new StreamableFile(createReadStream(backup.serverFilePath));
  }

  /** Cursor-paginated history (Contract §1) — every row carries the §2
   * verification outcome (status), its trigger, and the snapshot's size. */
  @RequirePermission(PermissionKey.BACKUP_MANAGE)
  @Get('history')
  listHistory(@Query() query: ListBackupHistoryQueryDto): Promise<ListBackupHistoryResponse> {
    return this.backupService.listHistory(query);
  }
}
