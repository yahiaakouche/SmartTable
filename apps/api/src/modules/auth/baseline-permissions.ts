import { EmployeeRole, PermissionKey } from '@smarttable/shared-types';

/**
 * The hard-coded, authoritative permission baseline — PRD §11's Roles &
 * Permissions matrix, encoded in Guards as mandated by Security Architecture §2.
 *
 * This layer ALWAYS runs first and can only ever RESTRICT further than the
 * DB-configurable `role_permissions` table allows — never loosen. A
 * misconfigured database row can therefore never grant more access than this
 * code-level baseline permits.
 *
 * Only permissions consumed by implemented modules appear here; each future
 * module (orders, menu, billing, ...) adds its rows as it comes online.
 */
export const BASELINE_PERMISSIONS: Readonly<Record<PermissionKey, readonly EmployeeRole[]>> = {
  [PermissionKey.STAFF_MANAGE]: [EmployeeRole.OWNER],
  [PermissionKey.STAFF_VIEW_ROSTER]: [EmployeeRole.OWNER, EmployeeRole.MANAGER],
};
