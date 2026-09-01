import type {
  ApiErrorDto,
  BatchInvoiceRequestDto,
  BatchInvoiceResponseDto,
  FailedInvoiceSlotDto,
  PendingInvoiceSlotDto,
  PriceResponseDto,
  SettlementResponseDto,
} from "../api/contracts";
import {
  INVOICE_CLIENT_PROTOCOL_HEADER,
  INVOICE_CLIENT_PROTOCOL_VERSION,
} from "../api/contracts";
import {
  parsePriceSnapshotDto,
  serializePriceSnapshot,
} from "../api/serialization";
import { isRecord } from "../infrastructure/validation";
import { MAX_BOLT11_LENGTH } from "../lightning/bolt11";

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

const SEALED_VERIFICATION_TOKEN =
  /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u;

async function parseApiResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도하십시오.",
      response.status >= 500,
    );
  }
  if (!response.ok) {
    if (isRecord(value) && value.ok === false && isRecord(value.error)) {
      throw new ApiClientError(
        typeof value.error.code === "string" ? value.error.code : "API_ERROR",
        typeof value.error.message === "string"
          ? value.error.message
          : "요청에 실패했습니다.",
        value.error.retryable === true,
        typeof value.error.retryAfterSeconds === "number" &&
          Number.isSafeInteger(value.error.retryAfterSeconds) &&
          value.error.retryAfterSeconds >= 0
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
    !Number.isSafeInteger(value.slotNumber) ||
    Number(value.slotNumber) < 1 ||
    typeof value.targetSats !== "string" ||
    !/^[1-9]\d*$/u.test(value.targetSats) ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !isRecord(value.invoice) ||
    typeof value.invoice.bolt11 !== "string" ||
    value.invoice.bolt11.length > MAX_BOLT11_LENGTH ||
    !/^lnbc[0123456789acdefghjklmnpqrstuvwxyz]+$/u.test(value.invoice.bolt11) ||
    typeof value.invoice.paymentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.invoice.paymentHash) ||
    typeof value.invoice.timestampSeconds !== "number" ||
    !Number.isSafeInteger(value.invoice.timestampSeconds) ||
    Number(value.invoice.timestampSeconds) < 1 ||
    typeof value.invoice.expirySeconds !== "number" ||
    !Number.isSafeInteger(value.invoice.expirySeconds) ||
    Number(value.invoice.expirySeconds) < 1 ||
    typeof value.invoice.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.invoice.expiresAt)) ||
    typeof value.invoice.payeeNodeId !== "string" ||
    !/^[0-9a-f]{66}$/u.test(value.invoice.payeeNodeId) ||
    !Array.isArray(value.invoice.featureBits) ||
    !value.invoice.featureBits.every(
      (bit) => Number.isSafeInteger(bit) && Number(bit) >= 0,
    ) ||
    typeof value.invoice.providerDomain !== "string" ||
    (value.krwShare !== undefined &&
      (typeof value.krwShare !== "string" ||
        !/^[1-9]\d*$/u.test(value.krwShare)))
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "인보이스 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  const verificationToken =
    typeof value.invoice.verificationToken === "string" &&
    SEALED_VERIFICATION_TOKEN.test(value.invoice.verificationToken)
      ? value.invoice.verificationToken
      : undefined;
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
      ...(verificationToken === undefined ? {} : { verificationToken }),
    },
  };
}

