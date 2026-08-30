import type {
  ApiErrorDto,
  BatchInvoiceRequestDto,
  BatchInvoiceResponseDto,
  DeferredInvoiceSlotDto,
  FailedInvoiceSlotDto,
  PendingInvoiceSlotDto,
  PriceResponseDto,
  SettlementResponseDto,
} from "../api/contracts";
import {
  parsePriceSnapshotDto,
  serializePriceSnapshot,
} from "../api/serialization";
import { isRecord } from "../infrastructure/validation";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function parseApiResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    if (isRecord(value) && value.ok === false && isRecord(value.error)) {
      throw new ApiClientError(
        typeof value.error.code === "string" ? value.error.code : "API_ERROR",
        typeof value.error.message === "string"
          ? value.error.message
          : "요청에 실패했습니다.",
        value.error.retryable === true,
        typeof value.error.retryAfterSeconds === "number"
          ? value.error.retryAfterSeconds
          : undefined,
      );
    }
    throw new ApiClientError(
      "API_ERROR",
      "요청에 실패했습니다.",
      response.status >= 500,
    );
  }
  return value;
}

function assertPendingSlot(value: unknown): PendingInvoiceSlotDto {
  if (
    !isRecord(value) ||
    value.status !== "pending" ||
    typeof value.slotNumber !== "number" ||
    typeof value.targetSats !== "string" ||
    typeof value.attempt !== "number" ||
    !isRecord(value.invoice) ||
    typeof value.invoice.bolt11 !== "string" ||
    typeof value.invoice.paymentHash !== "string" ||
    typeof value.invoice.timestampSeconds !== "number" ||
    typeof value.invoice.expirySeconds !== "number" ||
    typeof value.invoice.expiresAt !== "string" ||
    typeof value.invoice.payeeNodeId !== "string" ||
    !Array.isArray(value.invoice.featureBits) ||
    !value.invoice.featureBits.every((bit) => typeof bit === "number") ||
    typeof value.invoice.providerDomain !== "string" ||
    (value.invoice.disposable !== undefined &&
      typeof value.invoice.disposable !== "boolean") ||
    (value.invoice.verificationToken !== undefined &&
      typeof value.invoice.verificationToken !== "string") ||
    (value.krwShare !== undefined && typeof value.krwShare !== "string")
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "인보이스 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  return {
    status: "pending",
    slotNumber: value.slotNumber,
    targetSats: value.targetSats,
    attempt: value.attempt,
    ...(typeof value.krwShare === "string" ? { krwShare: value.krwShare } : {}),
    invoice: {
      bolt11: value.invoice.bolt11,
      paymentHash: value.invoice.paymentHash,
      timestampSeconds: value.invoice.timestampSeconds,
      expirySeconds: value.invoice.expirySeconds,
      expiresAt: value.invoice.expiresAt,
      payeeNodeId: value.invoice.payeeNodeId,
      featureBits: value.invoice.featureBits,
      providerDomain: value.invoice.providerDomain,
      ...(typeof value.invoice.disposable === "boolean"
        ? { disposable: value.invoice.disposable }
        : {}),
      ...(typeof value.invoice.verificationToken === "string"
        ? { verificationToken: value.invoice.verificationToken }
        : {}),
    },
  };
}

function assertDeferredSlot(value: unknown): DeferredInvoiceSlotDto {
  if (
    !isRecord(value) ||
    value.status !== "deferred" ||
    typeof value.slotNumber !== "number" ||
    typeof value.targetSats !== "string" ||
    typeof value.attempt !== "number" ||
    (value.krwShare !== undefined && typeof value.krwShare !== "string")
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "대기 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  return {
    status: "deferred",
    slotNumber: value.slotNumber,
    targetSats: value.targetSats,
    attempt: value.attempt,
    ...(typeof value.krwShare === "string" ? { krwShare: value.krwShare } : {}),
  };
}

function assertFailedSlot(value: unknown): FailedInvoiceSlotDto {
  if (
    !isRecord(value) ||
    value.status !== "failed" ||
    typeof value.slotNumber !== "number" ||
    typeof value.targetSats !== "string" ||
    typeof value.attempt !== "number" ||
    !isRecord(value.failure) ||
    typeof value.failure.code !== "string" ||
    typeof value.failure.message !== "string" ||
    typeof value.failure.retryable !== "boolean" ||
    (value.krwShare !== undefined && typeof value.krwShare !== "string")
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "실패 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  return {
    status: "failed",
    slotNumber: value.slotNumber,
    targetSats: value.targetSats,
    attempt: value.attempt,
    ...(typeof value.krwShare === "string" ? { krwShare: value.krwShare } : {}),
    failure: {
      code: value.failure.code,
      message: value.failure.message,
      retryable: value.failure.retryable,
    },
  };
}

