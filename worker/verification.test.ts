import { describe, expect, it } from "vitest";

import {
  createEphemeralZapRecipientAlias,
  createEphemeralZapRequest,
  encodeLnurlPayUrl,
} from "../src/nostr/zap";
import {
  assertVerificationLink,
  openVerificationContext,
  sealVerificationContext,
} from "./verification";

const SECRET = "11".repeat(32);
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const INVOICE = "lnbc1000testinvoice";
const PAYMENT_HASH = "22".repeat(32);

describe("sealed verification token", () => {
  it("round-trips without exposing the verify URL", async () => {
    const token = await sealVerificationContext(
      {
        verifyUrl: "https://wallet.example/verify/secret-path",
        expectedPaymentHash: PAYMENT_HASH,
        expectedInvoice: INVOICE,
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
      SECRET,
      NOW,
    );
    expect(token).toMatch(/^v1\./u);
    expect(token).not.toContain("wallet.example");
    const context = await openVerificationContext(token, SECRET, NOW);
    expect(context.verifyUrl).toBe("https://wallet.example/verify/secret-path");
    await expect(
      assertVerificationLink(context, PAYMENT_HASH, INVOICE),
    ).resolves.toBeUndefined();
  });

  it("rejects tampering and a wrong invoice/payment hash link", async () => {
    const token = await sealVerificationContext(
      {
        verifyUrl: "https://wallet.example/verify/one",
        expectedPaymentHash: PAYMENT_HASH,
        expectedInvoice: INVOICE,
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
      SECRET,
      NOW,
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(
      openVerificationContext(tampered, SECRET, NOW),
    ).rejects.toThrow("결제 확인 정보");
    const context = await openVerificationContext(token, SECRET, NOW);
    await expect(
      assertVerificationLink(context, "33".repeat(32), INVOICE),
    ).rejects.toThrow("결제 확인 정보");
    await expect(
      assertVerificationLink(context, PAYMENT_HASH, `${INVOICE}changed`),
    ).rejects.toThrow("결제 확인 정보");
  });

  it("preserves authenticated expiry for endpoint enforcement", async () => {
    const token = await sealVerificationContext(
      {
        verifyUrl: "https://wallet.example/verify/one",
        expectedPaymentHash: PAYMENT_HASH,
        expectedInvoice: INVOICE,
        expiresAt: new Date(NOW + 1_000).toISOString(),
      },
      SECRET,
      NOW,
    );
    const context = await openVerificationContext(token, SECRET, NOW + 2_000);
    expect(context.expiresAtMs).toBe(NOW + 1_000);
  });

  it("round-trips a NIP-57 provider-attestation method under the backward-compatible v1 token envelope", async () => {
    const relayChannel = "44".repeat(32);
    const request = createEphemeralZapRequest({
      recipientPubkey: createEphemeralZapRecipientAlias(),
      amountMsat: 1_000_000n,
      lnurl: encodeLnurlPayUrl(
        "https://wallet.example/.well-known/lnurlp/user",
      ),
      relays: [`wss://relay.example/api/nostr/${relayChannel}`],
      createdAt: Math.floor(NOW / 1_000),
    });
    const providerPubkey = createEphemeralZapRecipientAlias();
    const token = await sealVerificationContext(
      {
        nip57: {
          relayChannel,
          providerPubkey,
          requestJson: request.json,
        },
        expectedPaymentHash: PAYMENT_HASH,
        expectedInvoice: INVOICE,
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
      SECRET,
      NOW,
    );

    expect(token).toMatch(/^v1\./u);
    expect(token).not.toContain(request.json);
    const context = await openVerificationContext(token, SECRET, NOW);
    expect(context.verifyUrl).toBeUndefined();
    expect(context.nip57).toEqual({
      relayChannel,
      providerPubkey,
      requestJson: request.json,
    });
    await expect(
      assertVerificationLink(context, PAYMENT_HASH, INVOICE),
    ).resolves.toBeUndefined();
  });
});
