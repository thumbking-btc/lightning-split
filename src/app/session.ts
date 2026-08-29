import type {
  BatchInvoiceResponseDto,
  SettlementResponseDto,
} from "../api/contracts";
import type { PriceSnapshotDto } from "../api/serialization";
import {
  createKrwSplitPlan,
  createSatsSplitPlan,
  sumAmounts,
} from "../domain/money";
import type { InputMode, PaymentAnnotation } from "../domain/models";
import type {
  ClientSlot,
  SettlementProgress,
  SettlementSession,
} from "./types";

export interface DraftInput {
  readonly inputMode: InputMode;
  readonly totalAmount: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly lightningAddress: string;
  readonly overallNote?: string;
  readonly participantNameCandidates: readonly string[];
}

export interface SettlementPreview {
  readonly invoiceShares: readonly bigint[];
  readonly targetSats: readonly bigint[];
  readonly invoiceCount: number;
  readonly payerShareKrw: bigint | null;
}

function mergePaymentHashes(
  ...collections: readonly (readonly string[])[]
): readonly string[] {
  return Object.freeze([...new Set(collections.flat())]);
}

export function collectIssuedPaymentHashes(
  session: SettlementSession,
): readonly string[] {
  return mergePaymentHashes(
    session.issuedPaymentHashes ?? [],
    session.slots.flatMap((slot) =>
      slot.invoice ? [slot.invoice.paymentHash] : [],
    ),
  );
}

function parsePositiveDecimal(value: string): bigint {
  if (!/^[1-9]\d*$/u.test(value))
    throw new Error("입력 금액은 1 이상의 정수여야 합니다.");
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("입력 금액이 너무 큽니다.");
  return parsed;
}

export function createSettlementPreview(
  draft: DraftInput,
  priceSnapshot?: PriceSnapshotDto,
): SettlementPreview {
  const total = parsePositiveDecimal(draft.totalAmount);
  if (draft.inputMode === "krw") {
    if (!priceSnapshot) throw new Error("BTC 기준가격을 먼저 조회하십시오.");
    const plan = createKrwSplitPlan(
      total,
      draft.totalPeople,
      draft.excludePayer,
      BigInt(priceSnapshot.priceKrw),
    );
    return {
      invoiceShares: plan.invoiceShares,
      targetSats: plan.targetSats,
      invoiceCount: plan.invoiceCount,
      payerShareKrw: plan.payerShareKrw,
    };
  }
  const plan = createSatsSplitPlan(
    total,
    draft.totalPeople,
    draft.excludePayer,
  );
  return {
    invoiceShares: plan.invoiceShares,
    targetSats: plan.invoiceShares,
    invoiceCount: plan.invoiceCount,
    payerShareKrw: null,
  };
}

export function createGeneratingSession(
  draft: DraftInput,
  preview: SettlementPreview,
  priceSnapshot: PriceSnapshotDto | undefined,
  now = new Date(),
): SettlementSession {
  const slots: ClientSlot[] = preview.targetSats.map((targetSats, index) => ({
    slotNumber: index + 1,
    targetSats: targetSats.toString(),
    ...(draft.inputMode === "krw"
      ? { krwShare: preview.invoiceShares[index]!.toString() }
      : {}),
    attempt: 1,
    status: "generating",
  }));
  return {
    version: 1,
    id: crypto.randomUUID(),
    inputMode: draft.inputMode,
    totalAmount: draft.totalAmount,
    totalPeople: draft.totalPeople,
    excludePayer: draft.excludePayer,
    invoiceCount: preview.invoiceCount,
    lightningAddress: draft.lightningAddress,
    ...(draft.overallNote ? { overallNote: draft.overallNote } : {}),
    participantNameCandidates: Object.freeze([
      ...draft.participantNameCandidates,
    ]),
    ...(priceSnapshot ? { priceSnapshot } : {}),
    ...(preview.payerShareKrw === null
      ? {}
      : { payerShareKrw: preview.payerShareKrw.toString() }),
    createdAt: now.toISOString(),
    slots: Object.freeze(slots),
  };
}

export function applyBatchResponse(
  session: SettlementSession,
  response: BatchInvoiceResponseDto,
): SettlementSession {
  return {
    ...session,
    providerDomain: response.provider.domain,
    issuedPaymentHashes: mergePaymentHashes(
      session.issuedPaymentHashes ?? [],
      response.slots.flatMap((slot) =>
        slot.status === "pending" ? [slot.invoice.paymentHash] : [],
      ),
    ),
    slots: response.slots.map((slot): ClientSlot =>
      slot.status === "pending"
        ? { ...slot, status: "pending", invoice: slot.invoice }
        : { ...slot, status: "failed", failure: slot.failure },
    ),
  };
}

export function prepareSlotRetry(
  session: SettlementSession,
  slotNumber: number,
): SettlementSession {
  const target = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (!target || (target.status !== "failed" && target.status !== "expired")) {
    throw new Error("실패하거나 만료된 결제만 다시 만들 수 있습니다.");
  }
  return {
    ...session,
    issuedPaymentHashes: mergePaymentHashes(
      session.issuedPaymentHashes ?? [],
      target.invoice ? [target.invoice.paymentHash] : [],
    ),
    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber
        ? {
            slotNumber: slot.slotNumber,
            targetSats: slot.targetSats,
            ...(slot.krwShare === undefined ? {} : { krwShare: slot.krwShare }),
            attempt: slot.attempt + 1,
            status: "generating",
          }
        : slot,
    ),
  };
}

