import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AUDIT_REPOSITORY, DrizzleAuditRepository } from './audit.repository';

/**
 * Imported by any module that performs auditable actions (auth, employees,
 * invitations now; menu, orders, billing, tables later — FR38's list).
 */
@Module({
  providers: [AuditService, { provide: AUDIT_REPOSITORY, useClass: DrizzleAuditRepository }],
  exports: [AuditService],
})
export class AuditModule {}
