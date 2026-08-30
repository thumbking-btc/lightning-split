import type { PriceSnapshotDto } from "../api/serialization";
import type {
  InputMode,
  PaymentAnnotation,
  ProviderCommentStatus,
} from "../domain/models";

export type ClientSlotStatus =
  | "generating"
  | "queued"
  | "pending"
  | "settled"
  | "manuallyConfirmed"
  | "expired"
  | "failed";

export interface ClientInvoice {
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
  readonly confirmedAt?: string;
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
  readonly payerShareSats?: string;
  readonly providerCommentStatus?: ProviderCommentStatus;
  readonly createdAt: string;
  readonly providerDomain?: string;
  readonly issuedPaymentHashes?: readonly string[];
  readonly slots: readonly ClientSlot[];
}

export interface SettlementProgress {
  readonly completedCount: number;
  readonly networkSettledCount: number;
  readonly manuallyConfirmedCount: number;
  readonly totalCount: number;
  readonly completedSats: bigint;
  readonly totalSats: bigint;
  readonly completedKrw: bigint;
  readonly totalKrw: bigint;
}
