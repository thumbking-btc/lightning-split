import { afterEach, describe, expect, it, vi } from "vitest";

import type { BatchInvoiceRequestDto } from "../api/contracts";
import { ApiClientError, fetchSettlement, requestInvoiceBatch } from "./api";

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

  it("drops malformed optional payment capabilities but keeps canonical BOLT11 payable", async () => {
    const slot = pendingSlot(1, "1000", 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response([
          {
            ...slot,
            invoice: {
              ...slot.invoice,
              verificationToken: "legacy-uuid-or-invalid-token",
              paymentRequest: "bitcoin:?lightning=another-invoice",
              disposable: "unknown",
            },
          },
        ]),
      ),
    );

    const result = await requestInvoiceBatch({
      address: request.address,
      slots: [request.slots[0]!],
    });
    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { bolt11: slot.invoice.bolt11 },
    });
    if (result.slots[0]?.status !== "pending") throw new Error("pending");
    expect(result.slots[0].invoice.verificationToken).toBeUndefined();
    expect(result.slots[0].invoice.paymentRequest).toBeUndefined();
    expect(result.slots[0].invoice.disposable).toBeUndefined();
  });

  it("rejects contradictory or malformed settlement state", async () => {
    const cases = [
      { ok: true, status: "settled", settled: false },
      { ok: true, status: "unsettled", settled: true },
      {
        ok: true,
        status: "settled",
        settled: true,
        checkedAt: "not-a-date",
      },
    ];
    for (const value of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(value)),
      );
      await expect(
        fetchSettlement({
          verificationToken: `v1.${"a".repeat(16)}.${"b".repeat(32)}`,
          paymentHash: "11".repeat(32),
          bolt11: "lnbc1test",
        }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
});
