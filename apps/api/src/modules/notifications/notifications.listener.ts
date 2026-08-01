import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  BackupFailedPayload,
  DOMAIN_EVENT,
  DomainEventsService,
  InvitationAcceptedPayload,
  OrderStatusChangedPayload,
} from '../../common/events/domain-events.service';
import { NotificationsService } from './notifications.service';

/**
 * The B5(a) seam: notification creation is a SIDE-EFFECT of domain events
 * (API Contract §1 — "internal EventEmitter domain events for
 * side-effects"), so this module listens instead of the orders/invitations
 * services being modified. Zero changes to Steps 3.1–3.4 code.
 *
 * FAILURE ISOLATION (frozen principle, Hardware Architecture's critical
 * rule applied to notifications): the bus calls listeners synchronously in
 * the emitter's call stack, so a notification failure must NEVER be able to
 * break a business transition. Every handler is fire-and-forget (`void`)
 * and every rejection is caught and app-logged here — nothing propagates
 * back into the order/invitation lifecycle.
 */
@Injectable()
export class NotificationsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsListener.name);
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly events: DomainEventsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribes.push(
      this.events.on(DOMAIN_EVENT.ORDER_CREATED, (payload) => {
        void this.isolated(() => this.notificationsService.notifyOrderCreated(payload as Record<string, unknown>), DOMAIN_EVENT.ORDER_CREATED);
      }),
      this.events.on(DOMAIN_EVENT.ORDER_STATUS_CHANGED, (payload) => {
        void this.isolated(
          () => this.notificationsService.notifyOrderStatusChanged(payload as OrderStatusChangedPayload),
          DOMAIN_EVENT.ORDER_STATUS_CHANGED,
        );
      }),
      this.events.on(DOMAIN_EVENT.INVITATION_ACCEPTED, (payload) => {
        void this.isolated(
          () => this.notificationsService.notifyInvitationAccepted(payload as InvitationAcceptedPayload),
          DOMAIN_EVENT.INVITATION_ACCEPTED,
        );
      }),
      // Step 3.9 (B5(a)) — the backup engine's failure signal becomes an
      // Owner notification here; the backup module itself never imports
      // notifications (Contract §1: side-effects via the bus, never HTTP).
      this.events.on(DOMAIN_EVENT.BACKUP_FAILED, (payload) => {
        void this.isolated(() => this.notificationsService.notifyBackupFailed(payload as BackupFailedPayload), DOMAIN_EVENT.BACKUP_FAILED);
      }),
    );
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Runs the handler; a failure is logged (app-log, Monitoring §1) and
   * swallowed — the business action that emitted the event stands. */
  private async isolated(run: () => Promise<void>, event: string): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Notification creation failed for ${event}: ${(error as Error).message}`, (error as Error).stack);
    }
  }
}
