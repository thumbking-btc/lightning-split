import { InfrastructureError } from "./errors";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProviderInteger(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        `${field} must be a non-negative safe integer.`,
      );
    }
    return BigInt(value);
  }

  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    return BigInt(value);
  }

  throw new InfrastructureError(
    "INVALID_RESPONSE",
    `${field} must be a non-negative decimal integer.`,
  );
}

export function parsePositiveSafeInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

export function sanitizeProviderReason(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replaceAll(/./gu, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 180) : fallback;
}

export function isHex(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value);
}
