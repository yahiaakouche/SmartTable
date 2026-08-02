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

/** API Contract §2 — generic 400 for request-shape problems a DTO cannot
 * express (e.g. a malformed opaque pagination cursor). */
export class ValidationFailedException extends DomainException {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Order Lifecycle state machine (PRD §12) — the requested transition is not
 * legal from the order's current status. The state machine inside the orders
 * service is the single source of truth for legality (Contract §3 advance
 * design note); this is how it says "no". Module-level extension of the
 * frozen error catalog (API Contract §2). */
export class InvalidOrderTransitionException extends DomainException {
  readonly code = 'INVALID_ORDER_TRANSITION';
  readonly httpStatus = 409;

  constructor(orderId: string, fromStatus: string, attemptedAction: string) {
    super(`Order ${orderId} is '${fromStatus}' — '${attemptedAction}' is not a legal transition from this status.`, {
      orderId,
      fromStatus,
      attemptedAction,
    });
  }
}

/** Q9 ruling — an order is rejected as a whole (never partially accepted)
 * when any requested product cannot be sold: unknown product, marked
 * unavailable, or under an inactive category. 409 with the full per-product
 * breakdown so the client can show exactly what to remove. */
export class ProductUnavailableException extends DomainException {
  readonly code = 'PRODUCT_UNAVAILABLE';
  readonly httpStatus = 409;

  constructor(unavailableProductIds: string[]) {
    super(`One or more requested products are not available. The order was not created.`, {
      unavailableProductIds,
    });
  }
}

/** API Contract §1 — the `Idempotency-Key` header is REQUIRED on the
 * order/payment creation endpoints; without it safe retries are impossible. */
export class IdempotencyKeyRequiredException extends DomainException {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  readonly httpStatus = 400;

  constructor(endpoint: string) {
    super(`The 'Idempotency-Key' header is required on ${endpoint}.`, { endpoint });
  }
}

/** API Contract §2 — "not an error per se": the same key + same endpoint +
 * same request body has already completed successfully, so the ORIGINAL
 * response is returned instead of executing the operation a second time.
 * The exception filter renders `replayBody` verbatim with HTTP 200. */
export class IdempotencyKeyReusedException extends DomainException {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 200;

  constructor(readonly replayBody: unknown) {
    super('This request has already been processed; returning the original response.');
  }
}

/** The same idempotency key arrived with a DIFFERENT request body, or the
 * first request carrying this key is still in flight — the client must not
 * reuse keys across logically different requests. */
export class IdempotencyKeyConflictException extends DomainException {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly httpStatus = 409;

  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- billing

/** Ruling D1 — a Table Bill Group can only be paid once EVERY order in it has
 * reached a terminal-or-served state: orders still in flight (pending /
 * accepted / preparing / ready) block payment, and a group with nothing
 * billable (all orders cancelled) has no bill to pay. Module-level extension
 * of the frozen error catalog (API Contract §2). */
export class PaymentNotReadyException extends DomainException {
  readonly code = 'PAYMENT_NOT_READY';
  readonly httpStatus = 409;

  constructor(tableBillGroupId: string, blockingOrderIds: string[]) {
    super(
      blockingOrderIds.length > 0
        ? `Table bill group ${tableBillGroupId} cannot be paid yet — some orders are still in progress.`
        : `Table bill group ${tableBillGroupId} has nothing to pay — every order in it was cancelled.`,
      { tableBillGroupId, blockingOrderIds },
    );
  }
}

/** Ruling D2 — exactly one payment per Table Bill Group in v1 (no split bill);
 * a second payment attempt against an already-paid group conflicts. */
export class PaymentAlreadyRecordedException extends DomainException {
  readonly code = 'PAYMENT_ALREADY_RECORDED';
  readonly httpStatus = 409;

  constructor(tableBillGroupId: string, paymentId: string | null) {
    super(`Table bill group ${tableBillGroupId} has already been paid.`, { tableBillGroupId, paymentId });
  }
}

/** Ruling D6 — one open shift per employee at a time; opening a second one
 * while another is still open conflicts. */
export class ShiftAlreadyOpenException extends DomainException {
  readonly code = 'SHIFT_ALREADY_OPEN';
  readonly httpStatus = 409;

  constructor(employeeId: string, openShiftId: string) {
    super(`Employee ${employeeId} already has an open shift. Close it before opening a new one.`, {
      employeeId,
      openShiftId,
    });
  }
}

/** Closing a shift that is already closed conflicts (the reconciliation was
 * already computed and recorded — it must never be recomputed silently). */
export class ShiftAlreadyClosedException extends DomainException {
  readonly code = 'SHIFT_ALREADY_CLOSED';
  readonly httpStatus = 409;

  constructor(shiftId: string) {
    super(`Shift ${shiftId} is already closed.`, { shiftId });
  }
}

/** Step 3.11 ruling B1(a)/D4 — the one-shot guard behind the public
 * bootstrap endpoint: once the Setup Wizard transaction has committed,
 * every further completion attempt is a conflict, never a second setup. */
export class SetupAlreadyCompletedException extends DomainException {
  readonly code = 'SETUP_ALREADY_COMPLETED';
  readonly httpStatus = 409;

  constructor() {
    super('Setup has already been completed for this installation.');
  }
}
