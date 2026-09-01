import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  InvoiceSlot,
  ParticipantNameCandidate,
  PaymentAnnotation,
  SettledInvoiceSlot,
} from "./models";

describe("domain model", () => {
  it("keeps participant candidates independent from invoice slots", () => {
    type CandidateKeys = keyof ParticipantNameCandidate;

    expectTypeOf<CandidateKeys>().toEqualTypeOf<"id" | "name" | "createdAt">();
  });

  it("allows annotations only on completed slot variants", () => {
    type AnnotatedSlot = Extract<
      InvoiceSlot,
      { annotation?: PaymentAnnotation }
    >;
    type AnnotatedStatus = AnnotatedSlot["status"];

    expectTypeOf<AnnotatedStatus>().toEqualTypeOf<
      "settled" | "manuallyConfirmed"
    >();
  });

  it("represents a user annotation without claiming payer identity", () => {
    const slot: SettledInvoiceSlot = {
      status: "settled",
      slotNumber: 1,
      krwShare: 21_500n,
      targetSats: 13_438n,
      attempt: 1,
      invoice: {
        bolt11: "lnbc-placeholder",
        paymentHash: "hash-placeholder",
        timestampSeconds: 1_700_000_000,
        expirySeconds: 3_600,
        expiresAt: "2023-11-14T23:13:20.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [17],
        payerMemo: "none",
        payeeMemo: "none",
        provider: {
          domain: "wallet.example",
          discoveryUrl: "https://wallet.example/.well-known/lnurlp/user",
          callbackUrl: "https://wallet.example/lnurl/callback",
        },
      },
      settlementCheck: {
        status: "verified",
        checkedAt: "2023-11-14T22:15:00.000Z",
      },
      annotation: {
        displayName: "철수",
        note: "사용자가 붙인 표시정보",
        updatedAt: "2023-11-14T22:16:00.000Z",
      },
    };

    expect(slot.annotation?.displayName).toBe("철수");
  });
});
