import { bech32 } from "@scure/base";

import { safeHttpsUrl } from "../infrastructure/url";
import { buildPaymentPayload, MAX_PAYMENT_PAYLOAD_BYTES } from "./paymentUri";

function validateLnurlPay(payload: string): void {
  try {
    const decoded = bech32.decode(payload, MAX_PAYMENT_PAYLOAD_BYTES);
    if (decoded.prefix !== "lnurl") throw new Error("prefix");
    const url = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bech32.fromWords(decoded.words));
    safeHttpsUrl(url);
  } catch {
    throw new Error("검증된 LNURL-pay 요청만 QR로 만들 수 있습니다.");
  }
}

function validateBip321(payload: string, canonicalInvoice: string): void {
  const prefix = `bitcoin:?lightning=${canonicalInvoice}&message=`;
  if (!payload.startsWith(prefix)) {
    throw new Error("BIP-321 결제 요청의 invoice가 일치하지 않습니다.");
  }
  let note: string;
  try {
    note = decodeURIComponent(payload.slice(prefix.length));
  } catch {
    throw new Error("BIP-321 결제 메모가 올바르지 않습니다.");
  }
  if (buildPaymentPayload(canonicalInvoice, note) !== payload) {
    throw new Error("BIP-321 결제 요청이 canonical 형식이 아닙니다.");
  }
}

export function buildQrPayload(
  paymentRequest: string,
  canonicalInvoice = paymentRequest,
): string {
  if (paymentRequest.length > MAX_PAYMENT_PAYLOAD_BYTES) {
    throw new Error("결제 요청이 QR 최대 길이를 초과합니다.");
  }
  if (paymentRequest === canonicalInvoice) {
    return buildPaymentPayload(canonicalInvoice);
  }
  if (paymentRequest.startsWith("lnurl1")) {
    validateLnurlPay(paymentRequest);
    return paymentRequest;
  }
  if (paymentRequest.startsWith("bitcoin:?lightning=")) {
    validateBip321(paymentRequest, canonicalInvoice);
    return paymentRequest;
  }
  throw new Error("지원하지 않는 결제 요청 형식입니다.");
}
