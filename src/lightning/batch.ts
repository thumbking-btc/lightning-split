import type { LightningPolicy } from "../config/policies";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  DeferredInvoiceSlot,
  FailedInvoiceSlot,
  PaymentDescriptionStatus,
  PendingInvoiceSlot,
  ProviderCommentStatus,
} from "../domain/models";
import { InfrastructureError } from "../infrastructure/errors";
import type { ValidatedZapRequest } from "../nostr/zap";
import { validateZapInvoice } from "../nostr/zap";
import {
  Bolt11InvoiceError,
  type ValidatedBolt11Invoice,
  validateBolt11Invoice,
} from "./bolt11";
import type {
  LnurlInvoiceResponse,
  LnurlPayDiscovery,
  LnurlPayClient,
} from "./lnurl";

export interface InvoiceSlotRequest {
  readonly slotNumber: number;
  readonly krwShare?: bigint;
  readonly targetSats: bigint;
  readonly attempt: number;
}

export interface GenerateInvoiceBatchInput {
  readonly address: string;
  readonly slots: readonly InvoiceSlotRequest[];
  readonly providerComment?: string;
  readonly excludedPaymentHashes?: readonly string[];
  readonly excludedInvoices?: readonly string[];
}

export interface GenerateInvoiceBatchResult {
  readonly discovery: LnurlPayDiscovery;
  readonly slots: readonly (
    PendingInvoiceSlot | FailedInvoiceSlot | DeferredInvoiceSlot
  )[];
  readonly completedCount: number;
  readonly failedCount: number;
  readonly providerCommentStatus?: ProviderCommentStatus;
  readonly paymentDescriptionStatus?: PaymentDescriptionStatus;
}

export interface BatchDependencies {
  readonly client: Pick<LnurlPayClient, "discover" | "requestInvoice">;
  readonly policy?: LightningPolicy;
  readonly now?: () => number;
  readonly prepareNostrPayment?: (
    discovery: LnurlPayDiscovery,
    slot: InvoiceSlotRequest,
    providerComment?: string,
  ) => Promise<NostrPaymentPreparation>;
}

export interface NostrPaymentPreparation {
  readonly request: ValidatedZapRequest;
  readonly relayChannel: string;
  readonly relayUrl: string;
  readonly providerPubkey: string;
}

function failureSlot(
  slot: InvoiceSlotRequest,
  error: unknown,
): FailedInvoiceSlot {
  const known = error instanceof InfrastructureError;
  const canRetryWithFreshProviderState =
    known &&
    new Set([
      "PROVIDER_REJECTED",
      "INVALID_RESPONSE",
      "INVALID_BOLT11",
      "DUPLICATE_PAYMENT_HASH",
      "BATCH_ABORTED",
    ]).has(error.code);
  return {
    ...slot,
    status: "failed",
    failure: {
      code: known
        ? error.code
        : error instanceof Bolt11InvoiceError
          ? error.code
          : "UNKNOWN",
      message:
        error instanceof Error ? error.message : "Invoice generation failed.",
      retryable:
        error instanceof Bolt11InvoiceError
          ? true
          : known
            ? error.retryable || canRetryWithFreshProviderState
            : false,
    },
  };
}

function validateBatchInput(
  input: GenerateInvoiceBatchInput,
  policy: LightningPolicy,
): void {
  if (input.slots.length < 1 || input.slots.length > policy.maximumBatchSize) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The batch size is invalid.",
    );
  }
  if (
    input.providerComment !== undefined &&
    (input.providerComment.length < 1 ||
      [...input.providerComment].length >
        policy.maximumProviderCommentCharacters)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The provider comment is invalid.",
    );
  }
  const numbers = new Set<number>();
  for (const slot of input.slots) {
    if (
      !Number.isSafeInteger(slot.slotNumber) ||
      slot.slotNumber < 1 ||
      numbers.has(slot.slotNumber)
    ) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        "Slot numbers must be unique positive integers.",
      );
    }
    if (
      !Number.isSafeInteger(slot.attempt) ||
      slot.attempt < 1 ||
      slot.targetSats < 1n
    ) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        "Slot amount or attempt is invalid.",
      );
    }
    numbers.add(slot.slotNumber);
  }
}

