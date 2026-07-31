import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import {
  categories,
  orderItems,
  orderStatusEvents,
  orders,
  products,
  tableBillGroups,
  tables,
} from '../../database/schema';

export const ORDERS_REPOSITORY = Symbol('ORDERS_REPOSITORY');

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type TableRow = typeof tables.$inferSelect;

export interface OrderItemWriteInput {
  productId: string;
  quantity: number;
  notes?: string;
}

export interface CreateOrderInput {
  tableId: string;
  /** Add-on path pins the parent's Table Bill Group explicitly (Contract §3:
   * "a linked Add-on Order against the same Table Bill Group"). */
  billGroupId?: string;
  source: string; // 'qr' | 'waiter_manual' (CHECK-constrained values)
  createdByEmployeeId: string | null; // null for QR-sourced orders
  items: OrderItemWriteInput[];
}

export type CreateOrderResult =
  | {
      outcome: 'created';
      order: OrderRow;
      items: OrderItemRow[];
      /** True when this order opened the visit's Table Bill Group (FR34) —
       * i.e. it is the table's first order and flipped the table to occupied. */
      groupCreated: boolean;
      tableFlippedToOccupied: boolean;
    }
  | { outcome: 'products_not_found'; productIds: string[] }
  | { outcome: 'products_unavailable'; productIds: string[] }
  | { outcome: 'bill_group_not_open' };

export interface ListOrdersFilter {
  status?: string;
  tableId?: string;
  channel?: string;
}

/** Keyset cursor position — (created_at, id) pair of the last row seen,
 * ordering DESC. UUID v7 ids are time-ordered, making id a stable
 * tiebreaker within the same millisecond. */
export interface CursorPosition {
  createdAt: number;
  id: string;
}

export interface TransitionInput {
  orderId: string;
  expectedFrom: string[];
  toStatus: string;
  actorEmployeeId: string | null;
  setFields: {
    acceptedByEmployeeId?: string;
    servedByEmployeeId?: string;
    cancelledByEmployeeId?: string;
    cancellationReason?: string;
  };
}

export type TransitionResult =
  | { outcome: 'ok'; order: OrderRow; fromStatus: string }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: OrderRow };

/**
 * Orders persistence — the only writer of orders, order_items,
 * order_status_events and table_bill_groups rows.
 *
 * Both multi-step writes run as single SYNCHRONOUS better-sqlite3
 * transactions (precedent: invitations acceptTransaction, Step 3.1) — the
 * driver serializes them on the single embedded connection, so "simultaneous
 * submissions from multiple tables/waiters" (NFR3) can never interleave
 * inside a transaction by construction.
 */
export interface OrdersRepository {
  createOrderTransaction(input: CreateOrderInput): Promise<CreateOrderResult>;
  findOrderById(id: string): Promise<OrderRow | undefined>;
  findItemsForOrder(orderId: string): Promise<OrderItemRow[]>;
  findItemsForOrders(orderIds: string[]): Promise<OrderItemRow[]>;
  listOrders(filter: ListOrdersFilter, cursor: CursorPosition | null, limit: number): Promise<OrderRow[]>;
  /** Optimistic-locking compare-and-set (MVP Scope Freeze §6.3): the orders
   * table deliberately has no version column — the conditional UPDATE on the
   * expected current status IS the concurrency guarantee, and the status
   * event row is written in the same transaction as the transition itself. */
  transitionStatusTransaction(input: TransitionInput): Promise<TransitionResult>;

  /** Read-only cross-module lookups (precedent: tables' countNonTerminalOrders). */
  findTableById(id: string): Promise<TableRow | undefined>;
  findTableByQrToken(qrToken: string): Promise<TableRow | undefined>;
}

