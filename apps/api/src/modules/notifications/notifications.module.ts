import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NOTIFICATIONS_REPOSITORY, DrizzleNotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Notifications domain — Step 3.6 (FR33, API Contract §3/§4).
 *
 * Depends on OrdersModule ONLY for one post-commit enrichment read (the
 * `order_ready` payload's tableId — Contract §4's status payload carries
 * none); the dependency direction is notifications → orders, never the
 * reverse. The event bus is global (EventsModule), so creation arrives as a
 * side-effect subscription (B5(a)) with zero changes to earlier steps.
 */
@Module({
  imports: [OrdersModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsListener,
    { provide: NOTIFICATIONS_REPOSITORY, useClass: DrizzleNotificationsRepository },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
