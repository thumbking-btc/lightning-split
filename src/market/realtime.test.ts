import { describe, expect, it } from "vitest";

import type { PriceResponseDto } from "../api/contracts";
import { serializeBigIntDecimal } from "../api/serialization";
import {
  calculatePremiumBasisPoints,
  createUpbitTradeSubscription,
  getMarketReconnectDelay,
  getMarketRestRefreshDelay,
  getMarketRestRefreshInterval,
  parseUpbitTradeMessage,
  withLiveMarketPrice,
} from "./realtime";

const nowMs = Date.parse("2030-01-01T00:00:10.000Z");

describe("real-time market information", () => {
  it("parses Upbit SIMPLE trade messages and rejects stale observations", async () => {
    await expect(
      parseUpbitTradeMessage(
        JSON.stringify({ cd: "KRW-BTC", tp: 162_345_000, ttms: nowMs - 500 }),
        nowMs,
      ),
    ).resolves.toEqual({
      priceKrw: 162_345_000n,
      observedAtMs: nowMs - 500,
    });
    await expect(
      parseUpbitTradeMessage(
        JSON.stringify({
          cd: "KRW-BTC",
          tp: 162_345_000,
          ttms: nowMs - 120_001,
        }),
        nowMs,
      ),
    ).resolves.toBeNull();
  });

  it("accepts the default field names but not another market or a future clock", async () => {
    const message = JSON.stringify({
      code: "KRW-BTC",
      trade_price: 162_345_000,
      trade_timestamp: nowMs,
    });
    await expect(
      parseUpbitTradeMessage(new TextEncoder().encode(message).buffer, nowMs),
    ).resolves.toEqual({ priceKrw: 162_345_000n, observedAtMs: nowMs });
    await expect(
      parseUpbitTradeMessage(
        JSON.stringify({ cd: "KRW-ETH", tp: 1, ttms: nowMs }),
        nowMs,
      ),
    ).resolves.toBeNull();
    await expect(
      parseUpbitTradeMessage(
        JSON.stringify({ cd: "KRW-BTC", tp: 1, ttms: nowMs + 30_001 }),
        nowMs,
      ),
    ).resolves.toBeNull();
  });

  it("uses 60-second REST backup and 15-30-60 WebSocket reconnect backoff", () => {
    expect(getMarketRestRefreshInterval(true)).toBe(60_000);
    expect(getMarketRestRefreshInterval(false)).toBe(60_000);
    expect(getMarketRestRefreshDelay(1_000, 60_000, 5_000)).toBe(56_000);
    expect(getMarketRestRefreshDelay(1_000, 60_000, 61_000)).toBe(0);
    expect([0, 1, 2, 3, 20].map(getMarketReconnectDelay)).toEqual([
      15_000, 30_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("builds a realtime-only KRW-BTC trade subscription", () => {
    expect(JSON.parse(createUpbitTradeSubscription("ticket"))).toEqual([
      { ticket: "ticket" },
      { type: "trade", codes: ["KRW-BTC"], is_only_realtime: true },
      { format: "SIMPLE" },
    ]);
  });

  it("recalculates display-only premium from the live domestic price", () => {
    expect(calculatePremiumBasisPoints(101n, 100n)).toBe(100n);
    const information: PriceResponseDto = {
      ok: true,
      snapshot: {
        priceKrw: serializeBigIntDecimal(100n),
        source: "bithumb",
        market: "KRW-BTC",
        observedAt: "2030-01-01T00:00:00.000Z",
        retrievedAt: "2030-01-01T00:00:00.000Z",
        snapshotAt: "2030-01-01T00:00:00.000Z",
        fallbackUsed: true,
      },
      premium: {
        basisPoints: "0",
        referencePriceKrw: "100",
        retrievedAt: "2030-01-01T00:00:00.000Z",
      },
    };
    const live = withLiveMarketPrice(
      information,
      { priceKrw: 101n, observedAtMs: nowMs },
      nowMs + 10,
    );
    expect(live.snapshot).toMatchObject({
      priceKrw: "101",
      source: "upbit",
      fallbackUsed: false,
    });
    expect(live.premium?.basisPoints).toBe("100");
  });
});
