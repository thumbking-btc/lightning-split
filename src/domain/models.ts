export type InputMode = "krw" | "usd" | "sats";
export type ProviderCommentStatus = "forwarded" | "unsupported" | "partial";
export type InvoiceSlotStatus =
  | "generating"
  | "pending"
  | "settled"
  | "manuallyConfirmed"
  | "expired"
  | "failed";

export type PriceSource = "upbit" | "bithumb";

export interface PriceSnapshot {
  readonly priceKrw: bigint;
  readonly source: PriceSource;
  readonly market: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly snapshotAt: string;
  readonly fallbackUsed: boolean;
}

export interface UsdPriceSnapshot {
  readonly priceUsdCents: bigint;
  readonly source: "coinbase" | "kraken";
  readonly market: "BTC-USD";
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly snapshotAt: string;
  readonly fallbackUsed: boolean;
}

export interface ParticipantNameCandidate {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface PaymentAnnotation {
  readonly displayName?: string;
  readonly note?: string;
  readonly updatedAt: string;
}

export type SettlementCheck =
  | { readonly status: "notAvailable" }
  | { readonly status: "notChecked" }
  | { readonly status: "checking"; readonly startedAt: string }
  | { readonly status: "unsettled"; readonly checkedAt: string }
  | {
      readonly status: "verificationDelayed";
      readonly lastCheckedAt?: string;
      readonly reason: string;
    }
  | {
      readonly status: "verified";
      readonly checkedAt: string;
      readonly settledAt?: string;
    }
  | { readonly status: "manual"; readonly confirmedAt: string };

export interface IssuedInvoice {
  readonly bolt11: string;
  readonly paymentHash: string;
  readonly timestampSeconds: number;
  readonly expirySeconds: number;
  readonly expiresAt: string;
  readonly payeeNodeId: string;
  readonly featureBits: readonly number[];
  readonly disposable?: boolean;
  readonly verifyUrl?: string;
  readonly provider: {
    readonly domain: string;
    readonly discoveryUrl: string;
    readonly callbackUrl: string;
  };
}

interface InvoiceSlotBase {
  readonly slotNumber: number;
  readonly krwShare?: bigint;
  readonly usdCentsShare?: bigint;
  readonly targetSats: bigint;
  readonly attempt: number;
}

export interface GeneratingInvoiceSlot extends InvoiceSlotBase {
  readonly status: "generating";
}

export interface FailedInvoiceSlot extends InvoiceSlotBase {
  readonly status: "failed";
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

interface IssuedInvoiceSlotBase extends InvoiceSlotBase {
  readonly invoice: IssuedInvoice;
}

export interface PendingInvoiceSlot extends IssuedInvoiceSlotBase {
  readonly status: "pending";
  readonly settlementCheck: Exclude<
    SettlementCheck,
    { readonly status: "verified" } | { readonly status: "manual" }
  >;
}

export interface SettledInvoiceSlot extends IssuedInvoiceSlotBase {
  readonly status: "settled";
  readonly settlementCheck: Extract<
    SettlementCheck,
    { readonly status: "verified" }
  >;
  readonly annotation?: PaymentAnnotation;
}

export interface ManuallyConfirmedInvoiceSlot extends IssuedInvoiceSlotBase {
  readonly status: "manuallyConfirmed";
  readonly settlementCheck: Extract<
    SettlementCheck,
    { readonly status: "manual" }
  >;
  readonly annotation?: PaymentAnnotation;
}

export interface ExpiredInvoiceSlot extends IssuedInvoiceSlotBase {
  readonly status: "expired";
  readonly settlementCheck: Exclude<
    SettlementCheck,
    { readonly status: "verified" } | { readonly status: "manual" }
  >;
}

export type InvoiceSlot =
  | GeneratingInvoiceSlot
  | PendingInvoiceSlot
  | SettledInvoiceSlot
  | ManuallyConfirmedInvoiceSlot
  | ExpiredInvoiceSlot
  | FailedInvoiceSlot;

interface SettlementBatchBase {
  readonly id: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly invoiceCount: number;
  readonly slots: readonly InvoiceSlot[];
  readonly overallNote?: string;
  readonly providerCommentStatus?: ProviderCommentStatus;
  readonly participantNameCandidates: readonly ParticipantNameCandidate[];
  readonly createdAt: string;
}

export interface KrwSettlementBatch extends SettlementBatchBase {
  readonly inputMode: "krw";
  readonly totalAmount: bigint;
  readonly priceSnapshot: PriceSnapshot;
  readonly usdPriceSnapshot?: never;
}

export interface UsdSettlementBatch extends SettlementBatchBase {
  readonly inputMode: "usd";
  readonly totalAmount: bigint;
  readonly priceSnapshot?: never;
  readonly usdPriceSnapshot: UsdPriceSnapshot;
}

export interface SatsSettlementBatch extends SettlementBatchBase {
  readonly inputMode: "sats";
  readonly totalAmount: bigint;
  readonly priceSnapshot?: never;
  readonly usdPriceSnapshot?: never;
}

export type SettlementBatch =
  KrwSettlementBatch | UsdSettlementBatch | SatsSettlementBatch;