@Injectable()
export class DrizzleOrdersRepository implements OrdersRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async createOrderTransaction(input: CreateOrderInput): Promise<CreateOrderResult> {
    return this.db.transaction((tx) => {
      // 1. Resolve every requested product together with its category's
      //    active flag — availability is judged at write time, inside the
      //    same transaction as the write itself (never a stale pre-read).
      const productIds = [...new Set(input.items.map((item) => item.productId))];
      const productRows = tx
        .select({
          product: products,
          categoryIsActive: categories.isActive,
          categoryNameAr: categories.nameAr,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(inArray(products.id, productIds))
        .all();
      const byId = new Map(productRows.map((row) => [row.product.id, row]));

      const notFound = productIds.filter((id) => !byId.has(id));
      if (notFound.length > 0) return { outcome: 'products_not_found', productIds: notFound } as const;

      const unavailable = productIds.filter((id) => {
        const row = byId.get(id)!;
        if (!row.product.isAvailable) return true;
        // A product under a soft-deleted category cannot be sold either —
        // it is invisible on every menu surface, so accepting an order for
        // it would contradict FR2's visibility rules.
        if (row.product.categoryId !== null && row.categoryIsActive !== true) return true;
        return false;
      });
      if (unavailable.length > 0) return { outcome: 'products_unavailable', productIds: unavailable } as const;

      // 2. Table Bill Group — pinned by the add-on path, otherwise
      //    find-or-create (FR34: auto-open on the table's first order).
      let group: typeof tableBillGroups.$inferSelect | undefined;
      let groupCreated = false;
      if (input.billGroupId !== undefined) {
        group = tx.select().from(tableBillGroups).where(eq(tableBillGroups.id, input.billGroupId)).all()[0];
        if (!group || group.status !== 'open') return { outcome: 'bill_group_not_open' } as const;
      } else {
        group = tx
          .select()
          .from(tableBillGroups)
          .where(and(eq(tableBillGroups.tableId, input.tableId), eq(tableBillGroups.status, 'open')))
          .all()[0];
        if (!group) {
          group = tx.insert(tableBillGroups).values({ tableId: input.tableId }).returning().all()[0];
          groupCreated = true;
        }
      }

      // 3. is_addon derivation: every order after the first in a group is an
      //    Add-on Order (FR5/FR34); the pinned add-on path is one by definition.
      let isAddon = true;
      if (input.billGroupId === undefined) {
        const countRows = tx
          .select({ total: sql<number>`count(*)` })
          .from(orders)
          .where(eq(orders.tableBillGroupId, group.id))
          .all();
        isAddon = (countRows[0]?.total ?? 0) > 0;
      }

      // 4. The order row + immutable item snapshots (FR40) + the initial
      //    status event — all in this one transaction.
      const order = tx
        .insert(orders)
        .values({
          tableBillGroupId: group.id,
          tableId: input.tableId,
          channel: 'dine_in', // the only channel active in v1 (FR39)
          isAddon,
          source: input.source,
          createdByEmployeeId: input.createdByEmployeeId,
        })
        .returning()
        .all()[0];

      const insertedItems = input.items.map((item) => {
        const productRow = byId.get(item.productId)!;
        return tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            productId: item.productId,
            // Single-column snapshots (frozen schema): the restaurant's
            // default language name is captured (FR15 — Arabic default).
            nameSnapshot: productRow.product.nameAr,
            categorySnapshot: productRow.categoryNameAr ?? '',
            unitPriceMinorSnapshot: productRow.product.priceMinor,
            quantity: item.quantity,
            notes: item.notes ?? null,
          })
          .returning()
          .all()[0];
      });

      tx.insert(orderStatusEvents)
        .values({ orderId: order.id, fromStatus: null, toStatus: 'pending', actorEmployeeId: input.createdByEmployeeId })
        .run();

      // 5. The table's first order flips it available → occupied (compare-
      //    and-set on the expected status — if some other path already moved
      //    the table, we leave it alone and report no flip).
      let tableFlippedToOccupied = false;
      if (groupCreated) {
        const flipped = tx
          .update(tables)
          .set({ status: 'occupied', updatedAt: Date.now() })
          .where(and(eq(tables.id, input.tableId), eq(tables.status, 'available')))
          .returning()
          .all();
        tableFlippedToOccupied = flipped.length > 0;
      }

      return { outcome: 'created', order, items: insertedItems, groupCreated, tableFlippedToOccupied } as const;
    });
  }

  async findOrderById(id: string): Promise<OrderRow | undefined> {
    const rows = await this.db.select().from(orders).where(eq(orders.id, id));
    return rows[0];
  }

  async findItemsForOrder(orderId: string): Promise<OrderItemRow[]> {
    return this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  }

  async findItemsForOrders(orderIds: string[]): Promise<OrderItemRow[]> {
    if (orderIds.length === 0) return [];
    return this.db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
  }

  async listOrders(filter: ListOrdersFilter, cursor: CursorPosition | null, limit: number): Promise<OrderRow[]> {
    const conditions = [
      ...(filter.status !== undefined ? [eq(orders.status, filter.status)] : []),
      ...(filter.tableId !== undefined ? [eq(orders.tableId, filter.tableId)] : []),
      ...(filter.channel !== undefined ? [eq(orders.channel, filter.channel)] : []),
      ...(cursor !== null
        ? [or(lt(orders.createdAt, cursor.createdAt), and(eq(orders.createdAt, cursor.createdAt), lt(orders.id, cursor.id)))!]
        : []),
    ];
    return this.db
      .select()
      .from(orders)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit);
  }

  async transitionStatusTransaction(input: TransitionInput): Promise<TransitionResult> {
    return this.db.transaction((tx) => {
      const current = tx.select().from(orders).where(eq(orders.id, input.orderId)).all()[0];
      if (!current) return { outcome: 'not_found' } as const;
      if (!input.expectedFrom.includes(current.status)) {
        return { outcome: 'conflict', current } as const;
      }

      // Compare-and-set: the UPDATE only lands if the status is STILL what
      // we just read — the frozen optimistic-locking pattern for a table
      // with no version column (MVP Scope Freeze §6.3).
      const updated = tx
        .update(orders)
        .set({ status: input.toStatus, ...input.setFields, updatedAt: Date.now() })
        .where(and(eq(orders.id, input.orderId), eq(orders.status, current.status)))
        .returning()
        .all();
      if (!updated[0]) return { outcome: 'conflict', current } as const;

      tx.insert(orderStatusEvents)
        .values({
          orderId: input.orderId,
          fromStatus: current.status,
          toStatus: input.toStatus,
          actorEmployeeId: input.actorEmployeeId,
        })
        .run();

      return { outcome: 'ok', order: updated[0], fromStatus: current.status } as const;
    });
  }

  async findTableById(id: string): Promise<TableRow | undefined> {
    const rows = await this.db.select().from(tables).where(eq(tables.id, id));
    return rows[0];
  }

  async findTableByQrToken(qrToken: string): Promise<TableRow | undefined> {
    const rows = await this.db.select().from(tables).where(eq(tables.qrToken, qrToken));
    return rows[0];
  }
}
