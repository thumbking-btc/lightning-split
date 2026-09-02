import QRCode from "qrcode";

import { copyTextToClipboard } from "./clipboard";
import { buildQrPayload } from "./qr";
import { formatUsdCents, localeFor, type Language } from "./preferences";

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
  | "sharedWithQr"
  | "sharedText"
  | "copied"
  | "cancelled"
  | "failed";

const qrFileCache = new Map<string, File>();
const qrFilePromises = new Map<string, Promise<File | undefined>>();

function formatInteger(value: string, language: Language): string {
  return new Intl.NumberFormat(localeFor(language)).format(Number(BigInt(value)));
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
    (language === "ko" ? `${input.slotNumber}번 결제` : `Payment ${input.slotNumber}`);
  const expiresAt = new Date(input.expiresAt).toLocaleString(localeFor(language));
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

export function buildBareInvoiceShareText(
  invoice: string,
  language: Language = "ko",
): string {
  return language === "ko"
    ? ["Lightning Split 결제 요청", "", "Lightning invoice", invoice].join("\n")
    : ["Lightning Split payment request", "", "Lightning invoice", invoice].join("\n");
}

function isUserCancellation(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

async function canvasToPngFile(canvas: HTMLCanvasElement): Promise<File | undefined> {
  if (typeof File === "undefined") return undefined;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return undefined;
  return new File([blob], "lightning-split-qr.png", { type: "image/png" });
}

async function createQrFile(invoice: string): Promise<File | undefined> {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, buildQrPayload(invoice), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 720,
    color: { dark: "#171612", light: "#ffffff" },
  });
  return await canvasToPngFile(canvas);
}

export function prepareInvoiceShareFile(invoice: string): Promise<File | undefined> {
  const cached = qrFileCache.get(invoice);
  if (cached) return Promise.resolve(cached);
  const existing = qrFilePromises.get(invoice);
  if (existing) return existing;
  const promise = createQrFile(invoice)
    .then((file) => {
      if (file) qrFileCache.set(invoice, file);
      return file;
    })
    .catch(() => undefined)
    .finally(() => qrFilePromises.delete(invoice));
  qrFilePromises.set(invoice, promise);
  return promise;
}

function preparedInvoiceShareFile(invoice: string): File | undefined {
  return qrFileCache.get(invoice);
}

function shareTitle(language: Language): string {
  return language === "ko"
    ? "Lightning Split 결제 요청"
    : "Lightning Split payment request";
}

async function shareText(
  text: string,
  language: Language,
): Promise<InvoiceShareResult | undefined> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return undefined;
  }
  try {
    await navigator.share({ title: shareTitle(language), text });
    return "sharedText";
  } catch (cause) {
    if (isUserCancellation(cause)) return "cancelled";
    return undefined;
  }
}

async function sharePreparedInvoice(
  invoice: string,
  text: string,
  language: Language,
): Promise<InvoiceShareResult> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const file = preparedInvoiceShareFile(invoice);
    if (file) {
      try {
        const canShareFile =
          typeof navigator.canShare !== "function" ||
          navigator.canShare({ files: [file] });
        if (canShareFile) {
          await navigator.share({
            title: shareTitle(language),
            text,
            files: [file],
          });
          return "sharedWithQr";
        }
      } catch (cause) {
        if (isUserCancellation(cause)) return "cancelled";
        // File sharing can fail independently of text sharing. Continue to the
        // text-only Web Share fallback while the user activation is still tied
        // to the original button action.
      }
    }

    const textResult = await shareText(text, language);
    if (textResult) return textResult;
  }

  return (await copyTextToClipboard(text)) ? "copied" : "failed";
}

export function shareInvoicePaymentRequest(
  input: InvoiceShareInput,
): Promise<InvoiceShareResult> {
  const language = input.language ?? "ko";
  return sharePreparedInvoice(
    input.invoice,
    buildInvoiceShareText(input),
    language,
  );
}

export function shareBareInvoicePaymentRequest(
  invoice: string,
  language: Language = "ko",
): Promise<InvoiceShareResult> {
  return sharePreparedInvoice(
    invoice,
    buildBareInvoiceShareText(invoice, language),
    language,
  );
}
