import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_SETTLEMENT_STANDARD_PRIORITY,
  type InvoiceSettlementAdvertisement,
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
