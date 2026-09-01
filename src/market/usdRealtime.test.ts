import { describe, expect, it } from "vitest";

import {
  createCoinbaseHeartbeatSubscription,
  createCoinbaseTickerSubscription,
  getUsdMarketReconnectDelay,
  getUsdMarketRestRefreshInterval,
  parseCoinbaseTickerMessage,
  withLiveUsdMarketPrice,
} from "./usdRealtime";

describe("Coinbase realtime BTC/USD", () => {
  it("uses five-minute REST refresh and 15-30-60 reconnect backoff", () => {
    expect(getUsdMarketRestRefreshInterval()).toBe(300_000);
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

  it("keeps the REST premium snapshot while the Coinbase price updates live", () => {
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
    expect(updated.premium?.basisPoints).toBe("0");
  });
});
