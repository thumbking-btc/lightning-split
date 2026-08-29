import type { PriceSnapshotDto } from "./serialization";
import { parseBigIntDecimal } from "./serialization";
import { InfrastructureError } from "../infrastructure/errors";
import { isRecord } from "../infrastructure/validation";
import type { InvoiceSlotRequest } from "../lightning/batch";

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
}

export interface BatchInvoiceRequestDto {
  readonly address: string;
  readonly slots: readonly {
    readonly slotNumber: number;
    readonly krwShare?: string;
    readonly targetSats: string;
    readonly attempt: number;
  }[];
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
    readonly automaticSettlementAvailable: boolean;
  };
  readonly slots: readonly (PendingInvoiceSlotDto | FailedInvoiceSlotDto)[];
  readonly completedCount: number;
  readonly failedCount: number;
}

export interface SettlementRequestDto {
  readonly verificationToken: string;
}

export interface SettlementResponseDto {
  readonly ok: true;
  readonly status: "settled" | "unsettled" | "expired" | "notAvailable";
  readonly settled: boolean;
  readonly checkedAt?: string;
  readonly preimagePresent?: boolean;
  readonly providerStatus?: string | null;
}

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
    value.slots.length > 10
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
  return Object.freeze({ address: value.address, slots: Object.freeze(slots) });
}

const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseSettlementRequest(value: unknown): SettlementRequestDto {
  if (
    !isRecord(value) ||
    typeof value.verificationToken !== "string" ||
    !TOKEN_PATTERN.test(value.verificationToken)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The verification token is invalid.",
    );
  }
  return Object.freeze({ verificationToken: value.verificationToken });
}
