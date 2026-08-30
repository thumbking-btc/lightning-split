import { describe, expect, it, vi } from "vitest";

import { InfrastructureError } from "../infrastructure/errors";
import { createTestBolt11 } from "../test/bolt11-fixture";
import { generateInvoiceBatch, type InvoiceSlotRequest } from "./batch";
import type {
  InvoiceRequestOptions,
  LnurlPayDiscovery,
  LnurlPayClient,
} from "./lnurl";

const NOW_SECONDS = 1_900_000_100;
const DISCOVERY: LnurlPayDiscovery = {
  address: "user@wallet.example",
  username: "user",
  domain: "wallet.example",
  discoveryUrl: "https://wallet.example/.well-known/lnurlp/user",
  callbackUrl: "https://wallet.example/callback",
  minSendableMsat: 1_000n,
  maxSendableMsat: 100_000_000n,
  metadata: '[["text/plain","test"]]',
  metadataEntries: [["text/plain", "test"]],
  payerData: null,
  mandatoryPayerData: [],
  commentAllowed: 0,
  allowsNostr: false,
};

function slots(count: number): InvoiceSlotRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    slotNumber: index + 1,
    targetSats: 1_000n + BigInt(index),
    attempt: 1,
  }));
}

function clientWith(
  requestInvoice: (
    discovery: LnurlPayDiscovery,
    amountSats: bigint,
    options?: InvoiceRequestOptions,
  ) => Promise<{
    invoice: string;
    verifyUrl?: string;
    disposable?: boolean;
    commentSent?: boolean;
  }>,
  discovery: LnurlPayDiscovery = DISCOVERY,
): {
  readonly client: Pick<LnurlPayClient, "discover" | "requestInvoice">;
  readonly discover: ReturnType<typeof vi.fn>;
  readonly callback: ReturnType<typeof vi.fn>;
} {
  const discover = vi.fn(() => Promise.resolve(discovery));
  const callback = vi.fn(
    async (
      currentDiscovery: LnurlPayDiscovery,
      amountSats: bigint,
      options?: InvoiceRequestOptions,
    ) => {
      const result = await requestInvoice(
        currentDiscovery,
        amountSats,
        options,
      );
      return {
        disposable: result.disposable ?? false,
        commentSent: result.commentSent ?? options?.comment !== undefined,
        ...result,
      };
    },
  );
  return { client: { discover, requestInvoice: callback }, discover, callback };
}

