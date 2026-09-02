import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { serializeBigIntDecimal } from "../api/serialization";
import {
  applyLateSettlementTrackingResponse,
  archiveCompletedSettlement,
  clearSettlementHistory,
  createSettlementHistoryRecord,
  deleteSettlementHistoryRecord,
  listLateSettlementTrackingTargets,
  listSettlementHistory,
  selectLateSettlementTrackingTargets,
  type LateSettlementTrackingTarget,
} from "./settlementHistory";
import type { ClientInvoice, SettlementSession } from "./types";

const createdAt = "2030-08-31T12:00:00.000Z";
const expiresAt = "2030-08-31T13:00:00.000Z";

function invoice(
  marker: string,
  verificationToken = `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
): ClientInvoice {
  return {
    bolt11: `lnbc1${marker.repeat(30)}`,
    paymentHash: marker.repeat(64),
    timestampSeconds: 1_914_410_400,
    expirySeconds: 3_600,
    expiresAt,
    payeeNodeId: `02${marker.repeat(64)}`,
    featureBits: [],
    providerDomain: "wallet.example",
    verificationToken,
  };
}

function completedSession(
  id: string,
  status: "settled" | "manuallyConfirmed" = "settled",
): SettlementSession {
  const currentInvoice = invoice("1");
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
    issuedPaymentHashes: [currentInvoice.paymentHash],
    slots: [
      {
        slotNumber: 1,
        krwShare: "25000",
        targetSats: "15625",
        attempt: 2,
        status,
        ...(status === "settled"
          ? {
              settledAt: "2030-08-31T12:05:00.000Z",
              settlementEvidence: {
                kind: "lud21" as const,
                checkedAt: "2030-08-31T12:05:00.000Z",
                preimagePresent: true as const,
              },
            }
          : { confirmedAt: "2030-08-31T12:05:00.000Z" }),
        annotation: {
          displayName: "민수",
          note: "기기 메모",
          updatedAt: "2030-08-31T12:06:00.000Z",
        },
        invoice: currentInvoice,
      },
    ],
  };
}

describe("settlement history lifecycle", () => {
  beforeEach(async () => clearSettlementHistory());

  it("creates a display-safe record without Lightning payment secrets", () => {
    const record = createSettlementHistoryRecord(
      completedSession("privacy"),
      "2030-08-31T13:00:00.000Z",
    );
    const serialized = JSON.stringify(record);

    expect(record.slots[0]).toMatchObject({
      displayName: "민수",
      status: "settled",
      completedAt: "2030-08-31T12:05:00.000Z",
      invoiceExpiresAt: expiresAt,
    });
    expect(serialized).not.toContain("receiver@example.com");
    expect(serialized).not.toContain("lnbc1");
    expect(serialized).not.toContain("wallet.example");
    expect(serialized).not.toContain("verificationToken");
    expect(serialized).not.toContain("paymentHash");
  });

  it("refuses to archive a settlement while a participant is still pending", async () => {
    const session = completedSession("pending");
    const settledSlot = session.slots[0]!;
    const {
      settledAt: _settledAt,
      settlementEvidence: _settlementEvidence,
      ...pendingSlot
    } = settledSlot;
    void _settledAt;
    void _settlementEvidence;
    const pending: SettlementSession = {
      ...session,
      slots: [{ ...pendingSlot, status: "pending" }],
    };

    await expect(archiveCompletedSettlement(pending)).rejects.toThrow(
      "정산이 아직 진행 중입니다",
    );
    expect(await listSettlementHistory()).toEqual([]);
  });

  it("stores completed settlements newest first and allows record deletion", async () => {
    const older = {
      ...completedSession("older"),
      createdAt: "2030-08-01T12:00:00.000Z",
    };
    await archiveCompletedSettlement(older);
    await archiveCompletedSettlement(completedSession("newer"));

    expect((await listSettlementHistory()).map((record) => record.id)).toEqual([
      "newer",
      "older",
    ]);

    await deleteSettlementHistoryRecord("newer");
    expect((await listSettlementHistory()).map((record) => record.id)).toEqual([
      "older",
    ]);
  });

  it("continues tracking a replaced invoice after the completed settlement is archived", async () => {
    const session = completedSession("late-replaced");
    const retiredInvoice = invoice(
      "2",
      `v2.${"c".repeat(16)}.${"d".repeat(32)}`,
    );
    await archiveCompletedSettlement({
      ...session,
      invoiceHistory: [
        {
          slotNumber: 1,
          krwShare: "25000",
          targetSats: "15625",
          attempt: 1,
          invoice: retiredInvoice,
          retiredAt: "2030-08-31T12:01:00.000Z",
        },
      ],
    });

    const targets = await listLateSettlementTrackingTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      sessionId: "late-replaced",
      kind: "retired",
      slotNumber: 1,
      attempt: 1,
      paymentHash: retiredInvoice.paymentHash,
    });

    await applyLateSettlementTrackingResponse(targets[0]!, {
      ok: true,
      status: "settled",
      settled: true,
      checkedAt: "2030-08-31T12:30:00.000Z",
      preimagePresent: true,
      providerStatus: "PAID",
    });

    const [record] = await listSettlementHistory();
    expect(record?.slots[0]?.latePaymentWarningAt).toBe(
      "2030-08-31T12:30:00.000Z",
    );
    expect(await listLateSettlementTrackingTargets()).toEqual([]);
  });

  it("upgrades a manually confirmed completed record when LUD-21 later verifies it", async () => {
    await archiveCompletedSettlement(
      completedSession("manual-upgrade", "manuallyConfirmed"),
    );
    const targets = await listLateSettlementTrackingTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.kind).toBe("manual-current");

    await applyLateSettlementTrackingResponse(targets[0]!, {
      ok: true,
      status: "settled",
      settled: true,
      checkedAt: "2030-08-31T12:40:00.000Z",
      preimagePresent: true,
      providerStatus: "PAID",
    });

    const [record] = await listSettlementHistory();
    expect(record?.slots[0]).toMatchObject({
      status: "settled",
      completedAt: "2030-08-31T12:40:00.000Z",
    });
  });

  it("drops expired late-payment tracking context while keeping the safe history record", async () => {
    const session = completedSession("expired-tracker", "manuallyConfirmed");
    await archiveCompletedSettlement(session);

    expect(
      await listLateSettlementTrackingTargets(
        Date.parse(expiresAt) + 8 * 24 * 60 * 60 * 1_000,
      ),
    ).toEqual([]);
    expect((await listSettlementHistory()).map((record) => record.id)).toEqual([
      "expired-tracker",
    ]);
  });
});

describe("late settlement tracking scheduling", () => {
  it("rotates a bounded batch so later records are not starved", () => {
    const targets: LateSettlementTrackingTarget[] = Array.from(
      { length: 120 },
      (_, index) => ({
        sessionId: `session-${index.toString().padStart(3, "0")}`,
        kind: "retired",
        slotNumber: 1,
        attempt: index + 1,
        paymentHash: index.toString(16).padStart(64, "0"),
        bolt11: `lnbc1${"q".repeat(30)}${index}`,
        verificationToken: `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
        trackingExpiresAt: "2030-09-07T13:00:00.000Z",
      }),
    );

    const first = selectLateSettlementTrackingTargets(targets, 0);
    const second = selectLateSettlementTrackingTargets(targets, 60_000);

    expect(first).toHaveLength(60);
    expect(second).toHaveLength(60);
    expect(
      new Set([...first, ...second].map((target) => target.sessionId)).size,
    ).toBe(120);
  });
});
