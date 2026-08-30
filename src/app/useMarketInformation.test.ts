import { describe, expect, it, vi } from "vitest";

import type { PriceResponseDto } from "../api/contracts";
import { serializeBigIntDecimal } from "../api/serialization";
import {
  completeMarketRefresh,
  mergeRestMarketInformation,
} from "./useMarketInformation";

function information(
  priceKrw: bigint,
  observedAt: string,
  premiumReferenceKrw?: bigint,
): PriceResponseDto {
  return {
    ok: true,
    snapshot: {
      priceKrw: serializeBigIntDecimal(priceKrw),
      source: "upbit",
      market: "KRW-BTC",
      observedAt,
      retrievedAt: observedAt,
      snapshotAt: observedAt,
      fallbackUsed: false,
    },
    ...(premiumReferenceKrw === undefined
      ? {}
      : {
          premium: {
            basisPoints: "0",
            referencePriceKrw: premiumReferenceKrw.toString(),
            retrievedAt: observedAt,
          },
        }),
  };
}

describe("market refresh reconciliation", () => {
  it("returns and publishes the same live snapshot used for settlement locking", () => {
    const current = information(
      101_000_000n,
      "2030-01-01T00:00:03.000Z",
      100_000_000n,
    );
    const rest = information(
      99_000_000n,
      "2030-01-01T00:00:02.000Z",
      100_000_000n,
    );
    const setInformation = vi.fn();

    const locked = completeMarketRefresh(rest, current, true, setInformation);

    expect(locked.snapshot.priceKrw).toBe("101000000");
    expect(locked.premium?.basisPoints).toBe("100");
    expect(setInformation).toHaveBeenCalledWith(locked, "live");
  });

  it("removes an old premium when the latest REST response has none", () => {
    const current = information(
      101_000_000n,
      "2030-01-01T00:00:03.000Z",
      100_000_000n,
    );
    const rest = information(99_000_000n, "2030-01-01T00:00:02.000Z");

    const merged = mergeRestMarketInformation(rest, current, true);

    expect(merged.snapshot.priceKrw).toBe("101000000");
    expect(merged.premium).toBeUndefined();
  });

  it("uses a newer REST observation instead of an older live tick", () => {
    const current = information(
      101_000_000n,
      "2030-01-01T00:00:01.000Z",
      100_000_000n,
    );
    const rest = information(99_000_000n, "2030-01-01T00:00:02.000Z");

    expect(mergeRestMarketInformation(rest, current, true)).toBe(rest);
  });

  it("uses the REST snapshot unchanged when the live stream is inactive", () => {
    const current = information(
      101_000_000n,
      "2030-01-01T00:00:01.000Z",
      100_000_000n,
    );
    const rest = information(99_000_000n, "2030-01-01T00:00:02.000Z");

    expect(mergeRestMarketInformation(rest, current, false)).toBe(rest);
  });
});
