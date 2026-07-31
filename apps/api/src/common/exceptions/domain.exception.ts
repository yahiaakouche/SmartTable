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

/** Table status machine — e.g. mark-cleaned attempted on a table that is not
 * `needs_cleaning`. Module-level extension of the frozen error catalog
 * (API Contract §2 explicitly allows per-module extension via DomainException). */
export class InvalidTableStatusTransitionException extends DomainException {
  readonly code = 'INVALID_TABLE_STATUS_TRANSITION';
  readonly httpStatus = 409;

  constructor(tableId: string, fromStatus: string, attemptedAction: string) {
    super(`Table ${tableId} is '${fromStatus}' — '${attemptedAction}' is not a legal action in this state.`, {
      tableId,
      fromStatus,
      attemptedAction,
    });
  }
}

/** Security Architecture §6 — upload rejected (bad magic bytes, disallowed
 * format such as SVG, or over the configured size limit). Module-level
 * extension of the frozen error catalog (API Contract §2). */
export class InvalidFileUploadException extends DomainException {
  readonly code = 'INVALID_FILE_UPLOAD';
  readonly httpStatus = 400;

  constructor(reason: string) {
    super(`Upload rejected: ${reason}`);
  }
}

/** API Contract Design §2 — missing/expired/invalid JWT or failed credential check. */
export class UnauthenticatedException extends DomainException {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor(message = 'Authentication required or credentials invalid.') {
    super(message);
  }
}

/** Security Architecture §1 — PIN lockout after 5 consecutive failures.
 * 401 (authentication-class failure) with the remaining cooldown as detail
 * so the terminal UI can show "try again in N minutes". */
export class AccountLockedException extends DomainException {
  readonly code = 'ACCOUNT_LOCKED';
  readonly httpStatus = 401;

  constructor(retryAfterSeconds: number) {
    super(`Account is temporarily locked due to repeated failed attempts. Try again later.`, {
      retryAfterSeconds,
    });
  }
}

/** API Contract Design §2 — entity does not exist. */
export class EntityNotFoundException extends DomainException {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} does not exist.`, { entityType, entityId });
  }
}

/** API Contract Design §2 — invitation token has already been consumed (single-use, FR26). */
export class InvitationAlreadyAcceptedException extends DomainException {
  readonly code = 'INVITATION_ALREADY_ACCEPTED';
  readonly httpStatus = 409;

  constructor(invitationId: string) {
    super(`Invitation ${invitationId} has already been accepted.`, { invitationId });
  }
}
