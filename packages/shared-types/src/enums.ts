/**
 * Shared enums — single source of truth for contract values between
 * apps/api and apps/web (Engineering Standards §1).
 *
 * These values are the literal TEXT values stored in SQLite CHECK constraints
 * (Database Schema Design, Appendix A) — keep in sync with migrations manually,
 * since SQLite has no native enum type to generate these from.
 */

export enum EmployeeRole {
  OWNER = 'owner',
  MANAGER = 'manager',
  CASHIER = 'cashier',
  WAITER = 'waiter',
  KITCHEN = 'kitchen',
}

export enum TableStatus {
  AVAILABLE = 'available',
  OCCUPIED = 'occupied',
  BILL_REQUESTED = 'bill_requested',
  NEEDS_CLEANING = 'needs_cleaning',
}

export enum TableBillGroupStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum OrderChannel {
  DINE_IN = 'dine_in',
  DELIVERY = 'delivery', // reserved, not activated in v1 — FR39
}

export enum OrderSource {
  QR = 'qr',
  WAITER_MANUAL = 'waiter_manual',
}

export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  PREPARING = 'preparing',
  READY = 'ready',
  SERVED = 'served',
  PAID = 'paid',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum PaymentMethod {
  CASH = 'cash', // the only value active in v1 — future methods extend this, not replace it
}

export enum ShiftStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

export enum InvitationChannel {
  LINK = 'link',
  QR = 'qr',
  EMAIL = 'email',
}

export enum Language {
  AR = 'ar',
  FR = 'fr',
}

export enum BackupStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}