function providerCommentForDiscovery(
  comment: string | undefined,
  discovery: LnurlPayDiscovery,
): string | undefined {
  if (
    comment === undefined ||
    discovery.commentAllowed === 0 ||
    [...comment].length > discovery.commentAllowed
  )
    return undefined;
  return comment;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function invoiceBindsPaymentDescription(
  description: string,
  invoice: {
    readonly description?: string;
    readonly descriptionHash?: string;
  },
  discovery: LnurlPayDiscovery,
  alternateDescriptionPreimage?: string,
): boolean {
  if (invoice.description === description) return true;
  if (!invoice.descriptionHash) return false;
  if (
    invoice.descriptionHash ===
    bytesToHex(sha256(new TextEncoder().encode(description)))
  )
    return true;
  if (
    invoice.descriptionHash ===
      bytesToHex(sha256(new TextEncoder().encode(discovery.metadata))) &&
    discovery.metadataEntries.some(
      (entry) =>
        (entry[0] === "text/plain" || entry[0] === "text/long-desc") &&
        entry[1] === description,
    )
  ) {
    return true;
  }
  return (
    alternateDescriptionPreimage !== undefined &&
    alternateDescriptionPreimage.includes(description) &&
    invoice.descriptionHash ===
      bytesToHex(sha256(new TextEncoder().encode(alternateDescriptionPreimage)))
  );
}

export async function generateInvoiceBatch(
  input: GenerateInvoiceBatchInput,
  dependencies: BatchDependencies,
): Promise<GenerateInvoiceBatchResult> {
  const policy = dependencies.policy ?? DEFAULT_LIGHTNING_POLICY;
  const now = dependencies.now ?? Date.now;
  validateBatchInput(input, policy);
  const invoices = new Set<string>(input.excludedInvoices ?? []);
  const hashes = new Set<string>(input.excludedPaymentHashes ?? []);
  const commentStatuses: ProviderCommentStatus[] = [];
  const descriptionStatuses: Exclude<PaymentDescriptionStatus, "partial">[] =
    [];
  const discoveryResults = await Promise.allSettled(
    input.slots.map(() => dependencies.client.discover(input.address)),
  );
  const discovery = discoveryResults.find(
    (result): result is PromiseFulfilledResult<LnurlPayDiscovery> =>
      result.status === "fulfilled",
  )?.value;
  if (!discovery) {
    const firstFailure = discoveryResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw firstFailure?.reason;
  }
  const generatedSlots = await Promise.all(
    input.slots.map(async (slot, index) => {
      const discoveryResult = discoveryResults[index];
      if (!discoveryResult || discoveryResult.status === "rejected") {
        return {
          kind: "failure" as const,
          slot: failureSlot(slot, discoveryResult?.reason),
        };
      }
      const slotDiscovery = discoveryResult.value;
      try {
        const providerComment = providerCommentForDiscovery(
          input.providerComment,
          slotDiscovery,
        );
        let nostrPreparation: NostrPaymentPreparation | undefined;
        if (
          slotDiscovery.allowsNostr &&
          slotDiscovery.nostrPubkey !== undefined &&
          dependencies.prepareNostrPayment !== undefined
        ) {
          try {
            nostrPreparation = await dependencies.prepareNostrPayment(
              slotDiscovery,
              slot,
              providerComment,
            );
          } catch {
            // NIP-57 is optional. A local preparation failure must leave the
            // base LUD-06 path available.
          }
        }
        let callback: LnurlInvoiceResponse | undefined;
        let validated: ValidatedBolt11Invoice | undefined;
        if (nostrPreparation !== undefined) {
          try {
            callback = await dependencies.client.requestInvoice(
              slotDiscovery,
              slot.targetSats,
              {
                ...(providerComment === undefined
                  ? {}
                  : { comment: providerComment }),
                nostr: {
                  requestJson: nostrPreparation.request.json,
                  lnurl: nostrPreparation.request.lnurl,
                },
              },
            );
            validated = validateZapInvoice(
              callback.invoice,
              nostrPreparation.request,
            );
            if (
              validated.expiresAt - Math.floor(now() / 1_000) <
              policy.minimumInvoiceRemainingSeconds
            ) {
              throw new Bolt11InvoiceError(
                "EXPIRED",
                "The NIP-57 invoice is expired or near expiry.",
              );
            }
          } catch {
            // A provider may advertise NIP-57 but reject a particular request.
            // Retry the same slot through plain LUD-06; never turn an optional
            // capability into a prerequisite for invoice creation.
            nostrPreparation = undefined;
          }
        }
        if (nostrPreparation === undefined) {
          callback = await dependencies.client.requestInvoice(
            slotDiscovery,
            slot.targetSats,
            providerComment === undefined ? {} : { comment: providerComment },
          );
          try {
            validated = validateBolt11Invoice(callback.invoice, {
              expectedSats: slot.targetSats,
              nowSeconds: Math.floor(now() / 1_000),
              minimumRemainingSeconds: policy.minimumInvoiceRemainingSeconds,
            });
          } catch (cause) {
            throw new InfrastructureError(
              "INVALID_BOLT11",
              "The provider returned an invalid BOLT11 invoice.",
              { cause },
            );
          }
        }
        if (callback === undefined || validated === undefined) {
          throw new InfrastructureError(
            "INVALID_RESPONSE",
            "The provider invoice result is incomplete.",
          );
        }
        const pendingSlot: PendingInvoiceSlot = {
          ...slot,
          status: "pending",
          invoice: {
            bolt11: validated.canonicalInvoice,
            paymentHash: validated.paymentHash,
            timestampSeconds: validated.timestamp,
            expirySeconds: validated.expirySeconds,
            expiresAt: new Date(validated.expiresAt * 1_000).toISOString(),
            payeeNodeId: validated.payeeNodeId,
            featureBits: validated.featureBits,
            disposable: callback.disposable,
            ...(callback.verifyUrl !== undefined
              ? { verifyUrl: callback.verifyUrl }
              : {}),
            ...(callback.successAction === undefined
              ? {}
              : { successAction: callback.successAction }),
            ...(nostrPreparation === undefined
              ? {}
              : {
                  nostrVerification: {
                    relayChannel: nostrPreparation.relayChannel,
                    relayUrl: nostrPreparation.relayUrl,
                    providerPubkey: nostrPreparation.providerPubkey,
                    requestJson: nostrPreparation.request.json,
                    requestId: nostrPreparation.request.event.id,
                    recipientPubkey: nostrPreparation.request.recipientPubkey,
                    lnurl: nostrPreparation.request.lnurl,
                  },
                }),
            provider: {
              domain: slotDiscovery.domain,
              discoveryUrl: slotDiscovery.discoveryUrl,
              callbackUrl: slotDiscovery.callbackUrl,
              metadata: slotDiscovery.metadata,
            },
          },
          settlementCheck:
            callback.verifyUrl || nostrPreparation !== undefined
              ? { status: "notChecked" }
              : { status: "notAvailable" },
        };
        return {
          kind: "success" as const,
          request: slot,
          slot: pendingSlot,
          providerCommentStatus:
            input.providerComment === undefined
              ? undefined
              : callback.commentSent
                ? ("forwarded" as const)
                : ("unsupported" as const),
          paymentDescriptionStatus:
            input.providerComment === undefined
              ? undefined
              : invoiceBindsPaymentDescription(
                    input.providerComment,
                    validated,
                    slotDiscovery,
                    nostrPreparation?.request.event.content ===
                      input.providerComment
                      ? nostrPreparation.request.json
                      : undefined,
                  )
                ? ("embedded" as const)
                : ("notEmbedded" as const),
        };
      } catch (error) {
        return { kind: "failure" as const, slot: failureSlot(slot, error) };
      }
    }),
  );
  const results: (
    PendingInvoiceSlot | FailedInvoiceSlot | DeferredInvoiceSlot
  )[] = [];
  const responseNowSeconds = Math.floor(now() / 1_000);
  for (const generated of generatedSlots) {
    if (generated.kind === "failure") {
      results.push(generated.slot);
      continue;
    }
    if (
      Date.parse(generated.slot.invoice.expiresAt) / 1_000 -
        responseNowSeconds <
      policy.minimumInvoiceRemainingSeconds
    ) {
      results.push(
        failureSlot(
          generated.request,
          new InfrastructureError(
            "INVALID_BOLT11",
            "The provider invoice became too close to expiry before the batch completed.",
          ),
        ),
      );
      continue;
    }
    if (
      invoices.has(generated.slot.invoice.bolt11) ||
      hashes.has(generated.slot.invoice.paymentHash)
    ) {
      results.push(
        failureSlot(
          generated.request,
          new InfrastructureError(
            "DUPLICATE_PAYMENT_HASH",
            "The provider reused an invoice or payment hash.",
          ),
        ),
      );
      continue;
    }
    invoices.add(generated.slot.invoice.bolt11);
    hashes.add(generated.slot.invoice.paymentHash);
    results.push(generated.slot);
    if (generated.providerCommentStatus !== undefined)
      commentStatuses.push(generated.providerCommentStatus);
    if (generated.paymentDescriptionStatus !== undefined)
      descriptionStatuses.push(generated.paymentDescriptionStatus);
  }

  const completedCount = results.filter(
    (slot) => slot.status === "pending",
  ).length;
  const failedCount = results.filter((slot) => slot.status === "failed").length;
  const providerCommentStatus =
    input.providerComment === undefined || commentStatuses.length === 0
      ? undefined
      : commentStatuses.every((status) => status === "forwarded")
        ? ("forwarded" as const)
        : commentStatuses.every((status) => status === "unsupported")
          ? ("unsupported" as const)
          : ("partial" as const);
  const paymentDescriptionStatus =
    input.providerComment === undefined || descriptionStatuses.length === 0
      ? undefined
      : descriptionStatuses.every((status) => status === "embedded")
        ? ("embedded" as const)
        : descriptionStatuses.every((status) => status === "notEmbedded")
          ? ("notEmbedded" as const)
          : ("partial" as const);
  return Object.freeze({
    discovery,
    slots: Object.freeze(results),
    completedCount,
    failedCount,
    ...(providerCommentStatus === undefined ? {} : { providerCommentStatus }),
    ...(paymentDescriptionStatus === undefined
      ? {}
      : { paymentDescriptionStatus }),
  });
}
