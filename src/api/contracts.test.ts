import { describe, expect, it } from "vitest";

import { parseBatchInvoiceRequest, parseSettlementRequest } from "./contracts";

describe("Worker API DTO validation", () => {
  it("parses decimal-string amounts without Number conversion", () => {
    expect(
      parseBatchInvoiceRequest({
        address: "user@wallet.example",
        slots: [
          { slotNumber: 1, krwShare: "21500", targetSats: "13438", attempt: 1 },
        ],
      }).slots[0],
    ).toMatchObject({ krwShare: 21_500n, targetSats: 13_438n });
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

  it("accepts only opaque v4 verification tokens", () => {
    expect(
      parseSettlementRequest({
        verificationToken: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toEqual({ verificationToken: "123e4567-e89b-42d3-a456-426614174000" });
    expect(() =>
      parseSettlementRequest({
        verificationToken: "https://wallet.example/verify",
      }),
    ).toThrowError();
  });
});
