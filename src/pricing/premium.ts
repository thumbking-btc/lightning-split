import type { PricePolicy } from "../config/policies";
import { DEFAULT_PRICE_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import {
  isRecord,
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

export class BinanceUpbitPremiumAdapter {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async fetchReference(): Promise<PremiumReference> {
    const [upbit, binance] = await Promise.all([
      fetchBoundedJson(
        "https://api.upbit.com/v1/ticker?markets=KRW-USDT",
        this.policy.http,
        this.fetcher,
        this.clock,
      ),
      fetchBoundedJson(
        "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
        this.policy.http,
        this.fetcher,
        this.clock,
      ),
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
    if (!isRecord(binance.value) || binance.value.symbol !== "BTCUSDT") {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "Binance BTC ticker is invalid.",
      );
    }
    const observedAtMs = parsePositiveSafeInteger(
      upbitTicker.trade_timestamp,
      "Upbit USDT trade_timestamp",
    );
    const retrievedAtMs = this.clock();
    if (
      observedAtMs > retrievedAtMs + this.policy.maxFutureClockSkewMs ||
      retrievedAtMs - observedAtMs > this.policy.maxObservationAgeMs
    ) {
      throw new InfrastructureError(
        "STALE_DATA",
        "Upbit USDT ticker is stale.",
        {
          retryable: true,
        },
      );
    }
    const usdtKrw = parseScaledDecimal(
      upbitTicker.trade_price,
      "Upbit KRW-USDT price",
    );
    const btcUsdt = parseScaledDecimal(
      binance.value.price,
      "Binance BTCUSDT price",
    );
    const referencePriceKrw = roundHalfUp(
      usdtKrw * btcUsdt,
      DECIMAL_SCALE * DECIMAL_SCALE,
    );
    return Object.freeze({
      internationalPriceKrw: referencePriceKrw.toString(),
      observedAt: new Date(observedAtMs).toISOString(),
      retrievedAt: new Date(retrievedAtMs).toISOString(),
    });
  }
}

export class KimchiPremiumService {
  constructor(
    private readonly adapter: BinanceUpbitPremiumAdapter,
    private readonly cache: PremiumReferenceCache = new NoopPremiumReferenceCache(),
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}

  async getInformation(
    domesticPriceKrw: bigint,
  ): Promise<KimchiPremiumInformation> {
    const nowMs = this.clock();
    let reference = await this.cache.get();
    if (
      !reference ||
      nowMs - Date.parse(reference.retrievedAt) >
        PREMIUM_REFERENCE_CACHE_TTL_MS ||
      nowMs - Date.parse(reference.observedAt) > this.policy.maxObservationAgeMs
    ) {
      reference = await this.adapter.fetchReference();
      await this.cache.put(reference);
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
