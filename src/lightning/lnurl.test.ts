import { describe, expect, it, vi } from "vitest";

import type { Fetcher } from "../infrastructure/http";
import { createTestBolt11 } from "../test/bolt11-fixture";
import { LnurlPayClient, normalizeLightningAddress } from "./lnurl";

function jsonFetcher(handler: (url: URL) => unknown): Fetcher {
  return vi.fn((input) =>
    Promise.resolve(
      new Response(JSON.stringify(handler(new URL(input.toString()))), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("Lightning Address and LNURL-pay", () => {
  it("normalizes an address into one HTTPS discovery URL", () => {
    expect(normalizeLightningAddress("User@Wallet.Example")).toEqual({
      address: "user@wallet.example",
      username: "user",
      domain: "wallet.example",
      discoveryUrl: "https://wallet.example/.well-known/lnurlp/user",
    });
    expect(() => normalizeLightningAddress("user@localhost")).toThrowError();
    expect(() =>
      normalizeLightningAddress("user!tag@wallet.example"),
    ).toThrowError();
  });

  it("parses metadata, payerData, comments and provider capabilities", async () => {
    const client = new LnurlPayClient(
      jsonFetcher(() => ({
        tag: "payRequest",
        callback: "https://wallet.example/callback",
        minSendable: 1_000,
        maxSendable: 10_000_000,
        metadata: '[["text/plain","test user"]]',
        payerData: { name: { mandatory: false } },
        commentAllowed: 40,
        allowsNostr: true,
        nostrPubkey: "11".repeat(32),
      })),
    );
    await expect(client.discover("user@wallet.example")).resolves.toMatchObject(
      {
        minSendableMsat: 1_000n,
        maxSendableMsat: 10_000_000n,
        commentAllowed: 40,
        allowsNostr: true,
        mandatoryPayerData: [],
      },
    );
  });

  it("accepts a LUD-06 discovery document containing a maximum-size image metadata entry", async () => {
    const image = "A".repeat(136_536);
    const metadata = JSON.stringify([
      ["text/plain", "test user"],
      ["image/png;base64", image],
    ]);
    const discoveryDocument = {
      tag: "payRequest",
      callback: "https://wallet.example/callback",
      minSendable: 1_000,
      maxSendable: 10_000_000,
      metadata,
    };
    const documentBytes = new TextEncoder().encode(
      JSON.stringify(discoveryDocument),
    ).byteLength;
    expect(documentBytes).toBeGreaterThan(65_536);
    expect(documentBytes).toBeLessThanOrEqual(192 * 1_024);
    const client = new LnurlPayClient(jsonFetcher(() => discoveryDocument));

    const discovery = await client.discover("user@wallet.example");
    expect(discovery.metadata).toBe(metadata);
    expect(discovery.metadataEntries[1]?.[1]).toBe(image);
  });

  it.each([
    [
      "duplicate text/plain",
      JSON.stringify([
        ["text/plain", "one"],
        ["text/plain", "two"],
      ]),
    ],
    [
      "multiple images",
      JSON.stringify([
        ["text/plain", "test"],
        ["image/png;base64", "AA=="],
        ["image/jpeg;base64", "AA=="],
      ]),
    ],
    [
      "oversized image",
      JSON.stringify([
        ["text/plain", "test"],
        ["image/png;base64", "A".repeat(136_537)],
      ]),
    ],
  ])(
    "rejects invalid LUD-06 metadata cardinality: %s",
    async (_label, metadata) => {
      const client = new LnurlPayClient(
        jsonFetcher(() => ({
          tag: "payRequest",
          callback: "https://wallet.example/callback",
          minSendable: 1_000,
          maxSendable: 10_000_000,
          metadata,
        })),
      );

      await expect(
        client.discover("user@wallet.example"),
      ).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    },
  );

  it("accepts a valid callback invoice above the legacy 1,200-character limit", async () => {
    const longInvoice = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "lnurl-long-invoice",
      description: "x".repeat(639),
    }).invoice;
    const client = new LnurlPayClient(
      jsonFetcher((url) =>
        url.pathname.includes("well-known")
          ? {
              tag: "payRequest",
              callback: "https://wallet.example/callback",
              minSendable: 1_000,
              maxSendable: 10_000_000,
              metadata: '[["text/plain","test user"]]',
            }
          : { pr: longInvoice },
      ),
    );

    const discovery = await client.discover("user@wallet.example");
    await expect(
      client.requestInvoice(discovery, 1_000n),
    ).resolves.toMatchObject({ invoice: longInvoice });
  });

  it("URL-encodes a supplied settlement note in the callback and preserves verify", async () => {
    const calls: URL[] = [];
    const fetcher = jsonFetcher((url) => {
      calls.push(url);
      if (url.pathname.includes("well-known")) {
        return {
          tag: "payRequest",
          callback: "https://wallet.example/callback?opaque=abc",
          minSendable: 1_000,
          maxSendable: 10_000_000,
          metadata: '[["text/plain","test"]]',
          commentAllowed: 40,
        };
      }
      return { pr: "lnbc-test", verify: "https://wallet.example/verify/one" };
    });
    const client = new LnurlPayClient(fetcher);
    const discovery = await client.discover("user@wallet.example");
    const invoice = await client.requestInvoice(discovery, 1_000n, {
      comment: "8/30 고깃집 저녁",
    });
    expect(calls[1]?.searchParams.get("opaque")).toBe("abc");
    expect(calls[1]?.searchParams.get("amount")).toBe("1000000");
    expect(calls[1]?.searchParams.get("comment")).toBe("8/30 고깃집 저녁");
    expect(calls[1]?.toString()).not.toContain("고깃집");
    expect(invoice.verifyUrl).toBe("https://wallet.example/verify/one");
    expect(invoice.commentSent).toBe(true);
    expect(invoice.disposable).toBe(true);
  });

  it.each([
    ["omitted", undefined, true],
    ["true", true, true],
    ["false", false, false],
  ] as const)(
    "does not gate repeated callback use when LUD-11 disposable is %s",
    async (_label, disposable, expectedDisposable) => {
      let callbackCount = 0;
      const fetcher = jsonFetcher((url) => {
        if (url.pathname.includes("well-known")) {
          return {
            tag: "payRequest",
            callback: "https://wallet.example/callback",
            minSendable: 1_000,
            maxSendable: 10_000_000,
            metadata: '[["text/plain","test"]]',
          };
        }
        callbackCount += 1;
        return {
          pr: `lnbc-test-${callbackCount}`,
          ...(disposable === undefined ? {} : { disposable }),
        };
      });
      const client = new LnurlPayClient(fetcher);
      const discovery = await client.discover("user@wallet.example");

      const invoices = [];
      for (let index = 0; index < 3; index += 1) {
        invoices.push(await client.requestInvoice(discovery, 1n));
      }

      expect(callbackCount).toBe(3);
      expect(invoices.map((invoice) => invoice.invoice)).toEqual([
        "lnbc-test-1",
        "lnbc-test-2",
        "lnbc-test-3",
      ]);
      expect(
        invoices.every((invoice) => invoice.disposable === expectedDisposable),
      ).toBe(true);
    },
  );

  it("keeps LUD-06 working when optional capabilities are malformed", async () => {
    const fetcher = jsonFetcher((url) =>
      url.pathname.includes("well-known")
        ? {
            tag: "payRequest",
            callback: "https://wallet.example/callback",
            minSendable: 1_000,
            maxSendable: 10_000_000,
            metadata:
              '[["text/plain","test"],["application/example",{"future":true}]]',
            payerData: {
              name: { mandatory: false },
              malformed: "ignored",
            },
            commentAllowed: "not-an-integer",
            allowsNostr: true,
            nostrPubkey: "bad",
          }
        : {
            pr: "lnbc-test",
            disposable: false,
            verify: "http://unsafe.example/verify",
          },
    );
    const client = new LnurlPayClient(fetcher);
    const discovery = await client.discover("user@wallet.example");
    expect(discovery).toMatchObject({
      commentAllowed: 0,
      allowsNostr: false,
      payerData: { name: { mandatory: false } },
    });
    expect(discovery.metadataEntries[1]?.[1]).toEqual({ future: true });
    await expect(client.requestInvoice(discovery, 1n)).resolves.toEqual({
      invoice: "lnbc-test",
      disposable: false,
      commentSent: false,
    });
  });

  it("rejects mandatory payerData and out-of-range amounts before callback", async () => {
    const fetcher = jsonFetcher((url) => {
      if (!url.pathname.includes("well-known"))
        throw new Error("callback must not run");
      return {
        tag: "payRequest",
        callback: "https://wallet.example/callback",
        minSendable: 10_000,
        maxSendable: 20_000,
        metadata: '[["text/plain","test"]]',
        payerData: { email: { mandatory: true } },
      };
    });
    const client = new LnurlPayClient(fetcher);
    const discovery = await client.discover("user@wallet.example");
    await expect(client.requestInvoice(discovery, 1n)).rejects.toMatchObject({
      code: "AMOUNT_OUT_OF_RANGE",
    });
    await expect(client.requestInvoice(discovery, 10n)).rejects.toMatchObject({
      code: "PAYER_DATA_REQUIRED",
    });
  });
});
