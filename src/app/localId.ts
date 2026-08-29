export interface LocalIdCryptoSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (values: Uint8Array) => Uint8Array;
}

let fallbackSequence = 0;

function currentCrypto(): LocalIdCryptoSource | undefined {
  return typeof globalThis.crypto === "object"
    ? (globalThis.crypto as LocalIdCryptoSource)
    : undefined;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createLocalSettlementId(
  source: LocalIdCryptoSource | null | undefined = currentCrypto(),
  nowMs = Date.now(),
  random = Math.random,
): string {
  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }
  if (typeof source?.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    return formatUuid(bytes);
  }

  // This ID only distinguishes local UI sessions. It is never an
  // authentication token or a payment identifier.
  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  const randomPart = Math.floor(random() * 0x1_0000_0000).toString(36);
  return `local-${nowMs.toString(36)}-${fallbackSequence.toString(36)}-${randomPart}`;
}