describe("sequential invoice batch generation", () => {
  it("discovers once and produces N unique validated pending invoices sequentially", async () => {
    let active = 0;
    let maximumActive = 0;
    let call = 0;
    const mock = clientWith(async (_discovery, amountSats) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const current = ++call;
      await Promise.resolve();
      active -= 1;
      return {
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `success-${current}`,
        }).invoice,
        ...(current === 1
          ? { verifyUrl: `https://wallet.example/verify/${current}` }
          : {}),
      };
    });
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(5) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(mock.discover).toHaveBeenCalledTimes(5);
    expect(mock.callback).toHaveBeenCalledTimes(5);
    expect(maximumActive).toBe(1);
    expect(result.completedCount).toBe(5);
    const pending = result.slots.filter((slot) => slot.status === "pending");
    expect(new Set(pending.map((slot) => slot.invoice.bolt11)).size).toBe(5);
    expect(new Set(pending.map((slot) => slot.invoice.paymentHash)).size).toBe(
      5,
    );
    expect(pending[0]?.settlementCheck.status).toBe("notChecked");
    expect(pending[1]?.settlementCheck.status).toBe("notAvailable");
  });

  it("forwards the same settlement note to every callback when supported", async () => {
    let call = 0;
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: `comment-${++call}`,
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(3),
        providerComment: "8/30 고깃집 저녁",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(mock.callback).toHaveBeenCalledTimes(3);
    for (const callbackCall of mock.callback.mock.calls) {
      expect(callbackCall[2]).toEqual({ comment: "8/30 고깃집 저녁" });
    }
    expect(result.providerCommentStatus).toBe("forwarded");
    expect(result.paymentDescriptionStatus).toBe("notEmbedded");
  });

  it("detects when the provider embeds the payment description in BOLT11", async () => {
    const description = "8/30 고깃집 저녁";
    const direct = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "description-direct",
            description,
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );
    const directResult = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: direct.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(directResult.paymentDescriptionStatus).toBe("embedded");

    const metadata = `[["text/plain","${description}"]]`;
    const hashed = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "description-hash",
            descriptionHashSource: metadata,
          }).invoice,
        }),
      {
        ...DISCOVERY,
        metadata,
        metadataEntries: [["text/plain", description]],
        commentAllowed: 255,
      },
    );
    const hashedResult = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: hashed.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(hashedResult.paymentDescriptionStatus).toBe("embedded");
  });

  it("reports partial BOLT11 description binding per invoice", async () => {
    const description = "8/30 고깃집 저녁";
    let call = 0;
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: `description-partial-${++call}`,
            ...(call === 1 ? { description } : {}),
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );
    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(2),
        providerComment: description,
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.paymentDescriptionStatus).toBe("partial");
  });

  it("continues without a provider comment when comments are unsupported", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `unsupported-${amountSats}`,
        }).invoice,
      }),
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(2),
        providerComment: "8/30 고깃집 저녁",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.completedCount).toBe(2);
    expect(mock.callback).toHaveBeenCalledTimes(2);
    expect(mock.callback.mock.calls[0]?.[2]).toEqual({});
  });

  it("keeps settlement working when a provider-specific comment limit is smaller", async () => {
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "comment-too-long",
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 5 },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: "123456",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]?.status).toBe("pending");
    expect(result.providerCommentStatus).toBe("unsupported");
    expect(mock.callback).toHaveBeenCalledWith(
      { ...DISCOVERY, commentAllowed: 5 },
      1_000n,
      {},
    );
  });

  it("keeps successful slots and continues after an ordinary provider failure", async () => {
    let call = 0;
    const mock = clientWith((_discovery, amountSats) => {
      call += 1;
      if (call === 2) {
        return Promise.reject(
          new InfrastructureError(
            "PROVIDER_REJECTED",
            "temporary provider error",
            { retryable: true },
          ),
        );
      }
      return Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `partial-${call}`,
        }).invoice,
      });
    });
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(3) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "failed",
      "pending",
    ]);
    expect(mock.callback).toHaveBeenCalledTimes(3);
  });

  it("rejects duplicate payment hashes independently and still checks every slot", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "duplicate",
        }).invoice,
      }),
    );
    const sameAmounts = slots(3).map((slot) => ({
      ...slot,
      targetSats: 1_000n,
    }));
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: sameAmounts },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "failed",
      "failed",
    ]);
    expect(result.slots[1]).toMatchObject({
      failure: { code: "DUPLICATE_PAYMENT_HASH" },
    });
    expect(result.slots[2]).toMatchObject({
      failure: { code: "DUPLICATE_PAYMENT_HASH" },
    });
    expect(mock.callback).toHaveBeenCalledTimes(3);
  });

  it("rejects an invoice or payment hash reused by a slot retry", async () => {
    const reused = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "retry-reused",
    });
    const mock = clientWith(() => Promise.resolve({ invoice: reused.invoice }));
    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: [slots(1)[0]!],
        excludedPaymentHashes: [reused.paymentHash],
        excludedInvoices: [reused.invoice],
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "DUPLICATE_PAYMENT_HASH" },
    });
  });

  it("isolates invalid BOLT11 responses to their own slots", async () => {
    const mock = clientWith(() => Promise.resolve({ invoice: "lnbc-invalid" }));
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(2) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]).toMatchObject({
      failure: { code: "INVALID_BOLT11" },
    });
    expect(result.slots[1]).toMatchObject({
      failure: { code: "INVALID_BOLT11" },
    });
    expect(mock.callback).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["TIMEOUT", undefined],
    ["RATE_LIMITED", 30],
  ] as const)(
    "keeps slot failures independent after %s",
    async (code, retryAfterSeconds) => {
      const mock = clientWith(() =>
        Promise.reject(
          new InfrastructureError(code, "stop", {
            retryable: true,
            ...(retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds, upstreamStatus: 429 }),
          }),
        ),
      );
      const result = await generateInvoiceBatch(
        { address: "user@wallet.example", slots: slots(3) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );
      expect(result.slots[0]).toMatchObject({ failure: { code } });
      expect(
        result.slots.slice(1).every((slot) => slot.status === "failed"),
      ).toBe(true);
      expect(mock.callback).toHaveBeenCalledTimes(3);
    },
  );

  it("does not treat LUD-11 disposable as a callback or invoice concurrency capability", async () => {
    let call = 0;
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `disposable-${++call}`,
        }).invoice,
        disposable: true,
      }),
    );

    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(3) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(result.failedCount).toBe(0);
    expect(mock.discover).toHaveBeenCalledTimes(3);
    expect(mock.callback).toHaveBeenCalledTimes(3);
    const pending = result.slots.filter((slot) => slot.status === "pending");
    expect(new Set(pending.map((slot) => slot.invoice.bolt11)).size).toBe(3);
    expect(new Set(pending.map((slot) => slot.invoice.paymentHash)).size).toBe(
      3,
    );
  });
});
