import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';
import { ANALYTICS_RANGE, AnalyticsRange, OrderChannel, PaymentMethod } from '@smarttable/shared-types';

/**
 * The shared analytics query — API Contract §3: `from`, `to` (or a named
 * range enum), `channel?`, `paymentMethod?`, `employeeId?`.
 *
 * Cross-field rules live in the service (B5(a): from/to are required iff
 * range=custom and forbidden otherwise; Engineering Standards §6 — DTOs
 * validate shape, services validate cross-entity/cross-field truth).
 */
export class AnalyticsQueryDto {
  @IsOptional()
  @IsEnum(ANALYTICS_RANGE)
  range?: AnalyticsRange;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
