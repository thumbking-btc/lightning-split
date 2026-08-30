import { DurableObject } from "cloudflare:workers";

import type {
  BatchInvoiceResponseDto,
  FailedInvoiceSlotDto,
  PendingInvoiceSlotDto,
} from "../src/api/contracts";
import { serializeBigIntDecimal } from "../src/api/serialization";
import {
  InfrastructureError,
  type InfrastructureErrorCode,
} from "../src/infrastructure/errors";
import { generateInvoiceBatch } from "../src/lightning/batch";
import { LnurlPayClient } from "../src/lightning/lnurl";
import { sealVerificationContext } from "./verification";

export interface ParsedInvoiceBatchInput {
  readonly requestId: string;
  readonly address: string;
  readonly slots: readonly {
    readonly slotNumber: number;
    readonly krwShare?: bigint;
    readonly targetSats: bigint;
    readonly attempt: number;
  }[];
  readonly excludedPaymentHashes: readonly string[];
  readonly providerComment?: string;
}

interface InvoiceBatchEnv {
  readonly VERIFICATION_TOKEN_SECRET?: string;
}

const REPLAY_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
const FINGERPRINT_KEY = "fingerprint";
const RESPONSE_KEY = "response";
const PHASE_KEY = "phase";
type IssuancePhase = "reserved" | "callbacksStarted" | "committed";

function uncertainIssuanceResponse(
  input: ParsedInvoiceBatchInput,
): BatchInvoiceResponseDto {
  const domain = input.address.split("@").at(-1) ?? "unknown";
  return {
    ok: true,
    provider: { domain, commentAllowed: 0 },
    slots: input.slots.map((slot) => ({
      status: "failed" as const,
      slotNumber: slot.slotNumber,
      targetSats: serializeBigIntDecimal(slot.targetSats),
      attempt: slot.attempt,
      ...(slot.krwShare === undefined
        ? {}
        : { krwShare: serializeBigIntDecimal(slot.krwShare) }),
      failure: {
        code: "ISSUANCE_UNKNOWN",
        message:
          "결제 요청 발급 결과를 확인할 수 없습니다. 받는 지갑의 미결제 요청을 확인한 뒤 새 정산을 시작하십시오.",
        retryable: false,
      },
    })),
    completedCount: 0,
    failedCount: input.slots.length,
  };
}

function optionalVerificationSecret(env: InvoiceBatchEnv): string | undefined {
  return env.VERIFICATION_TOKEN_SECRET &&
    /^[0-9a-f]{64}$/u.test(env.VERIFICATION_TOKEN_SECRET)
    ? env.VERIFICATION_TOKEN_SECRET
    : undefined;
}

