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
import {
  MAX_INVOICE_HISTORY,
  type ClientSlot,
  type HistoricalInvoiceAttempt,
  type SettlementProgress,
  type SettlementSession,
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

function persistedInvoice(
  invoice: NonNullable<ClientSlot["invoice"]>,
): NonNullable<ClientSlot["invoice"]> {
  if (invoice.awaitingPersistence === undefined) return invoice;
  const { awaitingPersistence: _awaitingPersistence, ...persisted } = invoice;
  void _awaitingPersistence;
  return persisted;
}

function appendInvoiceHistory(
  history: readonly HistoricalInvoiceAttempt[] | undefined,
  slot: ClientSlot,
  now: Date,
): readonly HistoricalInvoiceAttempt[] {
  if (!slot.invoice) return history ?? [];
  const current = history ?? [];
  if (
    current.some(
      (attempt) =>
        attempt.slotNumber === slot.slotNumber &&
        attempt.attempt === slot.attempt &&
        attempt.invoice.paymentHash === slot.invoice?.paymentHash,
    )
  ) {
    return current;
  }
  if (current.length >= MAX_INVOICE_HISTORY) {
    throw new Error(
      "이전 결제 요청 확인 내역이 가득 차 새 결제 요청을 안전하게 만들 수 없습니다.",
    );
  }
  return Object.freeze([
    ...current,
    {
      slotNumber: slot.slotNumber,
      targetSats: slot.targetSats,
      ...(slot.krwShare === undefined ? {} : { krwShare: slot.krwShare }),
      attempt: slot.attempt,
      invoice: persistedInvoice(slot.invoice),
      retiredAt: now.toISOString(),
    },
  ]);
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
        ? {
            ...slot,
            status: "pending",
            invoice: { ...slot.invoice, awaitingPersistence: true },
          }
        : slot.status === "deferred"
          ? { ...slot, status: "queued" }
          : { ...slot, status: "failed", failure: slot.failure },
    ),
  };
}

