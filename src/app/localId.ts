export interface LocalIdCryptoSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (values: Uint8Array) => Uint8Array;
}

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

  // This ID is also the Durable Object idempotency key. A weak fallback can
  // collide across tabs or be preempted, so invoice issuance must stop.
  throw new Error("이 브라우저는 안전한 정산 식별자 생성을 지원하지 않습니다.");
}
