import type { PriceSnapshotDto } from "./serialization";
import { parseBigIntDecimal } from "./serialization";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { isRecord } from "../infrastructure/validation";
import type { InvoiceSlotRequest } from "../lightning/batch";
import { MAX_BOLT11_LENGTH } from "../lightning/bolt11";

export const INVOICE_CLIENT_PROTOCOL_HEADER =
  "X-Lightning-Split-Invoice-Protocol";
export const INVOICE_CLIENT_PROTOCOL_VERSION = "1";

export interface ApiErrorDto {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterSeconds?: number;
  };
}

export interface PriceResponseDto {
  readonly ok: true;
  readonly snapshot: PriceSnapshotDto;
  readonly premium?: {
    readonly basisPoints: string;
    readonly referencePriceKrw: string;
    readonly retrievedAt: string;
  };
}

export interface UsdPriceSnapshotDto {
  readonly priceUsdCents: string;
  readonly source: "coinbase" | "kraken";
  readonly market: "BTC-USD";
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly snapshotAt: string;
  readonly fallbackUsed: boolean;
}

export interface UsdPriceResponseDto {
  readonly ok: true;
  readonly snapshot: UsdPriceSnapshotDto;
  readonly premium?: {
    readonly basisPoints: string;
    readonly referencePriceUsdCents: string;
    readonly retrievedAt: string;
  };
}

export interface BatchInvoiceRequestDto {
  /** Client correlation key retained for compatibility; the Worker does not persist or replay it. */
  readonly requestId: string;
  readonly address: string;
  readonly slots: readonly {
    readonly slotNumber: number;
    readonly krwShare?: string;
    readonly targetSats: string;
    readonly attempt: number;
  }[];
  readonly excludedPaymentHashes?: readonly string[];
  readonly providerComment?: string;
}

export interface PendingInvoiceSlotDto {
  readonly status: "pending";
  readonly slotNumber: number;
  readonly krwShare?: string;
  readonly targetSats: string;
  readonly attempt: number;
  readonly invoice: {
    readonly bolt11: string;
    readonly paymentHash: string;
    readonly timestampSeconds: number;
    readonly expirySeconds: number;
    readonly expiresAt: string;
    readonly payeeNodeId: string;
    readonly featureBits: readonly number[];
    readonly providerDomain: string;
    readonly disposable?: boolean;
    readonly verificationToken?: string;
  };
}

export interface FailedInvoiceSlotDto {
  readonly status: "failed";
  readonly slotNumber: number;
  readonly krwShare?: string;
  readonly targetSats: string;
  readonly attempt: number;
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface BatchInvoiceResponseDto {
  readonly ok: true;
  readonly provider: {
    readonly domain: string;
    readonly commentAllowed: number;
    readonly commentStatus?: "forwarded" | "unsupported" | "partial";
  };
  readonly slots: readonly (PendingInvoiceSlotDto | FailedInvoiceSlotDto)[];
  readonly completedCount: number;
  readonly failedCount: number;
}

export interface SettlementRequestDto {
  readonly verificationToken: string;
  readonly paymentHash: string;
  readonly bolt11: string;
}

export type SettlementResponseDto =
  | {
      readonly ok: true;
      readonly status: "settled";
      readonly settled: true;
      readonly checkedAt: string;
      readonly preimagePresent: true;
      readonly providerStatus: string | null;
    }
  | {
      readonly ok: true;
      readonly status: "unsettled";
      readonly settled: false;
      readonly checkedAt: string;
      readonly preimagePresent: false;
      readonly providerStatus: string | null;
    }
  | {
      readonly ok: true;
      readonly status: "expired" | "notAvailable";
      readonly settled: false;
    };

function parsePositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

export function parseBatchInvoiceRequest(value: unknown): {
  readonly address: string;
  readonly slots: readonly InvoiceSlotRequest[];
  readonly excludedPaymentHashes: readonly string[];
  readonly providerComment?: string;
  readonly requestId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.address !== "string" ||
    !Array.isArray(value.slots)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The batch request is invalid.",
    );
  }
  if (
    value.address.length < 3 ||
    value.address.length > 320 ||
    value.slots.length < 1 ||
    value.slots.length > DEFAULT_LIGHTNING_POLICY.maximumBatchSize
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The batch request size is invalid.",
    );
  }
  const slots = value.slots.map((rawSlot, index): InvoiceSlotRequest => {
    if (!isRecord(rawSlot)) {
      throw new InfrastructureError(
        "INVALID_INPUT",
        `slots[${index}] is invalid.`,
      );
    }
    const targetSats = parseBigIntDecimal(rawSlot.targetSats, {
      field: `slots[${index}].targetSats`,
      minimum: 1n,
      maximum: BigInt(Number.MAX_SAFE_INTEGER),
    });
    const krwShare =
      rawSlot.krwShare === undefined
        ? undefined
        : parseBigIntDecimal(rawSlot.krwShare, {
            field: `slots[${index}].krwShare`,
            minimum: 1n,
            maximum: BigInt(Number.MAX_SAFE_INTEGER),
          });
    return {
      slotNumber: parsePositiveSafeInteger(
        rawSlot.slotNumber,
        `slots[${index}].slotNumber`,
      ),
      targetSats,
      attempt: parsePositiveSafeInteger(
        rawSlot.attempt,
        `slots[${index}].attempt`,
      ),
      ...(krwShare === undefined ? {} : { krwShare }),
    };
  });
  const parseStringList = (
    input: unknown,
    field: string,
    pattern: RegExp,
    maximumLength: number,
    maximumItems: number,
  ): readonly string[] => {
    if (input === undefined) return [];
    if (
      !Array.isArray(input) ||
      input.length > maximumItems ||
      !input.every(
        (item) =>
          typeof item === "string" &&
          item.length <= maximumLength &&
          pattern.test(item),
      )
    ) {
      throw new InfrastructureError("INVALID_INPUT", `${field} is invalid.`);
    }
    return Object.freeze([...new Set(input)]);
  };
  const excludedPaymentHashes = parseStringList(
    value.excludedPaymentHashes,
    "excludedPaymentHashes",
    /^[0-9a-f]{64}$/u,
    64,
    100,
  );
  if (
    value.providerComment !== undefined &&
    (typeof value.providerComment !== "string" ||
      value.providerComment.length < 1 ||
      [...value.providerComment].length >
        DEFAULT_LIGHTNING_POLICY.maximumProviderCommentCharacters)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "providerComment is invalid.",
    );
  }
  const requestId = value.requestId;
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "앱이 업데이트되었습니다. 페이지를 새로고침한 뒤 다시 시도하십시오.",
    );
  }
  return Object.freeze({
    address: value.address,
    slots: Object.freeze(slots),
    excludedPaymentHashes,
    requestId,
    ...(typeof value.providerComment === "string"
      ? { providerComment: value.providerComment }
      : {}),
  });
}

const TOKEN_PATTERN = /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u;

export function parseSettlementRequest(value: unknown): SettlementRequestDto {
  if (
    !isRecord(value) ||
    typeof value.verificationToken !== "string" ||
    !TOKEN_PATTERN.test(value.verificationToken) ||
    typeof value.paymentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.paymentHash) ||
    typeof value.bolt11 !== "string" ||
    value.bolt11.length > MAX_BOLT11_LENGTH ||
    !/^lnbc[0123456789acdefghjklmnpqrstuvwxyz]+$/u.test(value.bolt11)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The verification token is invalid.",
    );
  }
  return Object.freeze({
    verificationToken: value.verificationToken,
    paymentHash: value.paymentHash,
    bolt11: value.bolt11,
  });
}
