import { describe, expect, it } from "vitest";

import {
  assertVerificationLink,
  hashInvoice,
  openVerificationContext,
  sealVerificationContext,
} from "./verification";

const SECRET = "11".repeat(32);
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const VERIFY_URL = "https://wallet.example/verify/secret-path";
const INVOICE = "lnbc1000testinvoice";
const PAYMENT_HASH = "22".repeat(32);

async function seal(
  overrides: Partial<Parameters<typeof sealVerificationContext>[0]> = {},
): Promise<string> {
  return sealVerificationContext(
    {
      verifyUrl: VERIFY_URL,
      expectedPaymentHash: PAYMENT_HASH,
      expectedInvoice: INVOICE,
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      ...overrides,
    },
    SECRET,
    NOW,
  );
}

describe("sealed LUD-21 verification token", () => {
  it("seals, opens, and verifies the URL/hash/invoice link in a v2 envelope", async () => {
    const token = await seal();

    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u);
    expect(token).not.toContain("wallet.example");
    expect(token).not.toContain(INVOICE);
    expect(token).not.toContain(PAYMENT_HASH);

    const context = await openVerificationContext(token, SECRET, NOW);
    expect(context).toEqual({
      verifyUrl: VERIFY_URL,
      expectedPaymentHash: PAYMENT_HASH,
      expectedInvoiceHash: await hashInvoice(INVOICE),
      issuedAtMs: NOW,
      expiresAtMs: NOW + 3_600_000,
    });
    await expect(
      assertVerificationLink(context, PAYMENT_HASH, INVOICE),
    ).resolves.toBeUndefined();
  });

  it("rejects a tampered authenticated envelope", async () => {
    const token = await seal();
    const last = token.at(-1)!;
    const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;

    await expect(
      openVerificationContext(tampered, SECRET, NOW),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves authenticated expiry for endpoint enforcement and rejects invalid lifetimes", async () => {
    const expiresAtMs = NOW + 1_000;
    const token = await seal({
      expiresAt: new Date(expiresAtMs).toISOString(),
    });

    const expiredContext = await openVerificationContext(
      token,
      SECRET,
      expiresAtMs + 1,
    );
    expect(expiredContext.expiresAtMs).toBe(expiresAtMs);

    await expect(
      seal({ expiresAt: new Date(NOW).toISOString() }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      seal({
        expiresAt: new Date(NOW + 31 * 24 * 60 * 60 * 1_000 + 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects legacy v1 envelopes", async () => {
    const legacyToken = `v1.${"A".repeat(16)}.${"A".repeat(32)}`;

    await expect(
      openVerificationContext(legacyToken, SECRET, NOW),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unsafe verification URLs and malformed payment hashes", async () => {
    await expect(
      seal({ verifyUrl: "http://wallet.example/verify/payment" }),
    ).rejects.toBeDefined();
    await expect(
      seal({ expectedPaymentHash: "AB".repeat(32) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      seal({ expectedPaymentHash: PAYMENT_HASH.slice(1) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects payment hashes and invoices that do not match the sealed link", async () => {
    const context = await openVerificationContext(await seal(), SECRET, NOW);

    await expect(
      assertVerificationLink(context, "33".repeat(32), INVOICE),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      assertVerificationLink(context, PAYMENT_HASH, `${INVOICE}changed`),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
