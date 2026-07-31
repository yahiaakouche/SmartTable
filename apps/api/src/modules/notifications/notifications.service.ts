import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EmployeeRole,
  ListNotificationsResponse,
  NOTIFICATION_TYPE,
  NotificationDto,
  NotificationPayload,
  NotificationType,
  OrderStatus,
} from '@smarttable/shared-types';
import {
  DomainEventsService,
  InvitationAcceptedPayload,
  OrderStatusChangedPayload,
} from '../../common/events/domain-events.service';
import { EntityNotFoundException, InsufficientPermissionException, ValidationFailedException } from '../../common/exceptions/domain.exception';
import type { ActingEmployee } from '../auth/decorators/current-employee.decorator';
import { OrdersService } from '../orders/orders.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NOTIFICATIONS_REPOSITORY, NotificationRow, NotificationsRepository } from './notifications.repository';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export interface CreateNotificationInput {
  recipientRole: EmployeeRole | null;
  recipientEmployeeId: string | null;
  type: NotificationType;
  payload: NotificationPayload;
}

/**
 * Notifications domain — Step 3.6 (FR33, API Contract §3 `notifications`).
 *
 * Creation is a post-commit side-effect of domain events (ruling B5(a)): the
 * NotificationsListener forwards bus events here, this service maps each one
 * to persisted row(s) per the frozen recipient map (ruling B3), and only
 * THEN emits `notification.created` — so the real-time event can never
 * announce a row that does not exist (Contract §4 emit-after-commit, applied
 * one level down).
 *
 * Read surface (ruling B1(a)): every authenticated employee sees ONLY their
 * own scope — `recipient_role = their role OR recipient_employee_id = them`
 * (ruling B4(a) shared role read-state; the shifts own-scope pattern, D5).
 * No PermissionKey exists for notifications: PRD §11 has no row for them.
 *
 * Payloads carry ids only — never a money field (D2) — so any recipient
 * role, Kitchen included, can receive any notification without FR6 risk.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly notificationsRepository: NotificationsRepository,
    private readonly events: DomainEventsService,
    private readonly ordersService: OrdersService,
  ) {}

  // ------------------------------------------------------ creation (B5(a))

  /** order.created → role:kitchen (B3). The bus payload is the full order
   * DTO (Contract §4); only the two reference ids are taken from it (D2). */
  async notifyOrderCreated(orderPayload: Record<string, unknown>): Promise<void> {
    const orderId = orderPayload['id'];
    const tableId = orderPayload['tableId'];
    if (typeof orderId !== 'string' || typeof tableId !== 'string') {
      this.logger.error(`order.created payload missing id/tableId — notification skipped: ${JSON.stringify(orderPayload)}`);
      return;
    }
    await this.createAndEmit({
      recipientRole: EmployeeRole.KITCHEN,
      recipientEmployeeId: null,
      type: NOTIFICATION_TYPE.ORDER_CREATED,
      payload: { orderId, tableId },
    });
  }

  /** order.status_changed → role:waiter, but ONLY on entry into `ready`
   * (FR33 "order ready"; B2/B3). The frozen §4 payload carries no tableId,
   * so the order is re-read post-commit for the reference payload (D2). */
  async notifyOrderStatusChanged(payload: OrderStatusChangedPayload): Promise<void> {
    if (payload.toStatus !== OrderStatus.READY) return;
    const order = await this.ordersService.getOrder(payload.orderId, EmployeeRole.OWNER);
    await this.createAndEmit({
      recipientRole: EmployeeRole.WAITER,
      recipientEmployeeId: null,
      type: NOTIFICATION_TYPE.ORDER_READY,
      payload: { orderId: order.id, tableId: order.tableId },
    });
  }

  /** invitation.accepted → role:owner AND role:manager (B3) — one row per
   * role (B4(a): the schema's single recipient_role column cannot express
   * two roles in one row; the bridge routes each row's own emission). */
  async notifyInvitationAccepted(payload: InvitationAcceptedPayload): Promise<void> {
    for (const role of [EmployeeRole.OWNER, EmployeeRole.MANAGER] as const) {
      await this.createAndEmit({
        recipientRole: role,
        recipientEmployeeId: null,
        type: NOTIFICATION_TYPE.INVITATION_ACCEPTED,
        payload: { invitationId: payload.invitationId, employeeId: payload.employeeId },
      });
    }
  }

  /** Persist first, emit second — the emitted body IS the stored row's DTO
   * (D9: one shape serves REST and the socket; the bridge routes on the two
   * targeting fields). */
  private async createAndEmit(input: CreateNotificationInput): Promise<void> {
    const row = await this.notificationsRepository.insert({
      recipientRole: input.recipientRole,
      recipientEmployeeId: input.recipientEmployeeId,
      type: input.type,
      payloadJson: JSON.stringify(input.payload),
    });
    this.events.emitNotificationCreated({ ...this.toDto(row) });
  }

  // ---------------------------------------------------------- read surface

  /** GET /notifications — cursor pagination + unreadOnly (Contract §3),
   * scoped to the caller (B4(a)/D5). */
  async listForEmployee(query: ListNotificationsQueryDto, actor: ActingEmployee): Promise<ListNotificationsResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const cursor = query.cursor !== undefined ? this.decodeCursor(query.cursor) : null;

    // Fetch one extra row to learn whether another page exists.
    const rows = await this.notificationsRepository.listForRecipient(
      actor.role,
      actor.id,
      query.unreadOnly ?? false,
      cursor,
      limit + 1,
    );
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toDto(row)),
      meta: { nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null },
    };
  }

  /** POST /notifications/:id/read — D6: unknown id 404; a row outside the
   * caller's scope 403 (the shifts own-scope precedent). D7: naturally
   * idempotent — re-marking returns the current DTO and never overwrites
   * the first-read timestamp (enforced in the repository). */
  async markRead(id: string, actor: ActingEmployee): Promise<NotificationDto> {
    const row = await this.notificationsRepository.findById(id);
    if (!row) throw new EntityNotFoundException('notification', id);
    if (!this.isRecipient(row, actor)) throw new InsufficientPermissionException('notifications.read');
    if (row.readAt === null) {
      await this.notificationsRepository.markRead(id, Date.now());
    }
    const updated = await this.notificationsRepository.findById(id);
    return this.toDto(updated!);
  }

  // ------------------------------------------------------------- internals

  /** B4(a): a row is in scope when it targets the caller's role (shared by
   * the whole role) or the caller personally. */
  private isRecipient(row: NotificationRow, actor: ActingEmployee): boolean {
    return row.recipientRole === actor.role || row.recipientEmployeeId === actor.id;
  }

  private toDto(row: NotificationRow): NotificationDto {
    return {
      id: row.id,
      type: row.type as NotificationType,
      payload: JSON.parse(row.payloadJson) as NotificationPayload,
      recipientRole: (row.recipientRole as EmployeeRole | null) ?? null,
      recipientEmployeeId: row.recipientEmployeeId,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }

  private encodeCursor(row: NotificationRow): string {
    return Buffer.from(JSON.stringify({ c: row.createdAt, i: row.id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
      if (typeof parsed.c !== 'number' || typeof parsed.i !== 'string') throw new Error('bad shape');
      return { createdAt: parsed.c, id: parsed.i };
    } catch {
      throw new ValidationFailedException('Malformed pagination cursor.');
    }
  }
}
