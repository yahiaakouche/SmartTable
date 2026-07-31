import { Inject, Injectable } from '@nestjs/common';
import { EmployeeRole, ShiftStatus } from '@smarttable/shared-types';
import type { CloseShiftRequest, OpenShiftRequest, ShiftDto, ShiftReconciliationDto } from '@smarttable/shared-types';
import { BILLING_REPOSITORY, BillingRepository, ShiftRow } from './billing.repository';
import type { BillingActor } from './billing.service';
import { AuditService } from '../audit/audit.service';
import {
  EntityNotFoundException,
  InsufficientPermissionException,
  ShiftAlreadyClosedException,
  ShiftAlreadyOpenException,
} from '../../common/exceptions/domain.exception';

/**
 * Shift open/close tracking (MVP Scope Freeze: "Cashier-level"; PRD §6
 * Cashier Journey: "Works a shift with a clear open/close boundary").
 *
 * Ruling D6:
 *  - one OPEN shift per employee at a time (409 SHIFT_ALREADY_OPEN);
 *  - own-shift scoping: Owner/Manager unrestricted; anyone else (the Cashier,
 *    the only other role the baseline Guard admits) may open/close/view only
 *    their OWN shifts — same enforcement pattern as the waiter's pending-only
 *    cancellation (Q3): a service-layer 403, not expressible in a baseline row;
 *  - expected cash = opening + Σ cash payments linked to the shift, computed
 *    atomically at close; the close response is the frozen expected-vs-counted
 *    reconciliation (Contract §3).
 *
 * No domain events: shifts appear nowhere in the frozen Contract §4 event
 * list (same reasoning as payments) — the audit trail is their record.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billingRepository: BillingRepository,
    private readonly audit: AuditService,
  ) {}

  /** POST /shifts/open — the shift belongs to the ACTING employee; the
   * employee identity comes from the authenticated context, never the body. */
  async openShift(input: OpenShiftRequest, actor: BillingActor): Promise<ShiftDto> {
    const result = await this.billingRepository.openShiftTransaction({
      employeeId: actor.id,
      openingCashMinor: input.openingCashMinor,
    });
    if (result.outcome === 'already_open') {
      throw new ShiftAlreadyOpenException(actor.id, result.existing.id);
    }

    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'shift',
      entityId: result.shift.id,
      action: 'shift_opened',
      newValueJson: JSON.stringify({ openingCashMinor: result.shift.openingCashMinor }),
    });
    return this.toDto(result.shift);
  }

  /** POST /shifts/:id/close — returns the expected-vs-counted reconciliation
   * (Contract §3). Closing is compare-and-set on 'open': a double close can
   * never silently recompute the reconciliation (409 SHIFT_ALREADY_CLOSED). */
  async closeShift(shiftId: string, input: CloseShiftRequest, actor: BillingActor): Promise<ShiftReconciliationDto> {
    const existing = await this.billingRepository.findShiftById(shiftId);
    if (!existing) throw new EntityNotFoundException('shift', shiftId);
    this.assertShiftScope(existing, actor, 'close');

    const result = await this.billingRepository.closeShiftTransaction({
      shiftId,
      closingCashMinor: input.closingCashMinor,
    });
    if (result.outcome === 'not_found') throw new EntityNotFoundException('shift', shiftId);
    if (result.outcome === 'already_closed') throw new ShiftAlreadyClosedException(shiftId);

    const differenceMinor = result.shift.closingCashMinor! - result.shift.expectedCashMinor!;
    await this.audit.append({
      actorEmployeeId: actor.id,
      entityType: 'shift',
      entityId: shiftId,
      action: 'shift_closed',
      oldValueJson: JSON.stringify({ status: 'open', openingCashMinor: existing.openingCashMinor }),
      newValueJson: JSON.stringify({
        status: 'closed',
        closingCashMinor: result.shift.closingCashMinor,
        expectedCashMinor: result.shift.expectedCashMinor,
        differenceMinor,
        paymentsCollected: result.paymentsCollected,
      }),
    });
    return { shift: this.toDto(result.shift), paymentsCollected: result.paymentsCollected, differenceMinor };
  }

  /** GET /shifts/:id — PRD §11: the Cashier sees their OWN shift only. */
  async getShift(shiftId: string, actor: BillingActor): Promise<ShiftDto> {
    const shift = await this.billingRepository.findShiftById(shiftId);
    if (!shift) throw new EntityNotFoundException('shift', shiftId);
    this.assertShiftScope(shift, actor, 'view');
    return this.toDto(shift);
  }

  /** D6 own-shift scoping: Owner/Manager unrestricted; every other admitted
   * role may touch only their own shift (403 — a permission refusal, Q3 pattern). */
  private assertShiftScope(shift: ShiftRow, actor: BillingActor, action: 'view' | 'close'): void {
    const isSupervisor = actor.role === EmployeeRole.OWNER || actor.role === EmployeeRole.MANAGER;
    if (!isSupervisor && shift.employeeId !== actor.id) {
      throw new InsufficientPermissionException(`shifts.${action} (own shift only)`);
    }
  }

  private toDto(row: ShiftRow): ShiftDto {
    return {
      id: row.id,
      employeeId: row.employeeId,
      openingCashMinor: row.openingCashMinor,
      closingCashMinor: row.closingCashMinor,
      expectedCashMinor: row.expectedCashMinor,
      status: row.status as ShiftStatus,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    };
  }
}
