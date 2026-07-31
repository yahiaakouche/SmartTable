import { EmployeeRole } from '@smarttable/shared-types';
import { ShiftsService } from './shifts.service';
import { BillingActor } from './billing.service';
import { BillingRepository, ShiftRow } from './billing.repository';
import { AuditService } from '../audit/audit.service';
import {
  EntityNotFoundException,
  InsufficientPermissionException,
  ShiftAlreadyClosedException,
  ShiftAlreadyOpenException,
} from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the shift rules (Engineering Standards §10 — RBAC-adjacent
 * logic is a mandatory unit-test surface):
 *  - D6: one open shift per employee (SHIFT_ALREADY_OPEN),
 *  - D6: own-shift scoping (Owner/Manager unrestricted; others own only),
 *  - D6: expected-vs-counted reconciliation on close,
 *  - double close → SHIFT_ALREADY_CLOSED (never recompute silently).
 */
describe('ShiftsService', () => {
  let service: ShiftsService;
  let repository: jest.Mocked<BillingRepository>;
  let audit: jest.Mocked<AuditService>;

  const actor = (role: EmployeeRole, id = 'emp-1'): BillingActor => ({ id, role });

  const shiftRow = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
    id: 'shift-1',
    employeeId: 'emp-1',
    openingCashMinor: 10_000,
    closingCashMinor: null,
    expectedCashMinor: null,
    status: 'open',
    openedAt: 1000,
    closedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      findBillGroupById: jest.fn(),
      findOrdersWithItemsForGroup: jest.fn(),
      findPaymentForGroup: jest.fn(),
      getTaxRateBasisPoints: jest.fn(),
      recordPaymentTransaction: jest.fn(),
      openShiftTransaction: jest.fn(),
      findShiftById: jest.fn(),
      closeShiftTransaction: jest.fn(),
    } as jest.Mocked<BillingRepository>;
    audit = { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
    service = new ShiftsService(repository, audit);
  });

  describe('openShift', () => {
    it('opens a shift for the ACTING employee (identity never from the body) and audits shift_opened', async () => {
      repository.openShiftTransaction.mockResolvedValue({ outcome: 'opened', shift: shiftRow() });

      const shift = await service.openShift({ openingCashMinor: 10_000 }, actor(EmployeeRole.CASHIER, 'emp-1'));

      expect(repository.openShiftTransaction).toHaveBeenCalledWith({ employeeId: 'emp-1', openingCashMinor: 10_000 });
      expect(shift).toMatchObject({ id: 'shift-1', employeeId: 'emp-1', status: 'open', openingCashMinor: 10_000 });
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'shift', entityId: 'shift-1', action: 'shift_opened' }),
      );
    });

    it('rejects a second open shift with 409 SHIFT_ALREADY_OPEN (D6)', async () => {
      repository.openShiftTransaction.mockResolvedValue({ outcome: 'already_open', existing: shiftRow() });
      const error: any = await service.openShift({ openingCashMinor: 0 }, actor(EmployeeRole.CASHIER)).catch((e) => e);
      expect(error).toBeInstanceOf(ShiftAlreadyOpenException);
      expect(error.code).toBe('SHIFT_ALREADY_OPEN');
      expect(error.details).toEqual({ employeeId: 'emp-1', openShiftId: 'shift-1' });
      expect(audit.append).not.toHaveBeenCalled();
    });
  });

  describe('closeShift', () => {
    const closedShift = shiftRow({ status: 'closed', closingCashMinor: 70_000, expectedCashMinor: 69_500, closedAt: 5000 });

    it('404s an unknown shift', async () => {
      repository.findShiftById.mockResolvedValue(undefined);
      await expect(service.closeShift('ghost', { closingCashMinor: 0 }, actor(EmployeeRole.CASHIER))).rejects.toThrow(
        EntityNotFoundException,
      );
    });

    it('the cashier closes their OWN shift: reconciliation = closing − expected (D6), audited', async () => {
      repository.findShiftById.mockResolvedValue(shiftRow());
      repository.closeShiftTransaction.mockResolvedValue({ outcome: 'closed', shift: closedShift, paymentsCollected: 3 });

      const result = await service.closeShift('shift-1', { closingCashMinor: 70_000 }, actor(EmployeeRole.CASHIER, 'emp-1'));

      expect(result.shift.status).toBe('closed');
      expect(result.paymentsCollected).toBe(3);
      expect(result.differenceMinor).toBe(500); // 70_000 counted − 69_500 expected (over)
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'shift', entityId: 'shift-1', action: 'shift_closed' }),
      );
      const newValue = JSON.parse(audit.append.mock.calls[0][0].newValueJson!);
      expect(newValue).toMatchObject({ closingCashMinor: 70_000, expectedCashMinor: 69_500, differenceMinor: 500 });
    });

    it('a cashier CANNOT close another employee\'s shift (D6 own-shift scoping, 403)', async () => {
      repository.findShiftById.mockResolvedValue(shiftRow({ employeeId: 'emp-other' }));
      const error: any = await service
        .closeShift('shift-1', { closingCashMinor: 0 }, actor(EmployeeRole.CASHIER, 'emp-1'))
        .catch((e) => e);
      expect(error).toBeInstanceOf(InsufficientPermissionException);
      expect(repository.closeShiftTransaction).not.toHaveBeenCalled();
    });

    it.each([EmployeeRole.OWNER, EmployeeRole.MANAGER])('%s may close any shift (supervisor override)', async (role) => {
      repository.findShiftById.mockResolvedValue(shiftRow({ employeeId: 'emp-other' }));
      repository.closeShiftTransaction.mockResolvedValue({ outcome: 'closed', shift: closedShift, paymentsCollected: 0 });
      await expect(service.closeShift('shift-1', { closingCashMinor: 70_000 }, actor(role, 'emp-boss'))).resolves.toBeDefined();
    });

    it('a double close conflicts with 409 SHIFT_ALREADY_CLOSED (never recompute silently)', async () => {
      repository.findShiftById.mockResolvedValue(shiftRow());
      repository.closeShiftTransaction.mockResolvedValue({ outcome: 'already_closed', shift: closedShift });
      const error: any = await service.closeShift('shift-1', { closingCashMinor: 1 }, actor(EmployeeRole.CASHIER)).catch((e) => e);
      expect(error).toBeInstanceOf(ShiftAlreadyClosedException);
      expect(error.code).toBe('SHIFT_ALREADY_CLOSED');
      expect(audit.append).not.toHaveBeenCalled();
    });
  });

  describe('getShift', () => {
    it('404s an unknown shift', async () => {
      repository.findShiftById.mockResolvedValue(undefined);
      await expect(service.getShift('ghost', actor(EmployeeRole.CASHIER))).rejects.toThrow(EntityNotFoundException);
    });

    it('the cashier views their own shift; another employee\'s shift is refused (PRD §11 "Own shift only")', async () => {
      repository.findShiftById.mockResolvedValue(shiftRow({ employeeId: 'emp-1' }));
      await expect(service.getShift('shift-1', actor(EmployeeRole.CASHIER, 'emp-1'))).resolves.toMatchObject({
        id: 'shift-1',
      });

      repository.findShiftById.mockResolvedValue(shiftRow({ employeeId: 'emp-other' }));
      await expect(service.getShift('shift-1', actor(EmployeeRole.CASHIER, 'emp-1'))).rejects.toThrow(
        InsufficientPermissionException,
      );
    });

    it.each([EmployeeRole.OWNER, EmployeeRole.MANAGER])('%s views any shift', async (role) => {
      repository.findShiftById.mockResolvedValue(shiftRow({ employeeId: 'emp-other' }));
      await expect(service.getShift('shift-1', actor(role, 'emp-boss'))).resolves.toMatchObject({ id: 'shift-1' });
    });
  });
});