export function prepareSlotRetry(
  session: SettlementSession,
  slotNumber: number,
  now = new Date(),
): SettlementSession {
  const target = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (!target || (target.status !== "failed" && target.status !== "expired")) {
    throw new Error("실패하거나 만료된 결제만 다시 만들 수 있습니다.");
  }
  return {
    ...session,
    ...(target.invoice === undefined
      ? {}
      : {
          invoiceHistory: appendInvoiceHistory(
            session.invoiceHistory,
            target,
            now,
          ),
        }),
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
  now = new Date(),
): SettlementSession {
  if (
    response.slots.length !== 1 ||
    response.slots[0]?.slotNumber !== slotNumber
  ) {
    throw new Error("재발급 응답이 요청한 결제와 일치하지 않습니다.");
  }
  const result = response.slots[0];
  const current = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (!current) {
    return session;
  }
  if (current.status === "generating" && result.attempt !== current.attempt)
    return session;
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
  if (current.status !== "generating") {
    if (result.status !== "pending") return session;
    const issuedSlot: ClientSlot = {
      ...result,
      status: "pending",
      invoice: { ...result.invoice, awaitingPersistence: true },
    };
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
        [result.invoice.paymentHash],
      ),
      invoiceHistory: appendInvoiceHistory(
        session.invoiceHistory,
        issuedSlot,
        now,
      ),
    };
  }
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
        ? {
            ...result,
            status: "pending",
            invoice: { ...result.invoice, awaitingPersistence: true },
          }
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
      const expiresAtMs = Date.parse(slot.invoice.expiresAt);
      if (nowMs < expiresAtMs) {
        changed = true;
        return { ...slot, status: "pending" };
      }
      if (nowMs < expiresAtMs + finalVerificationGraceMs) {
        changed = true;
        return { ...slot, status: "verifyingExpired" };
      }
      return slot;
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
      return { ...slot, status: "expired" };
    }
    if (
      slot.status === "verifyingExpired" &&
      slot.invoice &&
      Date.parse(slot.invoice.expiresAt) + finalVerificationGraceMs <= nowMs
    ) {
      changed = true;
      return { ...slot, status: "expired" };
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

function isSameInvoice(
  slot: ClientSlot,
  identity: SettlementInvoiceIdentity,
): boolean {
  return (
    slot.slotNumber === identity.slotNumber &&
    slot.attempt === identity.attempt &&
    slot.invoice?.paymentHash === identity.paymentHash &&
    slot.invoice.verificationToken === identity.verificationToken
  );
}

function isCurrentVerification(
  slot: ClientSlot,
  identity: SettlementInvoiceIdentity,
): boolean {
  return (
    isSameInvoice(slot, identity) &&
    (slot.status === "pending" ||
      slot.status === "verifyingExpired" ||
      slot.status === "manuallyConfirmed") &&
    slot.invoice !== undefined
  );
}

function withoutVerificationDelay(slot: ClientSlot): ClientSlot {
  if (slot.verificationDelayed === undefined) return slot;
  const { verificationDelayed: _verificationDelayed, ...current } = slot;
  void _verificationDelayed;
  return current;
}

function withoutVerificationToken(
  invoice: NonNullable<ClientSlot["invoice"]>,
): NonNullable<ClientSlot["invoice"]> {
  if (invoice.verificationToken === undefined) return invoice;
  const { verificationToken: _verificationToken, ...remaining } = invoice;
  void _verificationToken;
  return remaining;
}

function applyHistoricalSettlementResponse(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
  response: SettlementResponseDto,
  now: Date,
): SettlementSession | undefined {
  const history = session.invoiceHistory;
  if (!history) return undefined;
  const historyIndex = history.findIndex(
    (attempt) =>
      attempt.slotNumber === identity.slotNumber &&
      attempt.attempt === identity.attempt &&
      attempt.invoice.paymentHash === identity.paymentHash &&
      attempt.invoice.verificationToken === identity.verificationToken,
  );
  if (historyIndex < 0) return undefined;
  const historicalAttempt = history[historyIndex]!;

  if (response.status === "settled" && response.settled) {
    const settledAt = response.checkedAt ?? now.toISOString();
    const current = session.slots.find(
      (slot) => slot.slotNumber === identity.slotNumber,
    );
    if (!current) return session;

    if (current.status === "settled") {
      if (historicalAttempt.settledAt !== undefined) return session;
      return {
        ...session,
        invoiceHistory: history.map((attempt, index) =>
          index === historyIndex ? { ...attempt, settledAt } : attempt,
        ),
      };
    }

    const remainingHistory = history.filter(
      (_attempt, index) => index !== historyIndex,
    );
    const nextHistory = current.invoice
      ? appendInvoiceHistory(remainingHistory, current, now)
      : remainingHistory;
    return {
      ...session,
      invoiceHistory: nextHistory,
      slots: session.slots.map((slot): ClientSlot =>
        slot.slotNumber === identity.slotNumber
          ? {
              slotNumber: slot.slotNumber,
              targetSats: slot.targetSats,
              ...(slot.krwShare === undefined
                ? {}
                : { krwShare: slot.krwShare }),
              attempt: historicalAttempt.attempt,
              status: "settled",
              invoice: historicalAttempt.invoice,
              settledAt,
              ...(slot.annotation === undefined
                ? {}
                : { annotation: slot.annotation }),
            }
          : slot,
      ),
    };
  }

  if (response.status !== "expired" && response.status !== "notAvailable")
    return session;
  return {
    ...session,
    invoiceHistory: history.map((attempt, index) =>
      index === historyIndex
        ? { ...attempt, invoice: withoutVerificationToken(attempt.invoice) }
        : attempt,
    ),
  };
}

export function applySettlementResponse(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
  response: SettlementResponseDto,
  now = new Date(),
): SettlementSession {
  const historicalResult = applyHistoricalSettlementResponse(
    session,
    identity,
    response,
    now,
  );
  if (historicalResult !== undefined) return historicalResult;
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (
      response.status === "settled" &&
      response.settled &&
      isSameInvoice(slot, identity) &&
      (slot.status === "pending" ||
        slot.status === "verifyingExpired" ||
        slot.status === "manuallyConfirmed")
    ) {
      changed = true;
      const current = withoutVerificationDelay(slot);
      return {
        ...current,
        status: "settled",
        settledAt: response.checkedAt ?? now.toISOString(),
      };
    }
    if (!isCurrentVerification(slot, identity)) return slot;
    if (
      slot.status === "manuallyConfirmed" &&
      slot.invoice &&
      (response.status === "expired" || response.status === "notAvailable")
    ) {
      changed = true;
      return {
        ...withoutVerificationDelay(slot),
        invoice: withoutVerificationToken(slot.invoice),
      };
    }
    if (response.status === "expired" && slot.invoice) {
      changed = true;
      return { ...withoutVerificationDelay(slot), status: "expired" };
    }
    if (response.status === "notAvailable" && slot.invoice) {
      changed = true;
      const { verificationToken: _verificationToken, ...invoice } =
        slot.invoice;
      void _verificationToken;
      return {
        ...withoutVerificationDelay(slot),
        status:
          Date.parse(invoice.expiresAt) <= now.getTime()
            ? "expired"
            : "pending",
        invoice,
      };
    }
    if (slot.verificationDelayed === true) {
      changed = true;
      return withoutVerificationDelay(slot);
    }
    return slot;
  });
  return changed ? { ...session, slots } : session;
}

