import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { buildQrPayload } from "./qr";

describe("QR payload", () => {
  it("is exactly the canonical BOLT11 invoice", () => {
    const fixture = createTestBolt11({ amountSats: 1_000n, fixtureId: "qr" });
    expect(buildQrPayload(fixture.invoice)).toBe(fixture.invoice);
  });

  it("rejects non-canonical payloads", () => {
    expect(() => buildQrPayload("LIGHTNING:lnbc-test")).toThrowError();
  });
});
