import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createTestBolt11 } from "../src/test/bolt11-fixture";
import worker from "./index";
import { network } from "./test/network";

const APP_ORIGIN = "https://app.example";
const DISCOVERY_URL = "https://wallet.example/.well-known/lnurlp/user";
const CALLBACK_URL = "https://wallet.example/callback";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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

function mockDiscovery(): void {
  network.use(
    http.get(DISCOVERY_URL, () =>
      HttpResponse.json({
        tag: "payRequest",
        callback: CALLBACK_URL,
        minSendable: 1_000,
        maxSendable: 100_000_000,
        metadata: '[["text/plain","test"]]',
        commentAllowed: 40,
      }),
    ),
  );
}

async function callWorker(
  request: Request<unknown, IncomingRequestCfProperties>,
): Promise<{ response: Response; ctx: ExecutionContext }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  return { response, ctx };
}

describe("Lightning Split Worker API", () => {
  beforeEach(async () => {
    await caches.default.delete(
      "https://cache.lightning-split.invalid/price/current",
    );
  });

  it("returns an Upbit price snapshot and uses Bithumb fallback independently", async () => {
    const timestamp = Date.now();
    network.use(
      http.get("https://api.upbit.com/v1/ticker", () =>
        HttpResponse.json([
          {
            market: "KRW-BTC",
            trade_price: 120_000_000,
            trade_timestamp: timestamp,
          },
        ]),
      ),
    );
    const primary = await callWorker(apiRequest("/api/price"));
    expect(primary.response.status).toBe(200);
    await expect(primary.response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: { source: "upbit", priceKrw: "120000000", fallbackUsed: false },
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
        });
      }),
    );
    const { response } = await callWorker(
      apiRequest("/api/invoices", {
        address: "user@wallet.example",
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

  it("keeps verify URLs server-side and settles through an opaque token", async () => {
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
      slots: [{ invoice: { verificationToken: string } }];
    };
    const serialized = JSON.stringify(batchBody);
    expect(serialized).not.toContain("wallet.example/verify");
    expect(batchBody.slots[0].invoice.verificationToken).toMatch(
      /^[0-9a-f-]{36}$/u,
    );

    const settlement = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: batchBody.slots[0].invoice.verificationToken,
      }),
    );
    await waitOnExecutionContext(settlement.ctx);
    await expect(settlement.response.json()).resolves.toMatchObject({
      ok: true,
      status: "settled",
      settled: true,
    });

    const repeated = await callWorker(
      apiRequest("/api/settlement", {
        verificationToken: batchBody.slots[0].invoice.verificationToken,
      }),
    );
    await expect(repeated.response.json()).resolves.toMatchObject({
      ok: true,
      status: "notAvailable",
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
