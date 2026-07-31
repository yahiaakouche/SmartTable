import { EmployeeRole, NOTIFICATION_TYPE, OrderStatus } from '@smarttable/shared-types';
import { NotificationsService } from './notifications.service';
import { NotificationRow, NotificationsRepository } from './notifications.repository';
import { DomainEventsService } from '../../common/events/domain-events.service';
import { OrdersService } from '../orders/orders.service';
import type { ActingEmployee } from '../auth/decorators/current-employee.decorator';
import {
  EntityNotFoundException,
  InsufficientPermissionException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the notifications rules (Engineering Standards §10):
 *  - B3: the frozen recipient map (kitchen / waiter / owner+manager),
 *  - B2: the ready-only filter on status transitions,
 *  - B4(a)/D5: recipient scoping on the read surface,
 *  - D6/D7: mark-read 404/403 and natural idempotency,
 *  - D8: cursor codec + limit clamping (the orders pattern),
 *  - D2/FR6: notification payloads carry ids only — never a money field.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;
  let repository: jest.Mocked<NotificationsRepository>;
  let events: jest.Mocked<DomainEventsService>;
  let orders: jest.Mocked<OrdersService>;

  const actor = (role: EmployeeRole, id = 'emp-1'): ActingEmployee => ({ id, name: 'Test', role });

  const row = (overrides: Partial<NotificationRow> = {}): NotificationRow => ({
    id: 'notif-1',
    recipientRole: EmployeeRole.KITCHEN,
    recipientEmployeeId: null,
    type: NOTIFICATION_TYPE.ORDER_CREATED,
    payloadJson: JSON.stringify({ orderId: 'order-1', tableId: 'table-1' }),
    readAt: null,
    createdAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      insert: jest.fn(),
      listForRecipient: jest.fn(),
      findById: jest.fn(),
      markRead: jest.fn(),
    } as jest.Mocked<NotificationsRepository>;
    events = { emitNotificationCreated: jest.fn() } as unknown as jest.Mocked<DomainEventsService>;
    orders = { getOrder: jest.fn() } as unknown as jest.Mocked<OrdersService>;
    service = new NotificationsService(repository, events, orders);
  });

  describe('notifyOrderCreated (B3: kitchen only)', () => {
    it('persists one kitchen-targeted row and emits its DTO', async () => {
      repository.insert.mockResolvedValue(row());
      await service.notifyOrderCreated({ id: 'order-1', tableId: 'table-1', items: [{ unitPriceMinor: 25000 }] });

      expect(repository.insert).toHaveBeenCalledWith({
        recipientRole: EmployeeRole.KITCHEN,
        recipientEmployeeId: null,
        type: NOTIFICATION_TYPE.ORDER_CREATED,
        payloadJson: JSON.stringify({ orderId: 'order-1', tableId: 'table-1' }),
      });
      expect(events.emitNotificationCreated).toHaveBeenCalledTimes(1);
      const emitted = events.emitNotificationCreated.mock.calls[0][0] as Record<string, unknown>;
      expect(emitted).toMatchObject({
        id: 'notif-1',
        type: NOTIFICATION_TYPE.ORDER_CREATED,
        recipientRole: EmployeeRole.KITCHEN,
        recipientEmployeeId: null,
        readAt: null,
      });
    });

    it('D2/FR6: the payload carries ids only — no money field can leak', async () => {
      repository.insert.mockResolvedValue(row());
      await service.notifyOrderCreated({ id: 'order-1', tableId: 'table-1', totalMinor: 50000 });
      const inserted = repository.insert.mock.calls[0][0];
      expect(Object.keys(JSON.parse(inserted.payloadJson)).sort()).toEqual(['orderId', 'tableId']);
    });

    it('skips (and does not emit) when the bus payload lacks the reference ids', async () => {
      await service.notifyOrderCreated({ id: 42 });
      expect(repository.insert).not.toHaveBeenCalled();
      expect(events.emitNotificationCreated).not.toHaveBeenCalled();
    });
  });

  describe('notifyOrderStatusChanged (B2: ready only; B3: waiter only)', () => {
    it('ignores every non-ready transition', async () => {
      for (const toStatus of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.SERVED, OrderStatus.PAID, OrderStatus.COMPLETED, OrderStatus.CANCELLED]) {
        await service.notifyOrderStatusChanged({ orderId: 'order-1', fromStatus: 'pending', toStatus });
      }
      expect(repository.insert).not.toHaveBeenCalled();
      expect(orders.getOrder).not.toHaveBeenCalled();
    });

    it('on ready: re-reads the order post-commit and notifies the waiter role', async () => {
      orders.getOrder.mockResolvedValue({ id: 'order-1', tableId: 'table-9' } as never);
      repository.insert.mockResolvedValue(row({ type: NOTIFICATION_TYPE.ORDER_READY, recipientRole: EmployeeRole.WAITER }));

      await service.notifyOrderStatusChanged({ orderId: 'order-1', fromStatus: 'preparing', toStatus: OrderStatus.READY });

      expect(orders.getOrder).toHaveBeenCalledWith('order-1', EmployeeRole.OWNER);
      expect(repository.insert).toHaveBeenCalledWith({
        recipientRole: EmployeeRole.WAITER,
        recipientEmployeeId: null,
        type: NOTIFICATION_TYPE.ORDER_READY,
        payloadJson: JSON.stringify({ orderId: 'order-1', tableId: 'table-9' }),
      });
      expect(events.emitNotificationCreated).toHaveBeenCalledTimes(1);
    });

    it('propagates an enrichment-read failure to the listener (which isolates it)', async () => {
      orders.getOrder.mockRejectedValue(new EntityNotFoundException('order', 'order-1'));
      await expect(
        service.notifyOrderStatusChanged({ orderId: 'order-1', fromStatus: 'preparing', toStatus: OrderStatus.READY }),
      ).rejects.toBeInstanceOf(EntityNotFoundException);
      expect(repository.insert).not.toHaveBeenCalled();
    });
  });

  describe('notifyInvitationAccepted (B3: owner + manager)', () => {
    it('persists one row per role and emits each', async () => {
      repository.insert.mockResolvedValue(row({ type: NOTIFICATION_TYPE.INVITATION_ACCEPTED }));
      await service.notifyInvitationAccepted({ invitationId: 'inv-1', employeeId: 'emp-9' });

      expect(repository.insert).toHaveBeenCalledTimes(2);
      expect(repository.insert.mock.calls[0][0].recipientRole).toBe(EmployeeRole.OWNER);
      expect(repository.insert.mock.calls[1][0].recipientRole).toBe(EmployeeRole.MANAGER);
      for (const call of repository.insert.mock.calls) {
        expect(call[0].type).toBe(NOTIFICATION_TYPE.INVITATION_ACCEPTED);
        expect(JSON.parse(call[0].payloadJson)).toEqual({ invitationId: 'inv-1', employeeId: 'emp-9' });
      }
      expect(events.emitNotificationCreated).toHaveBeenCalledTimes(2);
    });
  });

  describe('listForEmployee (B4(a) scope + D8 cursor)', () => {
    it('scopes to the caller role + id and applies the default limit (fetch limit+1)', async () => {
      repository.listForRecipient.mockResolvedValue([]);
      const result = await service.listForEmployee({}, actor(EmployeeRole.WAITER, 'emp-7'));
      expect(repository.listForRecipient).toHaveBeenCalledWith(EmployeeRole.WAITER, 'emp-7', false, null, 51);
      expect(result).toEqual({ data: [], meta: { nextCursor: null } });
    });

    it('passes unreadOnly through and clamps the limit to 100', async () => {
      repository.listForRecipient.mockResolvedValue([]);
      await service.listForEmployee({ unreadOnly: true, limit: 500 }, actor(EmployeeRole.OWNER));
      expect(repository.listForRecipient).toHaveBeenCalledWith(EmployeeRole.OWNER, 'emp-1', true, null, 101);
    });

    it('returns nextCursor when an extra row exists, decodable for the next page', async () => {
      const rows = [row({ id: 'n1', createdAt: 3000 }), row({ id: 'n2', createdAt: 2000 })];
      repository.listForRecipient.mockResolvedValue(rows);
      const result = await service.listForEmployee({ limit: 1 }, actor(EmployeeRole.KITCHEN));
      expect(result.data).toHaveLength(1);
      expect(result.meta.nextCursor).not.toBeNull();

      // round-trip: the returned cursor decodes to the last served row
      repository.listForRecipient.mockClear();
      repository.listForRecipient.mockResolvedValue([]);
      await service.listForEmployee({ cursor: result.meta.nextCursor!, limit: 1 }, actor(EmployeeRole.KITCHEN));
      expect(repository.listForRecipient).toHaveBeenCalledWith(EmployeeRole.KITCHEN, 'emp-1', false, { createdAt: 3000, id: 'n1' }, 2);
    });

    it('rejects a malformed cursor with VALIDATION_FAILED', async () => {
      await expect(service.listForEmployee({ cursor: 'not-a-cursor' }, actor(EmployeeRole.KITCHEN))).rejects.toBeInstanceOf(
        ValidationFailedException,
      );
    });
  });

  describe('markRead (D6 scoping, D7 idempotency)', () => {
    it('404s an unknown notification', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.markRead('nope', actor(EmployeeRole.KITCHEN))).rejects.toBeInstanceOf(EntityNotFoundException);
    });

    it('403s when the row targets another role and another employee', async () => {
      repository.findById.mockResolvedValue(row({ recipientRole: EmployeeRole.WAITER, recipientEmployeeId: null }));
      await expect(service.markRead('notif-1', actor(EmployeeRole.KITCHEN))).rejects.toBeInstanceOf(
        InsufficientPermissionException,
      );
      expect(repository.markRead).not.toHaveBeenCalled();
    });

    it('403s an employee-targeted row belonging to someone else', async () => {
      repository.findById.mockResolvedValue(row({ recipientRole: null, recipientEmployeeId: 'emp-other' }));
      await expect(service.markRead('notif-1', actor(EmployeeRole.KITCHEN, 'emp-1'))).rejects.toBeInstanceOf(
        InsufficientPermissionException,
      );
    });

    it('lets any member of the targeted role mark it (B4(a) shared read-state)', async () => {
      repository.findById
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ readAt: 5000 }));
      const result = await service.markRead('notif-1', actor(EmployeeRole.KITCHEN, 'emp-42'));
      expect(repository.markRead).toHaveBeenCalledWith('notif-1', expect.any(Number));
      expect(result.readAt).toBe(5000);
    });

    it('lets the personally-targeted employee mark it', async () => {
      repository.findById
        .mockResolvedValueOnce(row({ recipientRole: null, recipientEmployeeId: 'emp-1' }))
        .mockResolvedValueOnce(row({ recipientRole: null, recipientEmployeeId: 'emp-1', readAt: 6000 }));
      const result = await service.markRead('notif-1', actor(EmployeeRole.OWNER, 'emp-1'));
      expect(result.readAt).toBe(6000);
    });

    it('D7: re-marking an already-read row is a no-op that keeps the first-read timestamp', async () => {
      repository.findById.mockResolvedValue(row({ readAt: 4000 }));
      const result = await service.markRead('notif-1', actor(EmployeeRole.KITCHEN));
      expect(repository.markRead).not.toHaveBeenCalled();
      expect(result.readAt).toBe(4000);
    });
  });
});
