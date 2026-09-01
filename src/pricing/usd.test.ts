import { describe, expect, it, vi } from "vitest";

import type { Fetcher } from "../infrastructure/http";
import {
  InternationalUsdPremiumReferenceAdapter,
  CoinbasePremiumService,
  CoinbaseUsdPriceAdapter,
  KrakenUsdPriceAdapter,
  UsdPriceSnapshotService,
  type UsdPremiumReference,
  type UsdPremiumReferenceAdapter,
  type UsdPremiumReferenceCache,
  type UsdPremiumReferenceObservation,
  type UsdPriceObservation,
  type UsdPriceSnapshot,
  type UsdPriceSnapshotCache,
  type UsdPriceSourceAdapter,
} from "./usd";

const NOW = Date.parse("2030-01-01T00:00:10.000Z");

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class MemorySnapshotCache implements UsdPriceSnapshotCache {
  value: UsdPriceSnapshot | null = null;
  puts = 0;

  get(): Promise<UsdPriceSnapshot | null> {
    return Promise.resolve(this.value);
  }

  put(snapshot: UsdPriceSnapshot): Promise<void> {
    this.value = snapshot;
    this.puts += 1;
    return Promise.resolve();
  }
}

class MemoryPremiumCache implements UsdPremiumReferenceCache {
  value: UsdPremiumReference | null = null;
  puts = 0;

  get(): Promise<UsdPremiumReference | null> {
    return Promise.resolve(this.value);
  }

  put(reference: UsdPremiumReference): Promise<void> {
    this.value = reference;
    this.puts += 1;
    return Promise.resolve();
  }
}

function fakeAdapter(
  source: "coinbase" | "kraken",
  observation: UsdPriceObservation | Error,
): UsdPriceSourceAdapter {
  return {
    source,
    fetchObservation: vi.fn(() =>
      observation instanceof Error
        ? Promise.reject(observation)
        : Promise.resolve(observation),
    ),
  };
}

function fakePremiumReference(
  observation: UsdPremiumReferenceObservation | Error,
): UsdPremiumReferenceAdapter {
  return {
    fetchObservation: vi.fn(() =>
      observation instanceof Error
        ? Promise.reject(observation)
        : Promise.resolve(observation),
    ),
  };
}

describe("BTC/USD provider adapters", () => {
  it("parses Coinbase BTC-USD into exact cents", async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          price: "100000.125",
          time: "2030-01-01T00:00:09.000Z",
        }),
      ),
    );
    const observation = await new CoinbaseUsdPriceAdapter(
      fetcher,
      undefined,
      () => NOW,
    ).fetchObservation();

    expect(observation).toMatchObject({
      source: "coinbase",
      market: "BTC-USD",
      priceUsdCents: 10_000_013n,
      observedAtMs: Date.parse("2030-01-01T00:00:09.000Z"),
      retrievedAtMs: NOW,
    });
  });

  it("rejects a stale Coinbase observation", async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          price: "100000.00",
          time: "2029-12-31T23:00:00.000Z",
        }),
      ),
    );

    await expect(
      new CoinbaseUsdPriceAdapter(
        fetcher,
        undefined,
        () => NOW,
      ).fetchObservation(),
    ).rejects.toMatchObject({ code: "STALE_DATA" });
  });

  it("parses Kraken XBTUSD last trade into exact cents", async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          error: [],
          result: { XXBTZUSD: { c: ["99999.994", "0.1"] } },
        }),
      ),
    );
    const observation = await new KrakenUsdPriceAdapter(
      fetcher,
      undefined,
      () => NOW,
    ).fetchObservation();

    expect(observation.priceUsdCents).toBe(9_999_999n);
    expect(observation.source).toBe("kraken");
    expect(observation.observedAtMs).toBe(NOW);
  });

  it("parses Binance BTC-USDT as the Coinbase Premium reference", async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse({ symbol: "BTCUSDT", price: "100000.005" })),
    );
    const observation = await new InternationalUsdPremiumReferenceAdapter(
      fetcher,
      undefined,
      () => NOW,
    ).fetchObservation();

    expect(observation).toEqual({
      priceUsdCents: 10_000_001n,
      observedAtMs: NOW,
      retrievedAtMs: NOW,
    });
  });

  it("falls back to OKX BTC-USDT when Binance is unavailable", async () => {
    const fetcher: Fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 451 }))
      .mockResolvedValueOnce(new Response(null, { status: 451 }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: "0",
          data: [{ instId: "BTC-USDT", last: "99999.995" }],
        }),
      );

    const observation = await new InternationalUsdPremiumReferenceAdapter(
      fetcher,
      undefined,
      () => NOW,
    ).fetchObservation();

    expect(observation.priceUsdCents).toBe(10_000_000n);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("BTC/USD snapshot service", () => {
  it("falls back from Coinbase to Kraken and records fallback usage", async () => {
    const primary = fakeAdapter("coinbase", new Error("primary unavailable"));
    const fallback = fakeAdapter("kraken", {
      source: "kraken",
      market: "BTC-USD",
      priceUsdCents: 9_900_000n,
      observedAtMs: NOW - 1_000,
      retrievedAtMs: NOW,
    });
    const cache = new MemorySnapshotCache();

    const snapshot = await new UsdPriceSnapshotService(
      primary,
      fallback,
      cache,
      undefined,
      () => NOW,
    ).getSnapshot();

    expect(snapshot.source).toBe("kraken");
    expect(snapshot.fallbackUsed).toBe(true);
    expect(snapshot.priceUsdCents).toBe(9_900_000n);
    expect(cache.puts).toBe(1);
  });

  it("reuses a fresh cached snapshot without hitting either provider", async () => {
    const snapshot: UsdPriceSnapshot = Object.freeze({
      priceUsdCents: 10_000_000n,
      source: "coinbase",
      market: "BTC-USD",
      observedAt: "2030-01-01T00:00:09.000Z",
      retrievedAt: "2030-01-01T00:00:09.500Z",
      snapshotAt: "2030-01-01T00:00:09.500Z",
      fallbackUsed: false,
    });
    const cache = new MemorySnapshotCache();
    cache.value = snapshot;
    const primary = fakeAdapter("coinbase", new Error("must not run"));
    const fallback = fakeAdapter("kraken", new Error("must not run"));

    const result = await new UsdPriceSnapshotService(
      primary,
      fallback,
      cache,
      undefined,
      () => NOW,
    ).getSnapshot();

    expect(result).toBe(snapshot);
    expect(primary.fetchObservation).not.toHaveBeenCalled();
    expect(fallback.fetchObservation).not.toHaveBeenCalled();
  });
});

describe("Coinbase Premium information", () => {
  it("calculates positive and negative basis points against the reference", async () => {
    const reference = fakePremiumReference({
      priceUsdCents: 10_000_000n,
      observedAtMs: NOW,
      retrievedAtMs: NOW,
    });
    const cache = new MemoryPremiumCache();
    const service = new CoinbasePremiumService(
      reference,
      cache,
      undefined,
      () => NOW,
    );

    await expect(service.getInformation(10_100_000n)).resolves.toMatchObject({
      basisPoints: 100n,
      referencePriceUsdCents: 10_000_000n,
    });
    await expect(service.getInformation(9_900_000n)).resolves.toMatchObject({
      basisPoints: -100n,
      referencePriceUsdCents: 10_000_000n,
    });
    expect(reference.fetchObservation).toHaveBeenCalledTimes(1);
    expect(cache.puts).toBe(1);
  });
});
