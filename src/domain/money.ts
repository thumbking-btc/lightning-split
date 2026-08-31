const SATS_PER_BTC = 100_000_000n;
export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 20;
const MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

export type MoneyValidationCode =
  | "INVALID_PEOPLE_COUNT"
  | "INVALID_AMOUNT"
  | "UNSAFE_AMOUNT"
  | "INVALID_PRICE"
  | "ZERO_INVOICE_TARGET";

export class MoneyValidationError extends Error {
  readonly code: MoneyValidationCode;

  constructor(code: MoneyValidationCode, message: string) {
    super(message);
    this.name = "MoneyValidationError";
    this.code = code;
  }
}

export interface EqualSplitPlan {
  readonly invoiceShares: readonly bigint[];
  readonly invoiceCount: number;
}

export interface KrwSplitPlan extends EqualSplitPlan {
  readonly payerShareKrw: bigint | null;
  readonly targetSats: readonly bigint[];
}

export interface UsdSplitPlan extends EqualSplitPlan {
  readonly payerShareUsdCents: bigint | null;
  readonly targetSats: readonly bigint[];
}

export interface SatsSplitPlan extends EqualSplitPlan {
  readonly groupTotalSats: bigint;
  readonly payerShareSats: bigint | null;
}

export interface KrwPayerExcludedSplit {
  readonly invoiceShares: readonly bigint[];
  readonly payerShareKrw: bigint;
}

export interface UsdPayerExcludedSplit {
  readonly invoiceShares: readonly bigint[];
  readonly payerShareUsdCents: bigint;
}

function assertPeopleCount(people: number): void {
  if (
    !Number.isSafeInteger(people) ||
    people < MIN_PEOPLE ||
    people > MAX_PEOPLE
  ) {
    throw new MoneyValidationError(
      "INVALID_PEOPLE_COUNT",
      `인원은 ${MIN_PEOPLE}명 이상 ${MAX_PEOPLE}명 이하의 정수여야 합니다.`,
    );
  }
}

function assertPositiveSafeAmount(
  amount: bigint,
  field: "amount" | "price",
): void {
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new MoneyValidationError(
      field === "price" ? "INVALID_PRICE" : "INVALID_AMOUNT",
      field === "price"
        ? "BTC 기준가격은 1 이상의 정수여야 합니다."
        : "금액은 1 이상의 정수여야 합니다.",
    );
  }

  if (amount > MAX_SAFE_AMOUNT) {
    throw new MoneyValidationError(
      "UNSAFE_AMOUNT",
      field === "price"
        ? "BTC 기준가격이 안전하게 처리할 수 있는 범위를 넘었습니다."
        : "금액이 안전하게 처리할 수 있는 범위를 넘었습니다.",
    );
  }
}

function splitEvenly(total: bigint, slotCount: number): readonly bigint[] {
  const divisor = BigInt(slotCount);
  const quotient = total / divisor;
  const remainder = Number(total % divisor);

  return Array.from({ length: slotCount }, (_, index) =>
    index < remainder ? quotient + 1n : quotient,
  );
}

function assertPositiveInvoiceShares(invoiceShares: readonly bigint[]): void {
  if (invoiceShares.some((share) => share === 0n)) {
    throw new MoneyValidationError(
      "ZERO_INVOICE_TARGET",
      "각 결제 금액은 1 sat 이상이어야 합니다.",
    );
  }
}

function splitPayerExcluded(
  total: bigint,
  totalPeople: number,
): {
  readonly invoiceShares: readonly bigint[];
  readonly payerShare: bigint;
} {
  assertPeopleCount(totalPeople);
  assertPositiveSafeAmount(total, "amount");

  const divisor = BigInt(totalPeople);
  const equalShare = total / divisor;
  const remainder = total % divisor;
  const invoiceShares = Array.from(
    { length: totalPeople - 1 },
    () => equalShare,
  );
  assertPositiveInvoiceShares(invoiceShares);
  return { invoiceShares, payerShare: equalShare + remainder };
}

function fiatMinorToSats(amountMinor: bigint, btcPriceMinor: bigint): bigint {
  assertPositiveSafeAmount(amountMinor, "amount");
  assertPositiveSafeAmount(btcPriceMinor, "price");
  const doubledNumerator = 2n * amountMinor * SATS_PER_BTC;
  const doubledDenominator = 2n * btcPriceMinor;
  return (doubledNumerator + btcPriceMinor) / doubledDenominator;
}

