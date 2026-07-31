import { computeOrderTotals, roundHalfUpDiv, sumTotals } from './billing-math';

/**
 * Money-math unit tests — Engineering Standards §10 non-negotiable: "Any code
 * touching money (Section 6, FR36) or the order lifecycle state machine must
 * have unit test coverage before it is considered done." These functions are
 * where a silent rounding bug would directly cost the restaurant real money.
 *
 * Ruling B3: tax-exclusive prices; tax = round-half-up(subtotal × bps / 10000)
 * computed PER ORDER in exact integer math; subtotal + tax = total.
 */
describe('billing-math', () => {
  describe('roundHalfUpDiv', () => {
    it.each([
      [0, 10_000, 0],
      [14, 10, 1], // 1.4 → 1
      [15, 10, 2], // 1.5 → 2 (half rounds UP)
      [25, 10, 3], // 2.5 → 3
      [24_999, 10_000, 2], // 2.4999 → 2
      [25_000, 10_000, 3], // exactly 2.5 → 3
      [47_500_000, 10_000, 4_750], // 25_000 minor × 1900 bps, exact
      [237_500, 10_000, 24], // 125 minor × 1900 bps = 23.75 → 24
    ])('roundHalfUpDiv(%i, %i) = %i', (numerator, denominator, expected) => {
      expect(roundHalfUpDiv(numerator, denominator)).toBe(expected);
    });

    it('never produces a floating-point artifact for large minor-unit values', () => {
      // 999_999_999 minor (≈10M DZD) at 19% = 189_999_999.81 → 190_000_000,
      // computed exactly (the numerator is well within 2^53).
      const result = roundHalfUpDiv(999_999_999 * 1900, 10_000);
      expect(result).toBe(190_000_000);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe('computeOrderTotals', () => {
    it('sums snapshot price × quantity over items (FR40 snapshots, not live prices)', () => {
      const totals = computeOrderTotals(
        [
          { unitPriceMinorSnapshot: 25_000, quantity: 2 },
          { unitPriceMinorSnapshot: 15_000, quantity: 1 },
        ],
        0,
      );
      expect(totals).toEqual({ subtotalMinor: 65_000, taxMinor: 0, totalMinor: 65_000 });
    });

    it('computes tax in integer basis points (1900 = 19%) with subtotal + tax = total', () => {
      const totals = computeOrderTotals([{ unitPriceMinorSnapshot: 25_000, quantity: 2 }], 1900);
      expect(totals.subtotalMinor).toBe(50_000);
      expect(totals.taxMinor).toBe(9_500); // 50_000 × 0.19, exact
      expect(totals.totalMinor).toBe(59_500);
    });

    it('rounds tax half-up on fractional minor units', () => {
      // 125 minor at 19% = 23.75 → 24.
      expect(computeOrderTotals([{ unitPriceMinorSnapshot: 125, quantity: 1 }], 1900).taxMinor).toBe(24);
      // 250 minor at 1% = 2.5 → 3.
      expect(computeOrderTotals([{ unitPriceMinorSnapshot: 250, quantity: 1 }], 100).taxMinor).toBe(3);
    });

    it('a 0% rate (the frozen PRD default) always yields zero tax', () => {
      const totals = computeOrderTotals([{ unitPriceMinorSnapshot: 12_345, quantity: 7 }], 0);
      expect(totals.taxMinor).toBe(0);
      expect(totals.totalMinor).toBe(totals.subtotalMinor);
    });

    it('an empty order totals to zero', () => {
      expect(computeOrderTotals([], 1900)).toEqual({ subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
    });
  });

  describe('sumTotals (bill-level aggregation)', () => {
    it('Σ per-order totals == bill total (the B3/D4 reconciliation invariant)', () => {
      // Two orders whose INDIVIDUAL rounding may differ from bill-level
      // rounding: the bill sums per-order values, so rollup revenue per order
      // always reconciles exactly with the payment amount.
      const orderA = computeOrderTotals([{ unitPriceMinorSnapshot: 125, quantity: 1 }], 1900); // tax 24
      const orderB = computeOrderTotals([{ unitPriceMinorSnapshot: 125, quantity: 1 }], 1900); // tax 24
      const bill = sumTotals([orderA, orderB]);
      expect(bill).toEqual({ subtotalMinor: 250, taxMinor: 48, totalMinor: 298 });
      expect(bill.totalMinor).toBe(orderA.totalMinor + orderB.totalMinor);
    });

    it('the empty bill totals to zero', () => {
      expect(sumTotals([])).toEqual({ subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
    });
  });
});
