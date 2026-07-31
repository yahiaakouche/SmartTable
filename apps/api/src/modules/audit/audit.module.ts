import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AUDIT_REPOSITORY, DrizzleAuditRepository } from './audit.repository';

/**
 * Imported by any module that performs auditable actions (auth, employees,
 * invitations, menu, orders, billing, tables — FR38's list). Step 3.8 added
 * the query surface (GET /audit-log, Owner/Manager only per ruling B1).
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, { provide: AUDIT_REPOSITORY, useClass: DrizzleAuditRepository }],
  exports: [AuditService],
})
export class AuditModule {}
