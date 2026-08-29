import { describe, expect, it } from "vitest";

import {
  MoneyValidationError,
  bigintFromSafeInteger,
  createKrwSplitPlan,
  createSatsSplitPlan,
  krwToSats,
  splitKrw,
  splitSats,
  sumAmounts,
} from "./money";

describe("KRW distribution with the payer excluded", () => {
  it("makes the payer absorb the remainder for 86,003 won across four people", () => {
    const split = splitKrw(86_003n, 4);
    const plan = createKrwSplitPlan(86_003n, 4, true, 100_000_000n);

    expect(split.invoiceShares).toEqual([21_500n, 21_500n, 21_500n]);
    expect(split.payerShareKrw).toBe(21_503n);
    expect(plan.invoiceShares).toEqual(split.invoiceShares);
    expect(plan.payerShareKrw).toBe(split.payerShareKrw);
    expect(plan.invoiceCount).toBe(3);
    expect(plan.targetSats).toEqual([21_500n, 21_500n, 21_500n]);
    if (plan.payerShareKrw === null) {
      throw new Error("The payer share must exist when the payer is excluded.");
    }
    expect(sumAmounts(plan.invoiceShares) + plan.payerShareKrw).toBe(86_003n);
  });

  it("makes the payer absorb a remainder of one", () => {
    const split = splitKrw(86_001n, 4);

    expect(86_001n % 4n).toBe(1n);
    expect(split.invoiceShares).toEqual([21_500n, 21_500n, 21_500n]);
    expect(split.payerShareKrw).toBe(21_501n);
  });

  it("makes the payer absorb a people-minus-one remainder", () => {
    const split = splitKrw(86_003n, 4);

    expect(86_003n % 4n).toBe(3n);
    expect(split.invoiceShares).toEqual([21_500n, 21_500n, 21_500n]);
    expect(split.payerShareKrw).toBe(21_503n);
  });

  it("gives everyone the same share when KRW divides exactly", () => {
    const split = splitKrw(86_000n, 4);

    expect(split.invoiceShares).toEqual([21_500n, 21_500n, 21_500n]);
    expect(split.payerShareKrw).toBe(21_500n);
  });

  it("supports two people", () => {
    const split = splitKrw(101n, 2);

    expect(split.invoiceShares).toEqual([50n]);
    expect(split.payerShareKrw).toBe(51n);
  });

  it("supports ten people", () => {
    const split = splitKrw(109n, 10);

    expect(split.invoiceShares).toEqual(Array.from({ length: 9 }, () => 10n));
    expect(split.payerShareKrw).toBe(19n);
  });

  it("preserves the group total and keeps every sender invoice equal", () => {
    for (let people = 2; people <= 10; people += 1) {
      for (let total = BigInt(people); total <= 500n; total += 1n) {
        const split = splitKrw(total, people);

        expect(sumAmounts(split.invoiceShares) + split.payerShareKrw).toBe(
          total,
        );
        expect(split.invoiceShares).toHaveLength(people - 1);
        expect(new Set(split.invoiceShares).size).toBe(1);
      }
    }
  });
});

describe("KRW distribution without an excluded payer", () => {
  it("preserves the total across all invoice slots", () => {
    const plan = createKrwSplitPlan(86_003n, 4, false, 100_000_000n);

    expect(plan.invoiceShares).toEqual([21_501n, 21_501n, 21_501n, 21_500n]);
    expect(plan.payerShareKrw).toBeNull();
    expect(plan.invoiceCount).toBe(4);
    expect(sumAmounts(plan.invoiceShares)).toBe(86_003n);
  });
});

describe("sats direct-input distribution", () => {
  it("splits 50,003 sats across five invoices", () => {
    expect(splitSats(50_003n, 5)).toEqual([
      10_001n,
      10_001n,
      10_001n,
      10_000n,
      10_000n,
    ]);
  });

  it("splits a divisible amount", () => {
    expect(splitSats(12n, 3)).toEqual([4n, 4n, 4n]);
  });

  it("distributes a one sat remainder to the first invoice", () => {
    expect(splitSats(10n, 3)).toEqual([4n, 3n, 3n]);
  });

  it("preserves the entered total across payer-excluded invoice targets", () => {
    const plan = createSatsSplitPlan(50_003n, 5, true);

    expect(plan.invoiceCount).toBe(4);
    expect(plan.invoiceShares).toEqual([12_501n, 12_501n, 12_501n, 12_500n]);
    expect(sumAmounts(plan.invoiceShares)).toBe(50_003n);
    expect(plan.totalSats).toBe(50_003n);
  });

  it("uses all people as invoice targets when the payer is not excluded", () => {
    const plan = createSatsSplitPlan(50_003n, 5, false);

    expect(plan.invoiceCount).toBe(5);
    expect(plan.invoiceShares).toEqual([
      10_001n,
      10_001n,
      10_001n,
      10_000n,
      10_000n,
    ]);
    expect(sumAmounts(plan.invoiceShares)).toBe(50_003n);
  });

  it("supports one invoice when two people exclude the payer", () => {
    const plan = createSatsSplitPlan(1n, 2, true);

    expect(plan.invoiceCount).toBe(1);
    expect(plan.invoiceShares).toEqual([1n]);
  });

  it("preserves the total across representative invoice counts", () => {
    for (let invoiceCount = 1; invoiceCount <= 10; invoiceCount += 1) {
      for (let total = BigInt(invoiceCount); total <= 500n; total += 1n) {
        expect(sumAmounts(splitSats(total, invoiceCount))).toBe(total);
      }
    }
  });
});

