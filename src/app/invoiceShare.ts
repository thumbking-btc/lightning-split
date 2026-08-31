import QRCode from "qrcode";

import { copyTextToClipboard } from "./clipboard";
import { buildQrPayload } from "./qr";

export interface InvoiceShareInput {
  readonly slotNumber: number;
  readonly displayName?: string;
  readonly krwShare?: string;
  readonly targetSats: string;
  readonly invoice: string;
  readonly expiresAt: string;
}

export type InvoiceShareResult = "shared" | "copied" | "cancelled" | "failed";

const integerFormatter = new Intl.NumberFormat("ko-KR");

function formatInteger(value: string): string {
  return integerFormatter.format(Number(BigInt(value)));
}

function formatAmount(input: InvoiceShareInput): string {
  return input.krwShare
    ? `${formatInteger(input.krwShare)}원 (${formatInteger(input.targetSats)} sats)`
    : `${formatInteger(input.targetSats)} sats`;
}

export function buildInvoiceShareText(input: InvoiceShareInput): string {
  const recipient = input.displayName?.trim() || `${input.slotNumber}번 결제`;
  const expiresAt = new Date(input.expiresAt).toLocaleString("ko-KR");
  return [
    `Lightning Split · ${recipient}`,
    `금액: ${formatAmount(input)}`,
    `만료: ${expiresAt}`,
    "",
    "Lightning invoice",
    input.invoice,
  ].join("\n");
}

function isShareCancellation(cause: unknown): boolean {
  return (
    cause instanceof DOMException &&
    (cause.name === "AbortError" || cause.name === "NotAllowedError")
  );
}

async function createQrFile(invoice: string): Promise<File | undefined> {
  if (typeof File === "undefined") return undefined;
  const dataUrl = await QRCode.toDataURL(buildQrPayload(invoice), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 720,
    color: { dark: "#171612", light: "#ffffff" },
  });
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], "lightning-split-qr.png", { type: "image/png" });
}

export async function shareInvoicePaymentRequest(
  input: InvoiceShareInput,
): Promise<InvoiceShareResult> {
  const text = buildInvoiceShareText(input);
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function"
  ) {
    try {
      const file = await createQrFile(input.invoice);
      if (
        file &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({
          title: "Lightning Split 결제 요청",
          text,
          files: [file],
        });
        return "shared";
      }
      await navigator.share({ title: "Lightning Split 결제 요청", text });
      return "shared";
    } catch (cause) {
      if (isShareCancellation(cause)) return "cancelled";
    }
  }

  return (await copyTextToClipboard(text)) ? "copied" : "failed";
}
