/**
 * Error code catalog — matches API Contract Design §2.
 * The frontend (apps/web) switches on `error.code`, never on `error.message`
 * (message text is for humans/logs, code is for programmatic handling).
 */
export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  INSUFFICIENT_PERMISSION = 'INSUFFICIENT_PERMISSION',
  NOT_FOUND = 'NOT_FOUND',
  ORDER_LOCKED = 'ORDER_LOCKED',
  INVITATION_EXPIRED = 'INVITATION_EXPIRED',
  INVITATION_ALREADY_ACCEPTED = 'INVITATION_ALREADY_ACCEPTED',
  TABLE_HAS_ACTIVE_ORDER = 'TABLE_HAS_ACTIVE_ORDER',
  CLIENT_VERSION_STALE = 'CLIENT_VERSION_STALE',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** Standard error envelope shape — API Contract Design §1 */
export interface ApiErrorResponse {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Standard success envelope shape — API Contract Design §1 */
export interface ApiSuccessResponse<T> {
  data: T;
  meta?: {
    nextCursor?: string;
    page?: number;
    pageSize?: number;
    total?: number;
  };
}
