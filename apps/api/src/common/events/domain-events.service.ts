import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/** Frozen internal event names — API Contract Design §4 (past tense, per
 * Engineering Standards §11). The Socket.IO bridge (Step 3.5) subscribes to
 * exactly these names; domain modules emit them so the seam is already in
 * place and tested.
 *
 * Not every frozen §4 event flows on this bus: `employee.presence_changed`
 * is emitted by the real-time gateway itself (B1 ruling — the gateway is the
 * only possible source of connect/disconnect truth), so it has no bus name
 * here. `notification.created` and `restaurant_profile.changed` have no
 * emitter until the notifications/config steps; their names are declared now
 * so the bridge subscribes once and those steps flow with zero bridge
 * changes (rulings D8/D9). */
export const DOMAIN_EVENT = {
  PRODUCT_AVAILABILITY_CHANGED: 'product.availability_changed',
  TABLE_STATUS_CHANGED: 'table.status_changed',
  ORDER_CREATED: 'order.created',
  ORDER_ACCEPTED: 'order.accepted',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  INVITATION_ACCEPTED: 'invitation.accepted',
  NOTIFICATION_CREATED: 'notification.created',
  RESTAURANT_PROFILE_CHANGED: 'restaurant_profile.changed',
} as const;

export interface ProductAvailabilityChangedPayload {
  productId: string;
  isAvailable: boolean;
}

export interface TableStatusChangedPayload {
  tableId: string;
  fromStatus: string;
  toStatus: string;
}

/** API Contract §4 — `order.created` / `order.accepted` carry the full
 * GET /orders/:id response shape; per-room shaping (e.g. FR6 price stripping
 * for the kitchen room) is the Socket.IO bridge's concern (ruling D5). Typed
 * as a generic record here so the bus never depends on module internals. */
export type OrderDtoPayload = Record<string, unknown>;

export interface OrderStatusChangedPayload {
  orderId: string;
  fromStatus: string;
  toStatus: string;
}

/** Contract §4 — `invitation.accepted` to owner-room (ruling D6). */
export interface InvitationAcceptedPayload {
  invitationId: string;
  employeeId: string;
}

/** Contract §4 — `notification.created` room targeting (ruling D9). The
 * notifications step owns the body; these two fields select the room, and
 * are frozen now so that step flows with zero bridge changes. */
export interface NotificationCreatedPayload {
  recipientRole: string | null;
  recipientEmployeeId: string | null;
  [key: string]: unknown;
}

/** Contract §4 — `restaurant_profile.changed` carries the full updated
 * profile DTO, owned by the config step; typed as a passthrough record so
 * the bridge never depends on a module that does not exist yet (D8). */
export type RestaurantProfileChangedPayload = Record<string, unknown>;

/**
 * The frozen internal event bus (Technology Stack: "Node EventEmitter, no
 * Redis/message broker in v1"; API Contract §1: "internal EventEmitter domain
 * events for side-effects — never HTTP calls between modules").
 *
 * BINDING RULE (API Contract §4): a domain event is emitted only AFTER its
 * corresponding database transaction has committed successfully — never
 * before. Callers emit once their writes have completed; this service
 * deliberately offers no transactional hooks that could invite doing so.
 */
@Injectable()
export class DomainEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each open customer SSE stream subscribes per order, so listener count
    // scales with connected customers — far past the default cap of 10. The
    // process is a single-restaurant LAN server (physically bounded device
    // count) and every stream removes its listeners on disconnect, so an
    // unbounded cap is safe here; the warning would be pure noise.
    this.emitter.setMaxListeners(0);
  }

  emitProductAvailabilityChanged(payload: ProductAvailabilityChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED, payload);
  }

  emitTableStatusChanged(payload: TableStatusChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.TABLE_STATUS_CHANGED, payload);
  }

  emitOrderCreated(payload: OrderDtoPayload): void {
    this.emitter.emit(DOMAIN_EVENT.ORDER_CREATED, payload);
  }

  emitOrderAccepted(payload: OrderDtoPayload): void {
    this.emitter.emit(DOMAIN_EVENT.ORDER_ACCEPTED, payload);
  }

  emitOrderStatusChanged(payload: OrderStatusChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.ORDER_STATUS_CHANGED, payload);
  }

  emitInvitationAccepted(payload: InvitationAcceptedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.INVITATION_ACCEPTED, payload);
  }

  /** No caller until the notifications step (3.6) — the typed emit path is
   * frozen now so that step needs zero changes to this file (ruling D9). */
  emitNotificationCreated(payload: NotificationCreatedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.NOTIFICATION_CREATED, payload);
  }

  /** No caller until the config step — same forward-seam rationale (D8). */
  emitRestaurantProfileChanged(payload: RestaurantProfileChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED, payload);
  }

  /** Subscription path for the real-time bridge, for customer SSE streams,
   * and for tests. Returns an unsubscribe function — long-lived subscribers
   * (SSE streams) MUST call it on client disconnect to avoid leaks. */
  on(event: string, listener: (payload: unknown) => void): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.removeListener(event, listener);
    };
  }
}
