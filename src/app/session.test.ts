import { describe, expect, it } from "vitest";

import {
  serializeBigIntDecimal,
  type PriceSnapshotDto,
} from "../api/serialization";
import {
  annotateSettledSlot,
  createGeneratingSession,
  createSettlementPreview,
  type DraftInput,
} from "./session";

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

  it("supports sats mode while preserving the total across invoice targets", () => {
    const preview = createSettlementPreview({
      inputMode: "sats",
      totalAmount: "50003",
      totalPeople: 6,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    });
    expect(preview.targetSats).toEqual([
      10_001n,
      10_001n,
      10_001n,
      10_000n,
      10_000n,
    ]);
    expect(preview.targetSats.reduce((sum, amount) => sum + amount, 0n)).toBe(
      50_003n,
    );
  });

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
});
