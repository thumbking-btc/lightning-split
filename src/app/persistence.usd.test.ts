import { describe, expect, it } from "vitest";

import type { UsdPriceSnapshotDto } from "../api/contracts";
import {
  restoreSession,
  serializeSession,
} from "./persistence";
import {
  createGeneratingSession,
  createSettlementPreview,
  type DraftInput,
} from "./session";

const usdSnapshot: UsdPriceSnapshotDto = {
  priceUsdCents: "10000000",
  source: "coinbase",
  market: "BTC-USD",
  observedAt: "2030-01-01T00:00:00.000Z",
  retrievedAt: "2030-01-01T00:00:01.000Z",
  snapshotAt: "2030-01-01T00:00:01.000Z",
  fallbackUsed: false,
};

describe("USD settlement persistence", () => {
  it("round-trips the frozen BTC/USD snapshot and cent shares", () => {
    const draft: DraftInput = {
      inputMode: "usd",
      totalAmount: "10001",
      totalPeople: 4,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: [],
    };
    const preview = createSettlementPreview(draft, undefined, usdSnapshot);
    const session = createGeneratingSession(
      draft,
      preview,
      undefined,
      usdSnapshot,
      new Date("2030-01-01T00:00:02.000Z"),
      () => "usd-session",
    );

    const restored = restoreSession(serializeSession(session));

    expect(restored.inputMode).toBe("usd");
    expect(restored.usdPriceSnapshot).toEqual(usdSnapshot);
    expect(restored.payerShareUsdCents).toBe("2501");
    expect(restored.slots.map((slot) => slot.usdCentsShare)).toEqual([
      "2500",
      "2500",
      "2500",
    ]);
    expect(restored.slots.map((slot) => slot.targetSats)).toEqual([
      "25000",
      "25000",
      "25000",
    ]);
  });
});
