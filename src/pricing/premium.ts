import type { PricePolicy } from "../config/policies";
import { DEFAULT_PRICE_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import { isRecord } from "../infrastructure/validation";

export const PREMIUM_REFERENCE_CACHE_TTL_MS = 60_000;
export const UPBIT_PREMIUM_URL =
  "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC";

export interface PremiumReference {
  readonly basisPoints: string;
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
export class NoopPremiumReferenceCache implements PremiumReferenceCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  put(_reference: PremiumReference): Promise<void> {
    void _reference;
    return Promise.resolve();
  }
}
function invalid(): never {
  throw new InfrastructureError(
    "INVALID_RESPONSE",
    "Upbit BTC premium is invalid.",
  );
}
export function parsePremiumReference(value: unknown): PremiumReference {
  if (
    !isRecord(value) ||
    typeof value.basisPoints !== "string" ||
    !/^-?\d{1,4}$/u.test(value.basisPoints) ||
    BigInt(value.basisPoints) < -5000n ||
    BigInt(value.basisPoints) > 5000n ||
    typeof value.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(value.retrievedAt))
  )
    invalid();
  return Object.freeze({
    basisPoints: value.basisPoints,
    retrievedAt: value.retrievedAt,
  });
}
export class UpbitDatalabPremiumAdapter implements PremiumReferenceAdapter {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}
  async fetchReference(): Promise<PremiumReference> {
    const { value } = await fetchBoundedJson(
      UPBIT_PREMIUM_URL,
      // DataLab can return all assets despite the symbols query parameter.
      { ...this.policy.http, maxResponseBytes: 256_000 },
      this.fetcher,
      this.clock,
    );
    if (
      !isRecord(value) ||
      value.code !== 0 ||
      !isRecord(value.data) ||
      !Array.isArray(value.data.records)
    )
      invalid();
    const records = value.data.records.filter(
      (record: unknown) =>
        isRecord(record) && record.code === "CRIX.UPBIT.KRW-BTC",
    );
    if (records.length !== 1 || !isRecord(records[0])) invalid();
    const record = records[0];
    if (record.pair !== "BTC/KRW") invalid();
    // disparityRate is BTC premium; realDisparityRate removes the USDT premium.
    const rate = record.disparityRate;
    const text = typeof rate === "number" ? String(rate) : rate;
    if (
      typeof text !== "string" ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(text) ||
      Math.abs(Number(text)) > 50
    )
      invalid();
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
    const scaled =
      BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
    const rounded = (scaled + 500_000n) / 1_000_000n;
    return Object.freeze({
      basisPoints: ((negative ? -1n : 1n) * rounded).toString(),
      retrievedAt: new Date(this.clock()).toISOString(),
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
      const cached = await this.cache.get();
      reference = cached ? parsePremiumReference(cached) : null;
    } catch {
      /* Treat invalid or unavailable cache as a miss. */
    }
    if (
      !reference ||
      nowMs - Date.parse(reference.retrievedAt) >=
        PREMIUM_REFERENCE_CACHE_TTL_MS ||
      Date.parse(reference.retrievedAt) >
        nowMs + this.policy.maxFutureClockSkewMs
    ) {
      reference = parsePremiumReference(await this.adapter.fetchReference());
      try {
        await this.cache.put(reference);
      } catch {
        /* Cache failure must not hide a valid indicator. */
      }
    }
    const basisPoints = BigInt(reference.basisPoints);
    // Keep the existing API field for older clients. This is an implied reference,
    // not a separately fetched international quote; the published indicator is authoritative.
    const denominator = 10_000n + basisPoints;
    const referencePriceKrw =
      (domesticPriceKrw * 20_000n + denominator) / (denominator * 2n);
    return Object.freeze({
      basisPoints,
      referencePriceKrw,
      retrievedAt: reference.retrievedAt,
    });
  }
}
