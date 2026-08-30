import { afterEach, describe, expect, it, vi } from "vitest";

import type { BatchInvoiceRequestDto } from "../api/contracts";
import { ApiClientError, fetchSettlement, requestInvoiceBatch } from "./api";

const request: BatchInvoiceRequestDto = {
  requestId: "session-1",
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
  it("correlates reordered slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response([pendingSlot(2, "1001", 2), pendingSlot(1, "1000", 1)]),
      ),
    );

    const result = await requestInvoiceBatch(request);
    expect(result.slots.map((slot) => slot.slotNumber)).toEqual([1, 2]);
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
        requestId: "excluded-retry",
        address: request.address,
        slots: [request.slots[0]!],
        excludedPaymentHashes: [excluded.invoice.paymentHash],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("drops unknown legacy payment fields but keeps canonical BOLT11 payable", async () => {
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
      requestId: "legacy-fields",
      address: request.address,
      slots: [request.slots[0]!],
    });
    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { bolt11: slot.invoice.bolt11 },
    });
    if (result.slots[0]?.status !== "pending") throw new Error("pending");
    expect(result.slots[0].invoice.verificationToken).toBeUndefined();
    expect(result.slots[0].invoice.disposable).toBeUndefined();
  });

  it("replays an idempotent request once after a network failure", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        response([pendingSlot(1, "1000", 1), pendingSlot(2, "1001", 2)]),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(requestInvoiceBatch(request)).resolves.toMatchObject({
      completedCount: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body,
    );
  });

  it("turns malformed JSON into a stable user-facing API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502 })),
    );
    await expect(requestInvoiceBatch(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도하십시오.",
    });
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
      {
        ok: true,
        status: "settled",
        settled: true,
        checkedAt: "2030-01-01T00:00:00.000Z",
        providerStatus: "OK",
      },
      {
        ok: true,
        status: "settled",
        settled: true,
        checkedAt: "2030-01-01T00:00:00.000Z",
        preimagePresent: false,
        providerStatus: "OK",
      },
      {
        ok: true,
        status: "expired",
        settled: false,
        preimagePresent: false,
      },
    ];
    for (const value of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(value)),
      );
      await expect(
        fetchSettlement({
          verificationToken: `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
          paymentHash: "11".repeat(32),
          bolt11: "lnbc1test",
        }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
});
