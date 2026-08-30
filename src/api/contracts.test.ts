import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { parseBatchInvoiceRequest, parseSettlementRequest } from "./contracts";

describe("Worker API DTO validation", () => {
  it("parses decimal amounts, request identity, exclusions and comments", () => {
    const parsed = parseBatchInvoiceRequest({
      requestId: "session-1:slot-1:attempt-2",
      address: "user@wallet.example",
      slots: [
        { slotNumber: 1, krwShare: "21500", targetSats: "13438", attempt: 2 },
      ],
      excludedPaymentHashes: ["11".repeat(32), "11".repeat(32)],
      providerComment: "8/30 고깃집 저녁",
    });
    expect(parsed.requestId).toBe("session-1:slot-1:attempt-2");
    expect(parsed.slots[0]).toMatchObject({
      krwShare: 21_500n,
      targetSats: 13_438n,
    });
    expect(parsed.excludedPaymentHashes).toEqual(["11".repeat(32)]);
    expect(parsed.providerComment).toBe("8/30 고깃집 저녁");
  });

  it("accepts 20 slots and rejects 21 slots or numeric amounts", () => {
    const slot = (index: number) => ({
      slotNumber: index + 1,
      targetSats: "1",
      attempt: 1,
    });
    expect(
      parseBatchInvoiceRequest({
        requestId: "twenty-slots",
        address: "user@wallet.example",
        slots: Array.from({ length: 20 }, (_, index) => slot(index)),
      }).slots,
    ).toHaveLength(20);
    expect(() =>
      parseBatchInvoiceRequest({
        requestId: "twenty-one-slots",
        address: "user@wallet.example",
        slots: Array.from({ length: 21 }, (_, index) => slot(index)),
      }),
    ).toThrowError();
    expect(() =>
      parseBatchInvoiceRequest({
        requestId: "numeric-amount",
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: 1, attempt: 1 }],
      }),
    ).toThrowError();
  });

  it("validates request identity and the 255 character comment boundary", () => {
    const base = {
      requestId: "comment-boundary",
      address: "user@wallet.example",
      slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
    };
    expect(
      parseBatchInvoiceRequest({ ...base, providerComment: "가".repeat(255) })
        .providerComment,
    ).toHaveLength(255);
    expect(() =>
      parseBatchInvoiceRequest({ ...base, requestId: "공백 불가" }),
    ).toThrowError();
    const { requestId: _requestId, ...missingRequestId } = base;
    void _requestId;
    expect(() => parseBatchInvoiceRequest(missingRequestId)).toThrowError(
      /업데이트/u,
    );
    expect(() =>
      parseBatchInvoiceRequest({ ...base, providerComment: "가".repeat(256) }),
    ).toThrowError();
  });

  it("accepts only v2 sealed verification tokens and long BOLT11 invoices", () => {
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "contract-long-invoice",
      description: "x".repeat(639),
    });
    const token = `v2.${"a".repeat(16)}.${"b".repeat(32)}`;
    expect(fixture.invoice.length).toBeGreaterThan(1_200);
    expect(
      parseSettlementRequest({
        verificationToken: token,
        paymentHash: fixture.paymentHash,
        bolt11: fixture.invoice,
      }),
    ).toMatchObject({ verificationToken: token, bolt11: fixture.invoice });
    expect(() =>
      parseSettlementRequest({
        verificationToken: token.replace("v2.", "v1."),
        paymentHash: fixture.paymentHash,
        bolt11: fixture.invoice,
      }),
    ).toThrowError();
  });
});