export function bigintFromSafeInteger(value: number, field = "amount"): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyValidationError(
      Number.isFinite(value) && value > Number.MAX_SAFE_INTEGER
        ? "UNSAFE_AMOUNT"
        : "INVALID_AMOUNT",
      `${field} 값은 안전하게 처리할 수 있는 1 이상의 정수여야 합니다.`,
    );
  }

  return BigInt(value);
}

export function splitKrw(
  totalKrw: bigint,
  totalPeople: number,
): KrwPayerExcludedSplit {
  const split = splitPayerExcluded(totalKrw, totalPeople);
  return {
    invoiceShares: split.invoiceShares,
    payerShareKrw: split.payerShare,
  };
}

export function splitUsdCents(
  totalUsdCents: bigint,
  totalPeople: number,
): UsdPayerExcludedSplit {
  const split = splitPayerExcluded(totalUsdCents, totalPeople);
  return {
    invoiceShares: split.invoiceShares,
    payerShareUsdCents: split.payerShare,
  };
}

export function krwToSats(krw: bigint, btcPriceKrw: bigint): bigint {
  return fiatMinorToSats(krw, btcPriceKrw);
}

export function usdCentsToSats(
  usdCents: bigint,
  btcPriceUsdCents: bigint,
): bigint {
  return fiatMinorToSats(usdCents, btcPriceUsdCents);
}

export function createKrwSplitPlan(
  totalKrw: bigint,
  people: number,
  excludePayer: boolean,
  btcPriceKrw: bigint,
): KrwSplitPlan {
  assertPositiveSafeAmount(btcPriceKrw, "price");
  assertPeopleCount(people);
  assertPositiveSafeAmount(totalKrw, "amount");

  const split = excludePayer
    ? splitKrw(totalKrw, people)
    : {
        invoiceShares: splitEvenly(totalKrw, people),
        payerShareKrw: null,
      };
  assertPositiveInvoiceShares(split.invoiceShares);

  const targetSats = split.invoiceShares.map((share) =>
    krwToSats(share, btcPriceKrw),
  );
  if (targetSats.some((amount) => amount === 0n)) {
    throw new MoneyValidationError(
      "ZERO_INVOICE_TARGET",
      "환산된 각 결제 금액은 1 sat 이상이어야 합니다.",
    );
  }

  return {
    invoiceShares: split.invoiceShares,
    invoiceCount: split.invoiceShares.length,
    payerShareKrw: split.payerShareKrw,
    targetSats,
  };
}

export function createUsdSplitPlan(
  totalUsdCents: bigint,
  people: number,
  excludePayer: boolean,
  btcPriceUsdCents: bigint,
): UsdSplitPlan {
  assertPositiveSafeAmount(btcPriceUsdCents, "price");
  assertPeopleCount(people);
  assertPositiveSafeAmount(totalUsdCents, "amount");

  const split = excludePayer
    ? splitUsdCents(totalUsdCents, people)
    : {
        invoiceShares: splitEvenly(totalUsdCents, people),
        payerShareUsdCents: null,
      };
  assertPositiveInvoiceShares(split.invoiceShares);

  const targetSats = split.invoiceShares.map((share) =>
    usdCentsToSats(share, btcPriceUsdCents),
  );
  if (targetSats.some((amount) => amount === 0n)) {
    throw new MoneyValidationError(
      "ZERO_INVOICE_TARGET",
      "환산된 각 결제 금액은 1 sat 이상이어야 합니다.",
    );
  }

  return {
    invoiceShares: split.invoiceShares,
    invoiceCount: split.invoiceShares.length,
    payerShareUsdCents: split.payerShareUsdCents,
    targetSats,
  };
}

export function createSatsSplitPlan(
  totalSats: bigint,
  people: number,
  excludePayer: boolean,
): SatsSplitPlan {
  assertPeopleCount(people);
  assertPositiveSafeAmount(totalSats, "amount");

  const divisor = BigInt(people);
  const equalShareSats = totalSats / divisor;
  const remainderSats = totalSats % divisor;
  const invoiceShares = excludePayer
    ? Array.from({ length: people - 1 }, () => equalShareSats)
    : splitEvenly(totalSats, people);
  assertPositiveInvoiceShares(invoiceShares);

  return {
    invoiceShares,
    invoiceCount: invoiceShares.length,
    groupTotalSats: totalSats,
    payerShareSats: excludePayer ? equalShareSats + remainderSats : null,
  };
}

export function sumAmounts(amounts: readonly bigint[]): bigint {
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}
