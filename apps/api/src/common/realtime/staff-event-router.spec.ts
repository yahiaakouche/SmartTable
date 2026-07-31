import { EmployeeRole, OWNER_ROOM, RESTAURANT_BROADCAST_ROOM, employeeRoom, roleRoom } from '@smarttable/shared-types';
import { DOMAIN_EVENT } from '../events/domain-events.service';
import { routeStaffEvent, toKitchenOrderPayload } from './staff-event-router';

const KITCHEN = roleRoom(EmployeeRole.KITCHEN);
const WAITER = roleRoom(EmployeeRole.WAITER);
const CASHIER = roleRoom(EmployeeRole.CASHIER);

const fullOrderPayload = {
  id: 'order-1',
  tableBillGroupId: 'group-1',
  tableId: 'table-1',
  channel: 'dine_in',
  isAddon: false,
  status: 'pending',
  source: 'qr',
  items: [
    { id: 'item-1', productId: 'p1', name: 'شوربة', category: 'مقبلات', unitPriceMinor: 2500, quantity: 2, notes: null },
    { id: 'item-2', productId: 'p2', name: 'قلب اللوز', category: 'حلويات', unitPriceMinor: 1500, quantity: 1, notes: 'بدون سكر' },
  ],
  createdByEmployeeId: null,
  acceptedByEmployeeId: null,
  servedByEmployeeId: null,
  cancelledByEmployeeId: null,
  cancellationReason: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

/**
 * The frozen room routing table (API Contract Design §4) with the Step 3.5
 * rulings: B3 static status_changed rooms, D5 FR6/Q7 kitchen shaping,
 * D9 notification pre-wiring, D12 table payload passthrough.
 */
describe('staff-event-router', () => {
  describe('toKitchenOrderPayload (FR6/Q7, ruling D5)', () => {
    it('strips unitPriceMinor from every item and keeps everything else', () => {
      const shaped = toKitchenOrderPayload(fullOrderPayload) as typeof fullOrderPayload;
      expect(shaped.items).toHaveLength(2);
      for (const item of shaped.items) {
        expect(item).not.toHaveProperty('unitPriceMinor');
      }
      expect(shaped.items[0]).toMatchObject({ id: 'item-1', name: 'شوربة', category: 'مقبلات', quantity: 2 });
      expect(shaped.items[1]).toMatchObject({ notes: 'بدون سكر', quantity: 1 });
      expect(shaped.id).toBe('order-1');
      expect(shaped.tableId).toBe('table-1');
    });

    it('never mutates the original payload', () => {
      toKitchenOrderPayload(fullOrderPayload);
      expect(fullOrderPayload.items[0].unitPriceMinor).toBe(2500);
    });

    it('passes through payloads without an items array unchanged', () => {
      const odd = { orderId: 'x' };
      expect(toKitchenOrderPayload(odd)).toBe(odd);
    });
  });

  describe('routeStaffEvent', () => {
    it('order.created → kitchen (stripped) + waiter (full) — Contract §4', () => {
      const routed = routeStaffEvent(DOMAIN_EVENT.ORDER_CREATED, fullOrderPayload);
      expect(routed).toHaveLength(2);
      const kitchen = routed.find((r) => r.rooms.includes(KITCHEN))!;
      const waiter = routed.find((r) => r.rooms.includes(WAITER))!;
      expect((kitchen.payload as typeof fullOrderPayload).items[0]).not.toHaveProperty('unitPriceMinor');
      expect((waiter.payload as typeof fullOrderPayload).items[0].unitPriceMinor).toBe(2500);
      expect(waiter.rooms).toEqual([WAITER]);
    });

    it('order.accepted → kitchen (stripped) + waiter & owner-room (full)', () => {
      const routed = routeStaffEvent(DOMAIN_EVENT.ORDER_ACCEPTED, fullOrderPayload);
      expect(routed).toHaveLength(2);
      const kitchen = routed.find((r) => r.rooms.includes(KITCHEN))!;
      const others = routed.find((r) => r.rooms.includes(WAITER))!;
      expect((kitchen.payload as typeof fullOrderPayload).items[1]).not.toHaveProperty('unitPriceMinor');
      expect(others.rooms).toEqual([WAITER, OWNER_ROOM]);
      expect(others.payload).toBe(fullOrderPayload);
    });

    it('order.status_changed → kitchen + waiter + cashier + owner-room for every transition (B3), payload untouched', () => {
      const payload = { orderId: 'order-1', fromStatus: 'served', toStatus: 'paid' };
      const routed = routeStaffEvent(DOMAIN_EVENT.ORDER_STATUS_CHANGED, payload);
      expect(routed).toEqual([{ rooms: [KITCHEN, WAITER, CASHIER, OWNER_ROOM], payload }]);
    });

    it('table.status_changed → waiter + cashier + owner-room, bus payload passes through (D12)', () => {
      const payload = { tableId: 'table-1', fromStatus: 'occupied', toStatus: 'needs_cleaning' };
      const routed = routeStaffEvent(DOMAIN_EVENT.TABLE_STATUS_CHANGED, payload);
      expect(routed).toEqual([{ rooms: [WAITER, CASHIER, OWNER_ROOM], payload }]);
    });

    it('product.availability_changed and restaurant_profile.changed → restaurant-broadcast', () => {
      const availability = { productId: 'p1', isAvailable: false };
      expect(routeStaffEvent(DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED, availability)).toEqual([
        { rooms: [RESTAURANT_BROADCAST_ROOM], payload: availability },
      ]);
      const profile = { name: 'مطعم الأمل', primaryColor: '#112233' };
      expect(routeStaffEvent(DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED, profile)).toEqual([
        { rooms: [RESTAURANT_BROADCAST_ROOM], payload: profile },
      ]);
    });

    it('invitation.accepted → owner-room only', () => {
      const payload = { invitationId: 'inv-1', employeeId: 'emp-1' };
      expect(routeStaffEvent(DOMAIN_EVENT.INVITATION_ACCEPTED, payload)).toEqual([
        { rooms: [OWNER_ROOM], payload },
      ]);
    });

    it('notification.created (D9 pre-wiring) → targeted role room', () => {
      const payload = { recipientRole: EmployeeRole.WAITER, recipientEmployeeId: null, type: 'order_ready' };
      expect(routeStaffEvent(DOMAIN_EVENT.NOTIFICATION_CREATED, payload)).toEqual([
        { rooms: [WAITER], payload },
      ]);
    });

    it('notification.created → targeted employee room', () => {
      const payload = { recipientRole: null, recipientEmployeeId: 'emp-9', type: 'shift_note' };
      expect(routeStaffEvent(DOMAIN_EVENT.NOTIFICATION_CREATED, payload)).toEqual([
        { rooms: [employeeRoom('emp-9')], payload },
      ]);
    });

    it('notification.created with BOTH targets → ONE emission with both rooms (no duplicate delivery)', () => {
      const payload = { recipientRole: EmployeeRole.CASHIER, recipientEmployeeId: 'emp-9', type: 'x' };
      const routed = routeStaffEvent(DOMAIN_EVENT.NOTIFICATION_CREATED, payload);
      expect(routed).toHaveLength(1);
      expect(routed[0].rooms).toEqual([CASHIER, employeeRoom('emp-9')]);
    });

    it('notification.created with no target → no emission', () => {
      expect(routeStaffEvent(DOMAIN_EVENT.NOTIFICATION_CREATED, { recipientRole: null, recipientEmployeeId: null })).toEqual([]);
      expect(routeStaffEvent(DOMAIN_EVENT.NOTIFICATION_CREATED, null)).toEqual([]);
    });

    it('unknown events route nowhere (forward-compat guard)', () => {
      expect(routeStaffEvent('some.future_event', {})).toEqual([]);
    });
  });
});