export interface InvoicePersistenceIdentity {
  readonly slotNumber: number;
  readonly attempt: number;
  readonly paymentHash: string;
}

export function pendingInvoicePersistenceIdentities(
  session: SettlementSession,
): readonly InvoicePersistenceIdentity[] {
  return session.slots.flatMap((slot) =>
    slot.status === "pending" && slot.invoice?.awaitingPersistence === true
      ? [
          {
            slotNumber: slot.slotNumber,
            attempt: slot.attempt,
            paymentHash: slot.invoice.paymentHash,
          },
        ]
      : [],
  );
}

function matchesPersistenceIdentity(
  slot: ClientSlot,
  identity: InvoicePersistenceIdentity,
): boolean {
  return (
    slot.slotNumber === identity.slotNumber &&
    slot.attempt === identity.attempt &&
    slot.invoice?.paymentHash === identity.paymentHash
  );
}

export function markPendingInvoicesPersisted(
  session: SettlementSession,
  identities: readonly InvoicePersistenceIdentity[],
): SettlementSession {
  if (identities.length === 0) return session;
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (
      slot.status !== "pending" ||
      slot.invoice?.awaitingPersistence !== true ||
      !identities.some((identity) => matchesPersistenceIdentity(slot, identity))
    ) {
      return slot;
    }
    changed = true;
    return { ...slot, invoice: persistedInvoice(slot.invoice) };
  });
  return changed ? { ...session, slots } : session;
}

export function failPendingInvoicePersistence(
  session: SettlementSession,
  identities: readonly InvoicePersistenceIdentity[],
): SettlementSession {
  if (identities.length === 0) return session;
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (
      slot.status !== "pending" ||
      slot.invoice?.awaitingPersistence !== true ||
      !identities.some((identity) => matchesPersistenceIdentity(slot, identity))
    ) {
      return slot;
    }
    changed = true;
    return {
      ...slot,
      status: "failed",
      failure: {
        code: "INVOICE_PERSISTENCE_FAILED",
        message:
          "결제 요청을 기기에 안전하게 저장하지 못했습니다. 이 결제 요청은 표시하지 않았으며 다시 시도할 수 있습니다.",
        retryable: true,
      },
    };
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

export function markAutomaticVerificationDelayed(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
): SettlementSession {
  let changed = false;
  const slots = session.slots.map((slot): ClientSlot => {
    if (!isCurrentVerification(slot, identity) || slot.verificationDelayed)
      return slot;
    changed = true;
    return { ...slot, verificationDelayed: true };
  });
  return changed ? { ...session, slots } : session;
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
  const target = session.slots.find((slot) => slot.slotNumber === slotNumber);
  if (!target) throw new Error("확인할 결제를 찾지 못했습니다.");
  if (target.status === "settled" || target.status === "manuallyConfirmed")
    return session;
  if (
    (target.status !== "pending" &&
      target.status !== "verifyingExpired" &&
      target.status !== "expired") ||
    !target.invoice
  ) {
    throw new Error(
      "실제 결제 요청이 있는 대기 또는 만료 결제만 확인할 수 있습니다.",
    );
  }
  return {
    ...session,
    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber
        ? {
            ...slot,
            status: "manuallyConfirmed",
            confirmedAt: now.toISOString(),
          }
        : slot,
    ),
  };
}

function isActionableSlot(slot: ClientSlot): boolean {
  return slot.status !== "settled" && slot.status !== "manuallyConfirmed";
}

export function firstActionableSlotIndex(session: SettlementSession): number {
  const index = session.slots.findIndex(isActionableSlot);
  return index === -1 ? 0 : index;
}

export function nextActionableSlotIndex(
  session: SettlementSession,
  completedIndex: number,
): number | undefined {
  for (let index = completedIndex + 1; index < session.slots.length; index += 1)
    if (isActionableSlot(session.slots[index]!)) return index;
  for (let index = 0; index < completedIndex; index += 1)
    if (isActionableSlot(session.slots[index]!)) return index;
  return undefined;
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

export function duplicateSettledSlotNumbers(
  session: SettlementSession,
): readonly number[] {
  return session.slots.flatMap((slot) => {
    if (slot.status !== "settled") return [];
    const settledHistoricalAttempts = (session.invoiceHistory ?? []).filter(
      (attempt) =>
        attempt.slotNumber === slot.slotNumber &&
        attempt.settledAt !== undefined,
    ).length;
    return settledHistoricalAttempts > 0 ? [slot.slotNumber] : [];
  });
}
