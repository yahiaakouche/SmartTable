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

  // Step 3.2 — menu & tables slice.
  // Menu mutations: FR19 / PRD §11 matrix — Owner + Manager.
  [PermissionKey.MENU_MANAGE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER],
  // Menu reading: all roles (waiters need it for manual order entry).
  [PermissionKey.MENU_VIEW]: [
    EmployeeRole.OWNER,
    EmployeeRole.MANAGER,
    EmployeeRole.CASHIER,
    EmployeeRole.WAITER,
    EmployeeRole.KITCHEN,
  ],
  // Table map viewing: PRD §11 matrix — Kitchen explicitly excluded.
  [PermissionKey.TABLES_VIEW]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER, EmployeeRole.WAITER],
  // Table/hall management (incl. QR regeneration): Step 3.2 ruling R2 — Owner + Manager.
  [PermissionKey.TABLES_MANAGE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER],
  // The waiter's loop-closing action (API Contract §3) — Owner/Manager may
  // perform any waiter floor action, consistent with the matrix's other rows.
  [PermissionKey.TABLES_MARK_CLEANED]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],
};
