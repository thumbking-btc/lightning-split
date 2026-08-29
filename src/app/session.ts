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

function parsePositiveDecimal(value: string, field: string): bigint {
  if (!/^[1-9]\d*$/u.test(value))
    throw new Error(`${field}은(는) 1 이상의 정수여야 합니다.`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${field}이(가) 너무 큽니다.`);
  return parsed;
}

export function createSettlementPreview(
  draft: DraftInput,
  priceSnapshot?: PriceSnapshotDto,
): SettlementPreview {
  const total = parsePositiveDecimal(
    draft.totalAmount,
    draft.inputMode === "krw" ? "총 원화" : "총 sats",
  );
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
    slots: response.slots.map((slot): ClientSlot =>
      slot.status === "pending"
        ? { ...slot, status: "pending", invoice: slot.invoice }
        : { ...slot, status: "failed", failure: slot.failure },
    ),
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
      slot.slotNumber === slotNumber && slot.status === "settled"
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

export function getSettlementProgress(
  session: SettlementSession,
): SettlementProgress {
  const settled = session.slots.filter((slot) => slot.status === "settled");
  return {
    settledCount: settled.length,
    totalCount: session.slots.length,
    settledSats: sumAmounts(settled.map((slot) => BigInt(slot.targetSats))),
    totalSats: sumAmounts(session.slots.map((slot) => BigInt(slot.targetSats))),
    settledKrw: sumAmounts(settled.map((slot) => BigInt(slot.krwShare ?? "0"))),
    totalKrw: sumAmounts(
      session.slots.map((slot) => BigInt(slot.krwShare ?? "0")),
    ),
  };
}
