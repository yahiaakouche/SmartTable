import { Controller, Get, Query } from '@nestjs/common';
import { PermissionKey } from '@smarttable/shared-types';
import type {
  AnalyticsKpisDto,
  OperationalStatsDto,
  OrdersOverTimeDto,
  RevenueOverTimeDto,
  TopProductsDto,
} from '@smarttable/shared-types';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics endpoints (API Contract Design §3 — exactly the five routes
 * listed there for the analytics module). Thin translation layer only:
 * range resolution, the frozen live/rollup branching, and every KPI
 * derivation live in AnalyticsService (Engineering Standards §3; the §3
 * design note freezes the branching as a service-internal concern).
 *
 * Ruling B1: ANALYTICS_VIEW = Owner + Manager only. Reads only — no audit
 * rows (FR38 lists mutations), default 120/min authenticated throttle class
 * (Security §5), no Idempotency-Key (no mutation). Money leaves here as
 * integer minor units; formatting is a frontend concern (Contract §6).
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /** The frozen KPI card set (PRD §7 item 29). */
  @RequirePermission(PermissionKey.ANALYTICS_VIEW)
  @Get('kpis')
  getKpis(@Query() query: AnalyticsQueryDto): Promise<AnalyticsKpisDto> {
    return this.analyticsService.getKpis(query);
  }

  @RequirePermission(PermissionKey.ANALYTICS_VIEW)
  @Get('revenue-over-time')
  getRevenueOverTime(@Query() query: AnalyticsQueryDto): Promise<RevenueOverTimeDto> {
    return this.analyticsService.getRevenueOverTime(query);
  }

  @RequirePermission(PermissionKey.ANALYTICS_VIEW)
  @Get('orders-over-time')
  getOrdersOverTime(@Query() query: AnalyticsQueryDto): Promise<OrdersOverTimeDto> {
    return this.analyticsService.getOrdersOverTime(query);
  }

  @RequirePermission(PermissionKey.ANALYTICS_VIEW)
  @Get('top-products')
  getTopProducts(@Query() query: AnalyticsQueryDto): Promise<TopProductsDto> {
    return this.analyticsService.getTopProducts(query);
  }

  /** FR43 — neutral per-employee operational metrics (B3(a)): no rankings,
   * no performance framing anywhere in the response shape. */
  @RequirePermission(PermissionKey.ANALYTICS_VIEW)
  @Get('operational-stats')
  getOperationalStats(@Query() query: AnalyticsQueryDto): Promise<OperationalStatsDto> {
    return this.analyticsService.getOperationalStats(query);
  }
}
