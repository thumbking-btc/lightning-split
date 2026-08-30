const SATS_PER_BTC = 100_000_000n;
const MIN_PEOPLE = 2;
const MAX_PEOPLE = 10;
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

export interface SatsSplitPlan extends EqualSplitPlan {
  readonly groupTotalSats: bigint;
  readonly payerShareSats: bigint | null;
}

export interface KrwPayerExcludedSplit {
  readonly invoiceShares: readonly bigint[];
  readonly payerShareKrw: bigint;
}

function assertPeopleCount(people: number): void {
  if (
    !Number.isSafeInteger(people) ||
    people < MIN_PEOPLE ||
    people > MAX_PEOPLE
  ) {
    throw new MoneyValidationError(
      "INVALID_PEOPLE_COUNT",
      `People must be an integer between ${MIN_PEOPLE} and ${MAX_PEOPLE}.`,
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
      `${field} must be a positive integer.`,
    );
  }

  if (amount > MAX_SAFE_AMOUNT) {
    throw new MoneyValidationError(
      "UNSAFE_AMOUNT",
      `${field} must not exceed Number.MAX_SAFE_INTEGER at the input boundary.`,
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
      "Every invoice target must be greater than zero.",
    );
  }
}

export function bigintFromSafeInteger(value: number, field = "amount"): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyValidationError(
      Number.isFinite(value) && value > Number.MAX_SAFE_INTEGER
        ? "UNSAFE_AMOUNT"
        : "INVALID_AMOUNT",
      `${field} must be a positive safe integer.`,
    );
  }

  return BigInt(value);
}

export function splitKrw(
  totalKrw: bigint,
  totalPeople: number,
): KrwPayerExcludedSplit {
  assertPeopleCount(totalPeople);
  assertPositiveSafeAmount(totalKrw, "amount");

  const divisor = BigInt(totalPeople);
  const senderShareKrw = totalKrw / divisor;
  const remainderKrw = totalKrw % divisor;
  const invoiceShares = Array.from(
    { length: totalPeople - 1 },
    () => senderShareKrw,
  );

  assertPositiveInvoiceShares(invoiceShares);

  return {
    invoiceShares,
    payerShareKrw: senderShareKrw + remainderKrw,
  };
}

export function krwToSats(krw: bigint, btcPriceKrw: bigint): bigint {
  assertPositiveSafeAmount(krw, "amount");
  assertPositiveSafeAmount(btcPriceKrw, "price");

  const doubledNumerator = 2n * krw * SATS_PER_BTC;
  const doubledDenominator = 2n * btcPriceKrw;

  return (doubledNumerator + btcPriceKrw) / doubledDenominator;
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
      "Every converted invoice target must be at least one sat.",
    );
  }

  return {
    invoiceShares: split.invoiceShares,
    invoiceCount: split.invoiceShares.length,
    payerShareKrw: split.payerShareKrw,
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
