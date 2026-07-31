import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { ListNotificationsResponse, NotificationDto } from '@smarttable/shared-types';
import { ActingEmployee, CurrentEmployee } from '../auth/decorators/current-employee.decorator';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationsService } from './notifications.service';

/**
 * Notifications endpoints (API Contract Design §3 — exactly the two routes
 * listed there for the notifications module; D11: no invented surface).
 * Thin translation layer only — recipient scoping, cursor pagination and
 * read-state rules all live in NotificationsService (Engineering Standards
 * §3).
 *
 * No @RequirePermission: PRD §11 defines no notifications row, so any
 * authenticated employee may use these routes — the service restricts every
 * caller to their OWN scope (B4(a)/D5). No throttler override: the Security
 * §5 default authenticated class (120/min) applies.
 */
@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** Cursor pagination, filterable by unreadOnly (Contract §3). */
  @Get('notifications')
  listNotifications(
    @Query() query: ListNotificationsQueryDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<ListNotificationsResponse> {
    return this.notificationsService.listForEmployee(query, actor);
  }

  /** D7: naturally idempotent — re-marking an already-read notification
   * returns its current DTO with the original first-read timestamp. */
  @Post('notifications/:id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<NotificationDto> {
    return this.notificationsService.markRead(id, actor);
  }
}
