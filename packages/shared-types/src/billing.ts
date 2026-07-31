/**
 * Billing contract types — API Contract Design §3 (`billing` section:
 * payments + shifts), Step 3.4.
 *
 * Money is integer minor units on the wire, always (FR36); tax is computed at
 * bill time in integer basis points (ruling B3: menu prices are tax-exclusive,
 * `subtotal + tax = total`). The consolidated bill is the Table Bill Group's
 * financial view (FR9): the main order and every add-on as ONE bill.
 */
import { PaymentMethod, ShiftStatus, TableBillGroupStatus } from './enums';
import { OrderDto } from './orders';

export interface TableBillGroupDto {
  id: string;
  tableId: string;
  status: TableBillGroupStatus;
  openedAt: number;
  closedAt: number | null;
}

export interface PaymentDto {
  id: string;
  tableBillGroupId: string;
  amountMinor: number;
  method: PaymentMethod;
  collectedByEmployeeId: string;
  /** NULL when the collector had no open shift at collection time (ruling D7 —
   * a payment never requires an open shift; the link is best-effort). */
  shiftId: string | null;
  createdAt: number;
}

/** GET /billing/table-bill-groups/:id — the consolidated bill (ruling D9).
 * `orders` lists every NON-cancelled order of the group, chronological;
 * totals aggregate only BILLABLE orders (served/paid/completed — ruling D1),
 * so a cancelled order never distorts the bill and an in-flight order is
 * visible but not yet charged. */
export interface ConsolidatedBillDto {
  group: TableBillGroupDto;
  orders: OrderDto[];
  /** Σ per-order subtotals of billable orders (snapshot prices × quantities). */
  subtotalMinor: number;
  /** Σ per-order tax — tax is computed PER ORDER with round-half-up integer
   * math and summed (ruling B3 + D4 reconciliation: per-order post-tax revenue
   * sums EXACTLY to the payment amount; no allocation drift). */
  taxMinor: number;
  /** subtotalMinor + taxMinor (B3: subtotal + tax = total). */
  totalMinor: number;
  /** restaurant_profile.tax_rate_percent — integer basis points (1900 = 19%). */
  taxRateBasisPoints: number;
  /** The group's single payment (ruling D2), once recorded; null before. */
  payment: PaymentDto | null;
}

/** POST /payments — body references the Table Bill Group (Contract §3). The
 * amount is server-computed from the bill (D2) — the client never sends it.
 * Requires the `Idempotency-Key` header (Contract §1). */
export interface RecordPaymentRequest {
  tableBillGroupId: string;
}

/** POST /payments response: the recorded payment plus the post-payment bill
 * (group now closed, orders completed) — everything a receipt view needs. */
export interface PaymentRecordedDto {
  payment: PaymentDto;
  bill: ConsolidatedBillDto;
}

export interface ShiftDto {
  id: string;
  employeeId: string;
  openingCashMinor: number;
  closingCashMinor: number | null;
  /** opening + Σ cash payments linked to this shift — computed at close. */
  expectedCashMinor: number | null;
  status: ShiftStatus;
  openedAt: number;
  closedAt: number | null;
}

/** POST /shifts/open — the shift belongs to the ACTING employee; the employee
 * identity is never taken from the request body. */
export interface OpenShiftRequest {
  openingCashMinor: number;
}

/** POST /shifts/:id/close (Contract §3: "Returns expected-vs-counted
 * reconciliation"). */
export interface CloseShiftRequest {
  closingCashMinor: number;
}

/** Close response — the frozen reconciliation (D6): what the drawer should
 * hold vs what was counted, and the signed difference (positive = over). */
export interface ShiftReconciliationDto {
  shift: ShiftDto;
  /** Number of cash payments linked to this shift. */
  paymentsCollected: number;
  /** closingCashMinor − expectedCashMinor (signed; 0 = perfect drawer). */
  differenceMinor: number;
}
