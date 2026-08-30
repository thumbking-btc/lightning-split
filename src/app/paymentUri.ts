import { bech32 } from "@scure/base";

import { MAX_BOLT11_LENGTH } from "../lightning/bolt11";

// QRCode's byte-mode capacity at error correction level M is 2,331 bytes.
// Keep a small margin so every URI accepted here remains encodable by QrCode.
export const MAX_PAYMENT_PAYLOAD_BYTES = 2_300;

const MAINNET_BOLT11_PREFIX = /^lnbc(?:[1-9][0-9]*[munp]?)?$/u;
const MINIMUM_BOLT11_WORDS = 111;

function assertCanonicalBolt11(canonicalInvoice: string): void {
  if (
    typeof canonicalInvoice !== "string" ||
    canonicalInvoice.length === 0 ||
    canonicalInvoice.length > MAX_BOLT11_LENGTH ||
    canonicalInvoice !== canonicalInvoice.toLowerCase() ||
    canonicalInvoice !== canonicalInvoice.trim()
  ) {
    throw new TypeError(
      "검증된 canonical BOLT11만 결제 payload로 만들 수 있습니다.",
    );
  }

  try {
    const decoded = bech32.decode(canonicalInvoice, false);
    if (
      !MAINNET_BOLT11_PREFIX.test(decoded.prefix) ||
      decoded.words.length < MINIMUM_BOLT11_WORDS
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(
      "검증된 canonical BOLT11만 결제 payload로 만들 수 있습니다.",
    );
  }
}

function encodeQueryValue(value: string): string {
  try {
    return encodeURIComponent(value).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw new TypeError("결제 메모는 유효한 UTF-8 문자열이어야 합니다.");
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Returns the canonical BOLT11 unchanged when there is no note. With a note,
 * returns the BIP-321 URI understood by wallets that surface `message` in the
 * payer's transaction history.
 */
export function buildPaymentPayload(
  canonicalInvoice: string,
  note?: string,
): string {
  assertCanonicalBolt11(canonicalInvoice);

  if (note === undefined) return canonicalInvoice;
  if (typeof note !== "string") {
    throw new TypeError("결제 메모는 문자열이어야 합니다.");
  }
  if (note.length === 0) return canonicalInvoice;

  const payload = `bitcoin:?lightning=${canonicalInvoice}&message=${encodeQueryValue(note)}`;
  if (utf8ByteLength(payload) > MAX_PAYMENT_PAYLOAD_BYTES) {
    throw new RangeError("결제 메모를 포함한 URI가 QR 최대 길이를 초과합니다.");
  }
  return payload;
}
