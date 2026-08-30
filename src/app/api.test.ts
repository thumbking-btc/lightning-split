import { afterEach, describe, expect, it, vi } from "vitest";

import type { BatchInvoiceRequestDto } from "../api/contracts";
import { ApiClientError, requestInvoiceBatch } from "./api";

const request: BatchInvoiceRequestDto = {
  address: "user@wallet.example",
  slots: [
    { slotNumber: 1, targetSats: "1000", attempt: 1 },
    { slotNumber: 2, targetSats: "1001", attempt: 2 },
  ],
};

function pendingSlot(slotNumber: number, targetSats: string, attempt: number) {
  const byte = slotNumber.toString(16).padStart(2, "0");
  return {
    status: "pending",
    slotNumber,
    targetSats,
    attempt,
    invoice: {
      bolt11: `lnbc1${slotNumber === 1 ? "qqqq" : "pppp"}`,
      paymentHash: byte.repeat(32),
      timestampSeconds: 1_893_456_000,
      expirySeconds: 3_600,
      expiresAt: "2030-01-01T01:00:00.000Z",
      payeeNodeId: `02${byte.repeat(32)}`,
      featureBits: [],
      providerDomain: "wallet.example",
    },
  } as const;
}

function response(
  slots: readonly unknown[],
  overrides: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      ok: true,
      provider: {
        domain: "wallet.example",
        commentAllowed: 0,
      },
      slots,
      completedCount: slots.filter(
        (slot) =>
          typeof slot === "object" &&
          slot !== null &&
          "status" in slot &&
          slot.status === "pending",
      ).length,
      failedCount: 0,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("invoice API response correlation", () => {
  it("correlates reordered slots and derives an omitted optional capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response([pendingSlot(2, "1001", 2), pendingSlot(1, "1000", 1)]),
      ),
    );

    const result = await requestInvoiceBatch(request);
    expect(result.slots.map((slot) => slot.slotNumber)).toEqual([1, 2]);
    expect(result.provider.automaticSettlementAvailable).toBe(false);
  });

  it.each([
    {
      name: "missing slot",
      slots: [pendingSlot(1, "1000", 1)],
    },
    {
      name: "duplicate slot",
      slots: [pendingSlot(1, "1000", 1), pendingSlot(1, "1000", 1)],
    },
    {
      name: "wrong amount",
      slots: [pendingSlot(1, "999", 1), pendingSlot(2, "1001", 2)],
    },
    {
      name: "wrong attempt",
      slots: [pendingSlot(1, "1000", 2), pendingSlot(2, "1001", 2)],
    },
  ])("rejects a $name response", async ({ slots }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(slots)),
    );
    await expect(requestInvoiceBatch(request)).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });

  it("rejects an invoice excluded by a retry request", async () => {
    const excluded = pendingSlot(1, "1000", 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([excluded])),
    );
    await expect(
      requestInvoiceBatch({
        address: request.address,
        slots: [request.slots[0]!],
        excludedPaymentHashes: [excluded.invoice.paymentHash],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
