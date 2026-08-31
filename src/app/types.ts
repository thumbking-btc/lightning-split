import type { UsdPriceSnapshotDto } from "../api/contracts";
import type { PriceSnapshotDto } from "../api/serialization";
import type {
  InputMode,
  PaymentAnnotation,
  ProviderCommentStatus,
} from "../domain/models";

export const MAX_INVOICE_HISTORY = 40;

export type ClientSlotStatus =
  | "generating"
  | "pending"
  | "verifyingExpired"
  | "settled"
  | "manuallyConfirmed"
  | "legacyReviewRequired"
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
  /**
   * Present only between receiving an invoice and durably storing that exact
   * session state. Legacy invoices omit it and are therefore display-ready.
   */
  readonly awaitingPersistence?: true;
}

export interface SettlementEvidence {
  readonly kind: "lud21";
  readonly checkedAt: string;
  readonly preimagePresent: true;
  readonly providerStatus?: string | null;
}

export interface LegacySettlementRecord {
  readonly source: "legacyUnknown";
  readonly observedAt: string;
}

export interface HistoricalInvoiceAttempt {
  readonly slotNumber: number;
  readonly krwShare?: string;
  readonly usdCentsShare?: string;
  readonly targetSats: string;
  readonly attempt: number;
  readonly invoice: ClientInvoice;
  readonly retiredAt: string;
  readonly settledAt?: string;
  /** User-provided confirmation retained when a newer attempt is retired. */
  readonly confirmedAt?: string;
  readonly settlementEvidence?: SettlementEvidence;
  readonly legacySettlement?: LegacySettlementRecord;
}

export interface ClientSlot {
  readonly slotNumber: number;
  readonly krwShare?: string;
  readonly usdCentsShare?: string;
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
  readonly verificationDelayed?: true;
  readonly settlementEvidence?: SettlementEvidence;
  readonly legacySettlement?: LegacySettlementRecord;
  readonly annotation?: PaymentAnnotation;
}

export interface SettlementSession {
  readonly version: 2;
  readonly id: string;
  readonly inputMode: InputMode;
  /** KRW and sats are stored in whole units; USD is stored in cents. */
  readonly totalAmount: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly invoiceCount: number;
  readonly lightningAddress: string;
  readonly overallNote?: string;
  readonly participantNameCandidates: readonly string[];
  readonly priceSnapshot?: PriceSnapshotDto;
  readonly usdPriceSnapshot?: UsdPriceSnapshotDto;
  readonly payerShareKrw?: string;
  readonly payerShareUsdCents?: string;
  readonly payerShareSats?: string;
  readonly providerCommentStatus?: ProviderCommentStatus;
  readonly createdAt: string;
  readonly providerDomain?: string;
  readonly issuedPaymentHashes?: readonly string[];
  /** Previous payable attempts retained for late settlement verification. */
  readonly invoiceHistory?: readonly HistoricalInvoiceAttempt[];
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
  readonly completedUsdCents: bigint;
  readonly totalUsdCents: bigint;
}
