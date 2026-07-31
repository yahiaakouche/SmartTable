import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CUSTOMER_EVENT, EmployeeRole, OrderStatus } from '@smarttable/shared-types';
import type {
  CreateAddonOrderRequest,
  CreateOrderRequest,
  CustomerEventName,
  KitchenOrderDto,
  ListOrdersQuery,
  OrderDto,
  PublicCreateOrderRequest,
  PublicOrderStatusDto,
} from '@smarttable/shared-types';
import { ORDERS_REPOSITORY, CreateOrderResult, OrderItemRow, OrderRow, OrdersRepository } from './orders.repository';
import { AuditService } from '../audit/audit.service';
import {
  DOMAIN_EVENT,
  DomainEventsService,
  OrderStatusChangedPayload,
  ProductAvailabilityChangedPayload,
} from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  InsufficientPermissionException,
  InvalidOrderTransitionException,
  InvalidTableStatusTransitionException,
  ProductUnavailableException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';

/** The acting-employee context, transport-agnostic (ES §3). */
export interface OrderActor {
  id: string;
  role: EmployeeRole;
}

/** One named message on the customer SSE stream (Contract §5). Transport-
 * agnostic on purpose (ES §4): the controller maps this to the SSE wire
 * format; the service never knows HTTP exists. */
export interface OrderStreamMessage {
  event: CustomerEventName;
  data: unknown;
}

type OrderAction = 'accept' | 'advance' | 'serve' | 'cancel';

interface TransitionRule {
  expectedFrom: readonly OrderStatus[];
  to: (from: OrderStatus) => OrderStatus;
  roles: readonly EmployeeRole[];
}

/**
 * THE order lifecycle state machine (PRD §12) — the single source of truth
 * for what transitions are legal and who may perform them (API Contract §3
 * advance design note). Encoded as data, exactly as the contract requires.
 *
 * Step 3.4 note (ruling B2): `paid`/`completed` are now reachable — via the
 * billing payment transaction only, never via these endpoints. Cancellation
 * from either status is therefore IMPOSSIBLE here by construction: both are
 * absent from cancel.expectedFrom, so any such attempt fails the from-check
 * with 409 INVALID_ORDER_TRANSITION. No refund/void flow exists in v1.
 */
