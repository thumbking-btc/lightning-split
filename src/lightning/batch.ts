import type { LightningPolicy } from "../config/policies";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import type { FailedInvoiceSlot, PendingInvoiceSlot } from "../domain/models";
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
  readonly slots: readonly (PendingInvoiceSlot | FailedInvoiceSlot)[];
  readonly completedCount: number;
  readonly failedCount: number;
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

function shouldAbort(error: unknown): boolean {
  return (
    error instanceof Bolt11InvoiceError ||
    (error instanceof InfrastructureError &&
      [
        "TIMEOUT",
        "NETWORK_ERROR",
        "RATE_LIMITED",
        "DUPLICATE_PAYMENT_HASH",
        "INVALID_BOLT11",
      ].includes(error.code))
  );
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

function assertDiscoverySupportsBatch(
  discovery: LnurlPayDiscovery,
  slots: readonly InvoiceSlotRequest[],
): void {
  if (discovery.mandatoryPayerData.length > 0) {
    throw new InfrastructureError(
      "PAYER_DATA_REQUIRED",
      "The provider requires payer data.",
    );
  }
  for (const slot of slots) {
    const amountMsat = slot.targetSats * 1_000n;
    if (
      amountMsat < discovery.minSendableMsat ||
      amountMsat > discovery.maxSendableMsat
    ) {
      throw new InfrastructureError(
        "AMOUNT_OUT_OF_RANGE",
        `Slot ${slot.slotNumber} is outside the provider amount range.`,
      );
    }
  }
}

export async function generateInvoiceBatch(
  input: GenerateInvoiceBatchInput,
  dependencies: BatchDependencies,
): Promise<GenerateInvoiceBatchResult> {
  const policy = dependencies.policy ?? DEFAULT_LIGHTNING_POLICY;
  const now = dependencies.now ?? Date.now;
  validateBatchInput(input, policy);
  const discovery = await dependencies.client.discover(input.address);
  assertDiscoverySupportsBatch(discovery, input.slots);
  const results: (PendingInvoiceSlot | FailedInvoiceSlot)[] = [];
  const invoices = new Set<string>(input.excludedInvoices ?? []);
  const hashes = new Set<string>(input.excludedPaymentHashes ?? []);
  let abortCause: unknown;

  for (const slot of input.slots) {
    if (abortCause) {
      results.push(
        failureSlot(
          slot,
          new InfrastructureError(
            "BATCH_ABORTED",
            "The remaining batch was not requested after a safety failure.",
            {
              retryable: true,
              cause: abortCause,
            },
          ),
        ),
      );
      continue;
    }
    try {
      const callback = await dependencies.client.requestInvoice(
        discovery,
        slot.targetSats,
        {
          ...(input.providerComment !== undefined
            ? { comment: input.providerComment }
            : {}),
        },
      );
      let validated;
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
          ...(callback.verifyUrl !== undefined
            ? { verifyUrl: callback.verifyUrl }
            : {}),
          provider: {
            domain: discovery.domain,
            discoveryUrl: discovery.discoveryUrl,
            callbackUrl: discovery.callbackUrl,
          },
        },
        settlementCheck: callback.verifyUrl
          ? { status: "notChecked" }
          : { status: "notAvailable" },
      });
    } catch (error) {
      results.push(failureSlot(slot, error));
      if (shouldAbort(error)) abortCause = error;
    }
  }

  const completedCount = results.filter(
    (slot) => slot.status === "pending",
  ).length;
  return Object.freeze({
    discovery,
    slots: Object.freeze(results),
    completedCount,
    failedCount: results.length - completedCount,
  });
}
