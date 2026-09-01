import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestBolt11 } from "../src/test/bolt11-fixture";
import {
  INVOICE_CLIENT_PROTOCOL_HEADER,
  INVOICE_CLIENT_PROTOCOL_VERSION,
} from "../src/api/contracts";
import worker, { handleApiRequest } from "./index";
import { network } from "./test/network";

const APP_ORIGIN = "https://app.example";
const DISCOVERY_URL = "https://wallet.example/.well-known/lnurlp/user";
const CALLBACK_URL = "https://wallet.example/callback";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ALLOWING_RATE_LIMITER = {
  limit: () => Promise.resolve({ success: true }),
} as unknown as RateLimit;
const TEST_ENV = {
  INVOICE_RATE_LIMITER: ALLOWING_RATE_LIMITER,
  SETTLEMENT_RATE_LIMITER: ALLOWING_RATE_LIMITER,
  VERIFICATION_TOKEN_SECRET: "11".repeat(32),
};

function apiRequest(
  path: string,
  body?: unknown,
  origin = APP_ORIGIN,
  invoiceProtocol: string | null = INVOICE_CLIENT_PROTOCOL_VERSION,
): Request<unknown, IncomingRequestCfProperties> {
  return new IncomingRequest(`${APP_ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: origin,
            ...(path === "/api/invoices" && invoiceProtocol !== null
              ? {
                  [INVOICE_CLIENT_PROTOCOL_HEADER]: invoiceProtocol,
                }
              : {}),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function callWorker(
  request: Request<unknown, IncomingRequestCfProperties>,
): Promise<Response> {
  return worker.fetch(request, TEST_ENV);
}

function invoiceRequest(requestId: string, count = 2): Record<string, unknown> {
  return {
    requestId,
    address: "user@wallet.example",
    slots: Array.from({ length: count }, (_, index) => ({
      slotNumber: index + 1,
      targetSats: String(1_000 + index),
      attempt: 1,
    })),
  };
}

function mockInvoiceProvider(options?: {
  readonly verifyUrl?: string;
  readonly successAction?: unknown;
}): {
  readonly discovery: ReturnType<typeof vi.fn>;
  readonly callback: ReturnType<typeof vi.fn>;
  readonly preimages: ReadonlyMap<string, string>;
} {
  const preimages = new Map<string, string>();
  const discovery = vi.fn(() =>
    HttpResponse.json({
      tag: "payRequest",
      callback: CALLBACK_URL,
      minSendable: 1_000,
      maxSendable: 100_000_000,
      metadata: '[["text/plain","test"]]',
      commentAllowed: 255,
    }),
  );
  const callback = vi.fn((requestUrl: string) => {
    const amountSats =
      BigInt(new URL(requestUrl).searchParams.get("amount")!) / 1_000n;
    const preimage = amountSats.toString(16).padStart(64, "0");
    const fixture = createTestBolt11({
      amountSats,
      fixtureId: `worker-${amountSats}`,
      timestamp: Math.floor(Date.now() / 1_000),
      paymentPreimage: preimage,
    });
    preimages.set(fixture.paymentHash, preimage);
    return HttpResponse.json({
      pr: fixture.invoice,
      ...(options?.verifyUrl === undefined
        ? {}
        : { verify: options.verifyUrl }),
      ...(options?.successAction === undefined
        ? {}
        : { successAction: options.successAction }),
    });
  });
  network.use(
    http.get(DISCOVERY_URL, () => discovery()),
    http.get(CALLBACK_URL, ({ request }) => callback(request.url)),
  );
  return { discovery, callback, preimages };
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

  it("returns a current BTC/KRW snapshot", async () => {
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

    const response = await callWorker(apiRequest("/api/price"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: { source: "upbit", priceKrw: "120000000" },
    });
  });

  it("requires a same-origin WebSocket upgrade for the KRW live stream", async () => {
    const response = await callWorker(apiRequest("/api/market/krw/stream"));
    expect(response.status).toBe(426);

    const crossOrigin = await callWorker(
      new IncomingRequest(`${APP_ORIGIN}/api/market/krw/stream`, {
        headers: {
          Origin: "https://attacker.example",
          Upgrade: "websocket",
        },
      }),
    );
    expect(crossOrigin.status).toBe(400);
  });

  it("issues one raw BOLT11 payment path per slot with one discovery", async () => {
    const provider = mockInvoiceProvider({
      verifyUrl: "https://wallet.example/verify/batch",
    });
    const response = await callWorker(
      apiRequest("/api/invoices", {
        ...invoiceRequest("raw-bolt11-batch"),
        providerComment: "저녁 정산",
      }),
    );
    const body = (await response.json()) as {
      provider: { domain: string; commentStatus?: string };
      slots: Array<{ status: string; invoice: Record<string, unknown> }>;
    };

    expect(response.status).toBe(200);
    expect(provider.discovery).toHaveBeenCalledOnce();
    expect(provider.callback).toHaveBeenCalledTimes(2);
    expect(body.provider).toMatchObject({
      domain: "wallet.example",
      commentStatus: "forwarded",
    });
    expect(body.slots).toHaveLength(2);
    for (const slot of body.slots) {
      expect(slot.status).toBe("pending");
      expect(slot.invoice.bolt11).toMatch(/^lnbc/u);
      expect(slot.invoice.verificationToken).toMatch(/^v2\./u);
      expect(slot.invoice).not.toHaveProperty("paymentRequest");
    }
  });

  it("does not keep replay state between accepted invoice requests", async () => {
    const provider = mockInvoiceProvider();
    const request = invoiceRequest("stateless-repeat");
    const first = await callWorker(apiRequest("/api/invoices", request));
    const second = await callWorker(apiRequest("/api/invoices", request));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(provider.discovery).toHaveBeenCalledTimes(2);
    expect(provider.callback).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "missing", protocol: null },
    { name: "unsupported", protocol: "0" },
  ])(
    "rejects a $name invoice protocol before contacting the provider",
    async ({ protocol }) => {
      const provider = mockInvoiceProvider();
      const response = await callWorker(
        apiRequest(
          "/api/invoices",
          invoiceRequest(`old-client-${protocol ?? "missing"}`, 1),
          APP_ORIGIN,
          protocol,
        ),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: {
          code: "CLIENT_UPGRADE_REQUIRED",
          retryable: false,
        },
      });
      expect(provider.discovery).not.toHaveBeenCalled();
      expect(provider.callback).not.toHaveBeenCalled();
    },
  );

  it("allows a safe retry after discovery fails before any provider callback", async () => {
    const request = invoiceRequest("retry-after-discovery-failure", 1);
    network.use(http.get(DISCOVERY_URL, () => HttpResponse.error()));

    const failed = await callWorker(apiRequest("/api/invoices", request));
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR", retryable: true },
    });

    const provider = mockInvoiceProvider();
    const retried = await callWorker(apiRequest("/api/invoices", request));
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      ok: true,
      completedCount: 1,
      failedCount: 0,
    });
    expect(provider.discovery).toHaveBeenCalledOnce();
    expect(provider.callback).toHaveBeenCalledOnce();
  });

  it("fails closed when an older client omits the idempotency key", async () => {
    const legacyRequest = invoiceRequest("removed-idempotency-key", 1);
    delete legacyRequest.requestId;
    const response = await callWorker(
      apiRequest("/api/invoices", legacyRequest),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        retryable: false,
      },
    });
  });

  it("does not coordinate repeated request keys with different input", async () => {
    const provider = mockInvoiceProvider();
    const first = await callWorker(
      apiRequest("/api/invoices", invoiceRequest("legacy-correlation-key", 1)),
    );
    const second = await callWorker(
      apiRequest("/api/invoices", invoiceRequest("legacy-correlation-key", 2)),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(provider.discovery).toHaveBeenCalledTimes(2);
    expect(provider.callback).toHaveBeenCalledTimes(3);
  });

  it("rejects a provider flow whose success action cannot be preserved", async () => {
    mockInvoiceProvider({
      successAction: { tag: "message", message: "결제 후 표시" },
    });
    const response = await callWorker(
      apiRequest("/api/invoices", invoiceRequest("success-action-rejected", 1)),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completedCount: 0,
      failedCount: 1,
      slots: [
        {
          status: "failed",
          failure: { code: "UNSUPPORTED_PAYMENT_FLOW", retryable: false },
        },
      ],
    });
  });

  it("uses only a matching LUD-21 response for automatic settlement", async () => {
    const verifyUrl = "https://wallet.example/verify/settlement";
    const provider = mockInvoiceProvider({ verifyUrl });
    const batch = await callWorker(
      apiRequest("/api/invoices", invoiceRequest("lud21-settlement", 1)),
    );
    const batchBody = (await batch.json()) as {
      slots: Array<{
        invoice: {
          bolt11: string;
          paymentHash: string;
          verificationToken: string;
        };
      }>;
    };
    const invoice = batchBody.slots[0]!.invoice;
    network.use(
      http.get(verifyUrl, () =>
        HttpResponse.json({
          settled: true,
          pr: invoice.bolt11,
          preimage: provider.preimages.get(invoice.paymentHash),
        }),
      ),
    );

    const settled = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: invoice.verificationToken,
        paymentHash: invoice.paymentHash,
        bolt11: invoice.bolt11,
      }),
    );
    await expect(settled.json()).resolves.toMatchObject({
      ok: true,
      status: "settled",
      settled: true,
      preimagePresent: true,
    });
  });

  it("rejects a verification token linked to a different invoice", async () => {
    const verifyUrl = "https://wallet.example/verify/mismatch";
    mockInvoiceProvider({ verifyUrl });
    const batch = await callWorker(
      apiRequest("/api/invoices", invoiceRequest("token-mismatch", 1)),
    );
    const body = (await batch.json()) as {
      slots: Array<{
        invoice: {
          bolt11: string;
          paymentHash: string;
          verificationToken: string;
        };
      }>;
    };
    const invoice = body.slots[0]!.invoice;
    const response = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: invoice.verificationToken,
        paymentHash: "ff".repeat(32),
        bolt11: invoice.bolt11,
      }),
    );
    expect(response.status).toBe(400);
  });

  it.each(["/api/nostr/" + "ab".repeat(32), "/api/pay/" + "ab".repeat(32)])(
    "does not expose removed wrapper endpoint %s",
    async (path) => {
      const response = await callWorker(apiRequest(path));
      expect(response.status).toBe(404);
    },
  );

  it("rejects cross-origin invoice issuance", async () => {
    const response = await callWorker(
      apiRequest(
        "/api/invoices",
        invoiceRequest("cross-origin", 1),
        "https://attacker.example",
      ),
    );
    expect(response.status).toBe(400);
  });

  it("returns 429 when the invoice limiter denies the request", async () => {
    const response = await handleApiRequest(
      apiRequest("/api/invoices", invoiceRequest("limited", 1)),
      {
        ...TEST_ENV,
        INVOICE_RATE_LIMITER: {
          limit: () => Promise.resolve({ success: false }),
        },
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
