import { describe, expect, it } from "vitest";

import type { SettlementSession } from "./types";
import {
  isSlotPollable,
  nextPollingDelay,
  settlementInvoiceIdentity,
  transitionAfterSettlementCheck,
} from "./polling";

function pendingSession(expiresAt: string): SettlementSession {
  return {
    version: 1,
    id: "session",
    inputMode: "sats",
    totalAmount: "1000",
    totalPeople: 2,
    excludePayer: true,
    invoiceCount: 1,
    lightningAddress: "user@wallet.example",
    participantNameCandidates: [],
    createdAt: "2030-01-01T00:00:00.000Z",
    slots: [
      {
        slotNumber: 1,
        targetSats: "1000",
        attempt: 1,
        status: "pending",
        invoice: {
          bolt11: "lnbc-test",
          paymentHash: "11".repeat(32),
          timestampSeconds: 1_893_456_000,
          expirySeconds: 3_600,
          expiresAt,
          payeeNodeId: `02${"11".repeat(32)}`,
          featureBits: [],
          providerDomain: "wallet.example",
          verificationToken: `v1.${"a".repeat(16)}.${"b".repeat(32)}`,
        },
      },
    ],
  };
}

describe("settlement polling transitions", () => {
  it("moves pending to settled and stops polling it", () => {
    const session = pendingSession("2030-01-01T01:00:00.000Z");
    const identity = settlementInvoiceIdentity(session.slots[0]!)!;
    const transitioned = transitionAfterSettlementCheck(
      session,
      identity,
      {
        ok: true,
        status: "settled",
        settled: true,
        checkedAt: "2030-01-01T00:01:00.000Z",
      },
      new Date("2030-01-01T00:01:00.000Z"),
    );
    expect(transitioned.slots[0]?.status).toBe("settled");
    expect(
      isSlotPollable(
        transitioned.slots[0]!,
        Date.parse("2030-01-01T00:02:00.000Z"),
      ),
    ).toBe(false);
  });

  it("keeps an expired invoice in a final verification grace period", () => {
    const session = pendingSession("2030-01-01T00:00:00.000Z");
    const identity = settlementInvoiceIdentity(session.slots[0]!)!;
    const transitioned = transitionAfterSettlementCheck(
      session,
      identity,
      { ok: true, status: "unsettled", settled: false },
      new Date("2030-01-01T00:00:30.000Z"),
    );
    expect(transitioned.slots[0]?.status).toBe("verifyingExpired");
    expect(
      isSlotPollable(
        transitioned.slots[0]!,
        Date.parse("2030-01-01T00:00:30.000Z"),
      ),
    ).toBe(true);
    const expired = transitionAfterSettlementCheck(
      transitioned,
      identity,
      { ok: true, status: "unsettled", settled: false },
      new Date("2030-01-01T00:01:00.000Z"),
    );
    expect(expired.slots[0]?.status).toBe("expired");
    expect(expired.slots[0]?.invoice?.verificationToken).toBeUndefined();
    expect(
      isSlotPollable(expired.slots[0]!, Date.parse("2030-01-01T00:01:00.000Z")),
    ).toBe(false);
  });

  it("ignores a late response for a replaced invoice", () => {
    const original = pendingSession("2030-01-01T01:00:00.000Z");
    const identity = settlementInvoiceIdentity(original.slots[0]!)!;
    const replacement: SettlementSession = {
      ...original,
      slots: [
        {
          ...original.slots[0]!,
          attempt: 2,
          invoice: {
            ...original.slots[0]!.invoice!,
            paymentHash: "22".repeat(32),
            verificationToken: `v1.${"c".repeat(16)}.${"d".repeat(32)}`,
          },
        },
      ],
    };
    const result = transitionAfterSettlementCheck(
      replacement,
      identity,
      { ok: true, status: "settled", settled: true },
      new Date("2030-01-01T00:01:00.000Z"),
    );
    expect(result).toBe(replacement);
    expect(result.slots[0]?.status).toBe("pending");
  });

  it("caps error backoff instead of retrying rapidly forever", () => {
    expect(nextPollingDelay(0)).toBe(5_000);
    expect(nextPollingDelay(2)).toBe(13_000);
    expect(nextPollingDelay(100)).toBe(30_000);
    expect(nextPollingDelay(1, 60)).toBe(60_000);
  });
});
