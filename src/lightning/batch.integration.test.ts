import { describe, expect, it, vi } from "vitest";

import { InfrastructureError } from "../infrastructure/errors";
import { createTestBolt11 } from "../test/bolt11-fixture";
import { generateInvoiceBatch, type InvoiceSlotRequest } from "./batch";
import type { LnurlPayDiscovery, LnurlPayClient } from "./lnurl";

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
  ) => Promise<{ invoice: string; verifyUrl?: string }>,
): {
  readonly client: Pick<LnurlPayClient, "discover" | "requestInvoice">;
  readonly discover: ReturnType<typeof vi.fn>;
  readonly callback: ReturnType<typeof vi.fn>;
} {
  const discover = vi.fn(() => Promise.resolve(DISCOVERY));
  const callback = vi.fn(requestInvoice);
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
    expect(mock.discover).toHaveBeenCalledTimes(1);
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

  it("rejects a duplicate payment hash and does not request remaining callbacks", async () => {
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
      failure: { code: "BATCH_ABORTED" },
    });
    expect(mock.callback).toHaveBeenCalledTimes(2);
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

  it("stops after an invalid BOLT11 response", async () => {
    const mock = clientWith(() => Promise.resolve({ invoice: "lnbc-invalid" }));
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(2) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]).toMatchObject({
      failure: { code: "INVALID_BOLT11" },
    });
    expect(result.slots[1]).toMatchObject({
      failure: { code: "BATCH_ABORTED" },
    });
    expect(mock.callback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TIMEOUT", undefined],
    ["RATE_LIMITED", 30],
  ] as const)(
    "stops without hammering the provider after %s",
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
      expect(mock.callback).toHaveBeenCalledTimes(1);
    },
  );
});
