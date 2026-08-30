import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { createTestBolt11 } from "../test/bolt11-fixture";
import { isValidNostrPublicKey, signNostrEvent } from "./event";
import {
  createEphemeralZapRequest,
  createEphemeralZapRecipientAlias,
  createSignedZapRequest,
  decodeLnurlPayUrl,
  encodeLnurlPayUrl,
  parseAndValidateZapRequest,
  type ValidatedZapRequest,
  validateZapInvoice,
  validateZapReceipt,
} from "./zap";

const auxiliaryRandom = new Uint8Array(32);
const timestamp = 1_900_000_000;
const fixtureId = "x".repeat(27);

function secret(value: number): Uint8Array {
  const result = new Uint8Array(32);
  result[31] = value;
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function createRequest(): ValidatedZapRequest {
  return createSignedZapRequest(
    {
      recipientPubkey: bytesToHex(schnorr.getPublicKey(secret(3))),
      amountMsat: 92_000n,
      lnurl: encodeLnurlPayUrl(
        "https://wallet.example.com/.well-known/lnurlp/recipient",
      ),
      relays: ["wss://relay.example.com", "wss://relay2.example.com/path"],
      content: "8/30 고깃집 저녁",
      createdAt: timestamp,
    },
    secret(1),
    auxiliaryRandom,
  );
}

function createFixture(request: ValidatedZapRequest) {
  return createTestBolt11({
    amountSats: 92n,
    fixtureId,
    timestamp,
    expirySeconds: 3_600,
    descriptionHashSource: request.json,
  });
}

function createReceipt(
  request: ValidatedZapRequest,
  invoice: string,
  options: {
    readonly providerSecret?: Uint8Array;
    readonly tags?: readonly (readonly string[])[];
    readonly createdAt?: number;
    readonly content?: string;
  } = {},
) {
  const preimage = bytesToHex(new TextEncoder().encode(`hash:${fixtureId}`));
  return signNostrEvent(
    {
      created_at: options.createdAt ?? timestamp + 10,
      kind: 9_735,
      tags: options.tags ?? [
        ["p", request.recipientPubkey],
        ["P", request.event.pubkey],
        ["bolt11", invoice],
        ["description", request.json],
        ["preimage", preimage],
      ],
      content: options.content ?? "",
    },
    options.providerSecret ?? secret(2),
    auxiliaryRandom,
  );
}

function receiptContext(request: ValidatedZapRequest) {
  const fixture = createFixture(request);
  return {
    fixture,
    context: {
      request,
      providerPubkey: bytesToHex(schnorr.getPublicKey(secret(2))),
      expectedInvoice: fixture.invoice,
      expectedPaymentHash: fixture.paymentHash,
      nowSeconds: timestamp + 20,
    },
  } as const;
}

describe("NIP-57 zap primitives", () => {
  it("round-trips a public HTTPS pay URL through canonical LNURL encoding", () => {
    const url = "https://wallet.example.com/.well-known/lnurlp/recipient";
    const encoded = encodeLnurlPayUrl(url);

    expect(encoded.startsWith("lnurl1")).toBe(true);
    expect(decodeLnurlPayUrl(encoded)).toBe(url);
    expect(() => encodeLnurlPayUrl("http://127.0.0.1/private")).toThrowError(
      expect.objectContaining({ code: "LNURL" }),
    );
  });

  it("creates a signed one-use request with exact amount, recipient and relays", () => {
    const request = createRequest();

    expect(request.event.kind).toBe(9_734);
    expect(request.amountMsat).toBe(92_000n);
    expect(request.event.pubkey).toBe(
      bytesToHex(schnorr.getPublicKey(secret(1))),
    );
    expect(request.relays).toEqual([
      "wss://relay.example.com",
      "wss://relay2.example.com/path",
    ]);
    expect(
      parseAndValidateZapRequest(request.json, {
        expectedAmountMsat: 92_000n,
        expectedRecipientPubkey: request.recipientPubkey,
        expectedLnurl: request.lnurl,
      }).event.id,
    ).toBe(request.event.id);

    const ephemeral = createEphemeralZapRequest({
      recipientPubkey: request.recipientPubkey,
      amountMsat: request.amountMsat,
      lnurl: request.lnurl,
      relays: request.relays,
      createdAt: timestamp,
    });
    expect(ephemeral.event.pubkey).not.toBe(request.event.pubkey);

    const alias = createEphemeralZapRecipientAlias();
    expect(isValidNostrPublicKey(alias)).toBe(true);
    expect(createEphemeralZapRecipientAlias()).not.toBe(alias);
  });

  it("validates the exact description-hash invoice and signed receipt links", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const invoice = validateZapInvoice(fixture.invoice, request);
    const receipt = createReceipt(request, fixture.invoice);

    expect(invoice.descriptionHash).toHaveLength(64);
    expect(invoice.paymentHash).toBe(fixture.paymentHash);
    expect(validateZapReceipt(receipt, context)).toMatchObject({
      paymentHash: fixture.paymentHash,
      preimage: bytesToHex(new TextEncoder().encode(`hash:${fixtureId}`)),
      providerAttestation: true,
    });
  });

  it("accepts a provider attestation without the optional preimage", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const receipt = createReceipt(request, fixture.invoice, {
      tags: [
        ["p", request.recipientPubkey],
        ["bolt11", fixture.invoice],
        ["description", request.json],
      ],
    });

    const validated = validateZapReceipt(receipt, context);
    expect(validated.preimage).toBeUndefined();
    expect(validated.providerAttestation).toBe(true);
  });

  it("rejects invoices that do not bind the request or exact amount", () => {
    const request = createRequest();
    const wrongDescription = createTestBolt11({
      amountSats: 92n,
      fixtureId: "wrong-description",
      timestamp,
      descriptionHashSource: "{}",
    });
    const wrongAmount = createTestBolt11({
      amountSats: 93n,
      fixtureId: "wrong-amount",
      timestamp,
      descriptionHashSource: request.json,
    });

    expect(() =>
      validateZapInvoice(wrongDescription.invoice, request),
    ).toThrowError(expect.objectContaining({ code: "INVOICE" }));
    expect(() => validateZapInvoice(wrongAmount.invoice, request)).toThrowError(
      expect.objectContaining({ code: "INVOICE" }),
    );
  });

  it("rejects the wrong provider signer and tampered NIP-01 signatures", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const wrongSigner = createReceipt(request, fixture.invoice, {
      providerSecret: secret(4),
    });
    const valid = createReceipt(request, fixture.invoice);

    expect(() => validateZapReceipt(wrongSigner, context)).toThrowError(
      expect.objectContaining({ code: "PROVIDER" }),
    );
    expect(() =>
      validateZapReceipt({ ...valid, content: "tampered" }, context),
    ).toThrowError(expect.objectContaining({ code: "RECEIPT_EVENT" }));
  });

  it("rejects receipt invoice, description, recipient and duplicate tags", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const otherRecipient = bytesToHex(schnorr.getPublicKey(secret(5)));
    const cases = [
      [
        ["p", request.recipientPubkey],
        [
          "bolt11",
          `${fixture.invoice.slice(0, -1)}${fixture.invoice.endsWith("q") ? "p" : "q"}`,
        ],
        ["description", request.json],
      ],
      [
        ["p", request.recipientPubkey],
        ["bolt11", fixture.invoice],
        ["description", `${request.json} `],
      ],
      [
        ["p", otherRecipient],
        ["bolt11", fixture.invoice],
        ["description", request.json],
      ],
      [
        ["p", request.recipientPubkey],
        ["bolt11", fixture.invoice],
        ["description", request.json],
        ["description", request.json],
      ],
    ] as const;

    for (const tags of cases) {
      expect(() =>
        validateZapReceipt(
          createReceipt(request, fixture.invoice, { tags }),
          context,
        ),
      ).toThrowError();
    }
  });

  it("rejects a contradictory preimage, payment hash and receipt time", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const badPreimage = createReceipt(request, fixture.invoice, {
      tags: [
        ["p", request.recipientPubkey],
        ["bolt11", fixture.invoice],
        ["description", request.json],
        ["preimage", "00".repeat(32)],
      ],
    });

    expect(() => validateZapReceipt(badPreimage, context)).toThrowError(
      expect.objectContaining({ code: "PREIMAGE" }),
    );
    expect(() =>
      validateZapReceipt(createReceipt(request, fixture.invoice), {
        ...context,
        expectedPaymentHash: "00".repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "PAYMENT_HASH" }));
    expect(() =>
      validateZapReceipt(
        createReceipt(request, fixture.invoice, {
          createdAt: timestamp + 10_000,
        }),
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "RECEIPT_TIME" }));
  });

  it("accepts a late provider receipt after invoice expiry", () => {
    const request = createRequest();
    const { fixture, context } = receiptContext(request);
    const lateReceiptAt = timestamp + 3_601;

    expect(
      validateZapReceipt(
        createReceipt(request, fixture.invoice, { createdAt: lateReceiptAt }),
        { ...context, nowSeconds: lateReceiptAt },
      ),
    ).toMatchObject({
      paymentHash: fixture.paymentHash,
      providerAttestation: true,
    });
  });

  it("rejects unsafe relays and mismatched callback bindings", () => {
    const request = createRequest();
    expect(() =>
      createSignedZapRequest(
        {
          recipientPubkey: request.recipientPubkey,
          amountMsat: request.amountMsat,
          lnurl: request.lnurl,
          relays: ["wss://127.0.0.1/private"],
          createdAt: timestamp,
        },
        secret(1),
        auxiliaryRandom,
      ),
    ).toThrowError(expect.objectContaining({ code: "RELAY" }));
    expect(() =>
      parseAndValidateZapRequest(request.json, {
        expectedAmountMsat: 93_000n,
      }),
    ).toThrowError(expect.objectContaining({ code: "AMOUNT" }));
    expect(() =>
      parseAndValidateZapRequest(request.json, {
        expectedLnurl: encodeLnurlPayUrl("https://other.example.com/lnurl"),
      }),
    ).toThrowError(expect.objectContaining({ code: "LNURL" }));
  });

  it("bounds adversarial decimal amounts before BigInt parsing", () => {
    const base = createRequest();
    const event = signNostrEvent(
      {
        created_at: timestamp,
        kind: 9_734,
        tags: [
          ["relays", "wss://relay.example.com"],
          ["amount", "9".repeat(20_000)],
          ["lnurl", base.lnurl],
          ["p", base.recipientPubkey],
        ],
        content: "",
      },
      secret(1),
      auxiliaryRandom,
    );

    expect(() =>
      parseAndValidateZapRequest(JSON.stringify(event)),
    ).toThrowError(expect.objectContaining({ code: "AMOUNT" }));
  });
});
