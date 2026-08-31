import type { PricePolicy } from "../config/policies";
import { DEFAULT_PRICE_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import { isRecord } from "../infrastructure/validation";

export const USD_PREMIUM_REFERENCE_CACHE_TTL_MS = 60_000;

export type UsdPriceSource = "coinbase" | "kraken";

export interface UsdPriceSnapshot {
  readonly priceUsdCents: bigint;
  readonly source: UsdPriceSource;
  readonly market: "BTC-USD";
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly snapshotAt: string;
  readonly fallbackUsed: boolean;
}

export interface UsdPriceObservation {
  readonly source: UsdPriceSource;
  readonly market: "BTC-USD";
  readonly priceUsdCents: bigint;
  readonly observedAtMs: number;
  readonly retrievedAtMs: number;
}

export interface UsdPriceSourceAdapter {
  readonly source: UsdPriceSource;
  fetchObservation(): Promise<UsdPriceObservation>;
}

export interface UsdPremiumReferenceObservation {
  readonly priceUsdCents: bigint;
  readonly observedAtMs: number;
  readonly retrievedAtMs: number;
}

export interface UsdPremiumReferenceAdapter {
  fetchObservation(): Promise<UsdPremiumReferenceObservation>;
}

export interface UsdPriceSnapshotCache {
  get(): Promise<UsdPriceSnapshot | null>;
  put(snapshot: UsdPriceSnapshot): Promise<void>;
}

export interface UsdPremiumReference {
  readonly priceUsdCents: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
}

export interface UsdPremiumReferenceCache {
  get(): Promise<UsdPremiumReference | null>;
  put(reference: UsdPremiumReference): Promise<void>;
}

export interface CoinbasePremiumInformation {
  readonly basisPoints: bigint;
  readonly referencePriceUsdCents: bigint;
  readonly retrievedAt: string;
}

export class NoopUsdPriceSnapshotCache implements UsdPriceSnapshotCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  put(_snapshot: UsdPriceSnapshot): Promise<void> {
    void _snapshot;
    return Promise.resolve();
  }
}

export class NoopUsdPremiumReferenceCache implements UsdPremiumReferenceCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  put(_reference: UsdPremiumReference): Promise<void> {
    void _reference;
    return Promise.resolve();
  }
}

function parseUsdCents(value: unknown, field: string): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(text)
  ) {
    throw new InfrastructureError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const padded = fraction.padEnd(3, "0");
  let cents = BigInt(whole!) * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2] ?? "0") >= 5) cents += 1n;
  if (cents < 1n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      `${field} is out of range.`,
    );
  }
  return cents;
}

function parseIsoTimestampMs(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw new InfrastructureError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new InfrastructureError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  return timestamp;
}

function assertFresh(
  observedAtMs: number,
  retrievedAtMs: number,
  nowMs: number,
  policy: PricePolicy,
): void {
  if (observedAtMs > nowMs + policy.maxFutureClockSkewMs) {
    throw new InfrastructureError(
      "STALE_DATA",
      "The BTC/USD market timestamp is too far in the future.",
    );
  }
  if (nowMs - observedAtMs > policy.maxObservationAgeMs) {
    throw new InfrastructureError(
      "STALE_DATA",
      "The BTC/USD observation is stale.",
      {
        retryable: true,
      },
    );
  }
  if (nowMs - retrievedAtMs > policy.maxRetrievalAgeMs) {
    throw new InfrastructureError(
      "STALE_DATA",
      "The BTC/USD retrieval is stale.",
      {
        retryable: true,
      },
    );
  }
}

function isFresh(
  observedAtMs: number,
  retrievedAtMs: number,
  nowMs: number,
  policy: PricePolicy,
): boolean {
  return (
    observedAtMs <= nowMs + policy.maxFutureClockSkewMs &&
    nowMs - observedAtMs <= policy.maxObservationAgeMs &&
    nowMs - retrievedAtMs <= policy.maxRetrievalAgeMs
  );
}

export class CoinbaseUsdPriceAdapter implements UsdPriceSourceAdapter {
  readonly source = "coinbase" as const;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async fetchObservation(): Promise<UsdPriceObservation> {
    const response = await fetchBoundedJson(
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
      this.policy.http,
      this.fetcher,
      this.clock,
    );
    if (!isRecord(response.value)) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Coinbase BTC-USD ticker is invalid.",
      );
    }
    const observedAtMs = parseIsoTimestampMs(
      response.value.time,
      "Coinbase BTC-USD time",
    );
    const retrievedAtMs = this.clock();
    assertFresh(observedAtMs, retrievedAtMs, retrievedAtMs, this.policy);
    return Object.freeze({
      source: this.source,
      market: "BTC-USD",
      priceUsdCents: parseUsdCents(
        response.value.price,
        "Coinbase BTC-USD price",
      ),
      observedAtMs,
      retrievedAtMs,
    });
  }
}

export class KrakenUsdPriceAdapter implements UsdPriceSourceAdapter {
  readonly source = "kraken" as const;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async fetchObservation(): Promise<UsdPriceObservation> {
    const response = await fetchBoundedJson(
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      this.policy.http,
      this.fetcher,
      this.clock,
    );
    if (
      !isRecord(response.value) ||
      !Array.isArray(response.value.error) ||
      response.value.error.length !== 0 ||
      !isRecord(response.value.result)
    ) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Kraken BTC-USD ticker is invalid.",
      );
    }
    const entries = Object.values(response.value.result);
    if (
      entries.length !== 1 ||
      !isRecord(entries[0]) ||
      !Array.isArray(entries[0].c)
    ) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Kraken BTC-USD ticker is invalid.",
      );
    }
    const lastTrade = entries[0].c[0];
    const retrievedAtMs = this.clock();
    return Object.freeze({
      source: this.source,
      market: "BTC-USD",
      priceUsdCents: parseUsdCents(lastTrade, "Kraken BTC-USD price"),
      observedAtMs: retrievedAtMs,
      retrievedAtMs,
    });
  }
}

