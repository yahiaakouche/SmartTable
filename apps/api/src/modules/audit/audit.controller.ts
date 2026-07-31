import { Controller, Get, Query } from '@nestjs/common';
import { PermissionKey } from '@smarttable/shared-types';
import type { ListAuditLogResponse } from '@smarttable/shared-types';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';
import { AuditService } from './audit.service';

/**
 * The audit query surface (API Contract Design §3 — exactly the one route
 * listed there for the audit module). Thin translation layer only: filter
 * composition, cursor pagination and DTO shaping live in AuditService
 * (Engineering Standards §3).
 *
 * Step 3.8 ruling B1: AUDIT_VIEW = Owner + Manager only. Read-only — the
 * read itself produces no audit row (FR38's trigger list covers mutations
 * only, D8), no Idempotency-Key, default 120/min authenticated throttle
 * class (Security §5).
 */
@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** Cursor pagination, filterable by entityType, entityId, actorEmployeeId
   * and an epoch-ms date range (Contract §3, ruling B2(a)). */
  @RequirePermission(PermissionKey.AUDIT_VIEW)
  @Get('audit-log')
  listAuditLog(@Query() query: ListAuditLogQueryDto): Promise<ListAuditLogResponse> {
    return this.auditService.list(query);
  }
}