export async function fetchPriceInformation(): Promise<PriceResponseDto> {
  const value = await parseApiResponse(
    await fetch("/api/price", { headers: { Accept: "application/json" } }),
  );
  if (!isRecord(value) || value.ok !== true) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "가격 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  const snapshot = serializePriceSnapshot(
    parsePriceSnapshotDto(value.snapshot),
  );
  const premium = value.premium;
  if (
    premium !== undefined &&
    (!isRecord(premium) ||
      typeof premium.basisPoints !== "string" ||
      !/^-?\d+$/u.test(premium.basisPoints) ||
      typeof premium.referencePriceKrw !== "string" ||
      !/^[1-9]\d*$/u.test(premium.referencePriceKrw) ||
      typeof premium.retrievedAt !== "string" ||
      !Number.isFinite(Date.parse(premium.retrievedAt)))
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "가격 참고정보 형식이 올바르지 않습니다.",
      false,
    );
  }
  return {
    ok: true,
    snapshot,
    ...(isRecord(premium)
      ? {
          premium: {
            basisPoints: String(premium.basisPoints),
            referencePriceKrw: String(premium.referencePriceKrw),
            retrievedAt: String(premium.retrievedAt),
          },
        }
      : {}),
  };
}

export async function requestInvoiceBatch(
  input: BatchInvoiceRequestDto,
): Promise<BatchInvoiceResponseDto> {
  const value = await parseApiResponse(
    await fetch("/api/invoices", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isRecord(value.provider) ||
    typeof value.provider.domain !== "string" ||
    typeof value.provider.commentAllowed !== "number" ||
    (value.provider.commentStatus !== undefined &&
      value.provider.commentStatus !== "forwarded" &&
      value.provider.commentStatus !== "unsupported" &&
      value.provider.commentStatus !== "partial") ||
    (value.provider.descriptionStatus !== undefined &&
      value.provider.descriptionStatus !== "embedded" &&
      value.provider.descriptionStatus !== "notEmbedded" &&
      value.provider.descriptionStatus !== "partial") ||
    typeof value.provider.automaticSettlementAvailable !== "boolean" ||
    !Array.isArray(value.slots) ||
    typeof value.completedCount !== "number" ||
    typeof value.failedCount !== "number"
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "배치 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  const slots = value.slots.map((slot) =>
    isRecord(slot) && slot.status === "pending"
      ? assertPendingSlot(slot)
      : isRecord(slot) && slot.status === "deferred"
        ? assertDeferredSlot(slot)
        : assertFailedSlot(slot),
  );
  return {
    ok: true,
    provider: {
      domain: value.provider.domain,
      commentAllowed: value.provider.commentAllowed,
      ...(value.provider.commentStatus === "forwarded" ||
      value.provider.commentStatus === "unsupported" ||
      value.provider.commentStatus === "partial"
        ? { commentStatus: value.provider.commentStatus }
        : {}),
      ...(value.provider.descriptionStatus === "embedded" ||
      value.provider.descriptionStatus === "notEmbedded" ||
      value.provider.descriptionStatus === "partial"
        ? { descriptionStatus: value.provider.descriptionStatus }
        : {}),
      automaticSettlementAvailable: value.provider.automaticSettlementAvailable,
    },
    slots,
    completedCount: value.completedCount,
    failedCount: value.failedCount,
  };
}

export async function fetchSettlement(input: {
  readonly verificationToken: string;
  readonly paymentHash: string;
  readonly bolt11: string;
}): Promise<SettlementResponseDto> {
  const value = await parseApiResponse(
    await fetch("/api/settlement", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !["settled", "unsettled", "expired", "notAvailable"].includes(
      String(value.status),
    ) ||
    typeof value.settled !== "boolean"
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "결제 확인 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  const status =
    value.status === "settled" ||
    value.status === "unsettled" ||
    value.status === "expired" ||
    value.status === "notAvailable"
      ? value.status
      : "notAvailable";
  return {
    ok: true,
    status,
    settled: value.settled,
    ...(typeof value.checkedAt === "string"
      ? { checkedAt: value.checkedAt }
      : {}),
    ...(typeof value.preimagePresent === "boolean"
      ? { preimagePresent: value.preimagePresent }
      : {}),
    ...(typeof value.providerStatus === "string" ||
    value.providerStatus === null
      ? { providerStatus: value.providerStatus }
      : {}),
  };
}

export type { ApiErrorDto };
