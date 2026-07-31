import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/** Frozen internal event names — API Contract Design §4 (past tense, per
 * Engineering Standards §11). The Socket.IO bridge built in the real-time
 * step will subscribe to exactly these names; domain modules emit them today
 * so the seam is already in place and tested. */
export const DOMAIN_EVENT = {
  PRODUCT_AVAILABILITY_CHANGED: 'product.availability_changed',
  TABLE_STATUS_CHANGED: 'table.status_changed',
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

  emitProductAvailabilityChanged(payload: ProductAvailabilityChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED, payload);
  }

  emitTableStatusChanged(payload: TableStatusChangedPayload): void {
    this.emitter.emit(DOMAIN_EVENT.TABLE_STATUS_CHANGED, payload);
  }

  /** Subscription path for the future real-time bridge — and for tests today. */
  on(event: string, listener: (payload: unknown) => void): void {
    this.emitter.on(event, listener);
  }
}
