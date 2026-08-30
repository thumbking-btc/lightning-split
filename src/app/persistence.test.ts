import "fake-indexeddb/auto";

import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";

import { serializeBigIntDecimal } from "../api/serialization";
import {
  clearActiveSession,
  loadActiveSession,
  recoverInterruptedSession,
  restoreSession,
  saveActiveSession,
  serializeSession,
} from "./persistence";
import type { SettlementSession } from "./types";

const SESSION: SettlementSession = {
  version: 1,
  id: "saved-session",
  inputMode: "krw",
  totalAmount: "43000",
  totalPeople: 2,
  excludePayer: true,
  invoiceCount: 1,
  lightningAddress: "user@wallet.example",
  overallNote: "8/30 고깃집 저녁",
  providerCommentStatus: "forwarded",
  priceSnapshot: {
    priceKrw: serializeBigIntDecimal(160_000_000n),
    source: "upbit",
    market: "KRW-BTC",
    observedAt: "2030-01-01T00:00:00.000Z",
    retrievedAt: "2030-01-01T00:00:01.000Z",
    snapshotAt: "2030-01-01T00:00:01.000Z",
    fallbackUsed: false,
  },
  payerShareKrw: "21500",
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
    const mismatchedTotal = JSON.parse(serializeSession(SESSION)) as {
      totalAmount: string;
    };
    mismatchedTotal.totalAmount = "43001";
    expect(() => restoreSession(JSON.stringify(mismatchedTotal))).toThrowError(
      /합계/u,
    );
  });

  it("round-trips the active session through IndexedDB", async () => {
    await saveActiveSession(SESSION);
    await expect(loadActiveSession()).resolves.toEqual(SESSION);
    await clearActiveSession();
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("does not destructively delete an unknown stored schema", async () => {
    const database = await openDB("lightning-split", 1);
    await database.put("settlements", '{"version":99}', "active");
    database.close();

    await expect(loadActiveSession()).resolves.toBeNull();

    const inspectionDatabase = await openDB("lightning-split", 1);
    await expect(inspectionDatabase.get("settlements", "active")).resolves.toBe(
      '{"version":99}',
    );
    inspectionDatabase.close();
  });

  it("does not let an in-flight save resurrect a cleared session", async () => {
    const saving = saveActiveSession(SESSION);
    const clearing = clearActiveSession();

    await Promise.all([saving, clearing]);
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("removes legacy UUID verification tokens without deleting the session", async () => {
    const legacy = JSON.parse(serializeSession(SESSION)) as {
      slots: Array<{ invoice?: { verificationToken?: string } }>;
    };
    legacy.slots[0]!.invoice!.verificationToken =
      "9b2168e2-f85c-4f69-ae09-7446f4afc4b1";

    const database = await openDB("lightning-split", 1);
    await database.put("settlements", JSON.stringify(legacy), "active");
    database.close();

    const restored = await loadActiveSession();

    expect(restored?.slots[0]?.invoice?.verificationToken).toBeUndefined();
    expect(restored?.slots[0]).toMatchObject({
      status: "settled",
      invoice: { paymentHash: "11".repeat(32) },
    });

    const inspectionDatabase = await openDB("lightning-split", 1);
    const migrated = await inspectionDatabase.get("settlements", "active");
    inspectionDatabase.close();
    expect(String(migrated)).not.toContain(
      "9b2168e2-f85c-4f69-ae09-7446f4afc4b1",
    );
  });

  it("recovers an interrupted generation as a retryable failure", () => {
    const interrupted: SettlementSession = {
      ...SESSION,
      issuedPaymentHashes: [],
      slots: [
        {
          slotNumber: 1,
          krwShare: "21500",
          targetSats: "13438",
          attempt: 2,
          status: "generating",
        },
      ],
    };

    const recovered = recoverInterruptedSession(interrupted);

    expect(recovered.slots[0]).toMatchObject({
      slotNumber: 1,
      attempt: 2,
      status: "failed",
      failure: {
        code: "GENERATION_INTERRUPTED",
        retryable: true,
      },
    });
    expect(recoverInterruptedSession(SESSION)).toBe(SESSION);
  });

  it("requires a sealed verification token while final verification is active", () => {
    const verifyingExpired: SettlementSession = {
      ...SESSION,
      slots: [{ ...SESSION.slots[0]!, status: "verifyingExpired" }],
    };
    expect(restoreSession(serializeSession(verifyingExpired))).toEqual(
      verifyingExpired,
    );

    const missingToken = JSON.parse(serializeSession(verifyingExpired)) as {
      slots: Array<{ invoice?: { verificationToken?: string } }>;
    };
    delete missingToken.slots[0]?.invoice?.verificationToken;
    expect(() => restoreSession(JSON.stringify(missingToken))).toThrowError();
  });

  it("stores final verification as backward-compatible v1 pending", async () => {
    const verifyingExpired: SettlementSession = {
      ...SESSION,
      slots: [{ ...SESSION.slots[0]!, status: "verifyingExpired" }],
    };

    await saveActiveSession(verifyingExpired);
    const database = await openDB("lightning-split", 1);
    const stored = String(await database.get("settlements", "active"));
    database.close();

    expect(JSON.parse(stored)).toMatchObject({
      version: 1,
      slots: [{ status: "pending" }],
    });
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
    const {
      priceSnapshot: _priceSnapshot,
      payerShareKrw: _payerShareKrw,
      ...sessionWithoutKrwFields
    } = SESSION;
    void _priceSnapshot;
    void _payerShareKrw;
    const { krwShare: _krwShare, ...slotWithoutKrwShare } = SESSION.slots[0]!;
    void _krwShare;
    const satsSession: SettlementSession = {
      ...sessionWithoutKrwFields,
      inputMode: "sats",
      totalAmount: "3002",
      totalPeople: 3,
      invoiceCount: 2,
      payerShareSats: "1002",
      issuedPaymentHashes: ["11".repeat(32), "22".repeat(32)],
      slots: [
        {
          ...slotWithoutKrwShare,
          slotNumber: 1,
          targetSats: "1000",
        },
        {
          ...slotWithoutKrwShare,
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
      paymentDescriptionStatus: "partial",
      slots: [
        {
          slotNumber: 1,
          krwShare: "21500",
          targetSats: "13438",
          attempt: 1,
          status: "queued",
        },
      ],
    };
    expect(restoreSession(serializeSession(queued))).toEqual(queued);
  });

  it("round-trips bounded historical invoice evidence", () => {
    const historical: SettlementSession = {
      ...SESSION,
      issuedPaymentHashes: ["11".repeat(32), "22".repeat(32)],
      invoiceHistory: [
        {
          slotNumber: 1,
          krwShare: "21500",
          targetSats: "13438",
          attempt: 2,
          invoice: {
            ...SESSION.slots[0]!.invoice!,
            bolt11: "lnbc-history",
            paymentHash: "22".repeat(32),
            verificationToken: `v1.${"c".repeat(16)}.${"d".repeat(32)}`,
          },
          retiredAt: "2030-01-01T01:05:00.000Z",
          settledAt: "2030-01-01T01:06:00.000Z",
        },
      ],
    };
    expect(restoreSession(serializeSession(historical))).toEqual(historical);
  });

  it("treats a persisted awaiting invoice as display-ready after recovery", () => {
    const { settledAt: _settledAt, ...pendingSlot } = SESSION.slots[0]!;
    void _settledAt;
    const awaiting: SettlementSession = {
      ...SESSION,
      slots: [
        {
          ...pendingSlot,
          status: "pending",
          invoice: {
            ...SESSION.slots[0]!.invoice!,
            awaitingPersistence: true,
          },
        },
      ],
    };
    const restored = restoreSession(serializeSession(awaiting));
    expect(restored.slots[0]?.invoice?.awaitingPersistence).toBe(true);
    expect(
      recoverInterruptedSession(restored).slots[0]?.invoice
        ?.awaitingPersistence,
    ).toBeUndefined();
  });
});
