import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BILLING_REPOSITORY, DrizzleBillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { ShiftsService } from './shifts.service';
import { BillingController } from './billing.controller';

/**
 * Billing domain — Step 3.4 (Contract §3 `billing` section: payments +
 * shifts). Depends on the audit append path (FR38) and the global event bus
 * (Contract §4); the auth module's guards are global and apply to these
 * routes like every other.
 */
@Module({
  imports: [AuditModule],
  controllers: [BillingController],
  providers: [BillingService, ShiftsService, { provide: BILLING_REPOSITORY, useClass: DrizzleBillingRepository }],
  exports: [BillingService, ShiftsService],
})
export class BillingModule {}
