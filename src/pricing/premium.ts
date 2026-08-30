import type { PricePolicy } from "../config/policies";
import { DEFAULT_PRICE_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import {
  isRecord,
  parseProviderInteger,
  parsePositiveSafeInteger,
} from "../infrastructure/validation";

const DECIMAL_SCALE = 100_000_000n;
export const PREMIUM_REFERENCE_CACHE_TTL_MS = 60_000;

export interface PremiumReference {
  readonly internationalPriceKrw: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
}

export interface KimchiPremiumInformation {
  readonly basisPoints: bigint;
  readonly referencePriceKrw: bigint;
  readonly retrievedAt: string;
}

export interface PremiumReferenceCache {
  get(): Promise<PremiumReference | null>;
  put(reference: PremiumReference): Promise<void>;
}

export interface PremiumReferenceAdapter {
  fetchReference(): Promise<PremiumReference>;
}

interface BtcUsdtTicker {
  readonly price: bigint;
  readonly observedAtMs: number;
}

export class NoopPremiumReferenceCache implements PremiumReferenceCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  put(_reference: PremiumReference): Promise<void> {
    void _reference;
    return Promise.resolve();
  }
}

function parseScaledDecimal(value: unknown, field: string): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(text)
  ) {
    throw new InfrastructureError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const scaled =
    BigInt(whole!) * DECIMAL_SCALE + BigInt(fraction.padEnd(8, "0"));
  if (scaled < 1n) {
    throw new InfrastructureError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  return scaled;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function parseTimestampMs(value: unknown, field: string): number {
  const parsed = parseProviderInteger(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      `${field} must be a safe integer.`,
    );
  }
  return Number(parsed);
}

function assertFresh(
  observedAtMs: number,
  retrievedAtMs: number,
  policy: PricePolicy,
  field: string,
): void {
  if (
    observedAtMs > retrievedAtMs + policy.maxFutureClockSkewMs ||
    retrievedAtMs - observedAtMs > policy.maxObservationAgeMs
  ) {
    throw new InfrastructureError("STALE_DATA", `${field} is stale.`, {
      retryable: true,
    });
  }
}

function parseOkxTicker(value: unknown): BtcUsdtTicker {
  if (!isRecord(value) || value.code !== "0" || !Array.isArray(value.data)) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "OKX BTC-USDT ticker is invalid.",
    );
  }
  const ticker = value.data[0];
  if (
    value.data.length !== 1 ||
    !isRecord(ticker) ||
    ticker.instType !== "SPOT" ||
    ticker.instId !== "BTC-USDT"
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "OKX BTC-USDT ticker is invalid.",
    );
  }
  return Object.freeze({
    price: parseScaledDecimal(ticker.last, "OKX BTC-USDT price"),
    observedAtMs: parseTimestampMs(ticker.ts, "OKX BTC-USDT timestamp"),
  });
}

function parseKuCoinTicker(value: unknown): BtcUsdtTicker {
  if (!isRecord(value) || value.code !== "200000" || !isRecord(value.data)) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "KuCoin BTC-USDT ticker is invalid.",
    );
  }
  return Object.freeze({
    price: parseScaledDecimal(value.data.price, "KuCoin BTC-USDT price"),
    observedAtMs: parseTimestampMs(
      value.data.time,
      "KuCoin BTC-USDT timestamp",
    ),
  });
}

export function parsePremiumReference(value: unknown): PremiumReference {
  if (
    !isRecord(value) ||
    typeof value.internationalPriceKrw !== "string" ||
    !/^[1-9]\d*$/u.test(value.internationalPriceKrw) ||
    typeof value.observedAt !== "string" ||
    typeof value.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Number.isFinite(Date.parse(value.retrievedAt))
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "Premium reference is invalid.",
    );
  }
  return Object.freeze({
    internationalPriceKrw: value.internationalPriceKrw,
    observedAt: value.observedAt,
    retrievedAt: value.retrievedAt,
  });
}

