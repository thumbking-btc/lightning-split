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
import { Bolt11InvoiceError, validateBolt11Invoice } from "./bolt11";
import type { LnurlPayDiscovery, LnurlPayClient } from "./lnurl";

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
}

function failureSlot(
  slot: InvoiceSlotRequest,
  error: unknown,
): FailedInvoiceSlot {
  const known = error instanceof InfrastructureError;
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
      retryable: known ? error.retryable : false,
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
): boolean {
  if (invoice.description?.includes(description)) return true;
  if (!invoice.descriptionHash) return false;
  if (
    invoice.descriptionHash ===
    bytesToHex(sha256(new TextEncoder().encode(description)))
  )
    return true;
  return discovery.metadataEntries.some(
    (entry) =>
      (entry[0] === "text/plain" || entry[0] === "text/long-desc") &&
      typeof entry[1] === "string" &&
      entry[1].includes(description),
  );
}

export async function generateInvoiceBatch(
  input: GenerateInvoiceBatchInput,
  dependencies: BatchDependencies,
): Promise<GenerateInvoiceBatchResult> {
  const policy = dependencies.policy ?? DEFAULT_LIGHTNING_POLICY;
  const now = dependencies.now ?? Date.now;
  validateBatchInput(input, policy);
  const discovery = await dependencies.client.discover(input.address);
  const results: (
    PendingInvoiceSlot | FailedInvoiceSlot | DeferredInvoiceSlot
  )[] = [];
  const invoices = new Set<string>(input.excludedInvoices ?? []);
  const hashes = new Set<string>(input.excludedPaymentHashes ?? []);
  const commentStatuses: ProviderCommentStatus[] = [];
  const descriptionStatuses: Exclude<PaymentDescriptionStatus, "partial">[] =
    [];
  for (const [index, slot] of input.slots.entries()) {
    try {
      const slotDiscovery =
        index === 0
          ? discovery
          : await dependencies.client.discover(input.address);
      const providerComment = providerCommentForDiscovery(
        input.providerComment,
        slotDiscovery,
      );
      const callback = await dependencies.client.requestInvoice(
        slotDiscovery,
        slot.targetSats,
        {
          ...(providerComment !== undefined
            ? { comment: providerComment }
            : {}),
        },
      );
      let validated;
      try {
        validated = validateBolt11Invoice(callback.invoice, {
          expectedSats: slot.targetSats,
          expectedDescription: slotDiscovery.metadata,
          nowSeconds: Math.floor(now() / 1_000),
          minimumRemainingSeconds: policy.minimumInvoiceRemainingSeconds,
        });
      } catch (cause) {
        throw new InfrastructureError(
          "INVALID_BOLT11",
          "The provider returned an invalid BOLT11 invoice.",
          {
            cause,
          },
        );
      }
      if (
        invoices.has(validated.canonicalInvoice) ||
        hashes.has(validated.paymentHash)
      ) {
        throw new InfrastructureError(
          "DUPLICATE_PAYMENT_HASH",
          "The provider reused an invoice or payment hash.",
        );
      }
      invoices.add(validated.canonicalInvoice);
      hashes.add(validated.paymentHash);
      results.push({
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
          provider: {
            domain: slotDiscovery.domain,
            discoveryUrl: slotDiscovery.discoveryUrl,
            callbackUrl: slotDiscovery.callbackUrl,
          },
        },
        settlementCheck: callback.verifyUrl
          ? { status: "notChecked" }
          : { status: "notAvailable" },
      });
      if (input.providerComment !== undefined)
        commentStatuses.push(
          callback.commentSent ? "forwarded" : "unsupported",
        );
      if (input.providerComment !== undefined)
        descriptionStatuses.push(
          invoiceBindsPaymentDescription(
            input.providerComment,
            validated,
            slotDiscovery,
          )
            ? "embedded"
            : "notEmbedded",
        );
    } catch (error) {
      results.push(failureSlot(slot, error));
    }
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
