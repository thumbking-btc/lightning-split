import { describe, expect, it, vi } from "vitest";

import type { Fetcher } from "../infrastructure/http";
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
