import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { serializeBigIntDecimal } from "../api/serialization";
import {
  archiveCompletedSettlement,
  clearSettlementHistory,
  createSettlementHistorySnapshot,
  deleteSettlementHistoryRecord,
  isSettlementComplete,
  listSettlementHistory,
} from "./settlementHistory";
import type { SettlementSession } from "./types";

function session(
  id: string,
  createdAt: string,
  status: "settled" | "pending" = "settled",
): SettlementSession {
  const settled = status === "settled";
  return {
    version: 2,
    id,
    inputMode: "krw",
    totalAmount: "50000",
    totalPeople: 2,
    excludePayer: true,
    invoiceCount: 1,
    lightningAddress: "receiver@example.com",
    overallNote: "저녁 식사",
    participantNameCandidates: ["민수"],
    priceSnapshot: {
      priceKrw: serializeBigIntDecimal(160_000_000n),
      source: "upbit",
      market: "KRW-BTC",
      observedAt: createdAt,
      retrievedAt: createdAt,
      snapshotAt: createdAt,
      fallbackUsed: false,
    },
    payerShareKrw: "25000",
    createdAt,
    issuedPaymentHashes: ["11".repeat(32)],
    slots: [
      {
        slotNumber: 1,
        krwShare: "25000",
        targetSats: "15625",
        attempt: 1,
        status,
        ...(settled
          ? {
              settledAt: "2030-08-31T12:05:00.000Z",
              settlementEvidence: {
                kind: "lud21" as const,
                checkedAt: "2030-08-31T12:05:00.000Z",
                preimagePresent: true as const,
              },
            }
          : {}),
        annotation: {
          displayName: "민수",
          note: "기기 메모",
          updatedAt: "2030-08-31T12:06:00.000Z",
        },
        invoice: {
          bolt11: "lnbc-secret-invoice",
          paymentHash: "11".repeat(32),
          timestampSeconds: 1_914_410_400,
          expirySeconds: 3_600,
          expiresAt: "2030-08-31T13:00:00.000Z",
          payeeNodeId: `02${"11".repeat(32)}`,
          featureBits: [],
          providerDomain: "wallet.example",
          verificationToken: `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
        },
      },
    ],
  };
}

describe("settlement history", () => {
  beforeEach(async () => clearSettlementHistory());

  it("creates a display-safe snapshot without payment secrets", () => {
    const record = createSettlementHistorySnapshot(
      session("one", "2030-08-31T12:00:00.000Z"),
      "2030-08-31T13:00:00.000Z",
    );
    const serialized = JSON.stringify(record);

    expect(record.slots[0]).toMatchObject({
      displayName: "민수",
      status: "settled",
      completedAt: "2030-08-31T12:05:00.000Z",
      invoiceExpiresAt: "2030-08-31T13:00:00.000Z",
    });
    expect(serialized).not.toContain("receiver@example.com");
    expect(serialized).not.toContain("lnbc-secret-invoice");
    expect(serialized).not.toContain("wallet.example");
    expect(serialized).not.toContain("verificationToken");
    expect(serialized).not.toContain("paymentHash");
  });

  it("does not archive a settlement while any participant is unfinished", async () => {
    const pending = session(
      "pending",
      "2030-08-31T12:00:00.000Z",
      "pending",
    );
    expect(isSettlementComplete(pending)).toBe(false);
    await expect(archiveCompletedSettlement(pending)).rejects.toThrow(
      "정산이 모두 완료되기 전에는",
    );
    expect(await listSettlementHistory()).toEqual([]);
  });

  it("archives only completed settlements and lists newest first", async () => {
    const older = session("older", "2030-08-01T12:00:00.000Z");
    const newer = session("newer", "2030-08-31T12:00:00.000Z");
    expect(isSettlementComplete(older)).toBe(true);

    await archiveCompletedSettlement(older);
    await archiveCompletedSettlement(newer);

    expect((await listSettlementHistory()).map((record) => record.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("deletes the selected completed history record", async () => {
    await archiveCompletedSettlement(
      session("delete-me", "2030-08-31T12:00:00.000Z"),
    );
    await deleteSettlementHistoryRecord("delete-me");
    expect(await listSettlementHistory()).toEqual([]);
  });
});