export class UpbitInternationalPremiumAdapter implements PremiumReferenceAdapter {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  private async fetchInternationalTicker(): Promise<BtcUsdtTicker> {
    let primaryError: unknown;
    try {
      const response = await fetchBoundedJson(
        "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
        this.policy.http,
        this.fetcher,
        this.clock,
      );
      const ticker = parseOkxTicker(response.value);
      assertFresh(
        ticker.observedAtMs,
        this.clock(),
        this.policy,
        "OKX BTC-USDT ticker",
      );
      return ticker;
    } catch (error) {
      primaryError = error;
    }

    try {
      const response = await fetchBoundedJson(
        "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT",
        this.policy.http,
        this.fetcher,
        this.clock,
      );
      const ticker = parseKuCoinTicker(response.value);
      assertFresh(
        ticker.observedAtMs,
        this.clock(),
        this.policy,
        "KuCoin BTC-USDT ticker",
      );
      return ticker;
    } catch (fallbackError) {
      throw new InfrastructureError(
        "NETWORK_ERROR",
        "International BTC-USDT ticker sources are unavailable.",
        {
          retryable: true,
          cause: new AggregateError([primaryError, fallbackError]),
        },
      );
    }
  }

  async fetchReference(): Promise<PremiumReference> {
    const [upbit, internationalTicker] = await Promise.all([
      fetchBoundedJson(
        "https://api.upbit.com/v1/ticker?markets=KRW-USDT",
        this.policy.http,
        this.fetcher,
        this.clock,
      ),
      this.fetchInternationalTicker(),
    ]);
    if (
      !Array.isArray(upbit.value) ||
      upbit.value.length !== 1 ||
      !isRecord(upbit.value[0])
    ) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Upbit USDT ticker is invalid.",
      );
    }
    const upbitTicker = upbit.value[0];
    if (upbitTicker.market !== "KRW-USDT") {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Upbit USDT market is invalid.",
      );
    }
    const upbitObservedAtMs = parsePositiveSafeInteger(
      upbitTicker.trade_timestamp,
      "Upbit USDT trade_timestamp",
    );
    const retrievedAtMs = this.clock();
    assertFresh(
      upbitObservedAtMs,
      retrievedAtMs,
      this.policy,
      "Upbit USDT ticker",
    );
    const usdtKrw = parseScaledDecimal(
      upbitTicker.trade_price,
      "Upbit KRW-USDT price",
    );
    const referencePriceKrw = roundHalfUp(
      usdtKrw * internationalTicker.price,
      DECIMAL_SCALE * DECIMAL_SCALE,
    );
    return Object.freeze({
      internationalPriceKrw: referencePriceKrw.toString(),
      observedAt: new Date(
        Math.min(upbitObservedAtMs, internationalTicker.observedAtMs),
      ).toISOString(),
      retrievedAt: new Date(retrievedAtMs).toISOString(),
    });
  }
}

export class KimchiPremiumService {
  constructor(
    private readonly adapter: PremiumReferenceAdapter,
    private readonly cache: PremiumReferenceCache = new NoopPremiumReferenceCache(),
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async getInformation(
    domesticPriceKrw: bigint,
  ): Promise<KimchiPremiumInformation> {
    const nowMs = this.clock();
    let reference: PremiumReference | null = null;
    try {
      reference = await this.cache.get();
    } catch {
      // Cache availability is optional; fetch a fresh reference below.
    }
    if (
      !reference ||
      nowMs - Date.parse(reference.retrievedAt) >
        PREMIUM_REFERENCE_CACHE_TTL_MS ||
      nowMs - Date.parse(reference.observedAt) > this.policy.maxObservationAgeMs
    ) {
      reference = await this.adapter.fetchReference();
      try {
        await this.cache.put(reference);
      } catch {
        // A cache write must not hide a valid premium reference.
      }
    }
    const referencePriceKrw = BigInt(reference.internationalPriceKrw);
    const ratioBasisPoints = roundHalfUp(
      domesticPriceKrw * 10_000n,
      referencePriceKrw,
    );
    return Object.freeze({
      basisPoints: ratioBasisPoints - 10_000n,
      referencePriceKrw,
      retrievedAt: reference.retrievedAt,
    });
  }
}
