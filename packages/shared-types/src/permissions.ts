/**
 * Permission keys — the vocabulary of the RBAC system (PRD §11, Security
 * Architecture §2). Keys live in shared-types because both the API (Guards)
 * and the frontend (hiding actions the role can't perform) must agree on
 * them; enforcement itself is always backend-side (NFR8).
 *
 * Only keys consumed by implemented modules are defined here — new keys are
 * added as the module that needs them comes online (orders, billing, ...),
 * keeping this list a faithful map of what exists, never speculation.
 */
export enum PermissionKey {
  /** Manage staff accounts and their role assignments — PRD §11: Owner only. */
  STAFF_MANAGE = 'staff.manage',
  /** View the employee roster (view-only) — PRD §11: Owner, Manager. */
  STAFF_VIEW_ROSTER = 'staff.view_roster',

  /** View the staff menu (categories/products, read-only) — all roles;
   * waiters need it for manual order entry (PRD §6 Waiter Journey). */
  MENU_VIEW = 'menu.view',
  /** Manage menu categories and products — FR19, PRD §11: Owner, Manager. */
  MENU_MANAGE = 'menu.manage',

  /** View halls and the table map — PRD §11: Owner, Manager, Cashier, Waiter
   * (Kitchen explicitly excluded by the matrix). */
  TABLES_VIEW = 'tables.view',
  /** Manage halls and tables (create, edit, remove, QR regeneration) —
   * PRD §11 as ruled for Step 3.2 (R2): Owner, Manager. */
  TABLES_MANAGE = 'tables.manage',
  /** Mark a cleaned table available again — the waiter's loop-closing action
   * (API Contract §3): Owner, Manager, Waiter. */
  TABLES_MARK_CLEANED = 'tables.mark_cleaned',
}
