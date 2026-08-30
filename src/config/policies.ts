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
  /** Maximum accepted lifetime so replay state outlives every payable invoice. */
  readonly maximumInvoiceRemainingSeconds: number;
  readonly settlementFinalVerificationGraceSeconds: number;
  /** How long expired/reissued invoice evidence remains queryable for late settlement. */
  readonly settlementHistoricalRetentionSeconds: number;
  /** Maximum simultaneous callbacks to one Lightning Address provider. */
  readonly providerRequestConcurrency: number;
  readonly maximumBatchSize: number;
  readonly maximumProviderCommentCharacters: number;
}

export interface ApiRateLimitPolicy {
  readonly invoiceRetryAfterSeconds: number;
  readonly settlementRetryAfterSeconds: number;
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
    userAgent: "LightningSplit/0.2.0 (+BTC/KRW snapshot)",
  }),
});

export const DEFAULT_LIGHTNING_POLICY: Readonly<LightningPolicy> =
  Object.freeze({
    discoveryHttp: Object.freeze({
      timeoutMs: 5_000,
      maxRedirects: 2,
      maxResponseBytes: 192 * 1_024,
      userAgent: "LightningSplit/0.2.0 (+Lightning Address discovery)",
    }),
    callbackHttp: Object.freeze({
      timeoutMs: 7_000,
      maxRedirects: 2,
      maxResponseBytes: 65_536,
      userAgent: "LightningSplit/0.2.0 (+LNURL-pay invoice request)",
    }),
    settlementHttp: Object.freeze({
      timeoutMs: 4_000,
      maxRedirects: 2,
      maxResponseBytes: 32_768,
      userAgent: "LightningSplit/0.2.0 (+LUD-21 settlement check)",
    }),
    minimumInvoiceRemainingSeconds: 120,
    maximumInvoiceRemainingSeconds: 24 * 60 * 60,
    settlementFinalVerificationGraceSeconds: 60,
    settlementHistoricalRetentionSeconds: 7 * 24 * 60 * 60,
    providerRequestConcurrency: 3,
    maximumBatchSize: 20,
    maximumProviderCommentCharacters: 255,
  });

// The actual request limits live in wrangler.jsonc because Cloudflare enforces
// them at the binding. Keep these retry windows aligned with that configuration.
export const DEFAULT_API_RATE_LIMIT_POLICY: Readonly<ApiRateLimitPolicy> =
  Object.freeze({
    invoiceRetryAfterSeconds: 60,
    settlementRetryAfterSeconds: 60,
  });
