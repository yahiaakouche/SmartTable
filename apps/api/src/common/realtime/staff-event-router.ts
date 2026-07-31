import {
  EmployeeRole,
  NotificationCreatedEventPayload,
  OWNER_ROOM,
  RESTAURANT_BROADCAST_ROOM,
  employeeRoom,
  roleRoom,
} from '@smarttable/shared-types';
import { DOMAIN_EVENT } from '../events/domain-events.service';

/** One server→client emission: the target rooms and the payload those rooms
 * receive. Kept as data so the routing table is unit-testable without a
 * Socket.IO server (Engineering Standards §10). */
export interface RoutedEmission {
  rooms: string[];
  payload: unknown;
}

const KITCHEN_ROOM = roleRoom(EmployeeRole.KITCHEN);
const WAITER_ROOM = roleRoom(EmployeeRole.WAITER);
const CASHIER_ROOM = roleRoom(EmployeeRole.CASHIER);

/**
 * FR6/Q7 kitchen shaping (ruling D5): the same deterministic strip the REST
 * layer applies to Kitchen-role callers — `unitPriceMinor` removed per item,
 * everything else untouched. A pure function over the bus payload: no DB
 * re-read, no bus change.
 */
export function toKitchenOrderPayload(payload: unknown): unknown {
  const order = payload as { items?: unknown } & Record<string, unknown>;
  if (!order || !Array.isArray(order.items)) return payload;
  return {
    ...order,
    items: (order.items as Array<Record<string, unknown>>).map((item) => {
      const { unitPriceMinor: _stripped, ...kitchenItem } = item;
      return kitchenItem;
    }),
  };
}

/**
 * The frozen room routing table — API Contract Design §4, with the Step 3.5
 * rulings applied:
 *  - B3: `order.status_changed` → kitchen + waiter + cashier + owner-room.
 *  - B2: owner-room members are Owner + Manager (membership is assigned at
 *    handshake; this table only names the room).
 *  - D5: order payloads are shaped per room (kitchen gets no pricing).
 *  - D9: `notification.created` is pre-wired although nothing emits it until
 *    the notifications step — that step then needs zero bridge changes.
 *  - D12: `table.status_changed` passes the bus payload through unchanged.
 *
 * Events whose rooms overlap for a single socket are always returned as ONE
 * emission with a room list — Socket.IO delivers once per socket per emit,
 * so no client ever receives a duplicate.
 */
export function routeStaffEvent(event: string, payload: unknown): RoutedEmission[] {
  switch (event) {
    case DOMAIN_EVENT.ORDER_CREATED:
      return [
        { rooms: [KITCHEN_ROOM], payload: toKitchenOrderPayload(payload) },
        { rooms: [WAITER_ROOM], payload },
      ];
    case DOMAIN_EVENT.ORDER_ACCEPTED:
      return [
        { rooms: [KITCHEN_ROOM], payload: toKitchenOrderPayload(payload) },
        { rooms: [WAITER_ROOM, OWNER_ROOM], payload },
      ];
    case DOMAIN_EVENT.ORDER_STATUS_CHANGED:
      return [{ rooms: [KITCHEN_ROOM, WAITER_ROOM, CASHIER_ROOM, OWNER_ROOM], payload }];
    case DOMAIN_EVENT.TABLE_STATUS_CHANGED:
      return [{ rooms: [WAITER_ROOM, CASHIER_ROOM, OWNER_ROOM], payload }];
    case DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED:
    case DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED:
      return [{ rooms: [RESTAURANT_BROADCAST_ROOM], payload }];
    case DOMAIN_EVENT.INVITATION_ACCEPTED:
      return [{ rooms: [OWNER_ROOM], payload }];
    case DOMAIN_EVENT.NOTIFICATION_CREATED: {
      const target = payload as NotificationCreatedEventPayload | null | undefined;
      const rooms: string[] = [];
      if (target?.recipientRole) rooms.push(roleRoom(target.recipientRole));
      if (target?.recipientEmployeeId) rooms.push(employeeRoom(target.recipientEmployeeId));
      return rooms.length > 0 ? [{ rooms, payload }] : [];
    }
    default:
      return [];
  }
}