export async function createInvoiceBatchResponse(
  input: ParsedInvoiceBatchInput,
  env: InvoiceBatchEnv,
  onInvoiceRequestsStarting?: () => void | Promise<void>,
): Promise<BatchInvoiceResponseDto> {
  const result = await generateInvoiceBatch(input, {
    client: new LnurlPayClient(),
    ...(onInvoiceRequestsStarting === undefined
      ? {}
      : { onInvoiceRequestsStarting }),
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

export async function fingerprintInvoiceBatchInput(
  input: ParsedInvoiceBatchInput,
): Promise<string> {
  const canonical = JSON.stringify(input, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class InvoiceBatchCoordinator extends DurableObject<InvoiceBatchEnv> {
  private inFlight:
    | {
        readonly fingerprint: string;
        readonly result: Promise<BatchInvoiceResponseDto>;
      }
    | undefined;

  async issue(
    fingerprint: string,
    input: ParsedInvoiceBatchInput,
    verificationSecret?: string,
  ): Promise<BatchInvoiceResponseDto> {
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        "The invoice request fingerprint is invalid.",
      );
    }
    if (this.inFlight !== undefined) {
      if (this.inFlight.fingerprint !== fingerprint) {
        throw new InfrastructureError(
          "INVALID_INPUT",
          "The invoice request key was reused with different input.",
        );
      }
      return this.inFlight.result;
    }
    const result = this.issueOnce(fingerprint, input, verificationSecret);
    this.inFlight = { fingerprint, result };
    try {
      return await result;
    } finally {
      if (this.inFlight?.result === result) this.inFlight = undefined;
    }
  }

  async issueForApi(
    fingerprint: string,
    input: ParsedInvoiceBatchInput,
    verificationSecret?: string,
  ): Promise<
    | { readonly ok: true; readonly response: BatchInvoiceResponseDto }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: InfrastructureErrorCode;
          readonly message: string;
          readonly retryable: boolean;
          readonly upstreamStatus?: number;
          readonly retryAfterSeconds?: number;
        };
      }
  > {
    try {
      return {
        ok: true,
        response: await this.issue(fingerprint, input, verificationSecret),
      };
    } catch (cause) {
      const error =
        cause instanceof InfrastructureError
          ? cause
          : new InfrastructureError(
              "INVALID_RESPONSE",
              cause instanceof Error
                ? cause.message
                : "The invoice request could not be coordinated.",
            );
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: error.upstreamStatus }),
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        },
      };
    }
  }

  private async issueOnce(
    fingerprint: string,
    input: ParsedInvoiceBatchInput,
    verificationSecret?: string,
  ): Promise<BatchInvoiceResponseDto> {
    const storedFingerprint =
      await this.ctx.storage.get<string>(FINGERPRINT_KEY);
    if (storedFingerprint !== undefined && storedFingerprint !== fingerprint) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        "The invoice request key was reused with different input.",
      );
    }
    const storedResponse =
      await this.ctx.storage.get<BatchInvoiceResponseDto>(RESPONSE_KEY);
    if (storedResponse !== undefined) return storedResponse;
    if (storedFingerprint !== undefined) {
      const storedPhase = await this.ctx.storage.get<IssuancePhase>(PHASE_KEY);
      if (storedPhase === "reserved") {
        // No provider callback was allowed to start. Retrying discovery and
        // continuing the same request cannot duplicate a payable invoice.
        await this.ctx.storage.delete(FINGERPRINT_KEY);
        await this.ctx.storage.delete(PHASE_KEY);
        return this.issueOnce(fingerprint, input, verificationSecret);
      }
      // A previous instance stopped after beginning this request but before it
      // durably stored a response. Reissuing provider callbacks could create
      // additional payable invoices, so expose the ambiguity instead.
      return uncertainIssuanceResponse(input);
    }

    // Arm cleanup before any provider request so even an interrupted instance
    // cannot leave a response key without an expiry.
    await this.ctx.storage.setAlarm(Date.now() + REPLAY_RETENTION_MS);
    await this.ctx.storage.put(FINGERPRINT_KEY, fingerprint);
    await this.ctx.storage.put(PHASE_KEY, "reserved");
    let invoiceRequestsStarted = false;
    try {
      const secret = verificationSecret ?? this.env.VERIFICATION_TOKEN_SECRET;
      const response = await createInvoiceBatchResponse(
        input,
        secret === undefined ? {} : { VERIFICATION_TOKEN_SECRET: secret },
        async () => {
          await this.ctx.storage.put(PHASE_KEY, "callbacksStarted");
          invoiceRequestsStarted = true;
        },
      );
      await this.ctx.storage.put({
        [RESPONSE_KEY]: response,
        [PHASE_KEY]: "committed" satisfies IssuancePhase,
      });
      return response;
    } catch (cause) {
      // Discovery failures happen before any payable callback and are safe to
      // retry. Once callbacks begin, keep the fingerprint even when committing
      // the response fails: issuing again could create additional invoices.
      if (!invoiceRequestsStarted) {
        await this.ctx.storage.delete(FINGERPRINT_KEY);
        await this.ctx.storage.delete(PHASE_KEY);
      }
      throw cause;
    }
  }

  override async alarm(): Promise<void> {
    this.inFlight = undefined;
    await this.ctx.storage.deleteAll();
  }
}
