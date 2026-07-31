import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PermissionKey } from '@smarttable/shared-types';
import type {
  KitchenOrderDto,
  OrderDto,
  PublicOrderStatusDto,
} from '@smarttable/shared-types';
import { OrdersService } from './orders.service';
import {
  CancelOrderDto,
  CreateAddonOrderDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  PublicCreateOrderDto,
} from './dto/order.dto';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Orders endpoints (API Contract Design §3 — exactly the ten routes listed
 * there for the orders module in the Step 3.3 lifecycle scope). Thin
 * translation layer only: the state machine, availability rules and role
 * refinements all live in OrdersService (Engineering Standards §3).
 *
 * `Idempotency-Key` is required on the three creation routes (Contract §1 +
 * the Security §5 table's public-order row) via @Idempotent().
 */
@Controller()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** Customer QR submission — unauthenticated by design (Security §1); the
   * channel's protection is token unguessability + the 10/min rate class
   * (Security §5) + source-IP audit (Security §7, service-side). */
  @Public()
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/orders')
  createPublicOrder(@Body() dto: PublicCreateOrderDto, @Ip() sourceIp: string): Promise<OrderDto> {
    return this.ordersService.createPublicOrder(dto, sourceIp ?? null);
  }

  /** Staff manual order entry — Q6: Owner, Manager, Waiter. */
  @RequirePermission(PermissionKey.ORDERS_CREATE)
  @Idempotent()
  @Post('orders')
  createStaffOrder(@Body() dto: CreateOrderDto, @CurrentEmployee() actor: ActingEmployee): Promise<OrderDto> {
    return this.ordersService.createStaffOrder(dto, actor);
  }

  /** KDS board + table map feed — cursor pagination, three frozen filters.
   * Kitchen-role callers receive price-stripped orders (FR6/Q7). */
  @RequirePermission(PermissionKey.ORDERS_VIEW)
  @Get('orders')
  listOrders(
    @Query() query: ListOrdersQueryDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<{ data: (OrderDto | KitchenOrderDto)[]; meta: { nextCursor: string | null } }> {
    return this.ordersService.listOrders(query, actor.role);
  }

  @RequirePermission(PermissionKey.ORDERS_VIEW)
  @Get('orders/:id')
  getOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<OrderDto | KitchenOrderDto> {
    return this.ordersService.getOrder(id, actor.role);
  }

  /** Q2: Owner, Manager, Kitchen — Waiter is refused by the baseline Guard
   * (403) before ever reaching the state machine. */
  @RequirePermission(PermissionKey.ORDERS_ACCEPT)
  @Post('orders/:id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<OrderDto> {
    return this.ordersService.accept(id, actor);
  }

  /** Generic advance (Contract §3 design note): accepted → preparing →
   * ready — Q5. The state machine, not this router, decides legality. */
  @RequirePermission(PermissionKey.ORDERS_ADVANCE)
  @Post('orders/:id/advance')
  advance(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<OrderDto> {
    return this.ordersService.advance(id, actor);
  }

  /** FR7: Waiter, Manager, Owner only. */
  @RequirePermission(PermissionKey.ORDERS_SERVE)
  @Post('orders/:id/serve')
  serve(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<OrderDto> {
    return this.ordersService.serve(id, actor);
  }

  /** Q3: Owner/Manager unrestricted; Waiter pending-only (service-enforced).
   * FR10: reason mandatory. */
  @RequirePermission(PermissionKey.ORDERS_CANCEL)
  @Post('orders/:id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<OrderDto> {
    return this.ordersService.cancel(id, dto.reason, actor);
  }

  /** FR5 — the only way to add items once the parent is locked. */
  @RequirePermission(PermissionKey.ORDERS_CREATE)
  @Idempotent()
  @Post('orders/:id/addon')
  createAddon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAddonOrderDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<OrderDto> {
    return this.ordersService.createAddonOrder(id, dto, actor);
  }

  /** Customer-facing minimal read (SSE initial snapshot) — Q8: `{id,status}`
   * only; 60/min public read class (Security §5). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('public/orders/:id/status')
  getPublicOrderStatus(@Param('id', ParseUUIDPipe) id: string): Promise<PublicOrderStatusDto> {
    return this.ordersService.getPublicOrderStatus(id);
  }
}
