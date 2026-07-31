import { EmployeeRole, OrderStatus } from '@smarttable/shared-types';
import { OrdersService, OrderActor } from './orders.service';
import { OrderItemRow, OrderRow, OrdersRepository } from './orders.repository';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  InsufficientPermissionException,
  InvalidOrderTransitionException,
  InvalidTableStatusTransitionException,
  ProductUnavailableException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the orders domain rules (Engineering Standards §10 —
 * lifecycle state machine and RBAC are mandatory unit-test surfaces):
 *  - the state machine's legal/illegal transitions (PRD §12),
 *  - Q2 (accept: Owner/Manager/Kitchen, Waiter refused),
 *  - Q3 (waiter cancels pending orders only),
 *  - Q5 (advance covers accepted→preparing→ready only),
 *  - FR7 (serve roles), FR10 (cancel reason plumbing),
 *  - Q7/FR6 (kitchen price stripping), Q8 (public minimal payload),
 *  - Q9 (whole-order rejection on unavailable products),
 *  - cursor pagination invariants (Contract §1).
 */
describe('OrdersService', () => {
  let service: OrdersService;
  let repository: jest.Mocked<OrdersRepository>;
  let audit: jest.Mocked<AuditService>;
  let events: jest.Mocked<DomainEventsService>;

  const actor = (role: EmployeeRole, id = 'emp-1'): OrderActor => ({ id, role });

  const orderRow = (overrides: Partial<OrderRow> = {}): OrderRow => ({
    id: 'order-1',
    tableBillGroupId: 'group-1',
    tableId: 'table-1',
    channel: 'dine_in',
    isAddon: false,
    status: 'pending',
    source: 'waiter_manual',
    createdByEmployeeId: 'emp-1',
    acceptedByEmployeeId: null,
    servedByEmployeeId: null,
    cancelledByEmployeeId: null,
    cancellationReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  const itemRow = (overrides: Partial<OrderItemRow> = {}): OrderItemRow => ({
    id: 'item-1',
    orderId: 'order-1',
    productId: 'product-1',
    nameSnapshot: 'شوربة',
    categorySnapshot: 'مقبلات',
    unitPriceMinorSnapshot: 25000,
    quantity: 2,
    notes: null,
    ...overrides,
  });

  const tableRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'table-1',
    hallId: 'hall-1',
    label: 'Table 1',
    qrToken: 'tok',
    status: 'available',
    isActive: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      createOrderTransaction: jest.fn(),
      findOrderById: jest.fn(),
      findItemsForOrder: jest.fn(),
      findItemsForOrders: jest.fn(),
      listOrders: jest.fn(),
      transitionStatusTransaction: jest.fn(),
      findTableById: jest.fn(),
      findTableByQrToken: jest.fn(),
    } as jest.Mocked<OrdersRepository>;
    audit = { append: jest.fn() } as unknown as jest.Mocked<AuditService>;
    events = {
      emitOrderCreated: jest.fn(),
      emitOrderAccepted: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitTableStatusChanged: jest.fn(),
    } as unknown as jest.Mocked<DomainEventsService>;
    service = new OrdersService(repository, audit, events);
  });

  const createdResult = (overrides: Record<string, unknown> = {}) => ({
    outcome: 'created' as const,
    order: orderRow(),
    items: [itemRow()],
    groupCreated: true,
    tableFlippedToOccupied: true,
    ...overrides,
  });

  // ------------------------------------------------------------- creation

  describe('createStaffOrder', () => {
    const input = { tableId: 'table-1', items: [{ productId: 'product-1', quantity: 2 }] };

    it('rejects an unknown table with 404', async () => {
      repository.findTableById.mockResolvedValue(undefined);
      await expect(service.createStaffOrder(input, actor(EmployeeRole.WAITER))).rejects.toThrow(EntityNotFoundException);
      expect(repository.createOrderTransaction).not.toHaveBeenCalled();
    });

    it('rejects a soft-deleted table with the same 404', async () => {
      repository.findTableById.mockResolvedValue(tableRow({ isActive: false }) as never);
      await expect(service.createStaffOrder(input, actor(EmployeeRole.WAITER))).rejects.toThrow(EntityNotFoundException);
    });

    it('rejects the WHOLE order with 409 PRODUCT_UNAVAILABLE when any product is unavailable (Q9)', async () => {
      repository.findTableById.mockResolvedValue(tableRow() as never);
      repository.createOrderTransaction.mockResolvedValue({
        outcome: 'products_unavailable',
        productIds: ['product-1'],
      });
      const error = await service.createStaffOrder(input, actor(EmployeeRole.WAITER)).catch((e) => e);
      expect(error).toBeInstanceOf(ProductUnavailableException);
      expect(error.httpStatus).toBe(409);
      expect(error.details.unavailableProductIds).toEqual(['product-1']);
    });

    it('rejects unknown products with 404', async () => {
      repository.findTableById.mockResolvedValue(tableRow() as never);
      repository.createOrderTransaction.mockResolvedValue({ outcome: 'products_not_found', productIds: ['ghost'] });
      await expect(service.createStaffOrder(input, actor(EmployeeRole.WAITER))).rejects.toThrow(EntityNotFoundException);
    });

    it('creates with waiter_manual source, audits, and emits post-commit events', async () => {
      repository.findTableById.mockResolvedValue(tableRow() as never);
      repository.createOrderTransaction.mockResolvedValue(createdResult());

      const dto = await service.createStaffOrder(input, actor(EmployeeRole.WAITER, 'emp-9'));

      expect(repository.createOrderTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'waiter_manual', createdByEmployeeId: 'emp-9' }),
      );
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ actorEmployeeId: 'emp-9', entityType: 'order', action: 'order_created' }),
      );
      expect(events.emitOrderCreated).toHaveBeenCalledTimes(1);
      expect(events.emitTableStatusChanged).toHaveBeenCalledWith({
        tableId: 'table-1',
        fromStatus: 'available',
        toStatus: 'occupied',
      });
      expect(dto.status).toBe(OrderStatus.PENDING);
      expect(dto.items[0].unitPriceMinor).toBe(25000); // snapshot on the wire
    });

    it('does not emit table.status_changed when the table did not flip', async () => {
      repository.findTableById.mockResolvedValue(tableRow({ status: 'occupied' }) as never);
      repository.createOrderTransaction.mockResolvedValue(
        createdResult({ groupCreated: false, tableFlippedToOccupied: false, order: orderRow({ isAddon: true }) }),
      );
      await service.createStaffOrder(input, actor(EmployeeRole.WAITER));
      expect(events.emitTableStatusChanged).not.toHaveBeenCalled();
    });

    it.each(['bill_requested', 'needs_cleaning'])(
      'rejects order creation on a %s table with 409 INVALID_TABLE_STATUS_TRANSITION (D8)',
      async (tableStatus) => {
        repository.findTableById.mockResolvedValue(tableRow({ status: tableStatus }) as never);
        repository.createOrderTransaction.mockResolvedValue({ outcome: 'table_not_orderable', tableStatus });
        const error: any = await service.createStaffOrder(input, actor(EmployeeRole.WAITER)).catch((e) => e);
        expect(error).toBeInstanceOf(InvalidTableStatusTransitionException);
        expect(error.code).toBe('INVALID_TABLE_STATUS_TRANSITION');
        expect(error.httpStatus).toBe(409);
        expect(error.details).toMatchObject({ tableId: 'table-1', fromStatus: tableStatus, attemptedAction: 'create-order' });
      },
    );
  });

  describe('createPublicOrder', () => {
    const input = { qrToken: 'a'.repeat(43), items: [{ productId: 'product-1', quantity: 1 }] };

    it('returns the identical 404 for unknown AND deactivated tokens (no oracle)', async () => {
      repository.findTableByQrToken.mockResolvedValue(undefined);
      const unknownError = await service.createPublicOrder(input, '10.0.0.5').catch((e) => e);

      repository.findTableByQrToken.mockResolvedValue(tableRow({ isActive: false }) as never);
      const inactiveError = await service.createPublicOrder(input, '10.0.0.5').catch((e) => e);

      expect(unknownError).toBeInstanceOf(EntityNotFoundException);
      expect(inactiveError).toBeInstanceOf(EntityNotFoundException);
      expect(unknownError.message).toBe(inactiveError.message);
    });

    it('creates with qr source, null employee, and audits the source IP (Security §7)', async () => {
      repository.findTableByQrToken.mockResolvedValue(tableRow() as never);
      repository.createOrderTransaction.mockResolvedValue(createdResult());

      await service.createPublicOrder(input, '10.0.0.5');

      expect(repository.createOrderTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'qr', createdByEmployeeId: null }),
      );
      const auditCall = audit.append.mock.calls[0][0];
      expect(auditCall.action).toBe('public_order_submitted');
      expect(auditCall.actorEmployeeId).toBeNull();
      expect(JSON.parse(auditCall.newValueJson!)).toMatchObject({ sourceIp: '10.0.0.5' });
    });
  });

  describe('createAddonOrder', () => {
    const input = { items: [{ productId: 'product-2', quantity: 1 }] };

    it('404s when the parent order does not exist', async () => {
      repository.findOrderById.mockResolvedValue(undefined);
      await expect(service.createAddonOrder('order-1', input, actor(EmployeeRole.WAITER))).rejects.toThrow(
        EntityNotFoundException,
      );
    });

    it('refuses add-ons against a cancelled parent (409)', async () => {
      repository.findOrderById.mockResolvedValue(orderRow({ status: 'cancelled' }));
      await expect(service.createAddonOrder('order-1', input, actor(EmployeeRole.WAITER))).rejects.toThrow(
        InvalidOrderTransitionException,
      );
    });

    it('pins the parent bill group (FR5 — same Table Bill Group)', async () => {
      repository.findOrderById.mockResolvedValue(orderRow({ status: 'preparing' }));
      repository.createOrderTransaction.mockResolvedValue(
        createdResult({ order: orderRow({ isAddon: true }), groupCreated: false, tableFlippedToOccupied: false }),
      );

      await service.createAddonOrder('order-1', input, actor(EmployeeRole.WAITER));

      expect(repository.createOrderTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ billGroupId: 'group-1', tableId: 'table-1' }),
      );
    });
  });

  // ---------------------------------------------------------- transitions

  const arrangeTransition = (from: string, outcome: 'ok' | 'conflict' = 'ok') => {
    const current = orderRow({ status: from });
    repository.findOrderById.mockResolvedValue(current);
    if (outcome === 'ok') {
      repository.transitionStatusTransaction.mockImplementation(async (input) => ({
        outcome: 'ok',
        order: orderRow({ status: input.toStatus }),
        fromStatus: from,
      }));
    } else {
      repository.transitionStatusTransaction.mockResolvedValue({ outcome: 'conflict', current: orderRow({ status: 'accepted' }) });
    }
    repository.findItemsForOrder.mockResolvedValue([itemRow()]);
  };

  describe('accept (Q2)', () => {
    it.each([EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.KITCHEN])(
      'allows %s to accept a pending order',
      async (role) => {
        arrangeTransition('pending');
        const dto = await service.accept('order-1', actor(role));
        expect(dto.status).toBe(OrderStatus.ACCEPTED);
        expect(repository.transitionStatusTransaction).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedFrom: ['pending'],
            toStatus: 'accepted',
            setFields: { acceptedByEmployeeId: 'emp-1' },
          }),
        );
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_accepted' }));
        expect(events.emitOrderAccepted).toHaveBeenCalledTimes(1);
        expect(events.emitOrderStatusChanged).toHaveBeenCalledWith({
          orderId: 'order-1',
          fromStatus: 'pending',
          toStatus: 'accepted',
        });
      },
    );

    it.each([EmployeeRole.WAITER, EmployeeRole.CASHIER])('refuses %s with 403 (Q2 — Waiter cannot accept)', async (role) => {
      arrangeTransition('pending');
      const error = await service.accept('order-1', actor(role)).catch((e) => e);
      expect(error).toBeInstanceOf(InsufficientPermissionException);
      expect(error.httpStatus).toBe(403);
      expect(repository.transitionStatusTransaction).not.toHaveBeenCalled();
    });

    it('rejects accepting a non-pending order with 409', async () => {
      arrangeTransition('preparing');
      const error = await service.accept('order-1', actor(EmployeeRole.OWNER)).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidOrderTransitionException);
      expect(error.httpStatus).toBe(409);
    });

    it('surfaces a lost transition race as 409 with the winning status (NFR3)', async () => {
      arrangeTransition('pending', 'conflict');
      const error = await service.accept('order-1', actor(EmployeeRole.KITCHEN)).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidOrderTransitionException);
      expect(error.details.fromStatus).toBe('accepted');
    });

    it('404s unknown orders', async () => {
      repository.findOrderById.mockResolvedValue(undefined);
      await expect(service.accept('ghost', actor(EmployeeRole.OWNER))).rejects.toThrow(EntityNotFoundException);
    });
  });

  describe('advance (Q5)', () => {
    it('moves accepted → preparing', async () => {
      arrangeTransition('accepted');
      const dto = await service.advance('order-1', actor(EmployeeRole.KITCHEN));
      expect(repository.transitionStatusTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ toStatus: 'preparing' }),
      );
      expect(dto.status).toBe(OrderStatus.PREPARING);
    });

    it('moves preparing → ready', async () => {
      arrangeTransition('preparing');
      const dto = await service.advance('order-1', actor(EmployeeRole.MANAGER));
      expect(repository.transitionStatusTransaction).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'ready' }));
      expect(dto.status).toBe(OrderStatus.READY);
    });

    it.each(['pending', 'ready', 'served'])('rejects advance from %s with 409', async (from) => {
      arrangeTransition(from);
      await expect(service.advance('order-1', actor(EmployeeRole.KITCHEN))).rejects.toThrow(
        InvalidOrderTransitionException,
      );
    });

    it('refuses waiters with 403', async () => {
      arrangeTransition('accepted');
      await expect(service.advance('order-1', actor(EmployeeRole.WAITER))).rejects.toThrow(
        InsufficientPermissionException,
      );
    });
  });

  describe('serve (FR7)', () => {
    it.each([EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER])('allows %s to serve a ready order', async (role) => {
      arrangeTransition('ready');
      const dto = await service.serve('order-1', actor(role));
      expect(dto.status).toBe(OrderStatus.SERVED);
      expect(repository.transitionStatusTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ setFields: { servedByEmployeeId: 'emp-1' } }),
      );
    });

    it('refuses kitchen with 403', async () => {
      arrangeTransition('ready');
      await expect(service.serve('order-1', actor(EmployeeRole.KITCHEN))).rejects.toThrow(InsufficientPermissionException);
    });

    it('rejects serving an order that is not ready with 409', async () => {
      arrangeTransition('accepted');
      await expect(service.serve('order-1', actor(EmployeeRole.WAITER))).rejects.toThrow(InvalidOrderTransitionException);
    });
  });

  describe('cancel (Q3, FR10)', () => {
    it('lets a waiter cancel while the order is still Pending', async () => {
      arrangeTransition('pending');
      const dto = await service.cancel('order-1', 'customer changed their mind', actor(EmployeeRole.WAITER));
      expect(dto.status).toBe(OrderStatus.CANCELLED);
      expect(repository.transitionStatusTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          toStatus: 'cancelled',
          setFields: { cancelledByEmployeeId: 'emp-1', cancellationReason: 'customer changed their mind' },
        }),
      );
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order_cancelled',
          newValueJson: JSON.stringify({ status: 'cancelled', reason: 'customer changed their mind' }),
        }),
      );
    });

    it.each(['accepted', 'preparing', 'ready', 'served'])(
      'forbids a waiter from cancelling once the order is %s (403)',
      async (from) => {
        arrangeTransition(from);
        const error = await service.cancel('order-1', 'too late', actor(EmployeeRole.WAITER)).catch((e) => e);
        expect(error).toBeInstanceOf(InsufficientPermissionException);
        expect(repository.transitionStatusTransaction).not.toHaveBeenCalled();
      },
    );

    it.each([
      [EmployeeRole.OWNER, 'served'],
      [EmployeeRole.MANAGER, 'preparing'],
      [EmployeeRole.OWNER, 'accepted'],
    ] as const)('lets %s cancel from %s (unrestricted)', async (role, from) => {
      arrangeTransition(from);
      const dto = await service.cancel('order-1', 'manager discretion', actor(role));
      expect(dto.status).toBe(OrderStatus.CANCELLED);
    });

    it.each([EmployeeRole.KITCHEN, EmployeeRole.CASHIER])('refuses %s cancellation entirely', async (role) => {
      arrangeTransition('pending');
      await expect(service.cancel('order-1', 'no', actor(role))).rejects.toThrow(InsufficientPermissionException);
    });

    it('rejects cancelling an already-cancelled order with 409', async () => {
      arrangeTransition('cancelled');
      await expect(service.cancel('order-1', 'again', actor(EmployeeRole.OWNER))).rejects.toThrow(
        InvalidOrderTransitionException,
      );
    });

    it.each(['paid', 'completed'])(
      'rejects cancelling a %s order with 409 INVALID_ORDER_TRANSITION for EVERY role (B2: no refunds/voids in v1)',
      async (from) => {
        // Owner is the most privileged role in the cancel rule — if the Owner
        // cannot do it, nobody can.
        arrangeTransition(from);
        const error: any = await service.cancel('order-1', 'refund attempt', actor(EmployeeRole.OWNER)).catch((e) => e);
        expect(error).toBeInstanceOf(InvalidOrderTransitionException);
        expect(error.code).toBe('INVALID_ORDER_TRANSITION');
        expect(error.httpStatus).toBe(409);
        expect(error.details).toMatchObject({ orderId: 'order-1', fromStatus: from, attemptedAction: 'cancel' });
        expect(repository.transitionStatusTransaction).not.toHaveBeenCalled();
      },
    );
  });

  // ---------------------------------------------------------------- reads

  describe('getOrder — FR6/Q7 kitchen price stripping', () => {
    it('strips unitPriceMinor for Kitchen viewers', async () => {
      repository.findOrderById.mockResolvedValue(orderRow());
      repository.findItemsForOrder.mockResolvedValue([itemRow()]);
      const dto = await service.getOrder('order-1', EmployeeRole.KITCHEN);
      expect(dto.items[0]).not.toHaveProperty('unitPriceMinor');
      expect(dto.items[0]).toMatchObject({ name: 'شوربة', quantity: 2 });
    });

    it.each([EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER, EmployeeRole.WAITER])(
      'keeps pricing for %s viewers',
      async (role) => {
        repository.findOrderById.mockResolvedValue(orderRow());
        repository.findItemsForOrder.mockResolvedValue([itemRow()]);
        const dto = await service.getOrder('order-1', role);
        expect(dto.items[0]).toHaveProperty('unitPriceMinor', 25000);
      },
    );
  });

  describe('listOrders — cursor pagination (Contract §1)', () => {
    it('returns nextCursor when more pages exist, built from the last row of the trimmed page', async () => {
      const rows = [orderRow({ id: 'o1', createdAt: 3000 }), orderRow({ id: 'o2', createdAt: 2000 }), orderRow({ id: 'o3', createdAt: 1000 })];
      repository.listOrders.mockResolvedValue(rows); // limit(2) + 1 extra
      repository.findItemsForOrders.mockResolvedValue([]);

      const result = await service.listOrders({ limit: 2 }, EmployeeRole.OWNER);

      expect(result.data.map((o) => o.id)).toEqual(['o1', 'o2']);
      const decoded = JSON.parse(Buffer.from(result.meta.nextCursor!, 'base64url').toString('utf8'));
      expect(decoded).toEqual({ c: 2000, i: 'o2' });
      expect(repository.listOrders).toHaveBeenCalledWith(expect.anything(), null, 3);
    });

    it('returns null nextCursor on the final page', async () => {
      repository.listOrders.mockResolvedValue([orderRow({ id: 'o1' })]);
      repository.findItemsForOrders.mockResolvedValue([]);
      const result = await service.listOrders({}, EmployeeRole.OWNER);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('rejects a malformed cursor with 400 VALIDATION_FAILED', async () => {
      await expect(service.listOrders({ cursor: 'not-a-cursor' }, EmployeeRole.OWNER)).rejects.toThrow(
        ValidationFailedException,
      );
    });

    it('strips pricing from listed orders for Kitchen viewers', async () => {
      repository.listOrders.mockResolvedValue([orderRow({ id: 'o1' })]);
      repository.findItemsForOrders.mockResolvedValue([itemRow({ orderId: 'o1' })]);
      const result = await service.listOrders({}, EmployeeRole.KITCHEN);
      expect(result.data[0].items[0]).not.toHaveProperty('unitPriceMinor');
    });
  });

  describe('getPublicOrderStatus (Q8)', () => {
    it('returns exactly { id, status }', async () => {
      repository.findOrderById.mockResolvedValue(orderRow({ status: 'preparing' }));
      const dto = await service.getPublicOrderStatus('order-1');
      expect(dto).toEqual({ id: 'order-1', status: 'preparing' });
      expect(Object.keys(dto).sort()).toEqual(['id', 'status']);
    });

    it('404s unknown orders without leaking existence', async () => {
      repository.findOrderById.mockResolvedValue(undefined);
      await expect(service.getPublicOrderStatus('ghost')).rejects.toThrow(EntityNotFoundException);
    });
  });
});