export class BinanceUsdtPremiumReferenceAdapter implements UsdPremiumReferenceAdapter {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async fetchObservation(): Promise<UsdPremiumReferenceObservation> {
    const response = await fetchBoundedJson(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      this.policy.http,
      this.fetcher,
      this.clock,
    );
    if (!isRecord(response.value) || response.value.symbol !== "BTCUSDT") {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Binance BTC-USDT ticker is invalid.",
      );
    }
    const retrievedAtMs = this.clock();
    return Object.freeze({
      priceUsdCents: parseUsdCents(
        response.value.price,
        "Binance BTC-USDT price",
      ),
      observedAtMs: retrievedAtMs,
      retrievedAtMs,
    });
  }
}

export class UsdPriceSnapshotUnavailableError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "No fresh BTC/USD price source was available.");
    this.name = "UsdPriceSnapshotUnavailableError";
  }
}

export class UsdPriceSnapshotService {
  constructor(
    private readonly primary: UsdPriceSourceAdapter,
    private readonly fallback: UsdPriceSourceAdapter,
    private readonly cache: UsdPriceSnapshotCache = new NoopUsdPriceSnapshotCache(),
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async getSnapshot(): Promise<UsdPriceSnapshot> {
    const nowMs = this.clock();
    let cached: UsdPriceSnapshot | null = null;
    try {
      cached = await this.cache.get();
    } catch {
      // Cache availability is optional.
    }
    if (cached) {
      const observedAtMs = Date.parse(cached.observedAt);
      const retrievedAtMs = Date.parse(cached.retrievedAt);
      const snapshotAtMs = Date.parse(cached.snapshotAt);
      if (
        Number.isFinite(snapshotAtMs) &&
        nowMs - snapshotAtMs <= this.policy.cacheTtlMs &&
        Number.isFinite(observedAtMs) &&
        Number.isFinite(retrievedAtMs) &&
        isFresh(observedAtMs, retrievedAtMs, nowMs, this.policy)
      ) {
        return cached;
      }
    }

    const errors: unknown[] = [];
    for (const [adapter, fallbackUsed] of [
      [this.primary, false],
      [this.fallback, true],
    ] as const) {
      try {
        const observation = await adapter.fetchObservation();
        assertFresh(
          observation.observedAtMs,
          observation.retrievedAtMs,
          this.clock(),
          this.policy,
        );
        const snapshot: UsdPriceSnapshot = Object.freeze({
          priceUsdCents: observation.priceUsdCents,
          source: observation.source,
          market: observation.market,
          observedAt: new Date(observation.observedAtMs).toISOString(),
          retrievedAt: new Date(observation.retrievedAtMs).toISOString(),
          snapshotAt: new Date(this.clock()).toISOString(),
          fallbackUsed,
        });
        try {
          await this.cache.put(snapshot);
        } catch {
          // A cache write must not hide a fresh upstream price.
        }
        return snapshot;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new UsdPriceSnapshotUnavailableError(errors);
  }
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function parseUsdPremiumReference(value: unknown): UsdPremiumReference {
  if (
    !isRecord(value) ||
    typeof value.priceUsdCents !== "string" ||
    !/^[1-9]\d*$/u.test(value.priceUsdCents) ||
    typeof value.observedAt !== "string" ||
    typeof value.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Number.isFinite(Date.parse(value.retrievedAt))
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "USD premium reference is invalid.",
    );
  }
  return Object.freeze({
    priceUsdCents: value.priceUsdCents,
    observedAt: value.observedAt,
    retrievedAt: value.retrievedAt,
  });
}

export class CoinbasePremiumService {
  constructor(
    private readonly referenceAdapter: UsdPremiumReferenceAdapter,
    private readonly cache: UsdPremiumReferenceCache = new NoopUsdPremiumReferenceCache(),
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async getInformation(
    coinbasePriceUsdCents: bigint,
  ): Promise<CoinbasePremiumInformation> {
    const nowMs = this.clock();
    let reference: UsdPremiumReference | null = null;
    try {
      reference = await this.cache.get();
    } catch {
      // Cache availability is optional.
    }
    if (
      !reference ||
      nowMs - Date.parse(reference.retrievedAt) >
        USD_PREMIUM_REFERENCE_CACHE_TTL_MS ||
      nowMs - Date.parse(reference.observedAt) > this.policy.maxObservationAgeMs
    ) {
      const observation = await this.referenceAdapter.fetchObservation();
      reference = Object.freeze({
        priceUsdCents: observation.priceUsdCents.toString(),
        observedAt: new Date(observation.observedAtMs).toISOString(),
        retrievedAt: new Date(observation.retrievedAtMs).toISOString(),
      });
      try {
        await this.cache.put(reference);
      } catch {
        // A cache write must not hide a valid reference.
      }
    }
    const referencePriceUsdCents = BigInt(reference.priceUsdCents);
    const ratioBasisPoints = roundHalfUp(
      coinbasePriceUsdCents * 10_000n,
      referencePriceUsdCents,
    );
    return Object.freeze({
      basisPoints: ratioBasisPoints - 10_000n,
      referencePriceUsdCents,
      retrievedAt: reference.retrievedAt,
    });
  }
}
