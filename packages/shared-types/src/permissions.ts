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

  /** View orders (KDS board, table map, order detail) — all roles; the
   * Kitchen view is price-stripped per FR6/Q7, enforced service-side. */
  ORDERS_VIEW = 'orders.view',
  /** Create orders (staff manual entry and add-on orders) — Q6 ruling:
   * Owner, Manager, Waiter. */
  ORDERS_CREATE = 'orders.create',
  /** Accept pending orders — Q2 ruling: Owner, Manager, Kitchen.
   * (This deliberately narrows the PRD §11 matrix, which also listed
   * Waiter; the Step 3.3 ruling is authoritative.) */
  ORDERS_ACCEPT = 'orders.accept',
  /** Advance preparation status (accepted→preparing→ready) — Q5 ruling:
   * Owner, Manager, Kitchen. */
  ORDERS_ADVANCE = 'orders.advance',
  /** Mark an order served — FR7: Owner, Manager, Waiter only. */
  ORDERS_SERVE = 'orders.serve',
  /** Cancel an order (reason mandatory, FR10) — Q3 ruling: Owner and
   * Manager unrestricted; Waiter only while the order is still Pending
   * (the pending-only refinement is enforced in the service-layer state
   * machine, not expressible in a static baseline row). */
  ORDERS_CANCEL = 'orders.cancel',

  /** View the consolidated table bill (GET /billing/table-bill-groups/:id) —
   * D10 ruling: Owner, Manager, Cashier (the cashier's core screen, PRD §6;
   * Waiter/Kitchen have no financial view per PRD §11). */
  BILLING_VIEW = 'billing.view',
  /** Record a cash payment (POST /payments) — FR8: Paid/Completed are set
   * exclusively by Cashier, Manager, or Owner. */
  PAYMENTS_PROCESS = 'payments.process',
  /** Open/close a shift — MVP Scope Freeze: "Shift open/close tracking
   * (Cashier-level)"; D10: Owner, Manager, Cashier. The own-shift scoping
   * (a cashier touches only their own shift — D6) is service-layer. */
  SHIFTS_MANAGE = 'shifts.manage',
  /** View a shift — PRD §11: Cashier sees "Own shift only" (scoping enforced
   * in the service); Owner/Manager unrestricted. */
  SHIFTS_VIEW = 'shifts.view',
}
