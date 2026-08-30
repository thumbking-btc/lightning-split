import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearActiveSession,
  loadActiveSession,
  restoreSession,
  saveActiveSession,
  serializeSession,
} from "./persistence";
import type { SettlementSession } from "./types";

const SESSION: SettlementSession = {
  version: 1,
  id: "saved-session",
  inputMode: "krw",
  totalAmount: "86003",
  totalPeople: 2,
  excludePayer: true,
  invoiceCount: 1,
  lightningAddress: "user@wallet.example",
  overallNote: "8/30 고깃집 저녁",
  providerCommentStatus: "forwarded",
  participantNameCandidates: ["민수", "철수"],
  createdAt: "2030-01-01T00:00:00.000Z",
  issuedPaymentHashes: ["11".repeat(32)],
  slots: [
    {
      slotNumber: 1,
      krwShare: "21500",
      targetSats: "13438",
      attempt: 1,
      status: "settled",
      settledAt: "2030-01-01T00:05:00.000Z",
      invoice: {
        bolt11: "lnbc-test",
        paymentHash: "11".repeat(32),
        timestampSeconds: 1_893_456_000,
        expirySeconds: 3_600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [],
        providerDomain: "wallet.example",
        verificationToken: `v1.${"a".repeat(16)}.${"b".repeat(32)}`,
      },
      annotation: {
        displayName: "철수",
        note: "사용자 표시",
        updatedAt: "2030-01-01T00:06:00.000Z",
      },
    },
  ],
};

describe("local settlement persistence", () => {
  beforeEach(async () => clearActiveSession());

  it("serializes and restores all minimum recovery fields", () => {
    expect(restoreSession(serializeSession(SESSION))).toEqual(SESSION);
    expect(() => restoreSession('{"version":2}')).toThrowError();
    const corrupted = JSON.parse(serializeSession(SESSION)) as {
      slots: Array<Record<string, unknown>>;
    };
    delete corrupted.slots[0]?.invoice;
    expect(() => restoreSession(JSON.stringify(corrupted))).toThrowError();
  });

  it("round-trips the active session through IndexedDB", async () => {
    await saveActiveSession(SESSION);
    await expect(loadActiveSession()).resolves.toEqual(SESSION);
    await clearActiveSession();
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("restores a manual confirmation as user-provided state", () => {
    const manual: SettlementSession = {
      ...SESSION,
      slots: [
        {
          ...SESSION.slots[0]!,
          status: "manuallyConfirmed",
          confirmedAt: "2030-01-01T00:05:00.000Z",
        },
      ],
    };
    expect(restoreSession(serializeSession(manual)).slots[0]).toMatchObject({
      status: "manuallyConfirmed",
      confirmedAt: "2030-01-01T00:05:00.000Z",
      annotation: { displayName: "철수" },
    });
  });

  it("restores the sats payer share without treating it as an invoice", () => {
    const satsSession: SettlementSession = {
      ...SESSION,
      inputMode: "sats",
      totalAmount: "3002",
      totalPeople: 3,
      invoiceCount: 2,
      payerShareSats: "1002",
      slots: [
        { ...SESSION.slots[0]!, slotNumber: 1, targetSats: "1000" },
        {
          ...SESSION.slots[0]!,
          slotNumber: 2,
          targetSats: "1000",
          invoice: {
            ...SESSION.slots[0]!.invoice!,
            paymentHash: "22".repeat(32),
          },
        },
      ],
    };

    const restored = restoreSession(serializeSession(satsSession));
    expect(restored.payerShareSats).toBe("1002");
    expect(restored.slots.map((slot) => slot.targetSats)).toEqual([
      "1000",
      "1000",
    ]);
  });

  it("restores queued invoices and partial comment delivery", () => {
    const queued: SettlementSession = {
      ...SESSION,
      providerCommentStatus: "partial",
      slots: [
        {
          slotNumber: 1,
          targetSats: "1000",
          attempt: 1,
          status: "queued",
        },
      ],
    };
    expect(restoreSession(serializeSession(queued))).toEqual(queued);
  });
});
