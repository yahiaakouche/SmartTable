/**
 * Orders contract types — API Contract Design §3/§6.
 *
 * Order item rows carry IMMUTABLE snapshots (FR40): name, category and unit
 * price are copied from the live product at the moment of sale and never
 * re-read afterwards. Money is integer minor units on the wire, always
 * (FR36). The customer-facing public types deliberately expose the minimal
 * surface (Q8 ruling: `{ id, status }` only).
 */
import { OrderChannel, OrderSource, OrderStatus } from './enums';

export interface OrderItemDto {
  id: string;
  /** NULL when the underlying product was hard-deleted after the sale
   * (ON DELETE SET NULL) — the snapshot fields remain the source of truth. */
  productId: string | null;
  name: string; // snapshot
  category: string; // snapshot
  unitPriceMinor: number; // snapshot
  quantity: number;
  notes: string | null;
}

export interface OrderDto {
  id: string;
  tableBillGroupId: string;
  tableId: string;
  channel: OrderChannel;
  isAddon: boolean;
  status: OrderStatus;
  source: OrderSource;
  items: OrderItemDto[];
  createdByEmployeeId: string | null; // null for QR-sourced orders
  acceptedByEmployeeId: string | null;
  servedByEmployeeId: string | null;
  cancelledByEmployeeId: string | null;
  cancellationReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** FR6 — the Kitchen Display Screen must never carry pricing or payment
 * information (Q7 ruling: pricing fields are stripped server-side from any
 * order response served to a Kitchen-role caller, not merely hidden in UI). */
export interface KitchenOrderItemDto {
  id: string;
  productId: string | null;
  name: string;
  category: string;
  quantity: number;
  notes: string | null;
}

export type KitchenOrderDto = Omit<OrderDto, 'items'> & { items: KitchenOrderItemDto[] };

/** Customer-facing minimal status read (GET /public/orders/:id/status) —
 * Q8 ruling: exactly `{ id, status }`, nothing else. */
export interface PublicOrderStatusDto {
  id: string;
  status: OrderStatus;
}

export interface OrderItemInput {
  productId: string;
  quantity: number; // >= 1
  notes?: string;
}

/** Staff manual order entry (POST /orders) — PRD §6 Waiter Journey. */
export interface CreateOrderRequest {
  tableId: string;
  items: OrderItemInput[];
}

/** Customer QR submission (POST /public/orders) — carries the unguessable
 * table token, never a raw tableId (Contract §3). */
export interface PublicCreateOrderRequest {
  qrToken: string;
  items: OrderItemInput[];
}

/** Add-on Order against the same Table Bill Group (POST /orders/:id/addon)
 * — the only way to add items once an order is locked at Preparing (FR5). */
export interface CreateAddonOrderRequest {
  items: OrderItemInput[];
}

/** FR10 — the reason is mandatory; the DB CHECK constraint is the final
 * backstop behind this DTO. */
export interface CancelOrderRequest {
  reason: string;
}

/** GET /orders query — cursor (keyset) pagination per Contract §1, with the
 * three frozen filters powering the KDS board and the table map. */
export interface ListOrdersQuery {
  status?: OrderStatus;
  tableId?: string;
  channel?: OrderChannel;
  cursor?: string;
  limit?: number;
}
