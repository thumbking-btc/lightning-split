import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";

import { InfrastructureError } from "../infrastructure/errors";
import {
  createSignedZapRequest,
  encodeLnurlPayUrl,
  type ValidatedZapRequest,
} from "../nostr/zap";
import { createTestBolt11 } from "../test/bolt11-fixture";
import { generateInvoiceBatch, type InvoiceSlotRequest } from "./batch";
import type {
  LnurlInvoiceResponse,
  InvoiceRequestOptions,
  LnurlPayDiscovery,
  LnurlPayClient,
} from "./lnurl";

const NOW_SECONDS = 1_900_000_100;
const AUXILIARY_RANDOM = new Uint8Array(32);

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

const NIP57_PROVIDER_PUBKEY = bytesToHex(schnorr.getPublicKey(secret(2)));
const NIP57_RECIPIENT_PUBKEY = bytesToHex(schnorr.getPublicKey(secret(3)));
const DISCOVERY: LnurlPayDiscovery = {
  address: "user@wallet.example",
  username: "user",
  domain: "wallet.example",
  discoveryUrl: "https://wallet.example/.well-known/lnurlp/user",
  callbackUrl: "https://wallet.example/callback",
  minSendableMsat: 1_000n,
  maxSendableMsat: 100_000_000n,
  metadata: '[["text/plain","test"]]',
  metadataEntries: [["text/plain", "test"]],
  payerData: null,
  mandatoryPayerData: [],
  commentAllowed: 0,
  allowsNostr: false,
};

const NIP57_DISCOVERY: LnurlPayDiscovery = {
  ...DISCOVERY,
  commentAllowed: 255,
  allowsNostr: true,
  nostrPubkey: NIP57_PROVIDER_PUBKEY,
};

function nip57Request(
  slot: InvoiceSlotRequest,
  content = "",
): ValidatedZapRequest {
  return createSignedZapRequest(
    {
      recipientPubkey: NIP57_RECIPIENT_PUBKEY,
      amountMsat: slot.targetSats * 1_000n,
      lnurl: encodeLnurlPayUrl(NIP57_DISCOVERY.discoveryUrl),
      relays: [`wss://relay.example/${slot.slotNumber}`],
      content,
      createdAt: NOW_SECONDS,
    },
    secret(1),
    AUXILIARY_RANDOM,
  );
}

function slots(count: number): InvoiceSlotRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    slotNumber: index + 1,
    targetSats: 1_000n + BigInt(index),
    attempt: 1,
  }));
}

function clientWith(
  requestInvoice: (
    discovery: LnurlPayDiscovery,
    amountSats: bigint,
    options?: InvoiceRequestOptions,
  ) => Promise<
    Pick<LnurlInvoiceResponse, "invoice"> &
      Partial<Omit<LnurlInvoiceResponse, "invoice">>
  >,
  discovery: LnurlPayDiscovery = DISCOVERY,
): {
  readonly client: Pick<LnurlPayClient, "discover" | "requestInvoice">;
  readonly discover: ReturnType<typeof vi.fn>;
  readonly callback: ReturnType<typeof vi.fn>;
} {
  const discover = vi.fn(() => Promise.resolve(discovery));
  const callback = vi.fn(
    async (
      currentDiscovery: LnurlPayDiscovery,
      amountSats: bigint,
      options?: InvoiceRequestOptions,
    ) => {
      const result = await requestInvoice(
        currentDiscovery,
        amountSats,
        options,
      );
      return {
        disposable: result.disposable ?? false,
        commentSent: result.commentSent ?? options?.comment !== undefined,
        ...result,
      };
    },
  );
  return { client: { discover, requestInvoice: callback }, discover, callback };
}

