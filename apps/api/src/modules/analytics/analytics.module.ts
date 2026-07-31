import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { ANALYTICS_REPOSITORY, DrizzleAnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics domain — Step 3.7 (PRD §7 items 29–30, FR41–FR43). Read-only
 * query module over the 3.4 rollup tables and the permanent raw facts; no
 * imports from other business modules (the only cross-module dependency is
 * the pure billing-math money functions, single-sourced so analytics can
 * never drift from billing's revenue definitions).
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, { provide: ANALYTICS_REPOSITORY, useClass: DrizzleAnalyticsRepository }],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
