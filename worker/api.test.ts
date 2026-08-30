import { env } from "cloudflare:workers";
import { schnorr } from "@noble/curves/secp256k1.js";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIGHTNING_POLICY } from "../src/config/policies";
import { buildPaymentPayload } from "../src/app/paymentUri";
import { signNostrEvent } from "../src/nostr/event";
import {
  decodeLnurlPayUrl,
  parseAndValidateZapRequest,
} from "../src/nostr/zap";
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
  NIP57_RECEIPTS: env.NIP57_RECEIPTS,
  VERIFICATION_TOKEN_SECRET: TEST_SECRET,
};

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

  it("creates every invoice when LUD-11 disposable is omitted", async () => {
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
            fixtureId: `worker-disposable-default-${callbackCount}`,
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
      completedCount: 3,
      failedCount: 0,
      slots: [
        { status: "pending", slotNumber: 1 },
        { status: "pending", slotNumber: 2 },
        { status: "pending", slotNumber: 3 },
      ],
    });
    expect(callbackCount).toBe(3);
  });

  it("creates every invoice for older cached clients without capability negotiation", async () => {
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
            fixtureId: `worker-legacy-client-${callbackCount}`,
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
      completedCount: 2,
      failedCount: 0,
      slots: [
        { status: "pending", slotNumber: 1 },
        { status: "pending", slotNumber: 2 },
      ],
    });
    expect(callbackCount).toBe(2);
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

  it("performs one final provider verification during the post-expiry grace window", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "worker-final-expiry-check",
      timestamp: Math.floor(now / 1_000),
      expirySeconds: 3_600,
    });
    const verifyUrl = "https://wallet.example/verify/final";
    const verification = vi.fn(() =>
      HttpResponse.json({ settled: true, pr: fixture.invoice }),
    );
    network.use(http.get(verifyUrl, verification));
    const token = await sealVerificationContext(
      {
        verifyUrl,
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
    await expect(result.response.json()).resolves.toMatchObject({
      ok: true,
      status: "settled",
      settled: true,
    });
    expect(verification).toHaveBeenCalledOnce();
  });

  it("returns expired after the final verification grace window without provider access", async () => {
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
    vi.setSystemTime(
      now +
        1_001 +
        DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000,
    );
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

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-32-byte-key"],
  ] as const)(
    "preserves a payable invoice when the verification secret is %s",
    async (label, verificationTokenSecret) => {
      const allow = { limit: () => Promise.resolve({ success: true }) };
      mockDiscovery();
      network.use(
        http.get(CALLBACK_URL, ({ request }) => {
          const amountSats =
            BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
          return HttpResponse.json({
            pr: createTestBolt11({
              amountSats,
              fixtureId: `worker-verify-${label}-secret`,
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
          ...(verificationTokenSecret === undefined
            ? {}
            : { VERIFICATION_TOKEN_SECRET: verificationTokenSecret }),
        },
      );
      const body = (await response.json()) as {
        provider: { automaticSettlementAvailable: boolean };
        slots: { status: string; invoice: { verificationToken?: string } }[];
      };

      expect(response.status).toBe(200);
      expect(body.provider.automaticSettlementAvailable).toBe(false);
      expect(body.slots[0]?.status).toBe("pending");
      expect(body.slots[0]?.invoice.verificationToken).toBeUndefined();
    },
  );

  it("preserves a payable invoice when verification token sealing rejects its lifetime", async () => {
    const allow = { limit: () => Promise.resolve({ success: true }) };
    mockDiscovery();
    network.use(
      http.get(CALLBACK_URL, ({ request }) => {
        const amountSats =
          BigInt(new URL(request.url).searchParams.get("amount")!) / 1_000n;
        return HttpResponse.json({
          pr: createTestBolt11({
            amountSats,
            fixtureId: "worker-verify-token-lifetime",
            timestamp: Math.floor(Date.now() / 1_000),
            expirySeconds: 32 * 24 * 60 * 60,
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
        VERIFICATION_TOKEN_SECRET: TEST_SECRET,
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provider: { automaticSettlementAvailable: boolean };
      slots: { status: string; invoice: { verificationToken?: string } }[];
    };
    expect(body).toMatchObject({
      provider: { automaticSettlementAvailable: false },
      slots: [{ status: "pending" }],
    });
    expect(body.slots[0]?.invoice.verificationToken).toBeUndefined();
  });

  it("serves a payer-direct LNURL envelope with exact metadata and a LUD-09 transaction note", async () => {
    const metadata = '[["text/plain","Pay to test user"]]';
    let invoice = "";
    network.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          tag: "payRequest",
          callback: CALLBACK_URL,
          minSendable: 1_000,
          maxSendable: 100_000_000,
          metadata,
          commentAllowed: 255,
        }),
      ),
      http.get(CALLBACK_URL, ({ request }) => {
        expect(new URL(request.url).searchParams.get("comment")).toBe(
          "8/30 고깃집 저녁",
        );
        invoice = createTestBolt11({
          amountSats: 1_000n,
          fixtureId: "worker-payer-lnurl-envelope",
          timestamp: Math.floor(Date.now() / 1_000),
          descriptionHashSource: metadata,
        }).invoice;
        return HttpResponse.json({ pr: invoice, routes: [] });
      }),
    );

    const batch = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "8/30 고깃집 저녁",
      }),
    );
    const batchBody = (await batch.response.json()) as {
      slots: [{ invoice: { paymentRequest: string; bolt11: string } }];
    };
    const payUrl = decodeLnurlPayUrl(batchBody.slots[0].invoice.paymentRequest);
    expect(payUrl).toMatch(/^https:\/\/app\.example\/api\/pay\/[0-9a-f]{64}$/u);

    const discovery = await worker.fetch(
      new IncomingRequest(payUrl, { headers: { Accept: "application/json" } }),
      TEST_ENV,
    );
    const discoveryBody = (await discovery.json()) as {
      callback: string;
      metadata: string;
      minSendable: number;
      maxSendable: number;
    };
    expect(discoveryBody).toMatchObject({
      metadata,
      minSendable: 1_000_000,
      maxSendable: 1_000_000,
    });

    const callback = await worker.fetch(
      new IncomingRequest(`${discoveryBody.callback}?amount=1000000`, {
        headers: { Accept: "application/json" },
      }),
      TEST_ENV,
    );
    await expect(callback.json()).resolves.toEqual({
      pr: invoice,
      routes: [],
      disposable: true,
      successAction: { tag: "message", message: "8/30 고깃집 저녁" },
    });
  });

  it("preserves a downstream LUD-09 URL action through the payer-direct wrapper", async () => {
    const metadata = '[["text/plain","Pay to test user"]]';
    const downstreamActionUrl = "https://wallet.example/receipt/order-1";
    network.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          tag: "payRequest",
          callback: CALLBACK_URL,
          minSendable: 1_000,
          maxSendable: 100_000_000,
          metadata,
          commentAllowed: 255,
        }),
      ),
      http.get(CALLBACK_URL, () =>
        HttpResponse.json({
          pr: createTestBolt11({
            amountSats: 1_000n,
            fixtureId: "worker-payer-lnurl-action",
            timestamp: Math.floor(Date.now() / 1_000),
            descriptionHashSource: metadata,
          }).invoice,
          routes: [],
          successAction: {
            tag: "url",
            description: "영수증 열기",
            url: downstreamActionUrl,
          },
        }),
      ),
    );

    const batch = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "8/30 고깃집 저녁",
      }),
    );
    const batchBody = (await batch.response.json()) as {
      slots: [{ invoice: { paymentRequest: string } }];
    };
    const payUrl = decodeLnurlPayUrl(batchBody.slots[0].invoice.paymentRequest);
    const discovery = await worker.fetch(new IncomingRequest(payUrl), TEST_ENV);
    const discoveryBody = (await discovery.json()) as { callback: string };
    const callback = await worker.fetch(
      new IncomingRequest(`${discoveryBody.callback}?amount=1000000`),
      TEST_ENV,
    );
    const callbackBody = (await callback.json()) as {
      successAction: { tag: string; description: string; url: string };
    };
    expect(callbackBody.successAction).toMatchObject({
      tag: "url",
      description: "영수증 열기",
    });
    expect(callbackBody.successAction.url).toMatch(
      /^https:\/\/app\.example\/api\/pay\/[0-9a-f]{64}\/action$/u,
    );

    const action = await worker.fetch(
      new IncomingRequest(callbackBody.successAction.url),
      TEST_ENV,
    );
    expect(action.status).toBe(302);
    expect(action.headers.get("location")).toBe(downstreamActionUrl);
    expect(action.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not wrap an inline-description invoice as metadata-bound LNURL", async () => {
    const metadata = '[["text/plain","Pay to test user"]]';
    network.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          tag: "payRequest",
          callback: CALLBACK_URL,
          minSendable: 1_000,
          maxSendable: 100_000_000,
          metadata,
          commentAllowed: 255,
        }),
      ),
      http.get(CALLBACK_URL, () =>
        HttpResponse.json({
          pr: createTestBolt11({
            amountSats: 1_000n,
            fixtureId: "worker-inline-description-not-lnurl",
            timestamp: Math.floor(Date.now() / 1_000),
            description: "8/30 고깃집 저녁",
          }).invoice,
          routes: [],
        }),
      ),
    );

    const batch = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "8/30 고깃집 저녁",
      }),
    );
    const body = (await batch.response.json()) as {
      slots: [{ invoice: { bolt11: string; paymentRequest: string } }];
    };
    expect(body.slots[0].invoice.paymentRequest).toBe(
      buildPaymentPayload(body.slots[0].invoice.bolt11, "8/30 고깃집 저녁"),
    );
  });

  it.each([false, true])(
    "uses advertised NIP-57 receipts without a Lightning node (failing LUD-21: %s)",
    async (withFailingLud21) => {
      const providerSecret = Uint8Array.from({ length: 32 }, (_, index) =>
        index === 31 ? 7 : 0,
      );
      const providerPubkey = bytesToHex(schnorr.getPublicKey(providerSecret));
      const requests: ReturnType<typeof parseAndValidateZapRequest>[] = [];
      const invoices: string[] = [];
      const comments: (string | null)[] = [];
      network.use(
        http.get(DISCOVERY_URL, () =>
          HttpResponse.json({
            tag: "payRequest",
            callback: CALLBACK_URL,
            minSendable: 1_000,
            maxSendable: 100_000_000,
            metadata: '[["text/plain","Pay to test user"]]',
            commentAllowed: 255,
            allowsNostr: true,
            nostrPubkey: providerPubkey,
          }),
        ),
        http.get(CALLBACK_URL, ({ request }) => {
          const url = new URL(request.url);
          const requestJson = url.searchParams.get("nostr");
          const lnurl = url.searchParams.get("lnurl");
          if (!requestJson || !lnurl) {
            return HttpResponse.json(
              { status: "ERROR", reason: "zap request required" },
              { status: 422 },
            );
          }
          const parsed = parseAndValidateZapRequest(requestJson, {
            expectedLnurl: lnurl,
            expectedProviderPubkey: providerPubkey,
          });
          requests.push(parsed);
          comments.push(url.searchParams.get("comment"));
          const invoice = createTestBolt11({
            amountSats: parsed.amountMsat / 1_000n,
            fixtureId: `worker-nip57-${requests.length}`,
            timestamp: Math.floor(Date.now() / 1_000),
            descriptionHashSource: parsed.json,
          }).invoice;
          invoices.push(invoice);
          return HttpResponse.json({
            pr: invoice,
            routes: [],
            ...(withFailingLud21
              ? { verify: "https://wallet.example/verify/nip57" }
              : {}),
          });
        }),
        http.get("https://wallet.example/verify/nip57", () =>
          HttpResponse.json({}, { status: 503 }),
        ),
      );

      const batch = await callWorker(
        apiRequest("/api/invoices", {
          address: "user@wallet.example",
          slots: [1, 2].map((slotNumber) => ({
            slotNumber,
            targetSats: "92",
            attempt: 1,
          })),
          providerComment: "8/30 고깃집 저녁",
        }),
      );
      const body = (await batch.response.json()) as {
        provider: { automaticSettlementAvailable: boolean };
        slots: {
          invoice: {
            bolt11: string;
            paymentHash: string;
            paymentRequest: string;
            verificationToken: string;
          };
        }[];
      };
      expect(body.provider.automaticSettlementAvailable).toBe(true);
      expect(body.slots).toHaveLength(2);
      expect(new Set(body.slots.map((slot) => slot.invoice.bolt11)).size).toBe(
        2,
      );
      expect(
        new Set(body.slots.map((slot) => slot.invoice.paymentHash)).size,
      ).toBe(2);
      expect(
        body.slots.every((slot) =>
          slot.invoice.paymentRequest.startsWith("bitcoin:?lightning="),
        ),
      ).toBe(true);
      expect(comments).toEqual(["8/30 고깃집 저녁", "8/30 고깃집 저녁"]);
      expect(
        requests.every(
          (request) => request.event.pubkey !== request.recipientPubkey,
        ),
      ).toBe(true);

      const first = body.slots[0]!;
      const unsettled = await callWorker(
        apiRequest("/api/settlement", {
          verificationToken: first.invoice.verificationToken,
          paymentHash: first.invoice.paymentHash,
          bolt11: first.invoice.bolt11,
        }),
      );
      await expect(unsettled.response.json()).resolves.toMatchObject({
        status: "unsettled",
        settled: false,
        providerStatus: "NIP57_RECEIPT_PENDING",
      });

      const zapRequest = requests[0]!;
      const relayUrl = new URL(zapRequest.relays[0]!);
      const channel = relayUrl.pathname.split("/").at(-1)!;
      const receipt = signNostrEvent(
        {
          created_at: Math.floor(Date.now() / 1_000),
          kind: 9_735,
          tags: [
            ["p", zapRequest.recipientPubkey],
            ["P", zapRequest.event.pubkey],
            ["bolt11", invoices[0]!],
            ["description", zapRequest.json],
          ],
          content: "",
        },
        providerSecret,
      );
      const relay = TEST_ENV.NIP57_RECEIPTS.getByName(channel);
      const upgraded = await relay.fetch("https://relay.example/channel", {
        headers: { Upgrade: "websocket" },
      });
      const socket = upgraded.webSocket!;
      socket.accept();
      const forgedReceipt = signNostrEvent(
        {
          created_at: Math.floor(Date.now() / 1_000),
          kind: 9_735,
          tags: [
            ["p", zapRequest.recipientPubkey],
            ["P", zapRequest.event.pubkey],
            ["bolt11", invoices[0]!],
            ["description", zapRequest.json],
          ],
          content: "",
        },
        Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 9 : 0)),
      );
      const forgedAcknowledgement = new Promise<unknown>((resolve) => {
        socket.addEventListener(
          "message",
          (event) => resolve(JSON.parse(String(event.data)) as unknown),
          { once: true },
        );
      });
      socket.send(JSON.stringify(["EVENT", forgedReceipt]));
      await expect(forgedAcknowledgement).resolves.toEqual([
        "OK",
        forgedReceipt.id,
        false,
        "invalid: receipt does not match this payment",
      ]);

      const acknowledgement = new Promise<unknown>((resolve) => {
        socket.addEventListener(
          "message",
          (event) => resolve(JSON.parse(String(event.data)) as unknown),
          { once: true },
        );
      });
      socket.send(JSON.stringify(["EVENT", receipt]));
      await expect(acknowledgement).resolves.toEqual([
        "OK",
        receipt.id,
        true,
        "",
      ]);

      const settled = await callWorker(
        apiRequest("/api/settlement", {
          verificationToken: first.invoice.verificationToken,
          paymentHash: first.invoice.paymentHash,
          bolt11: first.invoice.bolt11,
        }),
      );
      await expect(settled.response.json()).resolves.toMatchObject({
        status: "settled",
        settled: true,
        preimagePresent: false,
        providerStatus: "NIP57_PROVIDER_ATTESTATION",
      });
    },
  );

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
