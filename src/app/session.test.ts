import { describe, expect, it } from "vitest";

import {
  serializeBigIntDecimal,
  type PriceSnapshotDto,
} from "../api/serialization";
import {
  annotateSettledSlot,
  applyBatchResponse,
  applySlotRetryResponse,
  collectIssuedPaymentHashes,
  createGeneratingSession,
  createSettlementPreview,
  getSettlementProgress,
  manuallyConfirmSlot,
  markExpiredSlots,
  prepareQueuedSlot,
  prepareSlotRetry,
  type DraftInput,
} from "./session";
import type { SettlementSession } from "./types";

const SNAPSHOT: PriceSnapshotDto = {
  priceKrw: serializeBigIntDecimal(100_000_000n),
  source: "upbit",
  market: "KRW-BTC",
  observedAt: "2030-01-01T00:00:00.000Z",
  retrievedAt: "2030-01-01T00:00:01.000Z",
  snapshotAt: "2030-01-01T00:00:01.000Z",
  fallbackUsed: false,
};

describe("mobile settlement session", () => {
  it("uses the approved KRW default flow and payer remainder policy", () => {
    const draft: DraftInput = {
      inputMode: "krw",
      totalAmount: "86003",
      totalPeople: 4,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    };
    const preview = createSettlementPreview(draft, SNAPSHOT);
    expect(preview.invoiceShares).toEqual([21_500n, 21_500n, 21_500n]);
    expect(preview.payerShareKrw).toBe(21_503n);
    expect(preview.targetSats).toEqual([21_500n, 21_500n, 21_500n]);
  });

  it("treats the sats input as the group total and excludes the payer share", () => {
    const preview = createSettlementPreview({
      inputMode: "sats",
      totalAmount: "50003",
      totalPeople: 5,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    });
    expect(preview.targetSats).toEqual([10_000n, 10_000n, 10_000n, 10_000n]);
    expect(preview.payerShareSats).toBe(10_003n);
    expect(preview.targetSats.reduce((sum, amount) => sum + amount, 0n)).toBe(
      40_000n,
    );
  });

  it("stores the sats payer share separately from anonymous invoice slots", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "3002",
      totalPeople: 3,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    };
    const session = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );

    expect(session.payerShareSats).toBe("1002");
    expect(session.slots.map((slot) => slot.targetSats)).toEqual([
      "1000",
      "1000",
    ]);
  });

  it("advances a restored legacy queued slot only after the active invoice finishes", () => {
    const base: SettlementSession = {
      version: 1,
      id: "queued",
      inputMode: "sats",
      totalAmount: "3000",
      totalPeople: 3,
      excludePayer: false,
      invoiceCount: 3,
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
            bolt11: "lnbc1first",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
          },
        },
        {
          slotNumber: 2,
          targetSats: "1000",
          attempt: 1,
          status: "queued",
        },
        {
          slotNumber: 3,
          targetSats: "1000",
          attempt: 1,
          status: "queued",
        },
      ],
    };
    expect(() => prepareQueuedSlot(base, 2)).toThrowError();
    const ready = {
      ...base,
      slots: [
        { ...base.slots[0]!, status: "manuallyConfirmed" as const },
        base.slots[1]!,
        base.slots[2]!,
      ],
    };
    const prepared = prepareQueuedSlot(ready, 2);
    expect(prepared.slots.map((slot) => slot.status)).toEqual([
      "manuallyConfirmed",
      "generating",
      "queued",
    ]);
  });

  it.each([
    [40, undefined],
    [0, "unsupported"],
  ] as const)(
    "records provider comment delivery status for commentAllowed=%i",
    (commentAllowed, expectedStatus) => {
      const draft: DraftInput = {
        inputMode: "sats",
        totalAmount: "2000",
        totalPeople: 2,
        excludePayer: true,
        lightningAddress: "user@wallet.example",
        overallNote: "8/30 고깃집 저녁",
        participantNameCandidates: [],
      };
      const generating = createGeneratingSession(
        draft,
        createSettlementPreview(draft),
        undefined,
      );
      const applied = applyBatchResponse(generating, {
        ok: true,
        provider: {
          domain: "wallet.example",
          commentAllowed,
          descriptionStatus: "notEmbedded",
          automaticSettlementAvailable: false,
        },
        slots: [
          {
            status: "failed",
            slotNumber: 1,
            targetSats: "1000",
            attempt: 1,
            failure: {
              code: "PROVIDER_REJECTED",
              message: "failed",
              retryable: true,
            },
          },
        ],
        completedCount: 0,
        failedCount: 1,
      });

      expect(applied.providerCommentStatus).toBe(expectedStatus);
      expect(applied.paymentDescriptionStatus).toBe("notEmbedded");
    },
  );

  it("keeps participant candidates separate from anonymous invoice slots", () => {
    const draft: DraftInput = {
      inputMode: "krw",
      totalAmount: "40000",
      totalPeople: 4,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: ["민수", "철수", "영희"],
    };
    const session = createGeneratingSession(
      draft,
      createSettlementPreview(draft, SNAPSHOT),
      SNAPSHOT,
    );
    expect(session.participantNameCandidates).toEqual(["민수", "철수", "영희"]);
    expect(session.slots.every((slot) => slot.annotation === undefined)).toBe(
      true,
    );
    expect(session.slots.map((slot) => slot.slotNumber)).toEqual([1, 2, 3]);
  });

  it("adds user display metadata only after a slot is settled", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: ["철수"],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    expect(
      annotateSettledSlot(generating, 1, { displayName: "철수", note: "표시" })
        .slots[0]?.annotation,
    ).toBeUndefined();
    const settled = {
      ...generating,
      slots: generating.slots.map((slot) => ({
        ...slot,
        status: "settled" as const,
        settledAt: "2030-01-01T00:00:00.000Z",
      })),
    };
    const annotated = annotateSettledSlot(settled, 1, {
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]?.annotation).toMatchObject({
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]).not.toHaveProperty("payerIdentity");
  });

  it("reissues only failed or expired slots and increments the attempt", () => {
    const base: SettlementSession = {
      version: 1,
      id: "retry",
      inputMode: "sats",
      totalAmount: "2000",
      totalPeople: 3,
      excludePayer: true,
      invoiceCount: 2,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
      createdAt: "2030-01-01T00:00:00.000Z",
      slots: [
        {
          slotNumber: 1,
          targetSats: "1000",
          attempt: 1,
          status: "failed",
          failure: { code: "HTTP_ERROR", message: "failed", retryable: true },
        },
        {
          slotNumber: 2,
          targetSats: "1000",
          attempt: 1,
          status: "settled",
          settledAt: "2030-01-01T00:01:00.000Z",
          invoice: {
            bolt11: "lnbc1old",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
          },
        },
      ],
    };
    const prepared = prepareSlotRetry(base, 1);
    expect(prepared.slots[0]).toMatchObject({
      status: "generating",
      attempt: 2,
    });
    expect(prepared.slots[1]).toEqual(base.slots[1]);
    const expiredPrepared = prepareSlotRetry(
      {
        ...base,
        slots: [
          {
            ...base.slots[1]!,
            slotNumber: 1,
            status: "expired",
          },
          base.slots[1]!,
        ],
      },
      1,
    );
    expect(expiredPrepared.slots[0]).toMatchObject({
      status: "generating",
      attempt: 2,
    });
    expect(expiredPrepared.issuedPaymentHashes).toEqual(["11".repeat(32)]);
    const applied = applySlotRetryResponse(
      prepared,
      1,
      {
        ok: true,
        provider: {
          domain: "wallet.example",
          commentAllowed: 0,
          automaticSettlementAvailable: false,
        },
        slots: [
          {
            status: "pending",
            slotNumber: 1,
            targetSats: "1000",
            attempt: 2,
            invoice: {
              bolt11: "lnbc1new",
              paymentHash: "22".repeat(32),
              timestampSeconds: 2,
              expirySeconds: 3600,
              expiresAt: "2030-01-01T01:00:00.000Z",
              payeeNodeId: `02${"22".repeat(32)}`,
              featureBits: [],
              providerDomain: "wallet.example",
            },
          },
        ],
        completedCount: 1,
        failedCount: 0,
      },
      ["11".repeat(32)],
      ["lnbc1old"],
    );
    expect(applied.slots[0]).toMatchObject({
      status: "pending",
      attempt: 2,
      invoice: { paymentHash: "22".repeat(32) },
    });
    expect(applied.slots[1]).toEqual(base.slots[1]);
    expect(collectIssuedPaymentHashes(applied)).toEqual([
      "11".repeat(32),
      "22".repeat(32),
    ]);
  });

  it("retains an expired invoice hash when a retry fails", () => {
    const expired: SettlementSession = {
      version: 1,
      id: "expired-retry",
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
          status: "expired",
          invoice: {
            bolt11: "lnbc1old",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
          },
        },
      ],
    };
    const prepared = prepareSlotRetry(expired, 1);
    const failed = applySlotRetryResponse(
      prepared,
      1,
      {
        ok: true,
        provider: {
          domain: "wallet.example",
          commentAllowed: 0,
          automaticSettlementAvailable: false,
        },
        slots: [
          {
            status: "failed",
            slotNumber: 1,
            targetSats: "1000",
            attempt: 2,
            failure: {
              code: "HTTP_ERROR",
              message: "failed",
              retryable: true,
            },
          },
        ],
        completedCount: 0,
        failedCount: 1,
      },
      collectIssuedPaymentHashes(prepared),
      ["lnbc1old"],
    );
    expect(collectIssuedPaymentHashes(failed)).toEqual(["11".repeat(32)]);
    expect(collectIssuedPaymentHashes(prepareSlotRetry(failed, 1))).toEqual([
      "11".repeat(32),
    ]);
  });

  it("rejects a reused payment hash during slot reissue", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    expect(() =>
      applySlotRetryResponse(
        generating,
        1,
        {
          ok: true,
          provider: {
            domain: "wallet.example",
            commentAllowed: 0,
            automaticSettlementAvailable: false,
          },
          slots: [
            {
              status: "pending",
              slotNumber: 1,
              targetSats: "1000",
              attempt: 1,
              invoice: {
                bolt11: "lnbc1new",
                paymentHash: "11".repeat(32),
                timestampSeconds: 1,
                expirySeconds: 3600,
                expiresAt: "2030-01-01T01:00:00.000Z",
                payeeNodeId: `02${"11".repeat(32)}`,
                featureBits: [],
                providerDomain: "wallet.example",
              },
            },
          ],
          completedCount: 1,
          failedCount: 0,
        },
        ["11".repeat(32)],
        [],
      ),
    ).toThrow("재사용");
  });

  it("marks verify-unsupported payments as user confirmed and annotates them", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: ["철수"],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    const pending: SettlementSession = {
      ...generating,
      slots: [
        {
          ...generating.slots[0]!,
          status: "pending",
          invoice: {
            bolt11: "lnbc1manual",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
          },
        },
      ],
    };
    const confirmed = manuallyConfirmSlot(
      pending,
      1,
      new Date("2030-01-01T00:02:00.000Z"),
    );
    expect(confirmed.slots[0]).toMatchObject({
      status: "manuallyConfirmed",
      confirmedAt: "2030-01-01T00:02:00.000Z",
    });
    const annotated = annotateSettledSlot(confirmed, 1, {
      displayName: "철수",
    });
    expect(annotated.slots[0]?.annotation?.displayName).toBe("철수");
    expect(getSettlementProgress(annotated)).toMatchObject({
      completedCount: 1,
      networkSettledCount: 0,
      manuallyConfirmedCount: 1,
    });
  });

  it("normalizes legacy expired verification states without losing a late payment check", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    const legacyExpired: SettlementSession = {
      ...generating,
      slots: [
        {
          ...generating.slots[0]!,
          status: "expired",
          invoice: {
            bolt11: "lnbc1legacy",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1_893_456_000,
            expirySeconds: 3_600,
            expiresAt: "2030-01-01T00:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
            verificationToken: `v1.${"a".repeat(16)}.${"b".repeat(32)}`,
          },
        },
      ],
    };

    const inGrace = markExpiredSlots(
      legacyExpired,
      Date.parse("2030-01-01T00:00:30.000Z"),
    );
    expect(inGrace.slots[0]?.status).toBe("verifyingExpired");
    expect(inGrace.slots[0]?.invoice?.verificationToken).toBeDefined();

    const afterGrace = markExpiredSlots(
      legacyExpired,
      Date.parse("2030-01-01T00:01:00.000Z"),
    );
    expect(afterGrace.slots[0]?.status).toBe("expired");
    expect(afterGrace.slots[0]?.invoice?.verificationToken).toBeUndefined();
  });
});
