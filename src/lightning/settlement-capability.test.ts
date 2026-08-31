import { describe, expect, it } from "vitest";

import { selectSettlementCapability } from "./settlement";

interface ProviderCallback {
  readonly providerDomain: string;
  readonly verifyUrl?: string;
}

describe("settlement capability selection", () => {
  it("uses LUD-21 whenever the individual invoice advertises verify", () => {
    const callback: ProviderCallback = {
      providerDomain: "brand-new-wallet.example",
      verifyUrl: "https://brand-new-wallet.example/verify/invoice-1",
    };

    expect(selectSettlementCapability(callback)).toEqual({
      method: "lud21",
      verifyUrl: callback.verifyUrl,
    });
  });

  it("falls back to manual confirmation when no standard verifier is advertised", () => {
    const callback: ProviderCallback = {
      providerDomain: "walletofsatoshi.com",
    };

    expect(selectSettlementCapability(callback)).toEqual({ method: "manual" });
  });

  it("does not special-case a provider name when its capabilities change", () => {
    const before: ProviderCallback = {
      providerDomain: "walletofsatoshi.com",
    };
    const after: ProviderCallback = {
      providerDomain: "walletofsatoshi.com",
      verifyUrl: "https://walletofsatoshi.com/verify/invoice-1",
    };

    expect(selectSettlementCapability(before)).toEqual({ method: "manual" });
    expect(selectSettlementCapability(after)).toEqual({
      method: "lud21",
      verifyUrl: after.verifyUrl,
    });
  });
});
