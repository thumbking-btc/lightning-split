import type {
  BatchInvoiceResponseDto,
  SettlementResponseDto,
} from "../api/contracts";
import type { PriceSnapshotDto } from "../api/serialization";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import {
  createKrwSplitPlan,
  createSatsSplitPlan,
  sumAmounts,
} from "../domain/money";
import type {
  InputMode,
  PaymentAnnotation,
  PaymentDescriptionStatus,
  ProviderCommentStatus,
} from "../domain/models";
import { createLocalSettlementId } from "./localId";
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
  readonly payerShareSats: bigint | null;
}

function mergePaymentHashes(
  ...collections: readonly (readonly string[])[]
): readonly string[] {
  return Object.freeze([...new Set(collections.flat())]);
}

function mergeProviderCommentStatus(
  current: ProviderCommentStatus | undefined,
  next: ProviderCommentStatus | undefined,
): ProviderCommentStatus | undefined {
  if (next === undefined) return current;
  if (current === undefined || current === next) return next;
  return "partial";
}

function mergePaymentDescriptionStatus(
  current: PaymentDescriptionStatus | undefined,
  next: PaymentDescriptionStatus | undefined,
): PaymentDescriptionStatus | undefined {
  if (next === undefined) return current;
  if (current === undefined || current === next) return next;
  return "partial";
}

function inferProviderCommentStatus(
  response: BatchInvoiceResponseDto,
): ProviderCommentStatus | undefined {
  if (response.provider.commentStatus !== undefined)
    return response.provider.commentStatus;
  if (response.provider.commentAllowed === 0) return "unsupported";
  return response.slots.some((slot) => slot.status === "pending")
    ? "forwarded"
    : undefined;
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
  if (
    draft.overallNote !== undefined &&
    [...draft.overallNote].length >
      DEFAULT_LIGHTNING_POLICY.maximumProviderCommentCharacters
  ) {
    throw new Error(
      `정산 메모는 ${DEFAULT_LIGHTNING_POLICY.maximumProviderCommentCharacters}자 이하여야 합니다.`,
    );
  }
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
      payerShareSats: null,
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
    payerShareSats: plan.payerShareSats,
  };
}

export function createGeneratingSession(
  draft: DraftInput,
  preview: SettlementPreview,
  priceSnapshot: PriceSnapshotDto | undefined,
  now = new Date(),
  idFactory: () => string = createLocalSettlementId,
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
    id: idFactory(),
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
    ...(preview.payerShareSats === null
      ? {}
      : { payerShareSats: preview.payerShareSats.toString() }),
    createdAt: now.toISOString(),
    slots: Object.freeze(slots),
  };
}

