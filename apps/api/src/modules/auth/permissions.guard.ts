import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { EmployeeRole, PermissionKey } from '@smarttable/shared-types';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { BASELINE_PERMISSIONS } from './baseline-permissions';
import { ActingEmployee } from './decorators/current-employee.decorator';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { rolePermissions } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { InsufficientPermissionException } from '../../common/exceptions/domain.exception';

/**
 * Dual-layer authorization (Security Architecture §2, defense in depth):
 *  1. The hard-coded PRD §11 baseline runs FIRST and can only restrict —
 *     a role not in the baseline is denied regardless of database content.
 *  2. The Owner-editable `role_permissions` table may then restrict FURTHER
 *     (allowed = 0) — it can never grant what the baseline denies.
 * Every denial is audit-logged as `permission_denied`: a repeated pattern of
 * denied attempts from one employee is itself a signal worth the Owner seeing.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_CLIENT) private readonly db: DbClient,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true; // authentication-only route

    const request = context.switchToHttp().getRequest<{ employee?: ActingEmployee }>();
    const employee = request.employee;
    if (!employee) {
      // The JwtAuthGuard runs first and attaches the acting employee; reaching
      // this point without one means the route is misconfigured, not merely
      // unauthorized — fail closed either way.
      throw new InsufficientPermissionException(required);
    }

    const baselineRoles = BASELINE_PERMISSIONS[required];
    let allowed = baselineRoles?.includes(employee.role) ?? false;

    if (allowed) {
      const rows = await this.db
        .select()
        .from(rolePermissions)
        .where(and(eq(rolePermissions.role, employee.role), eq(rolePermissions.permissionKey, required)));
      if (rows[0] && !rows[0].allowed) allowed = false; // DB layer can only restrict further
    }

    if (!allowed) {
      await this.audit.append({
        actorEmployeeId: employee.id,
        entityType: 'employee',
        entityId: employee.id,
        action: 'permission_denied',
        newValueJson: JSON.stringify({ permission: required, role: employee.role as EmployeeRole }),
      });
      throw new InsufficientPermissionException(required);
    }
    return true;
  }
}
