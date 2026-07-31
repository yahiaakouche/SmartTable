import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ORDERS_REPOSITORY, DrizzleOrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';

/**
 * Orders domain — Step 3.3. Depends on the audit append path (FR38,
 * Security §7) and the global event bus (Contract §4); the auth module's
 * guards are global and apply to these routes like every other.
 */
@Module({
  imports: [AuditModule],
  controllers: [OrdersController],
  providers: [OrdersService, { provide: ORDERS_REPOSITORY, useClass: DrizzleOrdersRepository }],
  exports: [OrdersService],
})
export class OrdersModule {}
