import type { LightningPolicy } from "../config/policies";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import type {
  FailedInvoiceSlot,
  PendingInvoiceSlot,
  ProviderCommentStatus,
} from "../domain/models";
import { InfrastructureError } from "../infrastructure/errors";
import { Bolt11InvoiceError, validateBolt11Invoice } from "./bolt11";
import type { LnurlPayDiscovery, LnurlPayClient } from "./lnurl";
import { selectSettlementCapability } from "./settlement-capability";

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
}

export interface GenerateInvoiceBatchResult {
  readonly discovery: LnurlPayDiscovery;
  readonly slots: readonly (PendingInvoiceSlot | FailedInvoiceSlot)[];
  readonly completedCount: number;
  readonly failedCount: number;
  readonly providerCommentStatus?: ProviderCommentStatus;
}

export interface BatchDependencies {
  readonly client: Pick<LnurlPayClient, "discover" | "requestInvoice">;
  readonly policy?: LightningPolicy;
  readonly now?: () => number;
  /** Called after discovery and immediately before any payable callback. */
  readonly onInvoiceRequestsStarting?: () => void | Promise<void>;
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
    !Number.isSafeInteger(policy.providerRequestConcurrency) ||
    policy.providerRequestConcurrency < 1
  ) {
    throw new InfrastructureError(
      "CONFIGURATION_ERROR",
      "The provider request concurrency is invalid.",
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
): {
  readonly comment?: string;
  readonly truncated: boolean;
} {
  if (comment === undefined || discovery.commentAllowed === 0) {
    return { truncated: false };
  }
  const characters = [...comment];
  if (characters.length <= discovery.commentAllowed) {
    return { comment, truncated: false };
  }
  return {
    comment: characters.slice(0, discovery.commentAllowed).join(""),
    truncated: true,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

export async function generateInvoiceBatch(
  input: GenerateInvoiceBatchInput,
  dependencies: BatchDependencies,
): Promise<GenerateInvoiceBatchResult> {
  const policy = dependencies.policy ?? DEFAULT_LIGHTNING_POLICY;
  const now = dependencies.now ?? Date.now;
  validateBatchInput(input, policy);

  // LUD-16 discovery describes one address. Reusing one fresh discovery
  // response avoids an unnecessary provider burst without assuming that
  // LUD-11's `disposable` flag permits invoice reuse.
  const discovery = await dependencies.client.discover(input.address);
  const providerComment = providerCommentForDiscovery(
    input.providerComment,
    discovery,
  );
  await dependencies.onInvoiceRequestsStarting?.();
  const generatedSlots = await mapWithConcurrency(
    input.slots,
    policy.providerRequestConcurrency,
    async (slot) => {
      try {
        const callback = await dependencies.client.requestInvoice(
          discovery,
          slot.targetSats,
          providerComment.comment === undefined
            ? {}
            : { comment: providerComment.comment },
        );
        if (callback.successAction !== undefined) {
          // A raw BOLT11 payer cannot execute LUD-09 after payment. Silently
          // dropping the action would change the provider's advertised flow.
          throw new InfrastructureError(
            "UNSUPPORTED_PAYMENT_FLOW",
            "The provider requires a post-payment action that this payment flow cannot preserve.",
          );
        }
        const settlementCapability = selectSettlementCapability(callback);
        let validated;
        try {
          validated = validateBolt11Invoice(callback.invoice, {
            expectedSats: slot.targetSats,
            nowSeconds: Math.floor(now() / 1_000),
            minimumRemainingSeconds: policy.minimumInvoiceRemainingSeconds,
          });
          if (
            validated.expiresAt - Math.floor(now() / 1_000) >
            policy.maximumInvoiceRemainingSeconds
          ) {
            throw new Bolt11InvoiceError(
              "EXPIRY",
              "The provider invoice lifetime exceeds the supported replay window.",
            );
          }
        } catch (cause) {
          throw new InfrastructureError(
            "INVALID_BOLT11",
            "The provider returned an invalid BOLT11 invoice.",
            { cause },
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
            ...(settlementCapability.method === "lud21"
              ? { verifyUrl: settlementCapability.verifyUrl }
              : {}),
            provider: {
              domain: discovery.domain,
              discoveryUrl: discovery.discoveryUrl,
              callbackUrl: discovery.callbackUrl,
            },
          },
          settlementCheck:
            settlementCapability.method === "lud21"
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
                ? providerComment.truncated
                  ? ("partial" as const)
                  : ("forwarded" as const)
                : ("unsupported" as const),
        };
      } catch (error) {
        return { kind: "failure" as const, slot: failureSlot(slot, error) };
      }
    },
  );

  const invoices = new Set<string>();
  const hashes = new Set<string>(input.excludedPaymentHashes ?? []);
  const commentStatuses: ProviderCommentStatus[] = [];
  const results: (PendingInvoiceSlot | FailedInvoiceSlot)[] = [];
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
    if (generated.providerCommentStatus !== undefined) {
      commentStatuses.push(generated.providerCommentStatus);
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

  return Object.freeze({
    discovery,
    slots: Object.freeze(results),
    completedCount,
    failedCount,
    ...(providerCommentStatus === undefined ? {} : { providerCommentStatus }),
  });
}