export function applySlotRetryResponse(
  session: SettlementSession,
  slotNumber: number,
  response: BatchInvoiceResponseDto,
  excludedPaymentHashes: readonly string[],
  excludedInvoices: readonly string[],
): SettlementSession {
  if (
    response.slots.length !== 1 ||
    response.slots[0]?.slotNumber !== slotNumber
  ) {
    throw new Error("재발급 응답이 요청한 결제와 일치하지 않습니다.");
  }
  const result = response.slots[0];
  const current = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (
    !current ||
    current.status !== "generating" ||
    result.attempt !== current.attempt
  ) {
    throw new Error("재발급 시도 정보가 일치하지 않습니다.");
  }
  if (
    result.status === "pending" &&
    (excludedPaymentHashes.includes(result.invoice.paymentHash) ||
      excludedInvoices.includes(result.invoice.bolt11))
  ) {
    throw new Error("이전 결제 요청이 재사용되어 안전하게 거부했습니다.");
  }
  return {
    ...session,
    providerDomain: response.provider.domain,
    issuedPaymentHashes: mergePaymentHashes(
      session.issuedPaymentHashes ?? [],
      excludedPaymentHashes,
      result.status === "pending" ? [result.invoice.paymentHash] : [],
    ),
    slots: session.slots.map((slot): ClientSlot => {
      if (slot.slotNumber !== slotNumber) return slot;
      return result.status === "pending"
        ? { ...result, status: "pending", invoice: result.invoice }
        : { ...result, status: "failed", failure: result.failure };
    }),
  };
}

export function markExpiredSlots(
  session: SettlementSession,
  nowMs = Date.now(),
): SettlementSession {
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (
      slot.status === "pending" &&
      slot.invoice &&
      Date.parse(slot.invoice.expiresAt) <= nowMs
    ) {
      changed = true;
      return { ...slot, status: "expired" };
    }
    return slot;
  });
  return changed ? { ...session, slots } : session;
}

export function applySettlementResponse(
  session: SettlementSession,
  slotNumber: number,
  response: SettlementResponseDto,
  now = new Date(),
): SettlementSession {
  return {
    ...session,
    slots: session.slots.map((slot): ClientSlot => {
      if (slot.slotNumber !== slotNumber || slot.status !== "pending")
        return slot;
      if (response.status === "settled" && response.settled) {
        return {
          ...slot,
          status: "settled",
          settledAt: response.checkedAt ?? now.toISOString(),
        };
      }
      if (response.status === "expired") return { ...slot, status: "expired" };
      if (response.status === "notAvailable" && slot.invoice) {
        const { verificationToken: _verificationToken, ...invoice } =
          slot.invoice;
        void _verificationToken;
        return { ...slot, invoice };
      }
      return slot;
    }),
  };
}

export function annotateSettledSlot(
  session: SettlementSession,
  slotNumber: number,
  annotation: Omit<PaymentAnnotation, "updatedAt">,
  now = new Date(),
): SettlementSession {
  return {
    ...session,
    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber &&
      (slot.status === "settled" || slot.status === "manuallyConfirmed")
        ? {
            ...slot,
            annotation: {
              ...(annotation.displayName
                ? { displayName: annotation.displayName }
                : {}),
              ...(annotation.note ? { note: annotation.note } : {}),
              updatedAt: now.toISOString(),
            },
          }
        : slot,
    ),
  };
}

export function manuallyConfirmSlot(
  session: SettlementSession,
  slotNumber: number,
  now = new Date(),
): SettlementSession {
  return {
    ...session,
    slots: session.slots.map((slot): ClientSlot => {
      if (slot.slotNumber !== slotNumber) return slot;
      if (
        slot.status !== "pending" ||
        !slot.invoice ||
        slot.invoice.verificationToken !== undefined
      ) {
        throw new Error(
          "자동 확인이 지원되지 않는 대기 결제만 확인할 수 있습니다.",
        );
      }
      return {
        ...slot,
        status: "manuallyConfirmed",
        confirmedAt: now.toISOString(),
      };
    }),
  };
}

export function getSettlementProgress(
  session: SettlementSession,
): SettlementProgress {
  const completed = session.slots.filter(
    (slot) => slot.status === "settled" || slot.status === "manuallyConfirmed",
  );
  return {
    completedCount: completed.length,
    networkSettledCount: completed.filter((slot) => slot.status === "settled")
      .length,
    manuallyConfirmedCount: completed.filter(
      (slot) => slot.status === "manuallyConfirmed",
    ).length,
    totalCount: session.slots.length,
    completedSats: sumAmounts(completed.map((slot) => BigInt(slot.targetSats))),
    totalSats: sumAmounts(session.slots.map((slot) => BigInt(slot.targetSats))),
    completedKrw: sumAmounts(
      completed.map((slot) => BigInt(slot.krwShare ?? "0")),
    ),
    totalKrw: sumAmounts(
      session.slots.map((slot) => BigInt(slot.krwShare ?? "0")),
    ),
  };
}
