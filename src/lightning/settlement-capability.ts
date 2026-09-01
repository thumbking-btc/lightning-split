/**
 * Standardized settlement data returned for one provider-issued invoice.
 *
 * Provider identity is deliberately absent. A standard is eligible only when
 * the data required by that standard is present for the individual invoice.
 */
export interface InvoiceSettlementAdvertisement {
  readonly verifyUrl?: string;
}

export type AutomaticSettlementCapability = {
  readonly method: "lud21";
  readonly verifyUrl: string;
};

export type SettlementCapability =
  AutomaticSettlementCapability | { readonly method: "manual" };

interface AutomaticSettlementStandard {
  readonly method: AutomaticSettlementCapability["method"];
  readonly select: (
    input: InvoiceSettlementAdvertisement,
  ) => AutomaticSettlementCapability | undefined;
}

/**
 * Highest-priority eligible standard wins. Only production-eligible standards
 * for the current address-issued BOLT11 flow belong here. Standards that need
 * another user-visible flow (for example NWC or BIP-321 PoP) use a separate
 * registry when that flow is implemented.
 */
const AUTOMATIC_SETTLEMENT_STANDARDS = Object.freeze([
  Object.freeze({
    method: "lud21" as const,
    select: (
      input: InvoiceSettlementAdvertisement,
    ): AutomaticSettlementCapability | undefined =>
      input.verifyUrl === undefined
        ? undefined
        : Object.freeze({ method: "lud21", verifyUrl: input.verifyUrl }),
  }),
]) satisfies readonly AutomaticSettlementStandard[];

export const AUTOMATIC_SETTLEMENT_STANDARD_PRIORITY = Object.freeze(
  AUTOMATIC_SETTLEMENT_STANDARDS.map((standard) => standard.method),
);

export function selectSettlementCapability(
  input: InvoiceSettlementAdvertisement,
): SettlementCapability {
  for (const standard of AUTOMATIC_SETTLEMENT_STANDARDS) {
    const capability = standard.select(input);
    if (capability !== undefined) return capability;
  }
  return Object.freeze({ method: "manual" });
}

export type MemoDelivery = "none" | "partial" | "full";

export interface PaymentCapabilityEvidence {
  /** True only when this client can actually run an automatic verifier. */
  readonly automaticSettlement: boolean;
  /** Memo encoded for the payer in the final payment request. */
  readonly payerMemo: MemoDelivery;
  /** Memo delivered to the receiving service. */
  readonly payeeMemo: MemoDelivery;
}

export type PaymentCapabilityTierId =
  | "automatic-both-memos"
  | "automatic-one-memo"
  | "automatic"
  | "both-memos"
  | "one-memo"
  | "qr-only";

export interface PaymentCapabilitySelection extends PaymentCapabilityEvidence {
  readonly tier: 1 | 2 | 3 | 4 | 5 | 6;
  readonly id: PaymentCapabilityTierId;
}

interface PaymentCapabilityTier {
  readonly tier: PaymentCapabilitySelection["tier"];
  readonly id: PaymentCapabilityTierId;
  readonly matches: (input: PaymentCapabilityEvidence) => boolean;
}

function fullMemoCount(input: PaymentCapabilityEvidence): number {
  return (
    Number(input.payerMemo === "full") + Number(input.payeeMemo === "full")
  );
}

/**
 * Product-level sieve. It ranks independently verified capabilities rather
 * than wallet or provider names. Partial memo delivery remains visible as
 * evidence but does not promote a payment to a full-memo tier.
 */
const PAYMENT_CAPABILITY_TIERS = Object.freeze([
  Object.freeze({
    tier: 1 as const,
    id: "automatic-both-memos" as const,
    matches: (input: PaymentCapabilityEvidence) =>
      input.automaticSettlement && fullMemoCount(input) === 2,
  }),
  Object.freeze({
    tier: 2 as const,
    id: "automatic-one-memo" as const,
    matches: (input: PaymentCapabilityEvidence) =>
      input.automaticSettlement && fullMemoCount(input) === 1,
  }),
  Object.freeze({
    tier: 3 as const,
    id: "automatic" as const,
    matches: (input: PaymentCapabilityEvidence) => input.automaticSettlement,
  }),
  Object.freeze({
    tier: 4 as const,
    id: "both-memos" as const,
    matches: (input: PaymentCapabilityEvidence) =>
      !input.automaticSettlement && fullMemoCount(input) === 2,
  }),
  Object.freeze({
    tier: 5 as const,
    id: "one-memo" as const,
    matches: (input: PaymentCapabilityEvidence) =>
      !input.automaticSettlement && fullMemoCount(input) === 1,
  }),
  Object.freeze({
    tier: 6 as const,
    id: "qr-only" as const,
    matches: () => true,
  }),
]) satisfies readonly PaymentCapabilityTier[];

export const PAYMENT_CAPABILITY_TIER_PRIORITY = Object.freeze(
  PAYMENT_CAPABILITY_TIERS.map(({ id }) => id),
);

export function isMemoDelivery(value: unknown): value is MemoDelivery {
  return value === "none" || value === "partial" || value === "full";
}

export function selectPaymentCapability(
  input: PaymentCapabilityEvidence,
): PaymentCapabilitySelection {
  for (const candidate of PAYMENT_CAPABILITY_TIERS) {
    if (!candidate.matches(input)) continue;
    return Object.freeze({
      tier: candidate.tier,
      id: candidate.id,
      automaticSettlement: input.automaticSettlement,
      payerMemo: input.payerMemo,
      payeeMemo: input.payeeMemo,
    });
  }
  // The final qr-only entry is unconditional. Keep this fail-closed guard in
  // case a future edit accidentally removes the terminal fallback.
  throw new Error("Payment capability registry has no terminal fallback.");
}
