import { describe, expect, it } from "vitest";

import type { PriceSnapshot } from "../domain/models";
import {
  parseBigIntDecimal,
  parsePaymentHash,
  parsePriceSnapshotDto,
  serializePriceSnapshot,
} from "./serialization";

describe("API decimal serialization", () => {
  it("round-trips BigInt price fields as canonical decimal strings", () => {
    const snapshot: PriceSnapshot = {
      priceKrw: 123_456_789n,
      source: "upbit",
      market: "KRW-BTC",
      observedAt: "2030-01-01T00:00:00.000Z",
      retrievedAt: "2030-01-01T00:00:01.000Z",
      snapshotAt: "2030-01-01T00:00:01.000Z",
      fallbackUsed: false,
    };
    expect(parsePriceSnapshotDto(serializePriceSnapshot(snapshot))).toEqual(
      snapshot,
    );
  });

  it("rejects non-canonical or out-of-range decimal strings", () => {
    expect(() => parseBigIntDecimal("01", { field: "amount" })).toThrowError();
    expect(() => parseBigIntDecimal("-1", { field: "amount" })).toThrowError();
    expect(() =>
      parseBigIntDecimal("11", { field: "amount", maximum: 10n }),
    ).toThrowError();
  });

  it("normalizes a 32-byte payment hash", () => {
    expect(parsePaymentHash("AB".repeat(32))).toBe("ab".repeat(32));
    expect(() => parsePaymentHash("ab")).toThrowError();
  });
});
