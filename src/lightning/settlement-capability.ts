/**
 * Capabilities advertised for one provider-issued invoice.
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
