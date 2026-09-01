import type {
  BatchInvoiceResponseDto,
  FailedInvoiceSlotDto,
  PendingInvoiceSlotDto,
} from "../src/api/contracts";
import { serializeBigIntDecimal } from "../src/api/serialization";
import {
  generateInvoiceBatch,
  type GenerateInvoiceBatchInput,
} from "../src/lightning/batch";
import { LnurlPayClient } from "../src/lightning/lnurl";
import { sealVerificationContext } from "./verification";

interface InvoiceBatchEnv {
  readonly VERIFICATION_TOKEN_SECRET?: string;
}

function optionalVerificationSecret(env: InvoiceBatchEnv): string | undefined {
  return env.VERIFICATION_TOKEN_SECRET &&
    /^[0-9a-f]{64}$/u.test(env.VERIFICATION_TOKEN_SECRET)
    ? env.VERIFICATION_TOKEN_SECRET
    : undefined;
}

export async function createInvoiceBatchResponse(
  input: GenerateInvoiceBatchInput,
  env: InvoiceBatchEnv,
): Promise<BatchInvoiceResponseDto> {
  const result = await generateInvoiceBatch(input, {
    client: new LnurlPayClient(),
  });
  const secret = optionalVerificationSecret(env);
  const slots = await Promise.all(
    result.slots.map(
      async (slot): Promise<PendingInvoiceSlotDto | FailedInvoiceSlotDto> => {
        const base = {
          slotNumber: slot.slotNumber,
          targetSats: serializeBigIntDecimal(slot.targetSats),
          attempt: slot.attempt,
          ...(slot.krwShare === undefined
            ? {}
            : { krwShare: serializeBigIntDecimal(slot.krwShare) }),
        };
        if (slot.status === "failed") {
          return { ...base, status: "failed", failure: slot.failure };
        }
        let verificationToken: string | undefined;
        if (secret && slot.invoice.verifyUrl !== undefined) {
          try {
            verificationToken = await sealVerificationContext(
              {
                verifyUrl: slot.invoice.verifyUrl,
                expectedPaymentHash: slot.invoice.paymentHash,
                expectedInvoice: slot.invoice.bolt11,
                expiresAt: slot.invoice.expiresAt,
              },
              secret,
            );
          } catch {
            // LUD-21 automation is optional. The validated invoice remains
            // payable and the client will offer explicit manual confirmation.
          }
        }
        return {
          ...base,
          status: "pending",
          invoice: {
            bolt11: slot.invoice.bolt11,
            paymentHash: slot.invoice.paymentHash,
            timestampSeconds: slot.invoice.timestampSeconds,
            expirySeconds: slot.invoice.expirySeconds,
            expiresAt: slot.invoice.expiresAt,
            payeeNodeId: slot.invoice.payeeNodeId,
            featureBits: slot.invoice.featureBits,
            providerDomain: slot.invoice.provider.domain,
            payerMemo: slot.invoice.payerMemo,
            payeeMemo: slot.invoice.payeeMemo,
            ...(slot.invoice.disposable === undefined
              ? {}
              : { disposable: slot.invoice.disposable }),
            ...(verificationToken === undefined ? {} : { verificationToken }),
          },
        };
      },
    ),
  );
  return Object.freeze({
    ok: true,
    provider: {
      domain: result.discovery.domain,
      commentAllowed: result.discovery.commentAllowed,
      ...(result.providerCommentStatus === undefined
        ? {}
        : { commentStatus: result.providerCommentStatus }),
    },
    slots: Object.freeze(slots),
    completedCount: result.completedCount,
    failedCount: slots.filter((slot) => slot.status === "failed").length,
  });
}
