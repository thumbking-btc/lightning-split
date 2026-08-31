import { describe, expect, it } from "vitest";

import { buildInvoiceShareText } from "./invoiceShare";

describe("invoice share text", () => {
  it("includes participant, fiat amount, sats, expiry, and canonical invoice", () => {
    const text = buildInvoiceShareText({
      slotNumber: 2,
      displayName: "민수",
      krwShare: "25000",
      targetSats: "15625",
      invoice: "lnbc1canonicalinvoice",
      expiresAt: "2030-08-31T13:00:00.000Z",
    });

    expect(text).toContain("민수");
    expect(text).toContain("25,000원");
    expect(text).toContain("15,625 sats");
    expect(text).toContain("만료:");
    expect(text).toContain("lnbc1canonicalinvoice");
  });

  it("uses the slot number when no participant name is saved", () => {
    const text = buildInvoiceShareText({
      slotNumber: 3,
      targetSats: "21000",
      invoice: "lnbc1invoice",
      expiresAt: "2030-08-31T13:00:00.000Z",
    });

    expect(text).toContain("3번 결제");
    expect(text).toContain("21,000 sats");
  });
});
