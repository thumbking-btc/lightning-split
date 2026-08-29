export interface HttpFetchPolicy {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface PricePolicy {
  readonly cacheTtlMs: number;
  readonly maxObservationAgeMs: number;
  readonly maxRetrievalAgeMs: number;
  readonly maxFutureClockSkewMs: number;
  readonly http: HttpFetchPolicy;
}

export interface LightningPolicy {
  readonly discoveryHttp: HttpFetchPolicy;
  readonly callbackHttp: HttpFetchPolicy;
  readonly settlementHttp: HttpFetchPolicy;
  readonly minimumInvoiceRemainingSeconds: number;
  readonly maximumBatchSize: number;
}

export const DEFAULT_PRICE_POLICY: Readonly<PricePolicy> = Object.freeze({
  cacheTtlMs: 10_000,
  maxObservationAgeMs: 60_000,
  maxRetrievalAgeMs: 15_000,
  maxFutureClockSkewMs: 30_000,
  http: Object.freeze({
    timeoutMs: 3_000,
    maxRedirects: 0,
    maxResponseBytes: 32_768,
    userAgent: "LightningSplit/0.1 (+BTC/KRW snapshot)",
  }),
});

export const DEFAULT_LIGHTNING_POLICY: Readonly<LightningPolicy> =
  Object.freeze({
    discoveryHttp: Object.freeze({
      timeoutMs: 5_000,
      maxRedirects: 2,
      maxResponseBytes: 65_536,
      userAgent: "LightningSplit/0.1 (+Lightning Address discovery)",
    }),
    callbackHttp: Object.freeze({
      timeoutMs: 7_000,
      maxRedirects: 2,
      maxResponseBytes: 65_536,
      userAgent: "LightningSplit/0.1 (+LNURL-pay invoice request)",
    }),
    settlementHttp: Object.freeze({
      timeoutMs: 4_000,
      maxRedirects: 2,
      maxResponseBytes: 32_768,
      userAgent: "LightningSplit/0.1 (+LUD-21 settlement check)",
    }),
    minimumInvoiceRemainingSeconds: 120,
    maximumBatchSize: 10,
  });
