/**
 * Base class for all expected business errors (Engineering Standards §7).
 * These are normal control flow, not bugs — they map to 4xx responses and are
 * logged at info/debug level at most, never as an `error`-level log entry.
 */
export abstract class DomainException extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** Order Lifecycle, PRD §12 — attempted edit on an order past `preparing`. */
export class OrderLockedException extends DomainException {
  readonly code = 'ORDER_LOCKED';
  readonly httpStatus = 409;

  constructor(orderId: string) {
    super(`Order ${orderId} is locked and can no longer be edited directly. Create an Add-on Order instead.`, {
      orderId,
    });
  }
}

export class InvitationExpiredException extends DomainException {
  readonly code = 'INVITATION_EXPIRED';
  readonly httpStatus = 409;

  constructor(invitationId: string) {
    super(`Invitation ${invitationId} has expired.`, { invitationId });
  }
}

export class InsufficientPermissionException extends DomainException {
  readonly code = 'INSUFFICIENT_PERMISSION';
  readonly httpStatus = 403;

  constructor(action: string) {
    super(`You do not have permission to perform: ${action}`, { action });
  }
}

export class TableHasActiveOrderException extends DomainException {
  readonly code = 'TABLE_HAS_ACTIVE_ORDER';
  readonly httpStatus = 409;

  constructor(tableId: string) {
    super(`Table ${tableId} cannot be removed while it has an active order.`, { tableId });
  }
}
