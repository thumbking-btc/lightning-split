import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { buildPaymentPayload, MAX_PAYMENT_PAYLOAD_BYTES } from "./paymentUri";

function createInvoice(): string {
  return createTestBolt11({
    amountSats: 1_000n,
    fixtureId: "bip-321-payment-uri",
  }).invoice;
}

describe("BIP-321 payment payload", () => {
  it.each([undefined, ""])(
    "keeps the raw canonical BOLT11 when the note is absent",
    (note) => {
      const invoice = createInvoice();
      expect(buildPaymentPayload(invoice, note)).toBe(invoice);
    },
  );

  it("adds a single UTF-8 percent-encoded message to the canonical invoice", () => {
    const invoice = createInvoice();
    const note = "8/30 고깃집 저녁 & A=B?#%";
    const payload = buildPaymentPayload(invoice, note);

    expect(payload).toBe(
      `bitcoin:?lightning=${invoice}&message=8%2F30%20%EA%B3%A0%EA%B9%83%EC%A7%91%20%EC%A0%80%EB%85%81%20%26%20A%3DB%3F%23%25`,
    );
    expect(decodeURIComponent(payload.split("&message=")[1] ?? "")).toBe(note);
    expect(payload).not.toContain("pop=");
    expect(payload).not.toContain("req-pop=");
  });

  it("uses strict RFC 3986 encoding for reserved punctuation", () => {
    const invoice = createInvoice();
    expect(buildPaymentPayload(invoice, "!'()*")).toBe(
      `bitcoin:?lightning=${invoice}&message=%21%27%28%29%2A`,
    );
  });

  it("rejects prefixed, upper-case, whitespace-padded, and bad-checksum invoices", () => {
    const invoice = createInvoice();
    const differentLastCharacter = invoice.endsWith("q") ? "p" : "q";
    const badChecksum = `${invoice.slice(0, -1)}${differentLastCharacter}`;

    for (const candidate of [
      `lightning:${invoice}`,
      invoice.toUpperCase(),
      ` ${invoice}`,
      badChecksum,
    ]) {
      expect(() => buildPaymentPayload(candidate, "memo")).toThrow(TypeError);
    }
  });

  it("enforces the QR-safe URI byte boundary", () => {
    const invoice = createInvoice();
    const base = `bitcoin:?lightning=${invoice}&message=`;
    const availableAsciiBytes = MAX_PAYMENT_PAYLOAD_BYTES - base.length;

    expect(
      buildPaymentPayload(invoice, "a".repeat(availableAsciiBytes)).length,
    ).toBe(MAX_PAYMENT_PAYLOAD_BYTES);
    expect(() =>
      buildPaymentPayload(invoice, "a".repeat(availableAsciiBytes + 1)),
    ).toThrow(RangeError);
    expect(() => buildPaymentPayload(invoice, "한".repeat(300))).toThrow(
      RangeError,
    );
  });

  it("rejects malformed UTF-16 instead of silently replacing it", () => {
    expect(() => buildPaymentPayload(createInvoice(), "\ud800")).toThrow(
      TypeError,
    );
  });
});
