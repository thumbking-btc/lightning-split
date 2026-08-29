import { describe, expect, it } from "vitest";

import { BinanceUpbitPremiumAdapter, KimchiPremiumService } from "./premium";

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
});