export function applyBatchResponse(
  session: SettlementSession,
  response: BatchInvoiceResponseDto,
): SettlementSession {
  const providerCommentStatus = session.overallNote
    ? mergeProviderCommentStatus(
        session.providerCommentStatus,
        inferProviderCommentStatus(response),
      )
    : undefined;
  const paymentDescriptionStatus = session.overallNote
    ? mergePaymentDescriptionStatus(
        session.paymentDescriptionStatus,
        response.provider.descriptionStatus,
      )
    : undefined;
  return {
    ...session,
    providerDomain: response.provider.domain,
    ...(providerCommentStatus === undefined ? {} : { providerCommentStatus }),
    ...(paymentDescriptionStatus === undefined
      ? {}
      : { paymentDescriptionStatus }),
    issuedPaymentHashes: mergePaymentHashes(
      session.issuedPaymentHashes ?? [],
      response.slots.flatMap((slot) =>
        slot.status === "pending" ? [slot.invoice.paymentHash] : [],
      ),
    ),
    slots: response.slots.map((slot): ClientSlot =>
      slot.status === "pending"
        ? { ...slot, status: "pending", invoice: slot.invoice }
        : slot.status === "deferred"
          ? { ...slot, status: "queued" }
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

export function prepareQueuedSlot(
  session: SettlementSession,
  slotNumber: number,
): SettlementSession {
  if (
    session.slots.some(
      (slot) => slot.status === "pending" || slot.status === "generating",
    )
  ) {
    throw new Error("현재 결제 요청을 먼저 완료하거나 만료를 기다리십시오.");
  }
  const target = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (!target || target.status !== "queued")
    throw new Error("대기 중인 결제 요청이 아닙니다.");
  return {
    ...session,
    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber ? { ...slot, status: "generating" } : slot,
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
    return session;
  }
  if (
    result.status === "pending" &&
    (excludedPaymentHashes.includes(result.invoice.paymentHash) ||
      excludedInvoices.includes(result.invoice.bolt11))
  ) {
    throw new Error("이전 결제 요청이 재사용되어 안전하게 거부했습니다.");
  }
  const providerCommentStatus = session.overallNote
    ? mergeProviderCommentStatus(
        session.providerCommentStatus,
        inferProviderCommentStatus(response),
      )
    : undefined;
  const paymentDescriptionStatus = session.overallNote
    ? mergePaymentDescriptionStatus(
        session.paymentDescriptionStatus,
        response.provider.descriptionStatus,
      )
    : undefined;
  return {
    ...session,
    providerDomain: response.provider.domain,
    ...(providerCommentStatus === undefined ? {} : { providerCommentStatus }),
    ...(paymentDescriptionStatus === undefined
      ? {}
      : { paymentDescriptionStatus }),
    issuedPaymentHashes: mergePaymentHashes(
      session.issuedPaymentHashes ?? [],
      excludedPaymentHashes,
      result.status === "pending" ? [result.invoice.paymentHash] : [],
    ),
    slots: session.slots.map((slot): ClientSlot => {
      if (slot.slotNumber !== slotNumber) return slot;
      return result.status === "pending"
        ? { ...result, status: "pending", invoice: result.invoice }
        : result.status === "deferred"
          ? { ...result, status: "queued" }
          : { ...result, status: "failed", failure: result.failure };
    }),
  };
}

export function markExpiredSlots(
  session: SettlementSession,
  nowMs = Date.now(),
): SettlementSession {
  const finalVerificationGraceMs =
    DEFAULT_LIGHTNING_POLICY.settlementFinalVerificationGraceSeconds * 1_000;
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (
      slot.status === "expired" &&
      slot.invoice?.verificationToken !== undefined
    ) {
      changed = true;
      const expiresAtMs = Date.parse(slot.invoice.expiresAt);
      if (nowMs < expiresAtMs) return { ...slot, status: "pending" };
      if (nowMs < expiresAtMs + finalVerificationGraceMs) {
        return { ...slot, status: "verifyingExpired" };
      }
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return { ...slot, invoice };
    }
    if (
      slot.status === "pending" &&
      slot.invoice &&
      Date.parse(slot.invoice.expiresAt) <= nowMs
    ) {
      changed = true;
      if (
        slot.invoice.verificationToken !== undefined &&
        nowMs < Date.parse(slot.invoice.expiresAt) + finalVerificationGraceMs
      ) {
        return { ...slot, status: "verifyingExpired" };
      }
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return { ...slot, status: "expired", invoice };
    }
    if (
      slot.status === "verifyingExpired" &&
      slot.invoice &&
      Date.parse(slot.invoice.expiresAt) + finalVerificationGraceMs <= nowMs
    ) {
      changed = true;
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return { ...slot, status: "expired", invoice };
    }
    return slot;
  });
  return changed ? { ...session, slots } : session;
}

export interface SettlementInvoiceIdentity {
  readonly slotNumber: number;
  readonly attempt: number;
  readonly paymentHash: string;
  readonly verificationToken: string;
}

function isCurrentVerification(
  slot: ClientSlot,
  identity: SettlementInvoiceIdentity,
): boolean {
  return (
    slot.slotNumber === identity.slotNumber &&
    slot.attempt === identity.attempt &&
    (slot.status === "pending" || slot.status === "verifyingExpired") &&
    slot.invoice?.paymentHash === identity.paymentHash &&
    slot.invoice.verificationToken === identity.verificationToken
  );
}

export function applySettlementResponse(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
  response: SettlementResponseDto,
  now = new Date(),
): SettlementSession {
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (!isCurrentVerification(slot, identity)) return slot;
    if (response.status === "settled" && response.settled) {
      changed = true;
      return {
        ...slot,
        status: "settled",
        settledAt: response.checkedAt ?? now.toISOString(),
      };
    }
    if (response.status === "expired" && slot.invoice) {
      changed = true;
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return { ...slot, status: "expired", invoice };
    }
    if (response.status === "notAvailable" && slot.invoice) {
      changed = true;
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return {
        ...slot,
        status:
          Date.parse(invoice.expiresAt) <= now.getTime()
            ? "expired"
            : "pending",
        invoice,
      };
    }
    return slot;
  });
  return changed ? { ...session, slots } : session;
}

export function disableAutomaticVerification(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
  now = new Date(),
): SettlementSession {
  return applySettlementResponse(
    session,
    identity,
    { ok: true, status: "notAvailable", settled: false },
    now,
  );
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
        (slot.status !== "pending" && slot.status !== "expired") ||
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
