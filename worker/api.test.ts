import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestBolt11 } from "../src/test/bolt11-fixture";
import worker, { handleApiRequest } from "./index";
import { network } from "./test/network";
import { sealVerificationContext } from "./verification";

const APP_ORIGIN = "https://app.example";
const DISCOVERY_URL = "https://wallet.example/.well-known/lnurlp/user";
const CALLBACK_URL = "https://wallet.example/callback";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_SECRET = "11".repeat(32);
const TEST_ENV = {
  INVOICE_RATE_LIMITER: env.INVOICE_RATE_LIMITER,
  SETTLEMENT_RATE_LIMITER: env.SETTLEMENT_RATE_LIMITER,
  VERIFICATION_TOKEN_SECRET: TEST_SECRET,
};

function apiRequest(
  path: string,
  body?: unknown,
): Request<unknown, IncomingRequestCfProperties> {
  return new IncomingRequest(`${APP_ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: APP_ORIGIN,
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mockDiscovery(commentAllowed = 40): void {
  network.use(
    http.get(DISCOVERY_URL, () =>
      HttpResponse.json({
        tag: "payRequest",
        callback: CALLBACK_URL,
        minSendable: 1_000,
        maxSendable: 100_000_000,
        metadata: '[["text/plain","test"]]',
        commentAllowed,
      }),
    ),
  );
}

async function callWorker(
  request: Request<unknown, IncomingRequestCfProperties>,
): Promise<{ response: Response }> {
  const response = await worker.fetch(request, TEST_ENV);
  return { response };
}

describe("Lightning Split Worker API", () => {
  beforeEach(async () => {
    await Promise.all([
      caches.default.delete(
        "https://cache.lightning-split.invalid/price/current",
      ),
      caches.default.delete(
        "https://cache.lightning-split.invalid/price/premium-reference",
      ),
    ]);
  });

  afterEach(() => vi.useRealTimers());

  it("returns an Upbit price snapshot and uses Bithumb fallback independently", async () => {
    const timestamp = Date.now();
    network.use(
      http.get("https://api.upbit.com/v1/ticker", ({ request }) =>
        HttpResponse.json([
          new URL(request.url).searchParams.get("markets") === "KRW-USDT"
            ? {
                market: "KRW-USDT",
                trade_price: 1_400,
                trade_timestamp: timestamp,
              }
            : {
                market: "KRW-BTC",
                trade_price: 120_000_000,
                trade_timestamp: timestamp,
              },
        ]),
      ),
      http.get("https://www.okx.com/api/v5/market/ticker", () =>
        HttpResponse.json({
          code: "0",
          data: [
            {
              instType: "SPOT",
              instId: "BTC-USDT",
              last: "80000",
              ts: String(timestamp),
            },
          ],
        }),
      ),
    );
    const primary = await callWorker(apiRequest("/api/price"));
    expect(primary.response.status).toBe(200);
    await expect(primary.response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: { source: "upbit", priceKrw: "120000000", fallbackUsed: false },
      premium: { basisPoints: "714" },
    });

    await caches.default.delete(
      "https://cache.lightning-split.invalid/price/current",
    );
    network.resetHandlers();
    network.use(
      http.get("https://api.upbit.com/v1/ticker", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get("https://api.bithumb.com/v1/ticker", () =>
        HttpResponse.json([
          {
            market: "KRW-BTC",
            trade_price: 121_000_000,
            trade_timestamp: timestamp,
          },
        ]),
      ),
    );
    const fallback = await callWorker(apiRequest("/api/price"));
    await expect(fallback.response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        source: "bithumb",
        priceKrw: "121000000",
        fallbackUsed: true,
      },
    });
  });

  it("returns a structured retryable price error when both sources fail", async () => {
    network.use(
      http.get("https://api.upbit.com/v1/ticker", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get("https://api.bithumb.com/v1/ticker", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );
    const { response } = await callWorker(apiRequest("/api/price"));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR", retryable: true },
    });
  });

  it("returns premium information through the KuCoin fallback when OKX fails", async () => {
    const timestamp = Date.now();
    network.use(
      http.get("https://api.upbit.com/v1/ticker", ({ request }) =>
        HttpResponse.json([
          new URL(request.url).searchParams.get("markets") === "KRW-USDT"
            ? {
                market: "KRW-USDT",
                trade_price: 1_400,
                trade_timestamp: timestamp,
              }
            : {
                market: "KRW-BTC",
                trade_price: 120_000_000,
                trade_timestamp: timestamp,
              },
        ]),
      ),
      http.get("https://www.okx.com/api/v5/market/ticker", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
      http.get("https://api.kucoin.com/api/v1/market/orderbook/level1", () =>
        HttpResponse.json({
          code: "200000",
          data: {
            time: timestamp,
            price: "80000",
          },
        }),
      ),
    );

    const { response } = await callWorker(apiRequest("/api/price"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      premium: { basisPoints: "714", referencePriceKrw: "112000000" },
    });
  });

  it("creates sequential anonymous invoices and preserves partial failures", async () => {
    mockDiscovery();
    let callbackCount = 0;
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        callbackCount += 1;
        if (callbackCount === 2) {
          return HttpResponse.json({
            status: "ERROR",
            reason: "temporary provider failure",
          });
        }
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: `worker-partial-${callbackCount}`,
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
          disposable: false,
        });
      }),
    );
    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        capabilities: { deferredSlots: true },
        slots: [1, 2, 3].map((slotNumber) => ({
          slotNumber,
          krwShare: "21500",
          targetSats: String(1_000 + slotNumber),
          attempt: 1,
        })),
      }),
    );
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      completedCount: 2,
      failedCount: 1,
      slots: [
        { status: "pending", slotNumber: 1 },
        { status: "failed", slotNumber: 2 },
        { status: "pending", slotNumber: 3 },
      ],
    });
    expect(callbackCount).toBe(3);
  });

  it("forwards the settlement note to every supported LNURL callback", async () => {
    mockDiscovery(255);
    const comments: (string | null)[] = [];
    let callbackCount = 0;
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        const url = new URL(request.url);
        comments.push(url.searchParams.get("comment"));
        const amountSats = BigInt(url.searchParams.get("amount")!) / 1_000n;
        callbackCount += 1;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: `worker-comment-${callbackCount}`,
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
          disposable: false,
        });
      }),
    );

    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [1, 2].map((slotNumber) => ({
          slotNumber,
          targetSats: "1000",
          attempt: 1,
        })),
        providerComment: "8/30 고깃집 저녁",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      provider: {
        commentStatus: "forwarded",
        descriptionStatus: "notEmbedded",
      },
    });
    expect(comments).toEqual(["8/30 고깃집 저녁", "8/30 고깃집 저녁"]);
  });

  it("defers later invoices when callback reuse is not explicitly supported", async () => {
    mockDiscovery();
    let callbackCount = 0;
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        callbackCount += 1;
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-disposable-default",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
        });
      }),
    );

    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        capabilities: { deferredSlots: true },
        slots: [1, 2, 3].map((slotNumber) => ({
          slotNumber,
          targetSats: "1000",
          attempt: 1,
        })),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      completedCount: 1,
      failedCount: 0,
      slots: [
        { status: "pending", slotNumber: 1 },
        { status: "deferred", slotNumber: 2 },
        { status: "deferred", slotNumber: 3 },
      ],
    });
    expect(callbackCount).toBe(1);
  });

  it("keeps deferred invoice batches parseable by an older cached PWA", async () => {
    mockDiscovery();
    let callbackCount = 0;
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        callbackCount += 1;
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-legacy-deferred",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
        });
      }),
    );

    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [1, 2].map((slotNumber) => ({
          slotNumber,
          targetSats: "1000",
          attempt: 1,
        })),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      completedCount: 1,
      failedCount: 1,
      slots: [
        { status: "pending", slotNumber: 1 },
        {
          status: "failed",
          slotNumber: 2,
          failure: { code: "INVOICE_DEFERRED", retryable: true },
        },
      ],
    });
    expect(callbackCount).toBe(1);
  });

  it("creates invoices without a comment when the provider does not support it", async () => {
    mockDiscovery(0);
    let callbackComment: string | null | undefined;
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        const url = new URL(request.url);
        callbackComment = url.searchParams.get("comment");
        const amountSats = BigInt(url.searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-comment-unsupported",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
        });
      }),
    );

    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "8/30 고깃집 저녁",
      }),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(callbackComment).toBeNull();
    expect(body).toMatchObject({
      ok: true,
      provider: { commentAllowed: 0 },
      completedCount: 1,
    });
  });

  it("keeps settlement working when a provider-specific comment limit is smaller", async () => {
    mockDiscovery(5);
    const callback = vi.fn();
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        callback();
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-overlong-provider-comment",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
          disposable: false,
        });
      }),
    );

    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "123456",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      provider: { commentAllowed: 5, commentStatus: "unsupported" },
      completedCount: 1,
    });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("keeps verify URLs sealed and settles without cache-local context", async () => {
    mockDiscovery();
    let invoice = "";
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        invoice = createTestBolt11({
          amountSats,
          fixtureId: "worker-settlement",
          timestamp: Math.floor(Date.now() / 1_000),
        }).invoice;
        return HttpResponse.json({
          pr: invoice,
          verify: "https://wallet.example/verify/one",
        });
      }),
      http.get("https://wallet.example/verify/one", () =>
        HttpResponse.json({ settled: true, pr: invoice }),
      ),
    );
    const batch = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
      }),
    );
    const batchBody = (await batch.response.json()) as {
      slots: [
        {
          invoice: {
            verificationToken: string;
            paymentHash: string;
            bolt11: string;
          };
        },
      ];
    };
    const serialized = JSON.stringify(batchBody);
    expect(serialized).not.toContain("wallet.example/verify");
    expect(batchBody.slots[0].invoice.verificationToken).toMatch(/^v1\./u);

    const settlement = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: batchBody.slots[0].invoice.verificationToken,
        paymentHash: batchBody.slots[0].invoice.paymentHash,
        bolt11: batchBody.slots[0].invoice.bolt11,
      }),
    );
    await expect(settlement.response.json()).resolves.toMatchObject({
      ok: true,
      status: "settled",
      settled: true,
    });

    const repeated = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: batchBody.slots[0].invoice.verificationToken,
        paymentHash: batchBody.slots[0].invoice.paymentHash,
        bolt11: batchBody.slots[0].invoice.bolt11,
      }),
    );
    await expect(repeated.response.json()).resolves.toMatchObject({
      ok: true,
      status: "settled",
    });
  });

  it("returns expired from authenticated token context without provider access", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "worker-expired-token",
      timestamp: Math.floor(now / 1_000),
      expirySeconds: 3_600,
    });
    const token = await sealVerificationContext(
      {
        verifyUrl: "https://wallet.example/verify/expired",
        expectedPaymentHash: fixture.paymentHash,
        expectedInvoice: fixture.invoice,
        expiresAt: new Date(now + 1_000).toISOString(),
      },
      TEST_SECRET,
      now,
    );
    vi.setSystemTime(now + 2_000);
    const result = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: token,
        paymentHash: fixture.paymentHash,
        bolt11: fixture.invoice,
      }),
    );
    expect(result.response.status).toBe(200);
    await expect(result.response.json()).resolves.toEqual({
      ok: true,
      status: "expired",
      settled: false,
    });
  });

  it("returns 429 for invoice and settlement limiter denials", async () => {
    const allow = { limit: () => Promise.resolve({ success: true }) };
    const deny = { limit: () => Promise.resolve({ success: false }) };
    const invoiceResponse = await handleApiRequest(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [],
      }),
      {
        INVOICE_RATE_LIMITER: deny,
        SETTLEMENT_RATE_LIMITER: allow,
        VERIFICATION_TOKEN_SECRET: TEST_SECRET,
      },
    );
    expect(invoiceResponse.status).toBe(429);
    expect(invoiceResponse.headers.get("retry-after")).toBe("60");
    await expect(invoiceResponse.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: "요청이 너무 많습니다. 잠시 후 다시 시도하십시오.",
      },
    });

    const settlementResponse = await handleApiRequest(
      apiRequest("/api/settlement", {}),
      {
        INVOICE_RATE_LIMITER: allow,
        SETTLEMENT_RATE_LIMITER: deny,
        VERIFICATION_TOKEN_SECRET: TEST_SECRET,
      },
    );
    expect(settlementResponse.status).toBe(429);
  });

  it("does not mistake Nostr zap support for a settlement verify capability", async () => {
    const allow = { limit: () => Promise.resolve({ success: true }) };
    network.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          tag: "payRequest",
          callback: CALLBACK_URL,
          minSendable: 1_000,
          maxSendable: 100_000_000,
          metadata: '[["text/plain","test"]]',
          commentAllowed: 40,
          allowsNostr: true,
          nostrPubkey: "02".repeat(32),
        }),
      ),
      http.get(CALLBACK_URL, ({ request }) => {
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-no-verify-secret",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
        });
      }),
    );
    const response = await handleApiRequest(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
      }),
      {
        INVOICE_RATE_LIMITER: allow,
        SETTLEMENT_RATE_LIMITER: allow,
        VERIFICATION_TOKEN_SECRET: "not-a-32-byte-key",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      provider: { automaticSettlementAvailable: false },
      slots: [{ status: "pending" }],
    });
  });

  it("fails closed when verify is offered but the sealing secret is invalid", async () => {
    const allow = { limit: () => Promise.resolve({ success: true }) };
    mockDiscovery();
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-verify-invalid-secret",
            timestamp: Math.floor(Date.now() / 1_000),
          }).invoice,
          verify: "https://wallet.example/verify/one",
        });
      }),
    );
    const response = await handleApiRequest(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
      }),
      {
        INVOICE_RATE_LIMITER: allow,
        SETTLEMENT_RATE_LIMITER: allow,
        VERIFICATION_TOKEN_SECRET: "not-a-32-byte-key",
      },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CONFIGURATION_ERROR" },
    });
  });

  it("rejects cross-origin and malformed DTO requests before provider access", async () => {
    const crossOrigin = new IncomingRequest(`${APP_ORIGIN}/api/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ address: "user@wallet.example", slots: [] }),
    });
    const first = await callWorker(crossOrigin);
    expect(first.response.status).toBe(400);

    const malformed = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: 1000, attempt: 1 }],
      }),
    );
    expect(malformed.response.status).toBe(400);
  });
});
