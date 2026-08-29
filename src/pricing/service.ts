import type { PricePolicy } from "../config/policies";
import { DEFAULT_PRICE_POLICY } from "../config/policies";
import type { PriceSnapshot, PriceSource } from "../domain/models";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import {
  isRecord,
  parsePositiveSafeInteger,
} from "../infrastructure/validation";

export interface PriceObservation {
  readonly source: PriceSource;
  readonly market: "KRW-BTC";
  readonly priceKrw: bigint;
  readonly observedAtMs: number;
  readonly retrievedAtMs: number;
}

export interface PriceSourceAdapter {
  readonly source: PriceSource;
  fetchObservation(): Promise<PriceObservation>;
}

export interface PriceSnapshotCache {
  get(): Promise<PriceSnapshot | null>;
  put(snapshot: PriceSnapshot): Promise<void>;
}

export class NoopPriceSnapshotCache implements PriceSnapshotCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  put(_snapshot: PriceSnapshot): Promise<void> {
    void _snapshot;
    return Promise.resolve();
  }
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
      "The market timestamp is too far in the future.",
    );
  }
  if (nowMs - observedAtMs > policy.maxObservationAgeMs) {
    throw new InfrastructureError(
      "STALE_DATA",
      "The market observation is stale.",
      { retryable: true },
    );
  }
  if (nowMs - retrievedAtMs > policy.maxRetrievalAgeMs) {
    throw new InfrastructureError(
      "STALE_DATA",
      "The retrieved market price is stale.",
      { retryable: true },
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

function parseTickerArray(
  value: unknown,
  source: PriceSource,
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      `${source} returned an invalid ticker list.`,
    );
  }
  return value[0];
}

function parseUpbitTicker(value: unknown): {
  priceKrw: bigint;
  observedAtMs: number;
} {
  const ticker = parseTickerArray(value, "upbit");
  if (ticker.market !== "KRW-BTC") {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "Upbit returned an unexpected market.",
    );
  }
  const price = parsePositiveSafeInteger(
    ticker.trade_price,
    "Upbit trade_price",
  );
  const observedAtMs = parsePositiveSafeInteger(
    ticker.trade_timestamp,
    "Upbit trade_timestamp",
  );
  return { priceKrw: BigInt(price), observedAtMs };
}

function parseBithumbTicker(value: unknown): {
  priceKrw: bigint;
  observedAtMs: number;
} {
  const ticker = parseTickerArray(value, "bithumb");
  if (ticker.market !== "KRW-BTC") {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "Bithumb returned an unexpected market.",
    );
  }
  const price = parsePositiveSafeInteger(
    ticker.trade_price,
    "Bithumb trade_price",
  );
  const observedAtMs = parsePositiveSafeInteger(
    ticker.trade_timestamp,
    "Bithumb trade_timestamp",
  );
  return { priceKrw: BigInt(price), observedAtMs };
}

abstract class KoreanExchangeAdapter implements PriceSourceAdapter {
  abstract readonly source: PriceSource;
  protected abstract readonly url: string;
  protected abstract parse(value: unknown): {
    priceKrw: bigint;
    observedAtMs: number;
  };

  constructor(
    protected readonly fetcher: Fetcher = fetch,
    protected readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    protected readonly clock: () => number = Date.now,
  ) {}

  async fetchObservation(): Promise<PriceObservation> {
    const response = await fetchBoundedJson(
      this.url,
      this.policy.http,
      this.fetcher,
      this.clock,
    );
    const parsed = this.parse(response.value);
    const retrievedAtMs = this.clock();
    assertFresh(parsed.observedAtMs, retrievedAtMs, retrievedAtMs, this.policy);
    return Object.freeze({
      source: this.source,
      market: "KRW-BTC",
      priceKrw: parsed.priceKrw,
      observedAtMs: parsed.observedAtMs,
      retrievedAtMs,
    });
  }
}

export class UpbitPriceAdapter extends KoreanExchangeAdapter {
  readonly source = "upbit" as const;
  protected readonly url = "https://api.upbit.com/v1/ticker?markets=KRW-BTC";
  protected parse(value: unknown): { priceKrw: bigint; observedAtMs: number } {
    return parseUpbitTicker(value);
  }
}

export class BithumbPriceAdapter extends KoreanExchangeAdapter {
  readonly source = "bithumb" as const;
  protected readonly url = "https://api.bithumb.com/v1/ticker?markets=KRW-BTC";
  protected parse(value: unknown): { priceKrw: bigint; observedAtMs: number } {
    return parseBithumbTicker(value);
  }
}

export class PriceSnapshotUnavailableError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "No fresh BTC/KRW price source was available.");
    this.name = "PriceSnapshotUnavailableError";
  }
}

export class PriceSnapshotService {
  constructor(
    private readonly primary: PriceSourceAdapter,
    private readonly fallback: PriceSourceAdapter,
    private readonly cache: PriceSnapshotCache = new NoopPriceSnapshotCache(),
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async getSnapshot(): Promise<PriceSnapshot> {
    const nowMs = this.clock();
    const cached = await this.cache.get();
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
        const snapshot: PriceSnapshot = Object.freeze({
          priceKrw: observation.priceKrw,
          source: observation.source,
          market: observation.market,
          observedAt: new Date(observation.observedAtMs).toISOString(),
          retrievedAt: new Date(observation.retrievedAtMs).toISOString(),
          snapshotAt: new Date(this.clock()).toISOString(),
          fallbackUsed,
        });
        await this.cache.put(snapshot);
        return snapshot;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new PriceSnapshotUnavailableError(errors);
  }
}
