/// <reference types="@cloudflare/workers-types" />

interface Env {
  readonly INVOICE_RATE_LIMITER: RateLimit;
  readonly SETTLEMENT_RATE_LIMITER: RateLimit;
}
