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
  version: 2,
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
      settlementEvidence: {
        kind: "lud21",
        checkedAt: "2030-01-01T00:05:00.000Z",
        preimagePresent: true,
        providerStatus: "PAID",
      },
      invoice: {
        bolt11: "lnbc-test",
        paymentHash: "11".repeat(32),
        timestampSeconds: 1_893_456_000,
        expirySeconds: 3_600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [],
        providerDomain: "wallet.example",
        verificationToken: `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
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
    const unverifiedSettlement = JSON.parse(serializeSession(SESSION)) as {
      slots: Array<Record<string, unknown>>;
    };
    delete unverifiedSettlement.slots[0]?.settlementEvidence;
    expect(() =>
      restoreSession(JSON.stringify(unverifiedSettlement)),
    ).toThrowError();
    const falsePreimage = JSON.parse(serializeSession(SESSION)) as {
      slots: Array<{ settlementEvidence?: { preimagePresent?: boolean } }>;
    };
    falsePreimage.slots[0]!.settlementEvidence!.preimagePresent = false;
    expect(() => restoreSession(JSON.stringify(falsePreimage))).toThrowError();
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
    await clearActiveSession(SESSION.id);
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("round-trips required LUD-21 settlement evidence", () => {
    expect(restoreSession(serializeSession(SESSION))).toEqual(SESSION);
  });

  it("preserves evidence-free v1 settlements for explicit review", () => {
    const legacy = JSON.parse(serializeSession(SESSION)) as {
      version: number;
      paymentDescriptionStatus?: string;
      slots: Array<Record<string, unknown>>;
      invoiceHistory?: Array<Record<string, unknown>>;
    };
    legacy.version = 1;
    legacy.paymentDescriptionStatus = "verified";
    (legacy as { issuedPaymentHashes?: string[] }).issuedPaymentHashes = [
      "11".repeat(32),
      "22".repeat(32),
    ];
    delete legacy.slots[0]!.settlementEvidence;
    legacy.invoiceHistory = [
      {
        slotNumber: 1,
        krwShare: "21500",
        targetSats: "13438",
        attempt: 2,
        invoice: {
          ...SESSION.slots[0]!.invoice,
          bolt11: "lnbc-legacy-history",
          paymentHash: "22".repeat(32),
        },
        retiredAt: "2030-01-01T00:06:00.000Z",
        settledAt: "2030-01-01T00:07:00.000Z",
      },
    ];

    const restored = restoreSession(JSON.stringify(legacy));

    expect(restored.version).toBe(2);
    expect(restored.slots[0]).toMatchObject({
      status: "legacyReviewRequired",
      legacySettlement: {
        source: "legacyUnknown",
        observedAt: "2030-01-01T00:05:00.000Z",
      },
    });
    expect(restored.slots[0]).not.toHaveProperty("settledAt");
    expect(restored.slots[0]).not.toHaveProperty("settlementEvidence");
    expect(restored.invoiceHistory?.[0]).toMatchObject({
      legacySettlement: {
        source: "legacyUnknown",
        observedAt: "2030-01-01T00:07:00.000Z",
      },
    });
    expect(restored.invoiceHistory?.[0]).not.toHaveProperty("settledAt");
    expect(restored).not.toHaveProperty("paymentDescriptionStatus");
  });

  it("moves the production v1 key into the isolated v2 key", async () => {
    const legacy = JSON.parse(serializeSession(SESSION)) as {
      version: number;
      slots: Array<Record<string, unknown>>;
    };
    legacy.version = 1;
    delete legacy.slots[0]!.settlementEvidence;
    const database = await openDB("lightning-split", 1);
    await database.put("settlements", JSON.stringify(legacy), "active");
    database.close();

    await expect(loadActiveSession()).resolves.toMatchObject({
      version: 2,
      slots: [{ status: "legacyReviewRequired" }],
    });

    const inspectionDatabase = await openDB("lightning-split", 1);
    await expect(
      inspectionDatabase.get("settlements", "active"),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse(
        String(await inspectionDatabase.get("settlements", "active-v2")),
      ),
    ).toMatchObject({ version: 2 });
    inspectionDatabase.close();
  });

  it("quarantines an unknown stored schema without destroying its payload", async () => {
    const database = await openDB("lightning-split", 1);
    await database.put("settlements", '{"version":99}', "active-v2");
    database.close();

    await expect(loadActiveSession()).resolves.toBeNull();

    const inspectionDatabase = await openDB("lightning-split", 1);
    await expect(
      inspectionDatabase.get("settlements", "active-v2"),
    ).resolves.toBeUndefined();
    await expect(
      inspectionDatabase.get("settlements", "quarantine-v2"),
    ).resolves.toBe('{"version":99}');
    inspectionDatabase.close();
  });

  it("rejects an invalid in-memory session before it reaches IndexedDB", async () => {
    const invalid = {
      ...SESSION,
      totalAmount: "43001",
    } as SettlementSession;

    await expect(saveActiveSession(invalid)).rejects.toThrow(/합계/u);
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("does not let an in-flight save resurrect a cleared session", async () => {
    const saving = saveActiveSession(SESSION);
    const clearing = clearActiveSession(SESSION.id);

    await Promise.all([saving, clearing]);
    await expect(loadActiveSession()).resolves.toBeNull();
  });

  it("rejects a stale-tab overwrite with an atomic revision check", async () => {
    await saveActiveSession(SESSION);
    const external: SettlementSession = {
      ...SESSION,
      slots: [
        {
          ...SESSION.slots[0]!,
          annotation: {
            displayName: "다른 탭",
            updatedAt: "2030-01-01T00:07:00.000Z",
          },
        },
      ],
    };
    const database = await openDB("lightning-split", 1);
    const revision = Number(await database.get("settlements", "revision-v2"));
    const transaction = database.transaction("settlements", "readwrite");
    await transaction.store.put(serializeSession(external), "active-v2");
    await transaction.store.put(revision + 1, "revision-v2");
    await transaction.done;
    database.close();

    await expect(saveActiveSession(SESSION)).rejects.toThrow(
      "다른 탭에서 정산 기록이 변경되었습니다.",
    );
    await expect(loadActiveSession()).resolves.toEqual(external);
  });

  it("does not let a stale tab delete a newer active session", async () => {
    await saveActiveSession(SESSION);
    const external: SettlementSession = {
      ...SESSION,
      id: "newer-session-from-another-tab",
      createdAt: "2030-01-01T00:10:00.000Z",
    };
    const database = await openDB("lightning-split", 1);
    const revision = Number(await database.get("settlements", "revision-v2"));
    const transaction = database.transaction("settlements", "readwrite");
    await transaction.store.put(serializeSession(external), "active-v2");
    await transaction.store.put(revision + 1, "revision-v2");
    await transaction.done;
    database.close();

    await expect(clearActiveSession(SESSION.id)).rejects.toThrow(
      "다른 탭에서 정산 기록이 변경되었습니다.",
    );
    await expect(loadActiveSession()).resolves.toEqual(external);
  });

  it("removes legacy UUID verification tokens without deleting the session", async () => {
    const legacy = JSON.parse(serializeSession(SESSION)) as {
      slots: Array<{ invoice?: { verificationToken?: string } }>;
    };
    legacy.slots[0]!.invoice!.verificationToken =
      "9b2168e2-f85c-4f69-ae09-7446f4afc4b1";

    const database = await openDB("lightning-split", 1);
    await database.put("settlements", JSON.stringify(legacy), "active-v2");
    database.close();

    const restored = await loadActiveSession();

    expect(restored?.slots[0]?.invoice?.verificationToken).toBeUndefined();
    expect(restored?.slots[0]).toMatchObject({
      status: "settled",
      invoice: { paymentHash: "11".repeat(32) },
    });

    const inspectionDatabase = await openDB("lightning-split", 1);
    const migrated = await inspectionDatabase.get("settlements", "active-v2");
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
    const {
      settledAt: _settledAt,
      settlementEvidence: _settlementEvidence,
      annotation: _annotation,
      ...unsettledSlot
    } = SESSION.slots[0]!;
    void _settledAt;
    void _settlementEvidence;
    void _annotation;
    const verifyingExpired: SettlementSession = {
      ...SESSION,
      slots: [{ ...unsettledSlot, status: "verifyingExpired" }],
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

  it("stores final verification as recoverable pending state", async () => {
    const {
      settledAt: _settledAt,
      settlementEvidence: _settlementEvidence,
      annotation: _annotation,
      ...unsettledSlot
    } = SESSION.slots[0]!;
    void _settledAt;
    void _settlementEvidence;
    void _annotation;
    const verifyingExpired: SettlementSession = {
      ...SESSION,
      slots: [{ ...unsettledSlot, status: "verifyingExpired" }],
    };

    await saveActiveSession(verifyingExpired);
    const database = await openDB("lightning-split", 1);
    const stored = String(await database.get("settlements", "active-v2"));
    database.close();

    expect(JSON.parse(stored)).toMatchObject({
      version: 2,
      slots: [{ status: "pending" }],
    });
  });

  it("restores a manual confirmation as user-provided state", () => {
    const {
      settledAt: _settledAt,
      settlementEvidence: _settlementEvidence,
      ...unsettledSlot
    } = SESSION.slots[0]!;
    void _settledAt;
    void _settlementEvidence;
    const manual: SettlementSession = {
      ...SESSION,
      slots: [
        {
          ...unsettledSlot,
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

  it("migrates legacy queued slots and removes obsolete payment metadata", () => {
    const queued = {
      ...SESSION,
      version: 1,
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
    expect(restoreSession(JSON.stringify(queued))).toMatchObject({
      providerCommentStatus: "partial",
      slots: [
        {
          status: "failed",
          failure: { code: "LEGACY_QUEUE_REMOVED", retryable: true },
        },
      ],
    });
    expect(restoreSession(JSON.stringify(queued))).not.toHaveProperty(
      "paymentDescriptionStatus",
    );
  });

  it("round-trips bounded historical invoice evidence", () => {
    const historical: SettlementSession = {
      ...SESSION,
      issuedPaymentHashes: ["11".repeat(32), "22".repeat(32), "33".repeat(32)],
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
            verificationToken: `v2.${"c".repeat(16)}.${"d".repeat(32)}`,
          },
          retiredAt: "2030-01-01T01:05:00.000Z",
          settledAt: "2030-01-01T01:06:00.000Z",
          settlementEvidence: {
            kind: "lud21" as const,
            checkedAt: "2030-01-01T01:06:00.000Z",
            preimagePresent: true as const,
            providerStatus: "PAID",
          },
        },
        {
          slotNumber: 1,
          krwShare: "21500",
          targetSats: "13438",
          attempt: 3,
          invoice: {
            ...SESSION.slots[0]!.invoice!,
            bolt11: "lnbc-manual-history",
            paymentHash: "33".repeat(32),
            verificationToken: `v2.${"e".repeat(16)}.${"f".repeat(32)}`,
          },
          retiredAt: "2030-01-01T02:05:00.000Z",
          confirmedAt: "2030-01-01T02:06:00.000Z",
        },
      ],
    };
    expect(restoreSession(serializeSession(historical))).toEqual(historical);

    const mixedEvidence = JSON.parse(serializeSession(historical)) as {
      invoiceHistory: Array<{
        settledAt?: string;
        settlementEvidence?: {
          kind: string;
          checkedAt: string;
          preimagePresent: boolean;
        };
      }>;
    };
    mixedEvidence.invoiceHistory[1]!.settledAt = "2030-01-01T02:07:00.000Z";
    mixedEvidence.invoiceHistory[1]!.settlementEvidence = {
      kind: "lud21",
      checkedAt: "2030-01-01T02:07:00.000Z",
      preimagePresent: true,
    };
    expect(() => restoreSession(JSON.stringify(mixedEvidence))).toThrowError();
  });

  it("treats a persisted awaiting invoice as display-ready after recovery", () => {
    const {
      settledAt: _settledAt,
      settlementEvidence: _settlementEvidence,
      annotation: _annotation,
      ...pendingSlot
    } = SESSION.slots[0]!;
    void _settledAt;
    void _settlementEvidence;
    void _annotation;
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
