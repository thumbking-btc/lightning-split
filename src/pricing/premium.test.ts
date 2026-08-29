import { describe, expect, it } from "vitest";

import {
  KimchiPremiumService,
  type PremiumReference,
  type PremiumReferenceCache,
  UpbitInternationalPremiumAdapter,
} from "./premium";

describe("kimchi premium information", () => {
  it("calculates informational basis points with integer arithmetic", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const adapter = new UpbitInternationalPremiumAdapter(
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
            : Response.json({
                code: "0",
                data: [
                  {
                    instType: "SPOT",
                    instId: "BTC-USDT",
                    last: "100000.00000000",
                    ts: String(now),
                  },
                ],
              }),
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
    const adapter = new UpbitInternationalPremiumAdapter(
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
            : Response.json({
                code: "0",
                data: [
                  {
                    instType: "SPOT",
                    instId: "BTC-USDT",
                    last: "100000",
                    ts: String(now),
                  },
                ],
              }),
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

  it("uses the single KuCoin fallback when the OKX ticker is unavailable", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const requested: string[] = [];
    const adapter = new UpbitInternationalPremiumAdapter(
      (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("upbit")) {
          return Promise.resolve(
            Response.json([
              {
                market: "KRW-USDT",
                trade_price: 1_400,
                trade_timestamp: now,
              },
            ]),
          );
        }
        if (url.includes("okx")) {
          return Promise.resolve(Response.json({}, { status: 451 }));
        }
        return Promise.resolve(
          Response.json({
            code: "200000",
            data: {
              time: now,
              price: "100000.00000000",
            },
          }),
        );
      },
      undefined,
      () => now,
    );

    const reference = await adapter.fetchReference();

    expect(reference.internationalPriceKrw).toBe("140000000");
    expect(requested.some((url) => url.includes("okx"))).toBe(true);
    expect(requested.some((url) => url.includes("kucoin"))).toBe(true);
  });

  it("rejects an international ticker whose timestamp is stale", async () => {
    const now = Date.parse("2030-01-01T00:02:00.000Z");
    const stale = now - 61_000;
    const adapter = new UpbitInternationalPremiumAdapter(
      (input) => {
        const url = String(input);
        if (url.includes("upbit")) {
          return Promise.resolve(
            Response.json([
              {
                market: "KRW-USDT",
                trade_price: 1_400,
                trade_timestamp: now,
              },
            ]),
          );
        }
        if (url.includes("okx")) {
          return Promise.resolve(
            Response.json({
              code: "0",
              data: [
                {
                  instType: "SPOT",
                  instId: "BTC-USDT",
                  last: "100000",
                  ts: String(stale),
                },
              ],
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            code: "200000",
            data: { time: stale, price: "100000" },
          }),
        );
      },
      undefined,
      () => now,
    );

    await expect(adapter.fetchReference()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });
});