function assertFailedSlot(value: unknown): FailedInvoiceSlotDto {
  if (
    !isRecord(value) ||
    value.status !== "failed" ||
    typeof value.slotNumber !== "number" ||
    !Number.isSafeInteger(value.slotNumber) ||
    Number(value.slotNumber) < 1 ||
    typeof value.targetSats !== "string" ||
    !/^[1-9]\d*$/u.test(value.targetSats) ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !isRecord(value.failure) ||
    typeof value.failure.code !== "string" ||
    typeof value.failure.message !== "string" ||
    typeof value.failure.retryable !== "boolean" ||
    (value.krwShare !== undefined &&
      (typeof value.krwShare !== "string" ||
        !/^[1-9]\d*$/u.test(value.krwShare)))
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
  let response: Response;
  try {
    response = await fetch("/api/invoices", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [INVOICE_CLIENT_PROTOCOL_HEADER]: INVOICE_CLIENT_PROTOCOL_VERSION,
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiClientError(
      "ISSUANCE_UNKNOWN",
      "결제 요청 발급 결과를 확인할 수 없습니다. 받는 지갑을 확인한 뒤 새 정산을 시작하십시오.",
      false,
    );
  }
  const value = await parseApiResponse(response);
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isRecord(value.provider) ||
    typeof value.provider.domain !== "string" ||
    typeof value.provider.commentAllowed !== "number" ||
    !Number.isSafeInteger(value.provider.commentAllowed) ||
    Number(value.provider.commentAllowed) < 0 ||
    !Array.isArray(value.slots) ||
    typeof value.completedCount !== "number" ||
    !Number.isSafeInteger(value.completedCount) ||
    Number(value.completedCount) < 0 ||
    typeof value.failedCount !== "number" ||
    !Number.isSafeInteger(value.failedCount) ||
    Number(value.failedCount) < 0
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "배치 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  const provider = value.provider;
  const parsedSlots = value.slots.map((slot) =>
    isRecord(slot) && slot.status === "pending"
      ? assertPendingSlot(slot)
      : assertFailedSlot(slot),
  );
  if (parsedSlots.length !== input.slots.length) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "결제 응답 수가 요청과 일치하지 않습니다.",
      false,
    );
  }
  const slotsByNumber = new Map(
    parsedSlots.map((slot) => [slot.slotNumber, slot] as const),
  );
  if (slotsByNumber.size !== parsedSlots.length) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "중복된 결제 응답이 포함되어 있습니다.",
      false,
    );
  }
  const slots = input.slots.map((requested) => {
    const slot = slotsByNumber.get(requested.slotNumber);
    if (
      !slot ||
      slot.targetSats !== requested.targetSats ||
      slot.attempt !== requested.attempt ||
      slot.krwShare !== requested.krwShare
    ) {
      throw new ApiClientError(
        "INVALID_RESPONSE",
        "결제 응답이 요청한 슬롯과 일치하지 않습니다.",
        false,
      );
    }
    return slot;
  });
  const pending = slots.filter(
    (slot): slot is PendingInvoiceSlotDto => slot.status === "pending",
  );
  if (
    Number(value.completedCount) !== pending.length ||
    Number(value.failedCount) !==
      slots.filter((slot) => slot.status === "failed").length ||
    pending.some((slot) => slot.invoice.providerDomain !== provider.domain) ||
    new Set(pending.map((slot) => slot.invoice.paymentHash)).size !==
      pending.length ||
    new Set(pending.map((slot) => slot.invoice.bolt11)).size !==
      pending.length ||
    pending.some((slot) =>
      input.excludedPaymentHashes?.includes(slot.invoice.paymentHash),
    )
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "결제 응답의 합계 또는 invoice 식별자가 올바르지 않습니다.",
      false,
    );
  }
  return {
    ok: true,
    provider: {
      domain: String(provider.domain),
      commentAllowed: Number(provider.commentAllowed),
      ...(provider.commentStatus === "forwarded" ||
      provider.commentStatus === "unsupported" ||
      provider.commentStatus === "partial"
        ? { commentStatus: provider.commentStatus }
        : {}),
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
    typeof value.settled !== "boolean" ||
    (value.status === "settled") !== value.settled
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
  if (status === "settled" || status === "unsettled") {
    if (
      typeof value.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.preimagePresent !== (status === "settled") ||
      (value.providerStatus !== null &&
        (typeof value.providerStatus !== "string" ||
          value.providerStatus.length > 128))
    ) {
      throw new ApiClientError(
        "INVALID_RESPONSE",
        "결제 확인 근거가 누락되었거나 올바르지 않습니다.",
        false,
      );
    }
    return status === "settled"
      ? {
          ok: true,
          status,
          settled: true,
          checkedAt: value.checkedAt,
          preimagePresent: true,
          providerStatus: value.providerStatus,
        }
      : {
          ok: true,
          status,
          settled: false,
          checkedAt: value.checkedAt,
          preimagePresent: false,
          providerStatus: value.providerStatus,
        };
  }
  if (
    value.checkedAt !== undefined ||
    value.preimagePresent !== undefined ||
    value.providerStatus !== undefined
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "결제 확인 응답 형식이 올바르지 않습니다.",
      false,
    );
  }
  return { ok: true, status, settled: false };
}

export type { ApiErrorDto };
