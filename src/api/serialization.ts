import type { PriceSnapshot } from "../domain/models";
import { InfrastructureError } from "../infrastructure/errors";
import { isHex, isRecord } from "../infrastructure/validation";

export type DecimalString = string & {
  readonly __decimalString: unique symbol;
};

export interface DecimalParseOptions {
  readonly field: string;
  readonly minimum?: bigint;
  readonly maximum?: bigint;
}

export interface PriceSnapshotDto {
  readonly priceKrw: DecimalString;
  readonly source: PriceSnapshot["source"];
  readonly market: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly snapshotAt: string;
  readonly fallbackUsed: boolean;
}

export function serializeBigIntDecimal(value: bigint): DecimalString {
  return value.toString(10) as DecimalString;
}

export function parseBigIntDecimal(
  value: unknown,
  options: DecimalParseOptions,
): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      `${options.field} must be a canonical decimal string.`,
    );
  }

  const parsed = BigInt(value);
  if (options.minimum !== undefined && parsed < options.minimum) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      `${options.field} is below its minimum.`,
    );
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      `${options.field} exceeds its maximum.`,
    );
  }
  return parsed;
}

export function parsePaymentHash(value: unknown): string {
  if (typeof value !== "string") {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "paymentHash must be a string.",
    );
  }
  const normalized = value.toLowerCase();
  if (!isHex(normalized, 32)) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "paymentHash must contain 32-byte hex.",
    );
  }
  return normalized;
}

export function serializePriceSnapshot(
  snapshot: PriceSnapshot,
): PriceSnapshotDto {
  return {
    priceKrw: serializeBigIntDecimal(snapshot.priceKrw),
    source: snapshot.source,
    market: snapshot.market,
    observedAt: snapshot.observedAt,
    retrievedAt: snapshot.retrievedAt,
    snapshotAt: snapshot.snapshotAt,
    fallbackUsed: snapshot.fallbackUsed,
  };
}

export function parsePriceSnapshotDto(value: unknown): PriceSnapshot {
  if (!isRecord(value)) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "priceSnapshot must be an object.",
    );
  }
  if (
    (value.source !== "upbit" && value.source !== "bithumb") ||
    value.market !== "KRW-BTC" ||
    typeof value.observedAt !== "string" ||
    typeof value.retrievedAt !== "string" ||
    typeof value.snapshotAt !== "string" ||
    typeof value.fallbackUsed !== "boolean"
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "priceSnapshot fields are invalid.",
    );
  }

  for (const timestamp of [
    value.observedAt,
    value.retrievedAt,
    value.snapshotAt,
  ]) {
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        "priceSnapshot timestamp is invalid.",
      );
    }
  }

  return {
    priceKrw: parseBigIntDecimal(value.priceKrw, {
      field: "priceKrw",
      minimum: 1n,
      maximum: BigInt(Number.MAX_SAFE_INTEGER),
    }),
    source: value.source,
    market: value.market,
    observedAt: value.observedAt,
    retrievedAt: value.retrievedAt,
    snapshotAt: value.snapshotAt,
    fallbackUsed: value.fallbackUsed,
  };
}
