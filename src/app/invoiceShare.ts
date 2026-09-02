import QRCode from "qrcode";

import { copyTextToClipboard } from "./clipboard";
import { formatUsdCents, localeFor, type Language } from "./preferences";
import { buildQrPayload } from "./qr";

export interface InvoiceShareInput {
  readonly slotNumber: number;
  readonly displayName?: string;
  readonly krwShare?: string;
  readonly usdCentsShare?: string;
  readonly targetSats: string;
  readonly invoice: string;
  readonly expiresAt: string;
  readonly language?: Language;
}

export type InvoiceShareResult =
  "shared-file" | "shared-text" | "copied" | "cancelled" | "failed";

interface InvoiceShareDependencies {
  readonly nativeShare?: (data: ShareData) => Promise<void>;
  readonly nativeCanShare?: (data?: ShareData) => boolean;
  readonly createQrFile?: (invoice: string) => Promise<File | undefined>;
  readonly copyText?: (text: string) => Promise<boolean>;
}

function formatInteger(value: string, language: Language): string {
  return new Intl.NumberFormat(localeFor(language)).format(
    Number(BigInt(value)),
  );
}

function formatAmount(input: InvoiceShareInput, language: Language): string {
  if (input.krwShare) {
    return `${formatInteger(input.krwShare, language)}${language === "ko" ? "원" : " KRW"} (${formatInteger(input.targetSats, language)} sats)`;
  }
  if (input.usdCentsShare) {
    return `${formatUsdCents(BigInt(input.usdCentsShare), language)} (${formatInteger(input.targetSats, language)} sats)`;
  }
  return `${formatInteger(input.targetSats, language)} sats`;
}

export function buildInvoiceShareText(input: InvoiceShareInput): string {
  const language = input.language ?? "ko";
  const recipient =
    input.displayName?.trim() ||
    (language === "ko"
      ? `${input.slotNumber}번 결제`
      : `Payment #${input.slotNumber}`);
  const expiresAt = new Date(input.expiresAt).toLocaleString(
    localeFor(language),
  );
  return language === "ko"
    ? [
        `Lightning Split · ${recipient}`,
        `금액: ${formatAmount(input, language)}`,
        `만료: ${expiresAt}`,
        "",
        "Lightning invoice",
        input.invoice,
      ].join("\n")
    : [
        `Lightning Split · ${recipient}`,
        `Amount: ${formatAmount(input, language)}`,
        `Expires: ${expiresAt}`,
        "",
        "Lightning invoice",
        input.invoice,
      ].join("\n");
}

function isShareCancellation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  );
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("QR PNG encoding failed.")),
      "image/png",
    );
  });
}

export async function createInvoiceQrFile(
  invoice: string,
): Promise<File | undefined> {
  if (typeof document === "undefined" || typeof File === "undefined") {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, buildQrPayload(invoice), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 720,
    color: { dark: "#171612", light: "#ffffff" },
  });
  const blob = await canvasToPngBlob(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return new File([blob], "lightning-split-payment-qr.png", {
    type: "image/png",
    lastModified: Date.now(),
  });
}

function browserShareDependencies(): InvoiceShareDependencies {
  if (typeof navigator === "undefined") {
    return { copyText: copyTextToClipboard };
  }
  return {
    ...(typeof navigator.share === "function"
      ? { nativeShare: navigator.share.bind(navigator) }
      : {}),
    ...(typeof navigator.canShare === "function"
      ? { nativeCanShare: navigator.canShare.bind(navigator) }
      : {}),
    createQrFile: createInvoiceQrFile,
    copyText: copyTextToClipboard,
  };
}

function canShareFiles(
  nativeCanShare: NonNullable<InvoiceShareDependencies["nativeCanShare"]>,
  file: File,
): boolean {
  try {
    return nativeCanShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareInvoicePaymentRequest(
  input: InvoiceShareInput,
  dependencies: InvoiceShareDependencies = browserShareDependencies(),
): Promise<InvoiceShareResult> {
  const language = input.language ?? "ko";
  const text = buildInvoiceShareText(input);
  const title =
    language === "ko"
      ? "Lightning Split 결제 요청"
      : "Lightning Split payment request";
  const nativeShare = dependencies.nativeShare;

  if (nativeShare) {
    let file: File | undefined;
    try {
      file = await (dependencies.createQrFile ?? createInvoiceQrFile)(
        input.invoice,
      );
    } catch {
      file = undefined;
    }

    if (
      file &&
      dependencies.nativeCanShare &&
      canShareFiles(dependencies.nativeCanShare, file)
    ) {
      try {
        await nativeShare({ title, text, files: [file] });
        return "shared-file";
      } catch (cause) {
        if (isShareCancellation(cause)) return "cancelled";
      }
    }

    try {
      await nativeShare({ title, text });
      return "shared-text";
    } catch (cause) {
      if (isShareCancellation(cause)) return "cancelled";
    }
  }

  const copied = await (dependencies.copyText ?? copyTextToClipboard)(text);
  return copied ? "copied" : "failed";
}
