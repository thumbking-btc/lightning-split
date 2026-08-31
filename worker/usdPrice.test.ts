import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "./index";
import { network } from "./test/network";

const APP_ORIGIN = "https://app.example";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_ENV = {
  INVOICE_RATE_LIMITER: env.INVOICE_RATE_LIMITER,
  SETTLEMENT_RATE_LIMITER: env.SETTLEMENT_RATE_LIMITER,
  INVOICE_BATCHES: env.INVOICE_BATCHES,
  VERIFICATION_TOKEN_SECRET: "11".repeat(32),
};

function priceRequest(): Request<unknown, IncomingRequestCfProperties> {
  return new IncomingRequest(`${APP_ORIGIN}/api/price/usd`, {
    headers: { Accept: "application/json" },
  });
}

describe("BTC/USD Worker API", () => {
  beforeEach(async () => {
    await Promise.all([
      caches.default.delete(
        "https://cache.lightning-split.invalid/price/usd/current",
      ),
      caches.default.delete(
        "https://cache.lightning-split.invalid/price/usd/premium-reference",
      ),
    ]);
  });

  it("returns Coinbase BTC/USD with a Kraken premium reference", async () => {
    network.use(
      http.get(
        "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
        () =>
          HttpResponse.json({
            price: "101000.00",
            time: new Date(Date.now() - 1_000).toISOString(),
          }),
      ),
      http.get("https://api.kraken.com/0/public/Ticker", () =>
        HttpResponse.json({
          error: [],
          result: { XXBTZUSD: { c: ["100000.00", "0.1"] } },
        }),
      ),
    );

    const response = await worker.fetch(priceRequest(), TEST_ENV);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        source: "coinbase",
        market: "BTC-USD",
        priceUsdCents: "10100000",
        fallbackUsed: false,
      },
      premium: {
        basisPoints: "100",
        referencePriceUsdCents: "10000000",
      },
    });
  });

  it("falls back to Kraken when Coinbase is unavailable", async () => {
    network.use(
      http.get(
        "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
        () => HttpResponse.error(),
      ),
      http.get("https://api.kraken.com/0/public/Ticker", () =>
        HttpResponse.json({
          error: [],
          result: { XXBTZUSD: { c: ["99000.00", "0.1"] } },
        }),
      ),
    );

    const response = await worker.fetch(priceRequest(), TEST_ENV);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      snapshot: {
        source: "kraken",
        priceUsdCents: "9900000",
        fallbackUsed: true,
      },
    });
    expect(body).not.toHaveProperty("premium");
  });
});