describe("KRW to sats conversion", () => {
  it("converts an exactly divisible amount", () => {
    expect(krwToSats(1_000n, 100_000_000n)).toBe(1_000n);
  });

  it("rounds an exact 0.5 sat upward", () => {
    expect(krwToSats(1n, 200_000_000n)).toBe(1n);
  });

  it("rounds below 0.5 sat downward", () => {
    expect(krwToSats(1n, 200_000_001n)).toBe(0n);
  });

  it("rounds above 0.5 sat upward", () => {
    expect(krwToSats(1n, 199_999_999n)).toBe(1n);
  });

  it("rounds simultaneous 0.5 sat sender boundaries independently", () => {
    const price = 200_000_000n;
    const plan = createKrwSplitPlan(12n, 4, true, price);
    const individualTotal = sumAmounts(plan.targetSats);
    const aggregateTotal = krwToSats(sumAmounts(plan.invoiceShares), price);

    expect(plan.invoiceShares).toEqual([3n, 3n, 3n]);
    expect(plan.targetSats).toEqual([2n, 2n, 2n]);
    expect(individualTotal).toBe(6n);
    expect(aggregateTotal).toBe(5n);
    expect(individualTotal - aggregateTotal).toBe(1n);
  });

  it("keeps arithmetic exact at the maximum safe input", () => {
    const maximumSafeInput = BigInt(Number.MAX_SAFE_INTEGER);

    expect(krwToSats(maximumSafeInput, 100_000_000n)).toBe(maximumSafeInput);
  });

  it.each([0n, -1n])("rejects an invalid BTC/KRW price: %s", (price) => {
    expect(() => krwToSats(1_000n, price)).toThrowError(MoneyValidationError);
  });
});

describe("input validation", () => {
  it.each([1, 11])("rejects %i people", (people) => {
    expect(() => splitKrw(1_000n, people)).toThrowError(MoneyValidationError);
    expect(() => createSatsSplitPlan(1_000n, people, true)).toThrowError(
      MoneyValidationError,
    );
  });

  it.each([0n, -1n])("rejects invalid KRW totals: %s", (total) => {
    expect(() => splitKrw(total, 2)).toThrowError(MoneyValidationError);
  });

  it.each([0n, -1n])("rejects invalid sats totals: %s", (total) => {
    expect(() => splitSats(total, 2)).toThrowError(MoneyValidationError);
  });

  it("rejects KRW totals whose sender invoice shares would be zero", () => {
    expect(() => splitKrw(1n, 2)).toThrowError(
      expect.objectContaining({ code: "ZERO_INVOICE_TARGET" }),
    );
  });

  it("rejects sats totals that cannot provide one sat per invoice", () => {
    expect(() => splitSats(1n, 2)).toThrowError(
      expect.objectContaining({ code: "ZERO_INVOICE_TARGET" }),
    );
  });

  it("rejects KRW sender shares that convert to zero sats", () => {
    expect(() => createKrwSplitPlan(4n, 4, true, 300_000_000n)).toThrowError(
      expect.objectContaining({ code: "ZERO_INVOICE_TARGET" }),
    );
  });

  it("calculates the sats invoice count for both payer modes", () => {
    expect(createSatsSplitPlan(100n, 4, true).invoiceCount).toBe(3);
    expect(createSatsSplitPlan(100n, 4, false).invoiceCount).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-integer Number input: %s",
    (value) => {
      expect(() => bigintFromSafeInteger(value)).toThrowError(
        MoneyValidationError,
      );
    },
  );

  it("rejects Number input that has crossed the safe integer boundary", () => {
    expect(() =>
      bigintFromSafeInteger(Number.MAX_SAFE_INTEGER + 1),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_AMOUNT" }));
  });

  it("rejects BigInt input beyond the approved safe input boundary", () => {
    expect(() =>
      splitSats(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_AMOUNT" }));
  });
});
