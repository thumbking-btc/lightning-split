import { describe, expect, it } from "vitest";

import {
  calculateCoinbasePremiumBasisPoints,
  createCoinbaseHeartbeatSubscription,
  createCoinbaseTickerSubscription,
  getUsdMarketReconnectDelay,
  getUsdMarketRestRefreshInterval,
  parseBinanceTradeMessage,
  parseCoinbaseTickerMessage,
  withLiveUsdMarketPrice,
  withLiveUsdPremiumReference,
} from "./usdRealtime";

describe("Coinbase realtime BTC/USD", () => {
  it("uses 60-second REST backup and 15-30-60 reconnect backoff", () => {
    expect(getUsdMarketRestRefreshInterval(true)).toBe(60_000);
    expect(getUsdMarketRestRefreshInterval(false)).toBe(60_000);
    expect([0, 1, 2, 3, 20].map(getUsdMarketReconnectDelay)).toEqual([
      15_000, 30_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("subscribes to public BTC-USD ticker and heartbeat channels", () => {
    expect(JSON.parse(createCoinbaseTickerSubscription())).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channel: "ticker",
    });
    expect(JSON.parse(createCoinbaseHeartbeatSubscription())).toEqual({
      type: "subscribe",
      channel: "heartbeats",
    });
  });

  it("parses a current BTC-USD ticker into exact cents", async () => {
    const now = Date.parse("2030-01-01T00:00:10.000Z");
    const result = await parseCoinbaseTickerMessage(
      JSON.stringify({
        channel: "ticker",
        timestamp: "2030-01-01T00:00:09.500Z",
        events: [
          {
            type: "update",
            tickers: [
              { type: "ticker", product_id: "BTC-USD", price: "101234.125" },
            ],
          },
        ],
      }),
      now,
    );
    expect(result).toEqual({
      priceUsdCents: 10_123_413n,
      observedAtMs: Date.parse("2030-01-01T00:00:09.500Z"),
    });
  });

  it("parses Binance BTCUSDT trade data and creates a premium without REST premium", async () => {
    const now = Date.parse("2030-01-01T00:00:10.000Z");
    const reference = await parseBinanceTradeMessage(
      JSON.stringify({
        e: "trade",
        E: Date.parse("2030-01-01T00:00:09.500Z"),
        s: "BTCUSDT",
        p: "100000.00",
      }),
      now,
    );
    expect(reference).toEqual({
      priceUsdCents: 10_000_000n,
      observedAtMs: Date.parse("2030-01-01T00:00:09.500Z"),
    });
    const information = withLiveUsdPremiumReference(
      {
        ok: true,
        snapshot: {
          priceUsdCents: "10100000",
          source: "coinbase",
          market: "BTC-USD",
          observedAt: "2030-01-01T00:00:09.000Z",
          retrievedAt: "2030-01-01T00:00:09.000Z",
          snapshotAt: "2030-01-01T00:00:09.000Z",
          fallbackUsed: false,
        },
      },
      reference!,
      now,
    );
    expect(information.premium?.basisPoints).toBe("100");
    expect(information.premium?.referencePriceUsdCents).toBe("10000000");
  });

  it("recalculates Coinbase Premium from the live Coinbase price", () => {
    const updated = withLiveUsdMarketPrice(
      {
        ok: true,
        snapshot: {
          priceUsdCents: "10000000",
          source: "coinbase",
          market: "BTC-USD",
          observedAt: "2030-01-01T00:00:00.000Z",
          retrievedAt: "2030-01-01T00:00:00.000Z",
          snapshotAt: "2030-01-01T00:00:00.000Z",
          fallbackUsed: false,
        },
        premium: {
          basisPoints: "0",
          referencePriceUsdCents: "10000000",
          retrievedAt: "2030-01-01T00:00:00.000Z",
        },
      },
      {
        priceUsdCents: 10_100_000n,
        observedAtMs: Date.parse("2030-01-01T00:00:09.000Z"),
      },
      Date.parse("2030-01-01T00:00:10.000Z"),
    );
    expect(updated.snapshot.priceUsdCents).toBe("10100000");
    expect(updated.premium?.basisPoints).toBe("100");
    expect(calculateCoinbasePremiumBasisPoints(9_900_000n, 10_000_000n)).toBe(
      -100n,
    );
  });
});
