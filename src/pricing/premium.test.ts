import { describe, expect, it } from "vitest";

import {
  BinanceUpbitPremiumAdapter,
  KimchiPremiumService,
  type PremiumReference,
  type PremiumReferenceCache,
} from "./premium";

describe("kimchi premium information", () => {
  it("calculates informational basis points with integer arithmetic", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const adapter = new BinanceUpbitPremiumAdapter(
      (input) => {
        const url = String(input);
        return Promise.resolve(
          url.includes("upbit")
            ? Response.json([
                {
                  market: "KRW-USDT",
                  trade_price: 1_400,
                  trade_timestamp: now,
                },
              ])
            : Response.json({ symbol: "BTCUSDT", price: "100000.00000000" }),
        );
      },
      undefined,
      () => now,
    );
    const information = await new KimchiPremiumService(
      adapter,
      undefined,
      undefined,
      () => now,
    ).getInformation(142_800_000n);
    expect(information.referencePriceKrw).toBe(140_000_000n);
    expect(information.basisPoints).toBe(200n);
  });

  it("reuses the premium reference for 60 seconds independently of the price cache", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    let fetchCount = 0;
    let stored: PremiumReference | null = null;
    const cache: PremiumReferenceCache = {
      get: () => Promise.resolve(stored),
      put: (reference) => {
        stored = reference;
        return Promise.resolve();
      },
    };
    const adapter = new BinanceUpbitPremiumAdapter(
      (input) => {
        fetchCount += 1;
        return Promise.resolve(
          String(input).includes("upbit")
            ? Response.json([
                {
                  market: "KRW-USDT",
                  trade_price: 1_400,
                  trade_timestamp: now,
                },
              ])
            : Response.json({ symbol: "BTCUSDT", price: "100000" }),
        );
      },
      undefined,
      () => now,
    );
    const service = new KimchiPremiumService(
      adapter,
      cache,
      undefined,
      () => now,
    );
    await service.getInformation(140_000_000n);
    now += 59_000;
    await service.getInformation(140_000_000n);
    expect(fetchCount).toBe(2);
    now += 2_000;
    await service.getInformation(140_000_000n);
    expect(fetchCount).toBe(4);
  });
});
