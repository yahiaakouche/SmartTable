/**
 * Real-time contract — API Contract Design §4 (staff, Socket.IO) and §5
 * (customer, SSE). Engineering Standards §1: WebSocket event names and their
 * payload shapes are cross-boundary contracts, so they live ONLY here.
 *
 * Step 3.5 rulings baked into this file:
 *  - B1(a): `employee.presence_changed` is emitted by the real-time gateway
 *    itself (the only possible source) on connect/disconnect transitions;
 *    the REST presence surface stays with the dedicated presence step.
 *  - B2(a): `owner-room` membership is Owner AND Manager — the frozen room
 *    vocabulary has no `role:manager`, so a Manager's entire live visibility
 *    (PRD §11 roster/presence view, FR28, FR31) flows through this room.
 *  - B3(a): `order.status_changed` goes to role:kitchen, role:waiter,
 *    role:cashier and owner-room for every transition — the payload carries
 *    no pricing, so the static set is FR6-safe by construction.
 *  - D3: both channels are server→client only; all mutations stay REST.
 *  - D4: clients reconcile after reconnect by refetching via REST — there is
 *    no replay buffer (ADR-006: no Redis; the internal bus has no history).
 *  - D5: order payloads are shaped PER ROOM at the gateway — role:kitchen
 *    receives the FR6/Q7 KitchenOrderDto (pricing stripped server-side),
 *    everyone else receives the full OrderDto.
 */
import { EmployeeRole } from './enums';
import type { KitchenOrderDto, OrderDto, PublicOrderStatusDto } from './orders';

// ------------------------------------------------------------ staff channel

/** Frozen event names — API Contract Design §4 (past tense, ES §11). */
export const STAFF_EVENT = {
  ORDER_CREATED: 'order.created',
  ORDER_ACCEPTED: 'order.accepted',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  TABLE_STATUS_CHANGED: 'table.status_changed',
  RESTAURANT_PROFILE_CHANGED: 'restaurant_profile.changed',
  PRODUCT_AVAILABILITY_CHANGED: 'product.availability_changed',
  EMPLOYEE_PRESENCE_CHANGED: 'employee.presence_changed',
  INVITATION_ACCEPTED: 'invitation.accepted',
  NOTIFICATION_CREATED: 'notification.created',
} as const;

export type StaffEventName = (typeof STAFF_EVENT)[keyof typeof STAFF_EVENT];

/** Frozen room vocabulary — API Contract Design §4. */
export const OWNER_ROOM = 'owner-room';
export const RESTAURANT_BROADCAST_ROOM = 'restaurant-broadcast';
export function roleRoom(role: EmployeeRole): string {
  return `role:${role}`;
}
export function employeeRoom(employeeId: string): string {
  return `employee:${employeeId}`;
}

/** B2 ruling: owner-room membership = Owner + Manager. */
export const OWNER_ROOM_ROLES: readonly EmployeeRole[] = [EmployeeRole.OWNER, EmployeeRole.MANAGER];

/**
 * Authenticated staff sockets are joined server-side (never client-claimed,
 * ruling D2) to exactly these rooms:
 *  - `role:<role>`            — every staff member
 *  - `employee:<id>`          — every staff member (targeted notifications, D9)
 *  - `restaurant-broadcast`   — every staff member
 *  - `owner-room`             — Owner and Manager only (B2)
 */

// ------------------------------------------------- staff event payloads

/** `order.created` / `order.accepted` carry the GET /orders/:id shape
 * (Contract §4) — full OrderDto for waiter/owner-room, the FR6/Q7
 * KitchenOrderDto (no pricing) for role:kitchen (ruling D5). */
export type OrderCreatedEventPayload = OrderDto | KitchenOrderDto;
export type OrderAcceptedEventPayload = OrderDto | KitchenOrderDto;

export interface OrderStatusChangedEventPayload {
  orderId: string;
  fromStatus: string;
  toStatus: string;
}

/** Contract §4 leaves this shape cell blank; the internal bus payload is the
 * natural reading (ruling D12) and carries no pricing by construction. */
export interface TableStatusChangedEventPayload {
  tableId: string;
  fromStatus: string;
  toStatus: string;
}

export interface ProductAvailabilityChangedEventPayload {
  productId: string;
  isAvailable: boolean;
}

/** Emitted by the gateway itself on presence transitions (B1 ruling):
 * online when an employee's FIRST socket connects, offline when their LAST
 * socket drops — multi-device staff are online while any device is. */
export interface EmployeePresenceChangedEventPayload {
  employeeId: string;
  online: boolean;
}

export interface InvitationAcceptedEventPayload {
  invitationId: string;
  employeeId: string;
}

/** Contract §4: `restaurant_profile.changed` carries the full updated profile
 * DTO. The config module (a later step) owns that DTO; typed as a passthrough
 * record here so the bridge never depends on a module that does not exist yet. */
export type RestaurantProfileChangedEventPayload = Record<string, unknown>;

/** Contract §4: `notification.created` targets a role room or an employee
 * room. The notifications step (3.6) owns the body; the bridge routes on the
 * two targeting fields (ruling D9) and passes the whole payload through. */
export interface NotificationCreatedEventPayload {
  recipientRole: EmployeeRole | null;
  recipientEmployeeId: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------- customer channel

/** Frozen named SSE events — API Contract Design §5. */
export const CUSTOMER_EVENT = {
  STATUS_CHANGED: 'status_changed',
  MENU_UPDATED: 'menu_updated',
} as const;

export type CustomerEventName = (typeof CUSTOMER_EVENT)[keyof typeof CUSTOMER_EVENT];

/** `status_changed` payload — uniformly the Q8 minimal `{id, status}` shape:
 * the first event on a stream is the initial snapshot (ruling D7), later
 * events carry the new status after each transition. The customer channel
 * never exposes staff-facing detail such as fromStatus. */
export type StatusChangedStreamPayload = PublicOrderStatusDto;

/** `menu_updated` payload (ruling D8): fired on `product.availability_changed`
 * — the only menu-affecting bus event in v1 — and on
 * `restaurant_profile.changed` once the config step exists. The customer
 * client treats it as a refetch cue for GET /public/menu/:qrToken. */
export type MenuUpdatedStreamPayload = ProductAvailabilityChangedEventPayload;
