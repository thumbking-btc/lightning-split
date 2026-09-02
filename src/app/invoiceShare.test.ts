import { describe, expect, it, vi } from "vitest";

import {
  buildInvoiceShareText,
  shareInvoicePaymentRequest,
} from "./invoiceShare";

const input = {
  slotNumber: 2,
  displayName: "민수",
  krwShare: "25000",
  targetSats: "15625",
  invoice: "lnbc1canonicalinvoice",
  expiresAt: "2030-08-31T13:00:00.000Z",
} as const;

function fakeFile(): File {
  return { name: "qr.png", type: "image/png" } as File;
}

describe("invoice share text", () => {
  it("includes participant, fiat amount, sats, expiry, and canonical invoice", () => {
    const text = buildInvoiceShareText(input);
    expect(text).toContain("민수");
    expect(text).toContain("25,000원");
    expect(text).toContain("15,625 sats");
    expect(text).toContain("만료:");
    expect(text).toContain("lnbc1canonicalinvoice");
  });

  it("formats USD explicitly with the dollar symbol", () => {
    const text = buildInvoiceShareText({
      ...input,
      krwShare: undefined,
      usdCentsShare: "2500",
      language: "en",
    });
    expect(text).toContain("$25.00");
    expect(text).toContain("Amount:");
  });
});

describe("invoice share transport", () => {
  it("shares QR file and text when file sharing is supported", async () => {
    const nativeShare = vi.fn(async () => undefined);
    const result = await shareInvoicePaymentRequest(input, {
      nativeShare,
      nativeCanShare: () => true,
      createQrFile: async () => fakeFile(),
      copyText: async () => true,
    });
    expect(result).toBe("shared-file");
    expect(nativeShare).toHaveBeenCalledTimes(1);
    expect(nativeShare.mock.calls[0]?.[0].files).toHaveLength(1);
  });

  it("falls back from QR file sharing to native text sharing", async () => {
    const nativeShare = vi
      .fn<(data: ShareData) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
      .mockResolvedValueOnce(undefined);
    const result = await shareInvoicePaymentRequest(input, {
      nativeShare,
      nativeCanShare: () => true,
      createQrFile: async () => fakeFile(),
      copyText: async () => true,
    });
    expect(result).toBe("shared-text");
    expect(nativeShare).toHaveBeenCalledTimes(2);
    expect(nativeShare.mock.calls[1]?.[0].files).toBeUndefined();
  });

  it("falls back to text sharing when QR generation fails", async () => {
    const nativeShare = vi.fn(async () => undefined);
    const result = await shareInvoicePaymentRequest(input, {
      nativeShare,
      nativeCanShare: () => true,
      createQrFile: async () => {
        throw new Error("PNG unavailable");
      },
      copyText: async () => true,
    });
    expect(result).toBe("shared-text");
    expect(nativeShare).toHaveBeenCalledTimes(1);
  });

  it("uses clipboard only after native file and text sharing both fail", async () => {
    const nativeShare = vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    });
    const copyText = vi.fn(async () => true);
    const result = await shareInvoicePaymentRequest(input, {
      nativeShare,
      nativeCanShare: () => true,
      createQrFile: async () => fakeFile(),
      copyText,
    });
    expect(result).toBe("copied");
    expect(nativeShare).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("treats only AbortError as an intentional share cancellation", async () => {
    const nativeShare = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    const copyText = vi.fn(async () => true);
    const result = await shareInvoicePaymentRequest(input, {
      nativeShare,
      nativeCanShare: () => true,
      createQrFile: async () => fakeFile(),
      copyText,
    });
    expect(result).toBe("cancelled");
    expect(nativeShare).toHaveBeenCalledTimes(1);
    expect(copyText).not.toHaveBeenCalled();
  });
});
