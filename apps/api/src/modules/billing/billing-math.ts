/**
 * Billing money math — pure functions, no I/O (Engineering Standards §10:
 * "Any code touching money … must have unit test coverage"). All arithmetic
 * is exact integer math on minor units (FR36 — no float ever enters here).
 *
 * Ruling B3: menu prices are TAX-EXCLUSIVE; tax is computed at bill time from
 * the restaurant's integer basis-point rate (1900 = 19.00%), and
 * `subtotal + tax = total`.
 */

export interface BillLineItem {
  unitPriceMinorSnapshot: number;
  quantity: number;
}

export interface MoneyTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** Exact integer round-half-up division for non-negative integers:
 * round(numerator / denominator) with .5 rounding UP — the conventional
 * commercial rounding for tax. `floor((2n + d) / 2d)` is exact for any
 * denominator > 0 and never touches floating point. */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** Per-order totals: subtotal from immutable item snapshots (FR40 — never
 * re-read from the live menu), tax as round-half-up(subtotal × bps / 10000).
 *
 * Tax is computed PER ORDER and the bill sums the per-order values (ruling
 * B3 + D4): this is what makes per-order post-tax rollup revenue reconcile
 * EXACTLY with the payment amount — Σ per-order totals = bill total, with no
 * rounding-allocation drift across orders. */
export function computeOrderTotals(items: BillLineItem[], taxBasisPoints: number): MoneyTotals {
  const subtotalMinor = items.reduce((sum, item) => sum + item.unitPriceMinorSnapshot * item.quantity, 0);
  const taxMinor = roundHalfUpDiv(subtotalMinor * taxBasisPoints, 10_000);
  return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

/** Sum per-order totals into bill-level totals (B3: subtotal + tax = total
 * holds at every level by construction). */
export function sumTotals(list: MoneyTotals[]): MoneyTotals {
  return list.reduce<MoneyTotals>(
    (acc, totals) => ({
      subtotalMinor: acc.subtotalMinor + totals.subtotalMinor,
      taxMinor: acc.taxMinor + totals.taxMinor,
      totalMinor: acc.totalMinor + totals.totalMinor,
    }),
    { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 },
  );
}
