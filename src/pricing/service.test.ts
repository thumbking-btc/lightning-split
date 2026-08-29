import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PRICE_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import type { Fetcher } from "../infrastructure/http";
import {
  BithumbPriceAdapter,
  NoopPriceSnapshotCache,
  PriceSnapshotService,
  type PriceSnapshotCache,
  type PriceSourceAdapter,
  UpbitPriceAdapter,
} from "./service";

const NOW = Date.UTC(2030, 0, 1);

function jsonFetcher(value: unknown): Fetcher {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("exchange-specific price adapters", () => {
  it("validates Upbit's own market and trade timestamp fields", async () => {
    const adapter = new UpbitPriceAdapter(
      jsonFetcher([
        {
          market: "KRW-BTC",
          trade_price: 120_000_000,
          trade_timestamp: NOW - 1_000,
        },
      ]),
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(adapter.fetchObservation()).resolves.toMatchObject({
      source: "upbit",
      priceKrw: 120_000_000n,
      observedAtMs: NOW - 1_000,
    });
  });

  it("independently rejects malformed or stale Bithumb timestamps", async () => {
    const malformed = new BithumbPriceAdapter(
      jsonFetcher([
        { market: "KRW-BTC", trade_price: 121_000_000, timestamp: NOW },
      ]),
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(malformed.fetchObservation()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const stale = new BithumbPriceAdapter(
      jsonFetcher([
        {
          market: "KRW-BTC",
          trade_price: 121_000_000,
          trade_timestamp: NOW - 61_000,
        },
      ]),
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(stale.fetchObservation()).rejects.toMatchObject({
      code: "STALE_DATA",
    });
  });
});

describe("PriceSnapshotService", () => {
  it("uses Upbit first and Bithumb only as fallback", async () => {
    const primary: PriceSourceAdapter = {
      source: "upbit",
      fetchObservation: vi.fn(() =>
        Promise.reject(new InfrastructureError("HTTP_ERROR", "down")),
      ),
    };
    const fallback: PriceSourceAdapter = {
      source: "bithumb",
      fetchObservation: vi.fn(() =>
        Promise.resolve({
          source: "bithumb" as const,
          market: "KRW-BTC" as const,
          priceKrw: 121_000_000n,
          observedAtMs: NOW - 500,
          retrievedAtMs: NOW,
        }),
      ),
    };
    const service = new PriceSnapshotService(
      primary,
      fallback,
      new NoopPriceSnapshotCache(),
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(service.getSnapshot()).resolves.toMatchObject({
      source: "bithumb",
      fallbackUsed: true,
      priceKrw: 121_000_000n,
    });
  });

  it("reuses a fresh cached immutable snapshot without upstream calls", async () => {
    const snapshot = {
      priceKrw: 120_000_000n,
      source: "upbit" as const,
      market: "KRW-BTC",
      observedAt: new Date(NOW - 500).toISOString(),
      retrievedAt: new Date(NOW - 100).toISOString(),
      snapshotAt: new Date(NOW - 100).toISOString(),
      fallbackUsed: false,
    };
    const cache: PriceSnapshotCache = {
      get: vi.fn(() => Promise.resolve(snapshot)),
      put: vi.fn(() => Promise.resolve()),
    };
    const adapter: PriceSourceAdapter = {
      source: "upbit",
      fetchObservation: vi.fn(() => Promise.reject(new Error("must not call"))),
    };
    const service = new PriceSnapshotService(
      adapter,
      adapter,
      cache,
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(service.getSnapshot()).resolves.toBe(snapshot);
    expect(adapter.fetchObservation).not.toHaveBeenCalled();
  });

  it("does not let a stale cached value prevent a fresh upstream lookup", async () => {
    const cache: PriceSnapshotCache = {
      get: vi.fn(() =>
        Promise.resolve({
          priceKrw: 100_000_000n,
          source: "upbit" as const,
          market: "KRW-BTC",
          observedAt: new Date(NOW - 120_000).toISOString(),
          retrievedAt: new Date(NOW - 100).toISOString(),
          snapshotAt: new Date(NOW - 100).toISOString(),
          fallbackUsed: false,
        }),
      ),
      put: vi.fn(() => Promise.resolve()),
    };
    const primary: PriceSourceAdapter = {
      source: "upbit",
      fetchObservation: vi.fn(() =>
        Promise.resolve({
          source: "upbit" as const,
          market: "KRW-BTC" as const,
          priceKrw: 120_000_000n,
          observedAtMs: NOW - 500,
          retrievedAtMs: NOW,
        }),
      ),
    };
    const service = new PriceSnapshotService(
      primary,
      primary,
      cache,
      DEFAULT_PRICE_POLICY,
      () => NOW,
    );
    await expect(service.getSnapshot()).resolves.toMatchObject({
      priceKrw: 120_000_000n,
    });
    expect(primary.fetchObservation).toHaveBeenCalledTimes(1);
  });
});