const TRANSITION_RULES: Record<OrderAction, TransitionRule> = {
  // Q2 ruling: Owner, Manager, Kitchen — Waiter is NOT permitted (this
  // deliberately narrows the PRD §11 matrix row; the ruling is authoritative).
  accept: {
    expectedFrom: [OrderStatus.PENDING],
    to: () => OrderStatus.ACCEPTED,
    roles: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.KITCHEN],
  },
  // Q5 ruling: advance covers accepted → preparing → ready only.
  advance: {
    expectedFrom: [OrderStatus.ACCEPTED, OrderStatus.PREPARING],
    to: (from) => (from === OrderStatus.ACCEPTED ? OrderStatus.PREPARING : OrderStatus.READY),
    roles: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.KITCHEN],
  },
  // FR7: Served is set exclusively by Waiter, Manager, or Owner.
  serve: {
    expectedFrom: [OrderStatus.READY],
    to: () => OrderStatus.SERVED,
    roles: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],
  },
  // Q3 ruling: Owner/Manager unrestricted within the Step 3.3 lifecycle;
  // Waiter only while Pending — enforced in assertCancelAllowed below.
  cancel: {
    expectedFrom: [
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.SERVED,
    ],
    to: () => OrderStatus.CANCELLED,
    roles: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],
  },
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/**
 * The orders domain (FR3–FR7, FR9/FR34 partially, FR10, FR39, FR40) —
 * creation (staff + customer QR), the lifecycle state machine up to Served,
 * add-on orders after lock (FR5), and the role-aware read surface (FR6).
 *
 * Transport-agnostic (ES §3): controllers pass plain inputs; every rule —
 * availability (Q9), legality of transitions, role refinements (Q2/Q3),
 * price stripping (Q7) — lives here.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly ordersRepository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
  ) {}

  // ------------------------------------------------------------- creation

  /** Staff manual order entry (POST /orders) — PRD §6 Waiter Journey. */
  async createStaffOrder(input: CreateOrderRequest, actor: OrderActor): Promise<OrderDto> {
    const table = await this.ordersRepository.findTableById(input.tableId);
    if (!table || !table.isActive) throw new EntityNotFoundException('table', input.tableId);

    const result = await this.ordersRepository.createOrderTransaction({
      tableId: table.id,
      source: 'waiter_manual',
      createdByEmployeeId: actor.id,
      items: input.items,
    });

    const created = this.unwrapCreateResult(result, input.tableId);
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'order',
      entityId: created.order.id,
      action: 'order_created',
      newValueJson: JSON.stringify({
        tableId: table.id,
        source: 'waiter_manual',
        itemCount: input.items.length,
        isAddon: created.order.isAddon,
      }),
    });
    this.emitAfterCreate(created);
    return this.toDto(created.order, created.items, actor.role) as OrderDto;
  }

  /** Customer QR submission (POST /public/orders) — unauthenticated by
   * design; source IP is recorded in the audit trail for forensic review
   * (Security Architecture §7 replay/spam mitigation). */
  async createPublicOrder(input: PublicCreateOrderRequest, sourceIp: string | null): Promise<OrderDto> {
    // No-oracle: unknown AND deactivated tokens produce the identical 404.
    const table = await this.ordersRepository.findTableByQrToken(input.qrToken);
    if (!table || !table.isActive) throw new EntityNotFoundException('table', input.qrToken);

    const result = await this.ordersRepository.createOrderTransaction({
      tableId: table.id,
      source: 'qr',
      createdByEmployeeId: null,
      items: input.items,
    });

    const created = this.unwrapCreateResult(result, table.id);
    await this.audit.append({
      actorEmployeeId: null,
      entityType: 'order',
      entityId: created.order.id,
      action: 'public_order_submitted',
      newValueJson: JSON.stringify({
        tableId: table.id,
        sourceIp,
        itemCount: input.items.length,
        isAddon: created.order.isAddon,
      }),
    });
    this.emitAfterCreate(created);
    // The customer response is the full order receipt — pricing included;
    // FR6 price stripping applies to the Kitchen role only.
    return this.toDto(created.order, created.items, EmployeeRole.WAITER) as OrderDto;
  }

  /** Add-on Order (POST /orders/:id/addon) — FR5: once an order is locked
   * at Preparing, further items arrive ONLY as a new linked order against
   * the same Table Bill Group. (With no order-edit endpoint in v1 — Q11 —
   * this endpoint is also the path for adding items to unlocked orders.) */
  async createAddonOrder(parentOrderId: string, input: CreateAddonOrderRequest, actor: OrderActor): Promise<OrderDto> {
    const parent = await this.ordersRepository.findOrderById(parentOrderId);
    if (!parent) throw new EntityNotFoundException('order', parentOrderId);
    if (parent.status === OrderStatus.CANCELLED) {
      throw new InvalidOrderTransitionException(parentOrderId, parent.status, 'addon');
    }

    const result = await this.ordersRepository.createOrderTransaction({
      tableId: parent.tableId,
      billGroupId: parent.tableBillGroupId,
      source: 'waiter_manual',
      createdByEmployeeId: actor.id,
      items: input.items,
    });

    const created = this.unwrapCreateResult(result, parent.tableId, parentOrderId);
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'order',
      entityId: created.order.id,
      action: 'order_created',
      newValueJson: JSON.stringify({
        tableId: parent.tableId,
        source: 'waiter_manual',
        itemCount: input.items.length,
        isAddon: true,
        parentOrderId,
      }),
    });
    this.emitAfterCreate(created);
    return this.toDto(created.order, created.items, actor.role) as OrderDto;
  }

  // ----------------------------------------------------------- transitions

  /** Pending → Accepted (FR3/FR4) — Q2: Owner, Manager, Kitchen only. */
  async accept(orderId: string, actor: OrderActor): Promise<OrderDto> {
    const { order, fromStatus } = await this.executeTransition(orderId, 'accept', actor);
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'order',
      entityId: orderId,
      action: 'order_accepted',
      oldValueJson: JSON.stringify({ status: fromStatus }),
      newValueJson: JSON.stringify({ status: order.status }),
    });
    const dto = await this.buildDto(order, actor.role);
    this.events.emitOrderAccepted(dto as unknown as Record<string, unknown>);
    this.events.emitOrderStatusChanged({ orderId, fromStatus, toStatus: order.status });
    return dto as OrderDto;
  }

  /** accepted → preparing → ready (Q5). */
  async advance(orderId: string, actor: OrderActor): Promise<OrderDto> {
    const { order, fromStatus } = await this.executeTransition(orderId, 'advance', actor);
    this.events.emitOrderStatusChanged({ orderId, fromStatus, toStatus: order.status });
    return this.buildDto(order, actor.role) as Promise<OrderDto>;
  }

  /** ready → served (FR7). */
  async serve(orderId: string, actor: OrderActor): Promise<OrderDto> {
    const { order, fromStatus } = await this.executeTransition(orderId, 'serve', actor);
    this.events.emitOrderStatusChanged({ orderId, fromStatus, toStatus: order.status });
    return this.buildDto(order, actor.role) as Promise<OrderDto>;
  }

  /** → cancelled (FR10: reason mandatory — DTO layer; DB CHECK backstop).
   * Q3: Owner/Manager unrestricted; Waiter pending-only. */
  async cancel(orderId: string, reason: string, actor: OrderActor): Promise<OrderDto> {
    const { order, fromStatus } = await this.executeTransition(orderId, 'cancel', actor, reason);
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'order',
      entityId: orderId,
      action: 'order_cancelled',
      oldValueJson: JSON.stringify({ status: fromStatus }),
      newValueJson: JSON.stringify({ status: order.status, reason }),
    });
    this.events.emitOrderStatusChanged({ orderId, fromStatus, toStatus: order.status });
    return this.buildDto(order, actor.role) as Promise<OrderDto>;
  }

  // ---------------------------------------------------------------- reads

  /** FR6/Q7 — Kitchen-role callers receive the order WITHOUT pricing. */
  async getOrder(id: string, viewerRole: EmployeeRole): Promise<OrderDto | KitchenOrderDto> {
    const order = await this.ordersRepository.findOrderById(id);
    if (!order) throw new EntityNotFoundException('order', id);
    return this.buildDto(order, viewerRole);
  }

  /** Cursor (keyset) pagination for the unbounded orders resource — Contract
   * §1: `?cursor=<opaque>&limit=50`, response `meta.nextCursor`. Filters:
   * status, tableId, channel (KDS board + table map). */
  async listOrders(
    query: ListOrdersQuery,
    viewerRole: EmployeeRole,
  ): Promise<{ data: (OrderDto | KitchenOrderDto)[]; meta: { nextCursor: string | null } }> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const cursor = query.cursor !== undefined ? this.decodeCursor(query.cursor) : null;

    // Fetch one extra row to learn whether another page exists.
    const rows = await this.ordersRepository.listOrders(
      { status: query.status, tableId: query.tableId, channel: query.channel },
      cursor,
      limit + 1,
    );
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];

    const items = await this.ordersRepository.findItemsForOrders(pageRows.map((row) => row.id));
    const itemsByOrder = new Map<string, OrderItemRow[]>();
    for (const item of items) {
      const bucket = itemsByOrder.get(item.orderId) ?? [];
      bucket.push(item);
      itemsByOrder.set(item.orderId, bucket);
    }

    return {
      data: pageRows.map((row) => this.toDto(row, itemsByOrder.get(row.id) ?? [], viewerRole)),
      meta: { nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null },
    };
  }

  /** Customer-facing minimal status read — Q8: exactly `{ id, status }`.
   * Unknown order → the same 404 as any other (no oracle). */
  async getPublicOrderStatus(id: string): Promise<PublicOrderStatusDto> {
    const order = await this.ordersRepository.findOrderById(id);
    if (!order) throw new EntityNotFoundException('order', id);
    return { id: order.id, status: order.status as OrderStatus };
  }

  /**
   * Customer SSE stream (API Contract §5, rulings D7/D8) — read-only, no
   * client→server messages by design (Real-Time Architecture §2.4, restated
   * in §5). Messages:
   *  - `status_changed`: the FIRST message is the initial snapshot (Q8's
   *    `{id, status}` read), then one message per transition. Listeners are
   *    attached BEFORE the snapshot read, so a transition landing between
   *    read and subscribe cannot slip through — a duplicated status is
   *    harmless (status display is idempotent), a missed final transition
   *    would wedge the customer's screen.
   *  - `menu_updated`: fired on `product.availability_changed` — the only
   *    menu-affecting bus event in v1 — and pre-subscribed for
   *    `restaurant_profile.changed` so the config step flows later with zero
   *    changes here (D8). The customer client treats it as a refetch cue for
   *    GET /public/menu/:qrToken.
   * The stream stays open after terminal states: EventSource auto-reconnect
   * would storm a server-closed stream against the 60/min class, so the
   * client closes on terminal status instead (D7).
   */
  async streamPublicOrderEvents(id: string): Promise<Observable<OrderStreamMessage>> {
    // Existence check up front: an unknown id fails as a normal HTTP 404
    // before the event stream ever starts.
    await this.getPublicOrderStatus(id);
    return new Observable<OrderStreamMessage>((subscriber) => {
      const offStatus = this.events.on(DOMAIN_EVENT.ORDER_STATUS_CHANGED, (payload) => {
        const p = payload as OrderStatusChangedPayload;
        if (p.orderId === id) {
          subscriber.next({ event: CUSTOMER_EVENT.STATUS_CHANGED, data: { id, status: p.toStatus as OrderStatus } });
        }
      });
      const offAvailability = this.events.on(DOMAIN_EVENT.PRODUCT_AVAILABILITY_CHANGED, (payload) => {
        subscriber.next({ event: CUSTOMER_EVENT.MENU_UPDATED, data: payload as ProductAvailabilityChangedPayload });
      });
      const offProfile = this.events.on(DOMAIN_EVENT.RESTAURANT_PROFILE_CHANGED, (payload) => {
        subscriber.next({ event: CUSTOMER_EVENT.MENU_UPDATED, data: payload });
      });
      void this.getPublicOrderStatus(id).then((snapshot) => {
        subscriber.next({ event: CUSTOMER_EVENT.STATUS_CHANGED, data: snapshot });
      });
      return () => {
        offStatus();
        offAvailability();
        offProfile();
      };
    });
  }

  // ----------------------------------------------------------- state machine

  private async executeTransition(
    orderId: string,
    action: OrderAction,
    actor: OrderActor,
    reason?: string,
  ): Promise<{ order: OrderRow; fromStatus: string }> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) throw new EntityNotFoundException('order', orderId);

    const rule = TRANSITION_RULES[action];
    const fromStatus = order.status as OrderStatus;
    if (!rule.expectedFrom.includes(fromStatus)) {
      throw new InvalidOrderTransitionException(orderId, fromStatus, action);
    }
    if (!rule.roles.includes(actor.role)) {
      throw new InsufficientPermissionException(`orders.${action}`);
    }
    if (action === 'cancel') this.assertCancelAllowed(actor.role, fromStatus);

    const result = await this.ordersRepository.transitionStatusTransaction({
      orderId,
      expectedFrom: [fromStatus],
      toStatus: rule.to(fromStatus),
      actorEmployeeId: actor.id,
      setFields: this.transitionFields(action, actor.id, reason),
    });

    if (result.outcome === 'not_found') throw new EntityNotFoundException('order', orderId);
    if (result.outcome === 'conflict') {
      // Lost a race against a concurrent transition (NFR3) — report the
      // status that actually won instead of guessing.
      throw new InvalidOrderTransitionException(orderId, result.current.status, action);
    }
    return { order: result.order, fromStatus: result.fromStatus };
  }

  /** Q3 — the waiter's pending-only cancellation window. Once Accepted or
   * beyond, waiter cancellation is forbidden (403 — a permission refusal). */
  private assertCancelAllowed(role: EmployeeRole, fromStatus: OrderStatus): void {
    if (role === EmployeeRole.WAITER && fromStatus !== OrderStatus.PENDING) {
      throw new InsufficientPermissionException('orders.cancel (waiters may cancel pending orders only)');
    }
  }

  private transitionFields(
    action: OrderAction,
    actorEmployeeId: string,
    reason?: string,
  ): { acceptedByEmployeeId?: string; servedByEmployeeId?: string; cancelledByEmployeeId?: string; cancellationReason?: string } {
    switch (action) {
      case 'accept':
        return { acceptedByEmployeeId: actorEmployeeId };
      case 'serve':
        return { servedByEmployeeId: actorEmployeeId };
      case 'cancel':
        return { cancelledByEmployeeId: actorEmployeeId, cancellationReason: reason };
      default:
        return {};
    }
  }

  // ---------------------------------------------------------------- helpers

  private unwrapCreateResult(
    result: CreateOrderResult,
    tableId: string,
    parentOrderId?: string,
  ): Extract<CreateOrderResult, { outcome: 'created' }> {
    switch (result.outcome) {
      case 'created':
        return result;
      case 'products_not_found':
        throw new EntityNotFoundException('product', result.productIds.join(', '));
      case 'products_unavailable':
        throw new ProductUnavailableException(result.productIds);
      case 'bill_group_not_open':
        // Reachable since Step 3.4 (payment closes bill groups): an add-on
        // can never silently attach an order to a closed group.
        throw new InvalidOrderTransitionException(parentOrderId ?? tableId, 'bill-group-closed', 'addon');
      case 'table_not_orderable':
        // Ruling D8 — the visit is financially closing/closed; a new visit
        // starts only after the table returns to `available` (mark-cleaned).
        throw new InvalidTableStatusTransitionException(tableId, result.tableStatus, 'create-order');
    }
  }

  private emitAfterCreate(created: Extract<CreateOrderResult, { outcome: 'created' }>): void {
    // Contract §4 binding rule: strictly after the transaction committed.
    const dto = this.toDto(created.order, created.items, EmployeeRole.OWNER);
    this.events.emitOrderCreated(dto as unknown as Record<string, unknown>);
    if (created.tableFlippedToOccupied) {
      this.events.emitTableStatusChanged({
        tableId: created.order.tableId,
        fromStatus: 'available',
        toStatus: 'occupied',
      });
    }
  }

  private async buildDto(order: OrderRow, viewerRole: EmployeeRole): Promise<OrderDto | KitchenOrderDto> {
    const items = await this.ordersRepository.findItemsForOrder(order.id);
    return this.toDto(order, items, viewerRole);
  }

  /** Entity → response DTO (Contract §1 DTO boundary), with the FR6/Q7
   * kitchen variant: Kitchen-role viewers never receive pricing fields. */
  private toDto(order: OrderRow, items: OrderItemRow[], viewerRole: EmployeeRole): OrderDto | KitchenOrderDto {
    const base = {
      id: order.id,
      tableBillGroupId: order.tableBillGroupId,
      tableId: order.tableId,
      channel: order.channel as OrderDto['channel'],
      isAddon: order.isAddon,
      status: order.status as OrderStatus,
      source: order.source as OrderDto['source'],
      createdByEmployeeId: order.createdByEmployeeId,
      acceptedByEmployeeId: order.acceptedByEmployeeId,
      servedByEmployeeId: order.servedByEmployeeId,
      cancelledByEmployeeId: order.cancelledByEmployeeId,
      cancellationReason: order.cancellationReason,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
    if (viewerRole === EmployeeRole.KITCHEN) {
      return {
        ...base,
        items: items.map((item) => ({
          id: item.id,
          productId: item.productId,
          name: item.nameSnapshot,
          category: item.categorySnapshot,
          quantity: item.quantity,
          notes: item.notes,
        })),
      };
    }
    return {
      ...base,
      items: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        name: item.nameSnapshot,
        category: item.categorySnapshot,
        unitPriceMinor: item.unitPriceMinorSnapshot,
        quantity: item.quantity,
        notes: item.notes,
      })),
    };
  }

  private encodeCursor(row: OrderRow): string {
    return Buffer.from(JSON.stringify({ c: row.createdAt, i: row.id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
      if (typeof parsed.c !== 'number' || typeof parsed.i !== 'string') throw new Error('bad shape');
      return { createdAt: parsed.c, id: parsed.i };
    } catch {
      throw new ValidationFailedException('Malformed pagination cursor.');
    }
  }
}
