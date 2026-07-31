/**
 * Permission keys — the vocabulary of the RBAC system (PRD §11, Security
 * Architecture §2). Keys live in shared-types because both the API (Guards)
 * and the frontend (hiding actions the role can't perform) must agree on
 * them; enforcement itself is always backend-side (NFR8).
 *
 * Only keys consumed by implemented modules are defined here — new keys are
 * added as the module that needs them comes online (orders, menu, ...),
 * keeping this list a faithful map of what exists, never speculation.
 */
export enum PermissionKey {
  /** Manage staff accounts and their role assignments — PRD §11: Owner only. */
  STAFF_MANAGE = 'staff.manage',
  /** View the employee roster (view-only) — PRD §11: Owner, Manager. */
  STAFF_VIEW_ROSTER = 'staff.view_roster',
}
