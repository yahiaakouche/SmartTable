/**
 * Notifications contract — API Contract Design §3 (`notifications` section:
 * GET /notifications + POST /notifications/:id/read) and §4 (the
 * `notification.created` staff event), Step 3.6.
 *
 * Step 3.6 rulings baked into this file:
 *  - B2(a): the live trigger vocabulary is order_created / order_ready /
 *    invitation_accepted. `bill_requested` stays in the vocabulary ONLY — no
 *    emitter exists until the corresponding business flow does (the Step 3.4
 *    B1 gap: no v1 code path sets the bill_requested table status).
 *  - B3: recipient map — order_created → role:kitchen; order_ready →
 *    role:waiter; invitation_accepted → role:owner + role:manager.
 *  - B4(a): shared role read-state — a role-targeted row is ONE row; any
 *    member of that role marks it read for the whole role. No schema change.
 *  - D2: payloads are minimal references (ids only) and carry NO money
 *    fields, ever — FR6-safe by construction for any recipient role.
 */
import { EmployeeRole } from './enums';

/** Frozen type vocabulary (Database Schema Design §7's examples, extended
 * with order_created for FR33's "new pending order"). Snake-case, completed
 * -state semantics per Engineering Standards §11. */
export const NOTIFICATION_TYPE = {
  ORDER_CREATED: 'order_created',
  ORDER_READY: 'order_ready',
  INVITATION_ACCEPTED: 'invitation_accepted',
  /** Vocabulary only — NO emitter until a request-bill flow exists (B2). */
  BILL_REQUESTED: 'bill_requested',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

/** D2 — minimal reference payloads: ids only, never a money field. */
export interface OrderNotificationPayload {
  orderId: string;
  tableId: string;
}

export interface InvitationAcceptedNotificationPayload {
  invitationId: string;
  employeeId: string;
}

export type NotificationPayload = OrderNotificationPayload | InvitationAcceptedNotificationPayload;

/** GET /notifications item AND the `notification.created` event body (D9):
 * one shape serves both — the bridge routes on the two targeting fields and
 * passes the whole body through (Step 3.5, ruling D9). */
export interface NotificationDto {
  id: string;
  type: NotificationType;
  payload: NotificationPayload;
  /** Set for role-targeted rows (B4(a) shared read-state), else null. */
  recipientRole: EmployeeRole | null;
  /** Set for employee-targeted rows, else null. */
  recipientEmployeeId: string | null;
  readAt: number | null;
  createdAt: number;
}

/** GET /notifications response — cursor pagination (Contract §1). */
export interface ListNotificationsResponse {
  data: NotificationDto[];
  meta: { nextCursor: string | null };
}
