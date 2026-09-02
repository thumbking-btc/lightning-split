import QRCode from "qrcode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBareInvoiceShareText,
  buildInvoiceShareText,
  prepareInvoiceShareFile,
  shareBareInvoicePaymentRequest,
  shareInvoicePaymentRequest,
} from "./invoiceShare";

const originalShare = navigator.share;
const originalCanShare = navigator.canShare;
const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: originalShare,
  });
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: originalCanShare,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubQrFilePreparation(): void {
  const canvas = {
    toBlob(callback: (blob: Blob | null) => void) {
      callback(new Blob(["png"], { type: "image/png" }));
    },
  } as HTMLCanvasElement;
  vi.stubGlobal("document", {
    createElement: vi.fn(() => canvas),
  });
  if (typeof File === "undefined") {
    class TestFile extends Blob {
      readonly name: string;

      constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
        super(parts, options);
        this.name = name;
      }
    }
    vi.stubGlobal("File", TestFile);
  }
  vi.spyOn(QRCode, "toCanvas").mockResolvedValue(undefined);
}

describe("invoice share text", () => {
  it("includes participant, KRW amount, sats, expiry, and invoice", () => {
    const text = buildInvoiceShareText({
      slotNumber: 2,
      displayName: "민수",
      krwShare: "25000",
      targetSats: "15625",
      invoice: "lnbc1canonicalinvoice",
      expiresAt: "2030-08-31T13:00:00.000Z",
      language: "ko",
    });

    expect(text).toContain("민수");
    expect(text).toContain("25,000원");
    expect(text).toContain("15,625 sats");
    expect(text).toContain("만료:");
    expect(text).toContain("lnbc1canonicalinvoice");
  });

  it("renders USD with an explicit dollar symbol", () => {
    const text = buildInvoiceShareText({
      slotNumber: 1,
      usdCentsShare: "1234",
      targetSats: "7000",
      invoice: "lnbc1usd",
      expiresAt: "2030-08-31T13:00:00.000Z",
      language: "en",
    });
    expect(text).toContain("$12.34");
  });

  it("keeps a minimal text request available for the QR component", () => {
    expect(buildBareInvoiceShareText("lnbc1invoice", "ko")).toContain(
      "lnbc1invoice",
    );
  });
});

describe("invoice share fallback", () => {
  it("shares a prepared QR file together with the complete payment text", async () => {
    stubQrFilePreparation();
    const invoice = "lnbc1preparedfull";
    await expect(prepareInvoiceShareFile(invoice)).resolves.toBeDefined();

    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn(() => true),
    });

    await expect(
      shareInvoicePaymentRequest({
        slotNumber: 2,
        displayName: "민수",
        krwShare: "25000",
        targetSats: "15625",
        invoice,
        expiresAt: "2030-08-31T13:00:00.000Z",
        language: "ko",
      }),
    ).resolves.toBe("sharedWithQr");

    expect(share).toHaveBeenCalledTimes(1);
    const request = share.mock.calls[0]?.[0] as ShareData;
    expect(request.text).toContain("민수");
    expect(request.text).toContain("25,000원");
    expect(request.text).toContain("15,625 sats");
    expect(request.text).toContain(invoice);
    expect(request.files).toHaveLength(1);
    expect(request.files?.[0]?.type).toBe("image/png");
  });

  it("falls back from rejected QR-file sharing to the same text Web Share", async () => {
    stubQrFilePreparation();
    const invoice = "lnbc1preparedfallback";
    await expect(prepareInvoiceShareFile(invoice)).resolves.toBeDefined();

    const share = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("file blocked", "NotAllowedError"),
      )
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn(() => true),
    });

    await expect(
      shareInvoicePaymentRequest({
        slotNumber: 1,
        usdCentsShare: "1234",
        targetSats: "7000",
        invoice,
        expiresAt: "2030-08-31T13:00:00.000Z",
        language: "en",
      }),
    ).resolves.toBe("sharedText");

    expect(share).toHaveBeenCalledTimes(2);
    const fileAttempt = share.mock.calls[0]?.[0] as ShareData;
    const textAttempt = share.mock.calls[1]?.[0] as ShareData;
    expect(fileAttempt.files).toHaveLength(1);
    expect(fileAttempt.text).toContain("$12.34");
    expect(textAttempt.files).toBeUndefined();
    expect(textAttempt.text).toBe(fileAttempt.text);
  });

  it("uses text Web Share when no prepared file is available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn(() => false),
    });

    await expect(
      shareBareInvoicePaymentRequest("lnbc1textonly", "ko"),
    ).resolves.toBe("sharedText");
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("lnbc1textonly"),
      }),
    );
  });

  it("falls back to clipboard if Web Share is unavailable", async () => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(
      shareBareInvoicePaymentRequest("lnbc1clipboard", "ko"),
    ).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("lnbc1clipboard"),
    );
  });

  it("treats AbortError as user cancellation instead of copying", async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("cancel", "AbortError"));
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(
      shareBareInvoicePaymentRequest("lnbc1cancel", "ko"),
    ).resolves.toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });
});
