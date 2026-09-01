import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_SETTLEMENT_STANDARD_PRIORITY,
  PAYMENT_CAPABILITY_TIER_PRIORITY,
  type InvoiceSettlementAdvertisement,
  selectPaymentCapability,
  selectSettlementCapability,
} from "./settlement-capability";

describe("settlement capability selection", () => {
  it("keeps one explicit priority list of standards eligible for this flow", () => {
    expect(AUTOMATIC_SETTLEMENT_STANDARD_PRIORITY).toEqual(["lud21"]);
  });

  it("uses LUD-21 whenever the individual invoice advertises verify", () => {
    const callback: InvoiceSettlementAdvertisement & {
      readonly providerDomain: string;
    } = {
      providerDomain: "brand-new-wallet.example",
      verifyUrl: "https://brand-new-wallet.example/verify/invoice-1",
    };

    expect(selectSettlementCapability(callback)).toEqual({
      method: "lud21",
      verifyUrl: callback.verifyUrl,
    });
  });

  it("falls back to manual confirmation when no standard verifier is advertised", () => {
    const callback: InvoiceSettlementAdvertisement & {
      readonly providerDomain: string;
    } = { providerDomain: "any-wallet.example" };

    expect(selectSettlementCapability(callback)).toEqual({ method: "manual" });
  });

  it("does not special-case a provider name when its capabilities change", () => {
    const before: InvoiceSettlementAdvertisement & {
      readonly providerDomain: string;
    } = { providerDomain: "same-wallet.example" };
    const after: InvoiceSettlementAdvertisement & {
      readonly providerDomain: string;
    } = {
      providerDomain: "same-wallet.example",
      verifyUrl: "https://same-wallet.example/verify/invoice-1",
    };

    expect(selectSettlementCapability(before)).toEqual({ method: "manual" });
    expect(selectSettlementCapability(after)).toEqual({
      method: "lud21",
      verifyUrl: after.verifyUrl,
    });
  });
});

describe("payment capability tier selection", () => {
  it("keeps the product sieve in one explicit priority order", () => {
    expect(PAYMENT_CAPABILITY_TIER_PRIORITY).toEqual([
      "automatic-both-memos",
      "automatic-one-memo",
      "automatic",
      "both-memos",
      "one-memo",
      "qr-only",
    ]);
  });

  it.each([
    [true, "full", "full", 1, "automatic-both-memos"],
    [true, "full", "none", 2, "automatic-one-memo"],
    [true, "none", "full", 2, "automatic-one-memo"],
    [true, "none", "none", 3, "automatic"],
    [false, "full", "full", 4, "both-memos"],
    [false, "full", "none", 5, "one-memo"],
    [false, "none", "full", 5, "one-memo"],
    [false, "none", "none", 6, "qr-only"],
  ] as const)(
    "selects the expected tier for automatic=%s payer=%s payee=%s",
    (automaticSettlement, payerMemo, payeeMemo, tier, id) => {
      expect(
        selectPaymentCapability({
          automaticSettlement,
          payerMemo,
          payeeMemo,
        }),
      ).toEqual({ automaticSettlement, payerMemo, payeeMemo, tier, id });
    },
  );

  it("records partial delivery without promoting it to a memo tier", () => {
    expect(
      selectPaymentCapability({
        automaticSettlement: true,
        payerMemo: "partial",
        payeeMemo: "partial",
      }),
    ).toEqual({
      automaticSettlement: true,
      payerMemo: "partial",
      payeeMemo: "partial",
      tier: 3,
      id: "automatic",
    });
  });
});
