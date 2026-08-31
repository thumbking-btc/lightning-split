import { describe, expect, it } from "vitest";

import {
  createUsdSplitPlan,
  splitUsdCents,
  sumAmounts,
  usdCentsToSats,
} from "./money";

describe("USD cent distribution", () => {
  it("makes the payer absorb the indivisible cent remainder", () => {
    const split = splitUsdCents(10_001n, 4);

    expect(split.invoiceShares).toEqual([2_500n, 2_500n, 2_500n]);
    expect(split.payerShareUsdCents).toBe(2_501n);
    expect(sumAmounts(split.invoiceShares) + split.payerShareUsdCents).toBe(
      10_001n,
    );
  });

  it("preserves every cent when the payer is included", () => {
    const plan = createUsdSplitPlan(10_001n, 4, false, 10_000_000n);

    expect(plan.invoiceShares).toEqual([2_501n, 2_500n, 2_500n, 2_500n]);
    expect(plan.payerShareUsdCents).toBeNull();
    expect(sumAmounts(plan.invoiceShares)).toBe(10_001n);
  });

  it("converts cents to sats using integer half-up rounding", () => {
    expect(usdCentsToSats(100n, 10_000_000n)).toBe(1_000n);
    expect(usdCentsToSats(1n, 10_000_000n)).toBe(10n);
    expect(usdCentsToSats(5n, 30_000_000n)).toBe(17n);
  });

  it("creates USD targets from the frozen BTC/USD cents price", () => {
    const plan = createUsdSplitPlan(10_000n, 4, true, 10_000_000n);

    expect(plan.invoiceShares).toEqual([2_500n, 2_500n, 2_500n]);
    expect(plan.targetSats).toEqual([25_000n, 25_000n, 25_000n]);
    expect(plan.payerShareUsdCents).toBe(2_500n);
  });
});
