import type { PriceSnapshotDto } from "../api/serialization";
import type { InputMode, PaymentAnnotation } from "../domain/models";

export type ClientSlotStatus =
  "generating" | "pending" | "settled" | "expired" | "failed";

export interface ClientInvoice {
  readonly bolt11: string;
  readonly paymentHash: string;
  readonly timestampSeconds: number;
  readonly expirySeconds: number;
  readonly expiresAt: string;
  readonly payeeNodeId: string;
  readonly featureBits: readonly number[];
  readonly providerDomain: string;
  readonly verificationToken?: string;
}

export interface ClientSlot {
  readonly slotNumber: number;
  readonly krwShare?: string;
  readonly targetSats: string;
  readonly attempt: number;
  readonly status: ClientSlotStatus;
  readonly invoice?: ClientInvoice;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly settledAt?: string;
  readonly annotation?: PaymentAnnotation;
}

export interface SettlementSession {
  readonly version: 1;
  readonly id: string;
  readonly inputMode: InputMode;
  readonly totalAmount: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly invoiceCount: number;
  readonly lightningAddress: string;
  readonly overallNote?: string;
  readonly participantNameCandidates: readonly string[];
  readonly priceSnapshot?: PriceSnapshotDto;
  readonly payerShareKrw?: string;
  readonly createdAt: string;
  readonly providerDomain?: string;
  readonly slots: readonly ClientSlot[];
}

export interface SettlementProgress {
  readonly settledCount: number;
  readonly totalCount: number;
  readonly settledSats: bigint;
  readonly totalSats: bigint;
  readonly settledKrw: bigint;
  readonly totalKrw: bigint;
}
