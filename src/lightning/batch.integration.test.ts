import { bech32 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { createTestBolt11 } from "../test/bolt11-fixture";
import { generateInvoiceBatch, type InvoiceSlotRequest } from "./batch";
import type {
  InvoiceRequestOptions,
  LnurlInvoiceResponse,
  LnurlPayClient,
  LnurlPayDiscovery,
} from "./lnurl";

const NOW_SECONDS = 1_900_000_100;
const ADDRESS = "user@wallet.example";
const COMMENT = "8/30 고깃집 저녁";

const DISCOVERY: LnurlPayDiscovery = {
  address: ADDRESS,
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
};

type InvoiceResult = Pick<LnurlInvoiceResponse, "invoice"> &
  Partial<Omit<LnurlInvoiceResponse, "invoice">>;

function slots(count: number, targetSats = 1_000n): InvoiceSlotRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    slotNumber: index + 1,
    targetSats: targetSats + BigInt(index),
    attempt: 1,
  }));
}

function sameAmountSlots(count: number, targetSats = 1_000n) {
  return slots(count).map((slot) => ({ ...slot, targetSats }));
}

function validInvoice(amountSats: bigint, fixtureId: string) {
  return createTestBolt11({
    amountSats,
    fixtureId,
    timestamp: NOW_SECONDS,
  });
}

function invalidateSignature(invoice: string): string {
  const decoded = bech32.decode(invoice, false);
  const words = [...decoded.words];
  const signatureStart = words.length - 104;
  const signature = Uint8Array.from(
    bech32.fromWords(words.slice(signatureStart)),
  );
  signature[64] = 4;
  words.splice(signatureStart, 104, ...bech32.toWords(signature));
  return bech32.encode(decoded.prefix, words, false);
}

function clientWith(
  requestInvoice: (
    discovery: LnurlPayDiscovery,
    amountSats: bigint,
    options: InvoiceRequestOptions,
  ) => Promise<InvoiceResult> | InvoiceResult,
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
      options: InvoiceRequestOptions = {},
    ): Promise<LnurlInvoiceResponse> => {
      const result = await requestInvoice(
        currentDiscovery,
        amountSats,
        options,
      );
      return {
        invoice: result.invoice,
        disposable: result.disposable ?? false,
        commentSent: result.commentSent ?? options.comment !== undefined,
        ...(result.verifyUrl === undefined
          ? {}
          : { verifyUrl: result.verifyUrl }),
        ...(result.successAction === undefined
          ? {}
          : { successAction: result.successAction }),
      };
    },
  );
  return { client: { discover, requestInvoice: callback }, discover, callback };
}

