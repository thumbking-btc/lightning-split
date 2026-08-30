import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { buildQrPayload } from "./qr";

describe("QR payload", () => {
  it("uses the validated BOLT11 invoice as the only payload and uppercases it", () => {
    const fixture = createTestBolt11({ amountSats: 1_000n, fixtureId: "qr" });
    expect(buildQrPayload(fixture.invoice)).toBe(fixture.invoice.toUpperCase());
  });

  it.each([
    "LIGHTNING:lnbc-test",
    "bitcoin:?lightning=lnbc1test",
    "lnurl1dp68gurn8ghj7",
    "lnbc-invalid-character-i",
  ])("rejects a non-BOLT11 payload: %s", (payload) => {
    expect(() => buildQrPayload(payload)).toThrowError();
  });
});
