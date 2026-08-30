import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import {
  Bolt11InvoiceError,
  MAX_BOLT11_LENGTH,
  validateBolt11Invoice,
} from "./bolt11";

describe("validateBolt11Invoice", () => {
  const nowSeconds = 1_900_000_100;

  it("strictly validates exact amount, hash, signature and expiry", () => {
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "valid",
    });
    const result = validateBolt11Invoice(fixture.invoice, {
      expectedSats: 1_000n,
      nowSeconds,
      minimumRemainingSeconds: 120,
    });
    expect(result.paymentHash).toBe(fixture.paymentHash);
    expect(result.amountSats).toBe(1_000n);
    expect(result.payeeNodeId).toHaveLength(66);
    expect(result.expiresAt).toBe(1_900_003_600);
    expect(result.description).toBe("Lightning Split test invoice");
    expect(result.descriptionHash).toBeUndefined();
  });

  it("rejects an amount mismatch", () => {
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "amount",
    });
    expect(() =>
      validateBolt11Invoice(fixture.invoice, {
        expectedSats: 1_001n,
        nowSeconds,
      }),
    ).toThrowError(Bolt11InvoiceError);
  });

  it("rejects checksum damage and near-expiry invoices", () => {
    const fixture = createTestBolt11({
      amountSats: 1n,
      fixtureId: "expiry",
      expirySeconds: 100,
    });
    expect(() =>
      validateBolt11Invoice(`${fixture.invoice.slice(0, -1)}q`, {
        expectedSats: 1n,
        nowSeconds,
      }),
    ).toThrowError();
    expect(() =>
      validateBolt11Invoice(fixture.invoice, {
        expectedSats: 1n,
        nowSeconds,
        minimumRemainingSeconds: 120,
      }),
    ).toThrowError();
  });

  it("validates LNURL metadata hashes and ignores unsupported fallback versions", () => {
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "metadata-hash",
      descriptionHashSource: '[["text/plain","recipient"]]',
      includeFallback: true,
    });
    const validated = validateBolt11Invoice(fixture.invoice, {
      expectedSats: 1_000n,
      expectedDescription: '[["text/plain","recipient"]]',
      nowSeconds,
    });
    expect(validated.paymentHash).toBe(fixture.paymentHash);
    expect(validated.description).toBeUndefined();
    expect(validated.descriptionHash).toHaveLength(64);
    expect(() =>
      validateBolt11Invoice(fixture.invoice, {
        expectedSats: 1_000n,
        expectedDescription: '[["text/plain","other"]]',
        nowSeconds,
      }),
    ).toThrowError(Bolt11InvoiceError);
  });

  it("accepts a valid long-description invoice above the legacy 1,200-character limit", () => {
    const description = "x".repeat(639);
    const fixture = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "long-description",
      description,
    });

    expect(fixture.invoice.length).toBeGreaterThan(1_200);
    expect(fixture.invoice.length).toBeLessThanOrEqual(MAX_BOLT11_LENGTH);
    expect(
      validateBolt11Invoice(fixture.invoice, {
        expectedSats: 1_000n,
        nowSeconds,
      }).description,
    ).toBe(description);
  });
});
