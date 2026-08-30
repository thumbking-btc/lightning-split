import { describe, expect, it } from "vitest";

import { restoreSession, serializeSession } from "./persistence";
import {
  annotateSettledSlot,
  manuallyConfirmSlot,
  undoManualConfirmation,
} from "./session";
import type { SettlementSession } from "./types";

const BASE_SESSION: SettlementSession = {
  version: 2,
  id: "settlement-ux-test",
  inputMode: "sats",
  totalAmount: "2000",
  totalPeople: 2,
  excludePayer: true,
  invoiceCount: 1,
  lightningAddress: "user@wallet.example",
  participantNameCandidates: ["민수", "철수"],
  payerShareSats: "1000",
  createdAt: "2030-01-01T00:00:00.000Z",
  issuedPaymentHashes: ["11".repeat(32)],
  slots: [
    {
      slotNumber: 1,
      targetSats: "1000",
      attempt: 1,
      status: "pending",
      invoice: {
        bolt11: "lnbc1participant",
        paymentHash: "11".repeat(32),
        timestampSeconds: 1_893_456_000,
        expirySeconds: 3_600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [],
        providerDomain: "wallet.example",
      },
    },
  ],
};

describe("settlement UX safety", () => {
  it("stores a participant label before payment and restores it locally", () => {
    const labeled = annotateSettledSlot(
      BASE_SESSION,
      1,
      { displayName: "민수" },
      new Date("2030-01-01T00:05:00.000Z"),
    );

    expect(labeled.slots[0]).toMatchObject({
      status: "pending",
      annotation: { displayName: "민수" },
    });
    expect(restoreSession(serializeSession(labeled))).toEqual(labeled);
  });

  it("undoes only the local manual completion mark and keeps the invoice and label", () => {
    const labeled = annotateSettledSlot(
      BASE_SESSION,
      1,
      { displayName: "민수" },
      new Date("2030-01-01T00:05:00.000Z"),
    );
    const confirmed = manuallyConfirmSlot(
      labeled,
      1,
      new Date("2030-01-01T00:06:00.000Z"),
    );
    const undone = undoManualConfirmation(
      confirmed,
      1,
      new Date("2030-01-01T00:07:00.000Z"),
    );

    expect(undone.slots[0]).toMatchObject({
      status: "pending",
      annotation: { displayName: "민수" },
      invoice: { paymentHash: "11".repeat(32) },
    });
    expect(undone.slots[0]).not.toHaveProperty("confirmedAt");
  });

  it("returns an expired manual completion to expired instead of reopening its QR", () => {
    const confirmed = manuallyConfirmSlot(
      BASE_SESSION,
      1,
      new Date("2030-01-01T00:30:00.000Z"),
    );
    const undone = undoManualConfirmation(
      confirmed,
      1,
      new Date("2030-01-01T02:00:00.000Z"),
    );

    expect(undone.slots[0]?.status).toBe("expired");
    expect(undone.slots[0]).not.toHaveProperty("confirmedAt");
  });
});