describe("invoice batch generation", () => {
  it("marks the boundary before any payable provider callback starts", async () => {
    const events: string[] = [];
    const mock = clientWith((_discovery, amountSats) => {
      events.push(`callback:${amountSats}`);
      return {
        invoice: validInvoice(amountSats, "issuance-boundary").invoice,
      };
    });
    mock.discover.mockImplementation(async () => {
      events.push("discover");
      return DISCOVERY;
    });

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1, 100n) },
      {
        client: mock.client,
        now: () => NOW_SECONDS * 1_000,
        onInvoiceRequestsStarting: () => {
          events.push("starting");
        },
      },
    );

    expect(result.completedCount).toBe(1);
    expect(events).toEqual(["discover", "starting", "callback:100"]);
  });

  it.each([
    "TIMEOUT",
    "NETWORK_ERROR",
    "HTTP_ERROR",
    "RESPONSE_TOO_LARGE",
    "INVALID_RESPONSE",
  ] as const)(
    "fails closed when a provider callback result is ambiguous: %s",
    async (code) => {
      const mock = clientWith(() =>
        Promise.reject(
          new InfrastructureError(code, "ambiguous callback", {
            retryable: true,
          }),
        ),
      );

      const result = await generateInvoiceBatch(
        { address: ADDRESS, slots: slots(1) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );

      expect(result.slots[0]).toMatchObject({
        status: "failed",
        failure: { code: "ISSUANCE_UNKNOWN", retryable: false },
      });
      expect(mock.callback).toHaveBeenCalledOnce();
    },
  );

  it("discovers once, caps callbacks at three, and preserves request order", async () => {
    const inputSlots = slots(8);
    let active = 0;
    let maximumActive = 0;
    const completionOrder: bigint[] = [];
    const mock = clientWith(async (_discovery, amountSats) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        const index = Number(amountSats - 1_000n);
        await new Promise((resolve) => setTimeout(resolve, (8 - index) * 3));
        completionOrder.push(amountSats);
        return {
          invoice: validInvoice(amountSats, `ordered-${amountSats}`).invoice,
        };
      } finally {
        active -= 1;
      }
    });

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: inputSlots },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(DEFAULT_LIGHTNING_POLICY.providerRequestConcurrency).toBe(3);
    expect(mock.discover).toHaveBeenCalledOnce();
    expect(mock.discover).toHaveBeenCalledWith(ADDRESS);
    expect(mock.callback).toHaveBeenCalledTimes(inputSlots.length);
    expect(maximumActive).toBe(
      DEFAULT_LIGHTNING_POLICY.providerRequestConcurrency,
    );
    expect(completionOrder).not.toEqual(
      inputSlots.map((slot) => slot.targetSats),
    );
    expect(result.slots.map((slot) => slot.slotNumber)).toEqual(
      inputSlots.map((slot) => slot.slotNumber),
    );
    expect(result.slots.map((slot) => slot.status)).toEqual(
      inputSlots.map(() => "pending"),
    );
  });

  it("isolates amount, expiry, and signature failures to their slots", async () => {
    const inputSlots = slots(5);
    const mock = clientWith((_discovery, amountSats) => {
      const slotNumber = Number(amountSats - 999n);
      if (slotNumber === 2) {
        return {
          invoice: validInvoice(amountSats + 1n, "wrong-amount").invoice,
        };
      }
      if (slotNumber === 3) {
        return {
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "expired",
            timestamp: NOW_SECONDS,
            expirySeconds:
              DEFAULT_LIGHTNING_POLICY.minimumInvoiceRemainingSeconds - 1,
          }).invoice,
        };
      }
      if (slotNumber === 4) {
        return {
          invoice: invalidateSignature(
            validInvoice(amountSats, "invalid-signature").invoice,
          ),
        };
      }
      return {
        invoice: validInvoice(amountSats, `valid-${slotNumber}`).invoice,
      };
    });

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: inputSlots },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "failed",
      "failed",
      "failed",
      "pending",
    ]);
    for (const slot of result.slots.slice(1, 4)) {
      expect(slot).toMatchObject({
        failure: { code: "INVALID_BOLT11", retryable: true },
      });
    }
    expect(result.completedCount).toBe(2);
    expect(result.failedCount).toBe(3);
    expect(mock.callback).toHaveBeenCalledTimes(inputSlots.length);
  });

  it("rejects a reused invoice and payment hash within one batch", async () => {
    const reused = validInvoice(1_000n, "batch-duplicate");
    const mock = clientWith(() => ({ invoice: reused.invoice }));

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: sameAmountSlots(2) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { paymentHash: reused.paymentHash },
    });
    expect(result.slots[1]).toMatchObject({
      status: "failed",
      failure: { code: "DUPLICATE_PAYMENT_HASH", retryable: true },
    });
  });

  it("rejects a payment hash issued by an earlier attempt", async () => {
    const reused = validInvoice(1_000n, "previous-duplicate");
    const mock = clientWith(() => ({ invoice: reused.invoice }));

    const result = await generateInvoiceBatch(
      {
        address: ADDRESS,
        slots: slots(1),
        excludedPaymentHashes: [reused.paymentHash],
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "DUPLICATE_PAYMENT_HASH", retryable: true },
    });
  });

  it("forwards one LUD-12 comment to every supported callback", async () => {
    const inputSlots = slots(3);
    const commentDiscovery = { ...DISCOVERY, commentAllowed: 255 };
    const mock = clientWith(
      (_discovery, amountSats) => ({
        invoice: validInvoice(amountSats, `comment-${amountSats}`).invoice,
      }),
      commentDiscovery,
    );

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: inputSlots, providerComment: COMMENT },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(mock.callback).toHaveBeenCalledTimes(inputSlots.length);
    for (const call of mock.callback.mock.calls) {
      expect(call[0]).toBe(commentDiscovery);
      expect(call[2]).toEqual({ comment: COMMENT });
    }
    expect(result.providerCommentStatus).toBe("forwarded");
    expect(
      result.slots.flatMap((slot) =>
        slot.status === "pending"
          ? [[slot.invoice.payerMemo, slot.invoice.payeeMemo] as const]
          : [],
      ),
    ).toEqual([
      ["none", "full"],
      ["none", "full"],
      ["none", "full"],
    ]);
  });

  it("recognizes the full settlement memo in both payer and payee paths", async () => {
    const commentDiscovery = { ...DISCOVERY, commentAllowed: 255 };
    const mock = clientWith(
      (_discovery, amountSats) => ({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "both-memos",
          timestamp: NOW_SECONDS,
          description: COMMENT,
        }).invoice,
      }),
      commentDiscovery,
    );

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1), providerComment: COMMENT },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { payerMemo: "full", payeeMemo: "full" },
    });
  });

  it("omits an unsupported LUD-12 comment and reports it", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: validInvoice(amountSats, "comment-unsupported").invoice,
    }));

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1), providerComment: COMMENT },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(mock.callback).toHaveBeenCalledWith(DISCOVERY, 1_000n, {});
    expect(result.providerCommentStatus).toBe("unsupported");
  });

  it("forwards a provider-sized memo prefix and reports partial delivery", async () => {
    const limitedDiscovery = { ...DISCOVERY, commentAllowed: 5 };
    const mock = clientWith(
      (_discovery, amountSats) => ({
        invoice: validInvoice(amountSats, "comment-truncated").invoice,
      }),
      limitedDiscovery,
    );

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1), providerComment: "가나다라마바사" },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(mock.callback).toHaveBeenCalledWith(limitedDiscovery, 1_000n, {
      comment: "가나다라마",
    });
    expect(result.providerCommentStatus).toBe("partial");
    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { payerMemo: "none", payeeMemo: "partial" },
    });
  });

  it("reports partial LUD-12 delivery across successful slots", async () => {
    const mock = clientWith(
      (_discovery, amountSats) => ({
        invoice: validInvoice(amountSats, `comment-partial-${amountSats}`)
          .invoice,
        commentSent: amountSats !== 1_001n,
      }),
      { ...DISCOVERY, commentAllowed: 255 },
    );

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(3), providerComment: COMMENT },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.providerCommentStatus).toBe("partial");
  });

  it("sets settlement status from each slot's LUD-21 capability", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: validInvoice(amountSats, `lud21-${amountSats}`).invoice,
      ...(amountSats === 1_000n
        ? { verifyUrl: "https://wallet.example/verify/one" }
        : {}),
    }));

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(2) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "pending",
      settlementCheck: { status: "notChecked" },
      invoice: { verifyUrl: "https://wallet.example/verify/one" },
    });
    expect(result.slots[1]).toMatchObject({
      status: "pending",
      settlementCheck: { status: "notAvailable" },
    });
  });

  it("rejects LUD-09 successAction when the raw payer cannot preserve it", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: validInvoice(amountSats, "success-action").invoice,
      successAction: { tag: "message", message: "paid" },
    }));

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "UNSUPPORTED_PAYMENT_FLOW", retryable: false },
    });
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(1);
  });

  it("accepts twenty slots and rejects twenty-one before provider I/O", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: validInvoice(amountSats, `capacity-${amountSats}`).invoice,
    }));

    const accepted = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(20) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(accepted.completedCount).toBe(20);
    expect(accepted.failedCount).toBe(0);
    expect(mock.discover).toHaveBeenCalledOnce();
    expect(mock.callback).toHaveBeenCalledTimes(20);

    await expect(
      generateInvoiceBatch(
        { address: ADDRESS, slots: slots(21) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mock.discover).toHaveBeenCalledOnce();
    expect(mock.callback).toHaveBeenCalledTimes(20);
  });

  it("rejects an invoice that loses required freshness before the response", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: createTestBolt11({
        amountSats,
        fixtureId: "stale-at-response",
        timestamp: NOW_SECONDS,
        expirySeconds:
          DEFAULT_LIGHTNING_POLICY.minimumInvoiceRemainingSeconds + 1,
      }).invoice,
    }));
    let clockCall = 0;

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1) },
      {
        client: mock.client,
        now: () => (NOW_SECONDS + (clockCall++ === 0 ? 0 : 2)) * 1_000,
      },
    );

    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "INVALID_BOLT11" },
    });
  });

  it("rejects an invoice whose lifetime exceeds the replay safety window", async () => {
    const mock = clientWith((_discovery, amountSats) => ({
      invoice: createTestBolt11({
        amountSats,
        fixtureId: "excessive-lifetime",
        timestamp: NOW_SECONDS,
        expirySeconds:
          DEFAULT_LIGHTNING_POLICY.maximumInvoiceRemainingSeconds + 1,
      }).invoice,
    }));

    const result = await generateInvoiceBatch(
      { address: ADDRESS, slots: slots(1) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "INVALID_BOLT11" },
    });
  });

  it.each([true, false])(
    "does not treat LUD-11 disposable=%s as a concurrency capability",
    async (disposable) => {
      const inputSlots = slots(6);
      let active = 0;
      let maximumActive = 0;
      const mock = clientWith(async (_discovery, amountSats) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 3));
          return {
            invoice: validInvoice(
              amountSats,
              `disposable-${disposable}-${amountSats}`,
            ).invoice,
            disposable,
          };
        } finally {
          active -= 1;
        }
      });

      const result = await generateInvoiceBatch(
        { address: ADDRESS, slots: inputSlots },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );

      expect(mock.discover).toHaveBeenCalledOnce();
      expect(mock.callback).toHaveBeenCalledTimes(inputSlots.length);
      expect(maximumActive).toBe(
        DEFAULT_LIGHTNING_POLICY.providerRequestConcurrency,
      );
      expect(result.slots).toHaveLength(inputSlots.length);
      expect(
        result.slots.every(
          (slot) =>
            slot.status === "pending" && slot.invoice.disposable === disposable,
        ),
      ).toBe(true);
    },
  );
});
