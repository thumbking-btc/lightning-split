import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { encodeLnurlPayUrl } from "../nostr/zap";
import { buildPaymentPayload } from "./paymentUri";
import { buildQrPayload } from "./qr";

describe("QR payload", () => {
  it("is exactly the canonical BOLT11 invoice", () => {
    const fixture = createTestBolt11({ amountSats: 1_000n, fixtureId: "qr" });
    expect(buildQrPayload(fixture.invoice)).toBe(fixture.invoice);
  });

  it("rejects non-canonical payloads", () => {
    expect(() => buildQrPayload("LIGHTNING:lnbc-test")).toThrowError();
  });

  it("accepts a canonical BIP-321 note bound to the exact invoice", () => {
    const fixture = createTestBolt11({ amountSats: 1_000n, fixtureId: "bip" });
    const payload = buildPaymentPayload(fixture.invoice, "8/30 고깃집 저녁");
    expect(buildQrPayload(payload, fixture.invoice)).toBe(payload);
    const other = createTestBolt11({ amountSats: 1_000n, fixtureId: "other" });
    expect(() => buildQrPayload(payload, other.invoice)).toThrowError();
  });

  it("accepts a checksummed public HTTPS LNURL-pay request", () => {
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "lnurl",
    });
    const payload = encodeLnurlPayUrl(
      "https://lightning-split.example/api/pay/" + "ab".repeat(32),
    );
    expect(buildQrPayload(payload, fixture.invoice)).toBe(payload);
  });
});
