import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EmployeeRole, PermissionKey } from '@smarttable/shared-types';
import { PermissionsGuard } from './permissions.guard';
import { InsufficientPermissionException } from '../../common/exceptions/domain.exception';

/**
 * Security Architecture §2 — the dual-layer rule under test:
 *  1. hard-coded PRD §11 baseline always runs first and can only restrict;
 *  2. role_permissions rows may restrict further but can NEVER loosen.
 * RBAC-adjacent logic is explicitly named in Engineering Standards §10 as
 * requiring unit coverage — a silent bug here is a security hole.
 */
describe('PermissionsGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const db = { select: jest.fn() };
  const audit = { append: jest.fn() };
  let guard: PermissionsGuard;

  const contextWith = (employee?: { id: string; name: string; role: EmployeeRole }): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ employee }) }),
    }) as unknown as ExecutionContext;

  const mockDbRows = (rows: { allowed: boolean }[]) => {
    const where = jest.fn().mockResolvedValue(rows);
    const from = jest.fn().mockReturnValue({ where });
    db.select.mockReturnValue({ from });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new PermissionsGuard(reflector as unknown as Reflector, db as never, audit as never);
  });

  it('allows routes with no required permission (authentication-only)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(contextWith())).resolves.toBe(true);
  });

  it('denies when the acting employee context is missing (fail closed)', async () => {
    reflector.getAllAndOverride.mockReturnValue(PermissionKey.STAFF_MANAGE);
    await expect(guard.canActivate(contextWith(undefined))).rejects.toBeInstanceOf(
      InsufficientPermissionException,
    );
  });

  it('allows a baseline-permitted role with no DB override row', async () => {
    reflector.getAllAndOverride.mockReturnValue(PermissionKey.STAFF_MANAGE);
    mockDbRows([]);
    await expect(
      guard.canActivate(contextWith({ id: 'e1', name: 'Karim', role: EmployeeRole.OWNER })),
    ).resolves.toBe(true);
  });

  it('denies a role outside the baseline even if a DB row would allow it (never loosens)', async () => {
    reflector.getAllAndOverride.mockReturnValue(PermissionKey.STAFF_MANAGE);
    mockDbRows([{ allowed: true }]); // misconfigured row tries to grant waiters staff.manage
    await expect(
      guard.canActivate(contextWith({ id: 'e2', name: 'Sofia', role: EmployeeRole.WAITER })),
    ).rejects.toBeInstanceOf(InsufficientPermissionException);
  });

  it('lets the DB layer restrict further than the baseline (allowed = 0)', async () => {
    reflector.getAllAndOverride.mockReturnValue(PermissionKey.STAFF_VIEW_ROSTER);
    mockDbRows([{ allowed: false }]);
    await expect(
      guard.canActivate(contextWith({ id: 'e3', name: 'Amina', role: EmployeeRole.MANAGER })),
    ).rejects.toBeInstanceOf(InsufficientPermissionException);
  });

  it('audit-logs every denial as permission_denied (Security §2)', async () => {
    reflector.getAllAndOverride.mockReturnValue(PermissionKey.STAFF_MANAGE);
    mockDbRows([]);
    await expect(
      guard.canActivate(contextWith({ id: 'e4', name: 'Yacine', role: EmployeeRole.CASHIER })),
    ).rejects.toBeInstanceOf(InsufficientPermissionException);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmployeeId: 'e4', action: 'permission_denied' }),
    );
  });
});
