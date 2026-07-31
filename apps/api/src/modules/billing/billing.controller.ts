import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PermissionKey } from '@smarttable/shared-types';
import type { ConsolidatedBillDto, PaymentRecordedDto, ShiftDto, ShiftReconciliationDto } from '@smarttable/shared-types';
import { BillingService } from './billing.service';
import { ShiftsService } from './shifts.service';
import { CloseShiftDto, OpenShiftDto, RecordPaymentDto } from './dto/billing.dto';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Billing endpoints (API Contract Design §3 — exactly the five routes of the
 * frozen `billing` section). Thin translation layer only (ES §3): every rule
 * — the billable gate, money math, shift scoping — lives in the services.
 *
 * Rate limiting: all five are authenticated staff routes and inherit the
 * generous default class (Security §5's table defines special classes only
 * for public/auth/invitation routes).
 */
@Controller()
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly shiftsService: ShiftsService,
  ) {}

  /** The consolidated bill (FR9) — the cashier's collection screen.
   * D10 baseline: Owner, Manager, Cashier. */
  @RequirePermission(PermissionKey.BILLING_VIEW)
  @Get('billing/table-bill-groups/:id')
  getBill(@Param('id', ParseUUIDPipe) id: string): Promise<ConsolidatedBillDto> {
    return this.billingService.getBill(id);
  }

  /** FR8 — Paid/Completed are set exclusively by Cashier, Manager, Owner.
   * Contract §1: `Idempotency-Key` REQUIRED (safe cash-drawer retries). */
  @RequirePermission(PermissionKey.PAYMENTS_PROCESS)
  @Idempotent()
  @Post('payments')
  recordPayment(@Body() dto: RecordPaymentDto, @CurrentEmployee() actor: ActingEmployee): Promise<PaymentRecordedDto> {
    return this.billingService.recordPayment(dto, actor);
  }

  /** Cashier-level shift tracking (MVP Scope Freeze) — D10 baseline. */
  @RequirePermission(PermissionKey.SHIFTS_MANAGE)
  @Post('shifts/open')
  openShift(@Body() dto: OpenShiftDto, @CurrentEmployee() actor: ActingEmployee): Promise<ShiftDto> {
    return this.shiftsService.openShift(dto, actor);
  }

  /** Returns the expected-vs-counted reconciliation (Contract §3, D6). */
  @RequirePermission(PermissionKey.SHIFTS_MANAGE)
  @Post('shifts/:id/close')
  closeShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<ShiftReconciliationDto> {
    return this.shiftsService.closeShift(id, dto, actor);
  }

  /** PRD §11 — Cashier sees their own shift only (service-layer scoping). */
  @RequirePermission(PermissionKey.SHIFTS_VIEW)
  @Get('shifts/:id')
  getShift(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<ShiftDto> {
    return this.shiftsService.getShift(id, actor);
  }
}
