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

  // Step 3.3 — orders slice. Every row below is a Step 3.3 FINAL ruling or a
  // frozen FR; see permissions.ts for the per-key citations.
  [PermissionKey.ORDERS_VIEW]: [
    EmployeeRole.OWNER,
    EmployeeRole.MANAGER,
    EmployeeRole.CASHIER,
    EmployeeRole.WAITER,
    EmployeeRole.KITCHEN,
  ],
  // Q6 — staff order entry: Owner, Manager, Waiter.
  [PermissionKey.ORDERS_CREATE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],
  // Q2 — acceptance: Owner, Manager, Kitchen. Waiter deliberately excluded
  // (narrows the PRD §11 matrix; the ruling is authoritative).
  [PermissionKey.ORDERS_ACCEPT]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.KITCHEN],
  // Q5 — preparation advance: Owner, Manager, Kitchen.
  [PermissionKey.ORDERS_ADVANCE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.KITCHEN],
  // FR7 — Served: Owner, Manager, Waiter.
  [PermissionKey.ORDERS_SERVE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],
  // Q3 — cancellation baseline: Owner, Manager, Waiter; the waiter's
  // pending-only refinement lives in the service-layer state machine.
  [PermissionKey.ORDERS_CANCEL]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.WAITER],

  // Step 3.4 — billing slice. Every row below is the D10 ruling: Owner,
  // Manager, Cashier (Cashier is the financial operator — PRD §6 Cashier
  // Journey, FR8; Waiter/Kitchen have no financial surface per PRD §11).
  [PermissionKey.BILLING_VIEW]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER],
  [PermissionKey.PAYMENTS_PROCESS]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER],
  [PermissionKey.SHIFTS_MANAGE]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER],
  // PRD §11 "Own shift only" for the Cashier is a service-layer scoping
  // refinement (D6), not expressible in this static row.
  [PermissionKey.SHIFTS_VIEW]: [EmployeeRole.OWNER, EmployeeRole.MANAGER, EmployeeRole.CASHIER],

  // Step 3.7 — analytics slice. Ruling B1: Owner + Manager only (the BI
  // Dashboard is the Owner surface, PRD §7 item 29; the Cashier's own-shift
  // visibility already shipped via SHIFTS_VIEW in 3.4).
  [PermissionKey.ANALYTICS_VIEW]: [EmployeeRole.OWNER, EmployeeRole.MANAGER],
};