describe("invoice batch generation", () => {
  it("produces N unique validated pending invoices concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    let call = 0;
    const mock = clientWith(async (_discovery, amountSats) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const current = ++call;
      await Promise.resolve();
      active -= 1;
      return {
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `success-${current}`,
        }).invoice,
        ...(current === 1
          ? { verifyUrl: `https://wallet.example/verify/${current}` }
          : {}),
      };
    });
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(5) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(mock.discover).toHaveBeenCalledTimes(5);
    expect(mock.callback).toHaveBeenCalledTimes(5);
    expect(maximumActive).toBe(5);
    expect(result.completedCount).toBe(5);
    const pending = result.slots.filter((slot) => slot.status === "pending");
    expect(new Set(pending.map((slot) => slot.invoice.bolt11)).size).toBe(5);
    expect(new Set(pending.map((slot) => slot.invoice.paymentHash)).size).toBe(
      5,
    );
    expect(pending[0]?.settlementCheck.status).toBe("notChecked");
    expect(pending[1]?.settlementCheck.status).toBe("notAvailable");
  });

  it("forwards the same settlement note to every callback when supported", async () => {
    let call = 0;
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: `comment-${++call}`,
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(3),
        providerComment: "8/30 고깃집 저녁",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(mock.callback).toHaveBeenCalledTimes(3);
    for (const callbackCall of mock.callback.mock.calls) {
      expect(callbackCall[2]).toEqual({ comment: "8/30 고깃집 저녁" });
    }
    expect(result.providerCommentStatus).toBe("forwarded");
    expect(result.paymentDescriptionStatus).toBe("notEmbedded");
  });

  it("accepts an exact NIP-57 description-hash invoice as pending with automatic settlement eligibility", async () => {
    const note = "8/30 고깃집 저녁";
    const slot = slots(1)[0]!;
    const request = nip57Request(slot, note);
    const preparation = {
      request,
      relayChannel: "a".repeat(64),
      relayUrl: "wss://relay.example/1",
      providerPubkey: NIP57_PROVIDER_PUBKEY,
    };
    const fixture = createTestBolt11({
      amountSats: slot.targetSats,
      fixtureId: "nip57-exact-invoice",
      timestamp: NOW_SECONDS,
      descriptionHashSource: request.json,
    });
    const mock = clientWith((_discovery, _amountSats, options) => {
      expect(options).toEqual({
        comment: note,
        nostr: {
          requestJson: request.json,
          lnurl: request.lnurl,
        },
      });
      return Promise.resolve({ invoice: fixture.invoice });
    }, NIP57_DISCOVERY);
    const prepareNostrPayment = vi.fn(() => Promise.resolve(preparation));

    const result = await generateInvoiceBatch(
      {
        address: NIP57_DISCOVERY.address,
        slots: [slot],
        providerComment: note,
      },
      {
        client: mock.client,
        prepareNostrPayment,
        now: () => NOW_SECONDS * 1_000,
      },
    );

    expect(prepareNostrPayment).toHaveBeenCalledWith(
      NIP57_DISCOVERY,
      slot,
      note,
    );
    expect(result.slots[0]).toMatchObject({
      status: "pending",
      settlementCheck: { status: "notChecked" },
      invoice: {
        bolt11: fixture.invoice,
        paymentHash: fixture.paymentHash,
        nostrVerification: {
          relayChannel: preparation.relayChannel,
          relayUrl: preparation.relayUrl,
          providerPubkey: NIP57_PROVIDER_PUBKEY,
          requestJson: request.json,
          requestId: request.event.id,
          recipientPubkey: request.recipientPubkey,
          lnurl: request.lnurl,
        },
      },
    });
    expect(result.providerCommentStatus).toBe("forwarded");
    expect(result.paymentDescriptionStatus).toBe("embedded");
  });

  it.each(["callback rejection", "wrong description hash"] as const)(
    "falls back to plain LUD-06 for the same slot after NIP-57 %s",
    async (failureMode) => {
      const note = "8/30 고깃집 저녁";
      const slot = slots(1)[0]!;
      const request = nip57Request(slot, note);
      const plain = createTestBolt11({
        amountSats: slot.targetSats,
        fixtureId: `nip57-fallback-${failureMode}`,
        timestamp: NOW_SECONDS,
      });
      const wrongHash = createTestBolt11({
        amountSats: slot.targetSats,
        fixtureId: `nip57-rejected-${failureMode}`,
        timestamp: NOW_SECONDS,
        descriptionHashSource: "not the exact zap request",
      });
      const mock = clientWith((_discovery, _amountSats, options) => {
        if (options?.nostr !== undefined) {
          return failureMode === "callback rejection"
            ? Promise.reject(
                new InfrastructureError(
                  "PROVIDER_REJECTED",
                  "NIP-57 rejected",
                  { retryable: true },
                ),
              )
            : Promise.resolve({ invoice: wrongHash.invoice });
        }
        return Promise.resolve({ invoice: plain.invoice });
      }, NIP57_DISCOVERY);

      const result = await generateInvoiceBatch(
        {
          address: NIP57_DISCOVERY.address,
          slots: [slot],
          providerComment: note,
        },
        {
          client: mock.client,
          prepareNostrPayment: () =>
            Promise.resolve({
              request,
              relayChannel: "b".repeat(64),
              relayUrl: "wss://relay.example/1",
              providerPubkey: NIP57_PROVIDER_PUBKEY,
            }),
          now: () => NOW_SECONDS * 1_000,
        },
      );

      expect(mock.callback).toHaveBeenCalledTimes(2);
      expect(mock.callback.mock.calls[0]?.[2]).toEqual({
        comment: note,
        nostr: { requestJson: request.json, lnurl: request.lnurl },
      });
      expect(mock.callback.mock.calls[1]?.[2]).toEqual({ comment: note });
      expect(result.slots[0]).toMatchObject({
        status: "pending",
        settlementCheck: { status: "notAvailable" },
        invoice: {
          bolt11: plain.invoice,
          paymentHash: plain.paymentHash,
        },
      });
      if (result.slots[0]?.status === "pending") {
        expect(result.slots[0].invoice.nostrVerification).toBeUndefined();
      }
      expect(result.providerCommentStatus).toBe("forwarded");
    },
  );

  it("keeps fallback and NIP-57 invoices unique across a mixed multi-slot batch", async () => {
    const note = "8/30 고깃집 저녁";
    const requests = new Map<number, ValidatedZapRequest>();
    const mock = clientWith((_discovery, amountSats, options) => {
      if (options?.nostr !== undefined) {
        if (amountSats === 1_000n) {
          return Promise.reject(
            new InfrastructureError(
              "PROVIDER_REJECTED",
              "optional zap request rejected",
              { retryable: true },
            ),
          );
        }
        if (amountSats === 1_001n) {
          return Promise.resolve({
            invoice: createTestBolt11({
              amountSats,
              fixtureId: "mixed-invalid-h",
              timestamp: NOW_SECONDS,
              descriptionHashSource: "wrong request",
            }).invoice,
          });
        }
        return Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "mixed-valid-nip57",
            timestamp: NOW_SECONDS,
            descriptionHashSource: options.nostr.requestJson,
          }).invoice,
        });
      }
      return Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `mixed-fallback-${amountSats}`,
          timestamp: NOW_SECONDS,
        }).invoice,
      });
    }, NIP57_DISCOVERY);

    const result = await generateInvoiceBatch(
      {
        address: NIP57_DISCOVERY.address,
        slots: slots(3),
        providerComment: note,
      },
      {
        client: mock.client,
        prepareNostrPayment: (_discovery, slot) => {
          const request = nip57Request(slot, note);
          requests.set(slot.slotNumber, request);
          return Promise.resolve({
            request,
            relayChannel: slot.slotNumber.toString(16).padStart(64, "0"),
            relayUrl: `wss://relay.example/${slot.slotNumber}`,
            providerPubkey: NIP57_PROVIDER_PUBKEY,
          });
        },
        now: () => NOW_SECONDS * 1_000,
      },
    );

    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    const pending = result.slots.filter((slot) => slot.status === "pending");
    expect(new Set(pending.map((slot) => slot.invoice.bolt11)).size).toBe(3);
    expect(new Set(pending.map((slot) => slot.invoice.paymentHash)).size).toBe(
      3,
    );
    expect(pending[0]?.invoice.nostrVerification).toBeUndefined();
    expect(pending[1]?.invoice.nostrVerification).toBeUndefined();
    expect(pending[2]?.invoice.nostrVerification?.requestJson).toBe(
      requests.get(3)?.json,
    );
    expect(result.providerCommentStatus).toBe("forwarded");
    expect(mock.callback).toHaveBeenCalledTimes(5);
  });

  it("detects when the provider embeds the payment description in BOLT11", async () => {
    const description = "8/30 고깃집 저녁";
    const direct = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "description-direct",
            description,
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );
    const directResult = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: direct.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(directResult.paymentDescriptionStatus).toBe("embedded");

    const metadata = `[["text/plain","${description}"]]`;
    const hashed = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "description-hash",
            descriptionHashSource: metadata,
          }).invoice,
        }),
      {
        ...DISCOVERY,
        metadata,
        metadataEntries: [["text/plain", description]],
        commentAllowed: 255,
      },
    );
    const hashedResult = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: hashed.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(hashedResult.paymentDescriptionStatus).toBe("embedded");
  });

  it("reports partial BOLT11 description binding per invoice", async () => {
    const description = "8/30 고깃집 저녁";
    let call = 0;
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: `description-partial-${++call}`,
            ...(call === 1 ? { description } : {}),
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );
    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(2),
        providerComment: description,
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.paymentDescriptionStatus).toBe("partial");
  });

  it("accepts a provider-signed description hash without assuming its preimage", async () => {
    const description = "8/30 고깃집 저녁";
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "provider-description-hash",
            descriptionHashSource: "provider-controlled private description",
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 255 },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]?.status).toBe("pending");
    expect(result.paymentDescriptionStatus).toBe("notEmbedded");
  });

  it("does not infer description embedding from a metadata substring without an exact hash binding", async () => {
    const description = "8/30 고깃집 저녁";
    const metadata = JSON.stringify([
      ["text/plain", `Pay to test user (${description})`],
    ]);
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "metadata-substring-not-bound",
            descriptionHashSource: "different provider-controlled preimage",
          }).invoice,
        }),
      {
        ...DISCOVERY,
        metadata,
        metadataEntries: [["text/plain", `Pay to test user (${description})`]],
        commentAllowed: 255,
      },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: description,
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]?.status).toBe("pending");
    expect(result.paymentDescriptionStatus).toBe("notEmbedded");
  });

  it("preserves a validated LUD-09 success action on the issued invoice", async () => {
    const successAction = {
      tag: "message" as const,
      message: "결제가 완료되었습니다.",
    };
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "success-action",
        }).invoice,
        successAction,
      }),
    );

    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(1) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]).toMatchObject({
      status: "pending",
      invoice: { successAction },
    });
  });

  it("continues without a provider comment when comments are unsupported", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `unsupported-${amountSats}`,
        }).invoice,
      }),
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(2),
        providerComment: "8/30 고깃집 저녁",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.completedCount).toBe(2);
    expect(mock.callback).toHaveBeenCalledTimes(2);
    expect(mock.callback.mock.calls[0]?.[2]).toEqual({});
  });

  it("keeps settlement working when a provider-specific comment limit is smaller", async () => {
    const mock = clientWith(
      (_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: "comment-too-long",
          }).invoice,
        }),
      { ...DISCOVERY, commentAllowed: 5 },
    );

    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: slots(1),
        providerComment: "123456",
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]?.status).toBe("pending");
    expect(result.providerCommentStatus).toBe("unsupported");
    expect(mock.callback).toHaveBeenCalledWith(
      { ...DISCOVERY, commentAllowed: 5 },
      1_000n,
      {},
    );
  });

  it("keeps successful slots and continues after an ordinary provider failure", async () => {
    let call = 0;
    const mock = clientWith((_discovery, amountSats) => {
      call += 1;
      if (call === 2) {
        return Promise.reject(
          new InfrastructureError(
            "PROVIDER_REJECTED",
            "temporary provider error",
            { retryable: true },
          ),
        );
      }
      return Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `partial-${call}`,
        }).invoice,
      });
    });
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(3) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "failed",
      "pending",
    ]);
    expect(mock.callback).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2])(
    "isolates discovery call %i failure without blocking other callback requests",
    async (failedDiscoveryCall) => {
      let discoveryCall = 0;
      let invoiceCall = 0;
      const discover = vi.fn(() => {
        discoveryCall += 1;
        return discoveryCall === failedDiscoveryCall
          ? Promise.reject(
              new InfrastructureError("NETWORK_ERROR", "discovery failed", {
                retryable: true,
              }),
            )
          : Promise.resolve(DISCOVERY);
      });
      const requestInvoice = vi.fn(
        (_discovery: LnurlPayDiscovery, amountSats: bigint) =>
          Promise.resolve({
            invoice: createTestBolt11({
              amountSats,
              fixtureId: `rediscovery-${++invoiceCall}`,
            }).invoice,
            disposable: true,
            commentSent: false,
          }),
      );

      const result = await generateInvoiceBatch(
        { address: "user@wallet.example", slots: slots(3) },
        {
          client: { discover, requestInvoice },
          now: () => NOW_SECONDS * 1_000,
        },
      );

      const expectedStatuses = ["pending", "pending", "pending"];
      expectedStatuses[failedDiscoveryCall - 1] = "failed";
      expect(result.slots.map((slot) => slot.status)).toEqual(expectedStatuses);
      expect(result.slots[failedDiscoveryCall - 1]).toMatchObject({
        failure: { code: "NETWORK_ERROR", retryable: true },
      });
      expect(requestInvoice).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects duplicate payment hashes independently and still checks every slot", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "duplicate",
        }).invoice,
      }),
    );
    const sameAmounts = slots(3).map((slot) => ({
      ...slot,
      targetSats: 1_000n,
    }));
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: sameAmounts },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "failed",
      "failed",
    ]);
    expect(result.slots[1]).toMatchObject({
      failure: { code: "DUPLICATE_PAYMENT_HASH", retryable: true },
    });
    expect(result.slots[2]).toMatchObject({
      failure: { code: "DUPLICATE_PAYMENT_HASH", retryable: true },
    });
    expect(mock.callback).toHaveBeenCalledTimes(3);
  });

  it("rejects an invoice or payment hash reused by a slot retry", async () => {
    const reused = createTestBolt11({
      amountSats: 1_000n,
      fixtureId: "retry-reused",
    });
    const mock = clientWith(() => Promise.resolve({ invoice: reused.invoice }));
    const result = await generateInvoiceBatch(
      {
        address: "user@wallet.example",
        slots: [slots(1)[0]!],
        excludedPaymentHashes: [reused.paymentHash],
        excludedInvoices: [reused.invoice],
      },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "DUPLICATE_PAYMENT_HASH", retryable: true },
    });
  });

  it("isolates invalid BOLT11 responses to their own slots", async () => {
    const mock = clientWith(() => Promise.resolve({ invoice: "lnbc-invalid" }));
    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(2) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );
    expect(result.slots[0]).toMatchObject({
      failure: { code: "INVALID_BOLT11", retryable: true },
    });
    expect(result.slots[1]).toMatchObject({
      failure: { code: "INVALID_BOLT11", retryable: true },
    });
    expect(mock.callback).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["TIMEOUT", undefined],
    ["RATE_LIMITED", 30],
  ] as const)(
    "keeps slot failures independent after %s",
    async (code, retryAfterSeconds) => {
      const mock = clientWith(() =>
        Promise.reject(
          new InfrastructureError(code, "stop", {
            retryable: true,
            ...(retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds, upstreamStatus: 429 }),
          }),
        ),
      );
      const result = await generateInvoiceBatch(
        { address: "user@wallet.example", slots: slots(3) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );
      expect(result.slots[0]).toMatchObject({ failure: { code } });
      expect(
        result.slots.slice(1).every((slot) => slot.status === "failed"),
      ).toBe(true);
      expect(mock.callback).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps every normal slot issued while preserving response-time freshness", async () => {
    let call = 0;
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: `freshness-${++call}`,
          timestamp: NOW_SECONDS,
          expirySeconds: 180,
        }).invoice,
      }),
    );

    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(3) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots.map((slot) => slot.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(mock.discover).toHaveBeenCalledTimes(3);
    expect(mock.callback).toHaveBeenCalledTimes(3);
    const pending = result.slots.filter((slot) => slot.status === "pending");
    expect(new Set(pending.map((slot) => slot.invoice.paymentHash)).size).toBe(
      3,
    );
    expect(
      pending.every(
        (slot) =>
          Date.parse(slot.invoice.expiresAt) / 1_000 - NOW_SECONDS >= 120,
      ),
    ).toBe(true);
  });

  it("accepts a single invoice with 121 seconds remaining", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "short-valid-invoice",
          timestamp: NOW_SECONDS,
          expirySeconds: 121,
        }).invoice,
      }),
    );

    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(1) },
      { client: mock.client, now: () => NOW_SECONDS * 1_000 },
    );

    expect(result.slots[0]?.status).toBe("pending");
  });

  it("rejects an early invoice that becomes too close to expiry before the response", async () => {
    const mock = clientWith((_discovery, amountSats) =>
      Promise.resolve({
        invoice: createTestBolt11({
          amountSats,
          fixtureId: "stale-at-response",
          timestamp: NOW_SECONDS,
          expirySeconds: 121,
        }).invoice,
      }),
    );
    let clockCall = 0;

    const result = await generateInvoiceBatch(
      { address: "user@wallet.example", slots: slots(1) },
      {
        client: mock.client,
        now: () => (NOW_SECONDS + (clockCall++ === 0 ? 0 : 2)) * 1_000,
      },
    );

    expect(result.slots[0]).toMatchObject({
      status: "failed",
      failure: { code: "INVALID_BOLT11" },
    });
  });

  it.each([true, false])(
    "does not treat LUD-11 disposable=%s as a callback or invoice concurrency capability",
    async (disposable) => {
      let call = 0;
      const mock = clientWith((_discovery, amountSats) =>
        Promise.resolve({
          invoice: createTestBolt11({
            amountSats,
            fixtureId: `disposable-${disposable}-${++call}`,
          }).invoice,
          disposable,
        }),
      );

      const result = await generateInvoiceBatch(
        { address: "user@wallet.example", slots: slots(3) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );

      expect(result.slots.map((slot) => slot.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      expect(result.failedCount).toBe(0);
      expect(mock.discover).toHaveBeenCalledTimes(3);
      expect(mock.callback).toHaveBeenCalledTimes(3);
      const pending = result.slots.filter((slot) => slot.status === "pending");
      expect(
        pending.every((slot) => slot.invoice.disposable === disposable),
      ).toBe(true);
      expect(new Set(pending.map((slot) => slot.invoice.bolt11)).size).toBe(3);
      expect(
        new Set(pending.map((slot) => slot.invoice.paymentHash)).size,
      ).toBe(3);
    },
  );
});
