import { describe, expect, it } from "vitest";

import { parseBatchInvoiceRequest, parseSettlementRequest } from "./contracts";

describe("Worker API DTO validation", () => {
  it("parses decimal-string amounts without Number conversion", () => {
    const parsed = parseBatchInvoiceRequest({
      address: "user@wallet.example",
      capabilities: { deferredSlots: true },
      slots: [
        { slotNumber: 1, krwShare: "21500", targetSats: "13438", attempt: 1 },
      ],
    });
    expect(parsed.slots[0]).toMatchObject({
      krwShare: 21_500n,
      targetSats: 13_438n,
    });
    expect(parsed.supportsDeferredSlots).toBe(true);
  });

  it("rejects JSON numbers, zero values and oversized batches", () => {
    expect(() =>
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: 1, attempt: 1 }],
      }),
    ).toThrowError();
    expect(() =>
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "0", attempt: 1 }],
      }),
    ).toThrowError();
    expect(() =>
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: Array.from({ length: 11 }, (_, index) => ({
          slotNumber: index + 1,
          targetSats: "1",
          attempt: 1,
        })),
      }),
    ).toThrowError();
  });

  it("accepts only sealed tokens linked to an invoice and payment hash", () => {
    const token = `v1.${"a".repeat(16)}.${"b".repeat(32)}`;
    expect(
      parseSettlementRequest({
        verificationToken: token,
        paymentHash: "11".repeat(32),
        bolt11: "lnbc1test",
      }),
    ).toEqual({
      verificationToken: token,
      paymentHash: "11".repeat(32),
      bolt11: "lnbc1test",
    });
    expect(() =>
      parseSettlementRequest({
        verificationToken: "https://wallet.example/verify",
      }),
    ).toThrowError();
  });

  it("keeps an automatically forwarded provider comment and validates retry exclusions", () => {
    const parsed = parseBatchInvoiceRequest({
      address: "user@wallet.example",
      slots: [{ slotNumber: 1, targetSats: "1000", attempt: 2 }],
      excludedPaymentHashes: ["11".repeat(32)],
      excludedInvoices: ["lnbc1test"],
      providerComment: "8/30 고깃집 저녁",
    });
    expect(parsed.providerComment).toBe("8/30 고깃집 저녁");
    expect(parsed.excludedPaymentHashes).toEqual(["11".repeat(32)]);
    expect(parsed.excludedInvoices).toEqual(["lnbc1test"]);

    const withoutComment = parseBatchInvoiceRequest({
      address: "user@wallet.example",
      slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
    });
    expect(withoutComment.providerComment).toBeUndefined();
    expect(withoutComment.supportsDeferredSlots).toBe(false);
    expect(() =>
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        capabilities: { deferredSlots: "yes" },
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
      }),
    ).toThrowError();
  });

  it("accepts at most 255 provider-comment characters", () => {
    expect(
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "가".repeat(255),
      }).providerComment,
    ).toHaveLength(255);
    expect(() =>
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: [{ slotNumber: 1, targetSats: "1000", attempt: 1 }],
        providerComment: "가".repeat(256),
      }),
    ).toThrowError();
  });
});
