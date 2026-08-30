import { openDB } from "idb";

import { parsePriceSnapshotDto } from "../api/serialization";
import {
  createKrwSplitPlan,
  createSatsSplitPlan,
  MAX_PEOPLE,
} from "../domain/money";
import { isRecord } from "../infrastructure/validation";
import { MAX_INVOICE_HISTORY, type SettlementSession } from "./types";

const DATABASE_NAME = "lightning-split";
const STORE_NAME = "settlements";
const ACTIVE_SESSION_KEY = "active-v2";
const LEGACY_ACTIVE_SESSION_KEY = "active";
const QUARANTINED_SESSION_KEY = "quarantine-v2";
const REVISION_KEY = "revision-v2";
const CURRENT_VERIFICATION_TOKEN =
  /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u;

let databasePromise: ReturnType<typeof openDB> | undefined;
let databaseOperationTail: Promise<void> = Promise.resolve();
let persistenceEpoch = 0;
let knownRevision: number | undefined;

export class SessionPersistenceConflictError extends Error {
  constructor() {
    super("다른 탭에서 정산 기록이 변경되었습니다.");
    this.name = "SessionPersistenceConflictError";
  }
}

function parseStoredRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function storedSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStoredInvoice(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.bolt11 === "string" &&
    value.bolt11.startsWith("lnbc") &&
    typeof value.paymentHash === "string" &&
    /^[0-9a-f]{64}$/u.test(value.paymentHash) &&
    Number.isSafeInteger(value.timestampSeconds) &&
    Number(value.timestampSeconds) > 0 &&
    Number.isSafeInteger(value.expirySeconds) &&
    Number(value.expirySeconds) > 0 &&
    isIsoTimestamp(value.expiresAt) &&
    typeof value.payeeNodeId === "string" &&
    /^[0-9a-f]{66}$/u.test(value.payeeNodeId) &&
    Array.isArray(value.featureBits) &&
    value.featureBits.every(
      (bit) => Number.isSafeInteger(bit) && Number(bit) >= 0,
    ) &&
    typeof value.providerDomain === "string" &&
    (value.disposable === undefined || typeof value.disposable === "boolean") &&
    (value.verificationToken === undefined ||
      (typeof value.verificationToken === "string" &&
        CURRENT_VERIFICATION_TOKEN.test(value.verificationToken))) &&
    (value.awaitingPersistence === undefined ||
      value.awaitingPersistence === true)
  );
}

function isStoredAnnotation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.displayName === undefined ||
      typeof value.displayName === "string") &&
    (value.note === undefined || typeof value.note === "string") &&
    isIsoTimestamp(value.updatedAt)
  );
}

function isStoredSettlementEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === "lud21" &&
    isIsoTimestamp(value.checkedAt) &&
    value.preimagePresent === true &&
    (value.providerStatus === undefined ||
      value.providerStatus === null ||
      (typeof value.providerStatus === "string" &&
        value.providerStatus.length <= 128))
  );
}

function isStoredLegacySettlement(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.source === "legacyUnknown" &&
    isIsoTimestamp(value.observedAt)
  );
}

function isStoredPaymentHashList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (paymentHash) =>
          typeof paymentHash === "string" &&
          /^[0-9a-f]{64}$/u.test(paymentHash),
      ) &&
      new Set(value).size === value.length)
  );
}

function isStoredSlot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.slotNumber) ||
    Number(value.slotNumber) < 1 ||
    !isCanonicalPositiveDecimal(value.targetSats) ||
    (value.krwShare !== undefined &&
      !isCanonicalPositiveDecimal(value.krwShare)) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    (value.verificationDelayed !== undefined &&
      value.verificationDelayed !== true)
  ) {
    return false;
  }
  if (value.status === "generating") {
    return (
      value.invoice === undefined &&
      value.failure === undefined &&
      value.settledAt === undefined &&
      value.confirmedAt === undefined &&
      value.verificationDelayed === undefined &&
      value.settlementEvidence === undefined &&
      value.legacySettlement === undefined &&
      value.annotation === undefined
    );
  }
  if (value.status === "failed") {
    return (
      isRecord(value.failure) &&
      typeof value.failure.code === "string" &&
      typeof value.failure.message === "string" &&
      typeof value.failure.retryable === "boolean" &&
      (value.invoice === undefined || isStoredInvoice(value.invoice)) &&
      value.settledAt === undefined &&
      value.confirmedAt === undefined &&
      value.verificationDelayed === undefined &&
      value.settlementEvidence === undefined &&
      value.legacySettlement === undefined &&
      value.annotation === undefined
    );
  }
  if (
    value.status !== "pending" &&
    value.status !== "verifyingExpired" &&
    value.status !== "settled" &&
    value.status !== "expired" &&
    value.status !== "manuallyConfirmed" &&
    value.status !== "legacyReviewRequired"
  ) {
    return false;
  }
  if (!isStoredInvoice(value.invoice)) return false;
  if (value.failure !== undefined) return false;
  if (
    value.status === "verifyingExpired" &&
    (!isRecord(value.invoice) ||
      typeof value.invoice.verificationToken !== "string")
  ) {
    return false;
  }
  if (
    value.status === "settled" &&
    (!isIsoTimestamp(value.settledAt) ||
      !isStoredSettlementEvidence(value.settlementEvidence))
  ) {
    return false;
  }
  if (
    value.status === "manuallyConfirmed" &&
    !isIsoTimestamp(value.confirmedAt)
  ) {
    return false;
  }
  if (
    value.status === "legacyReviewRequired" &&
    !isStoredLegacySettlement(value.legacySettlement)
  ) {
    return false;
  }
  if (
    (value.status === "pending" ||
      value.status === "verifyingExpired" ||
      value.status === "expired") &&
    (value.settledAt !== undefined ||
      value.confirmedAt !== undefined ||
      value.settlementEvidence !== undefined ||
      value.legacySettlement !== undefined ||
      value.annotation !== undefined)
  ) {
    return false;
  }
  if (
    value.status === "settled" &&
    (value.confirmedAt !== undefined ||
      value.legacySettlement !== undefined ||
      value.verificationDelayed !== undefined)
  ) {
    return false;
  }
  if (
    value.status === "manuallyConfirmed" &&
    (value.settledAt !== undefined ||
      value.settlementEvidence !== undefined ||
      value.legacySettlement !== undefined ||
      value.verificationDelayed !== undefined)
  ) {
    return false;
  }
  if (
    value.status === "legacyReviewRequired" &&
    (value.settledAt !== undefined ||
      value.confirmedAt !== undefined ||
      value.settlementEvidence !== undefined ||
      value.verificationDelayed !== undefined)
  ) {
    return false;
  }
  return (
    (value.annotation === undefined || isStoredAnnotation(value.annotation)) &&
    (value.settlementEvidence === undefined ||
      (value.status === "settled" &&
        isStoredSettlementEvidence(value.settlementEvidence))) &&
    (value.legacySettlement === undefined ||
      (value.status === "legacyReviewRequired" &&
        isStoredLegacySettlement(value.legacySettlement)))
  );
}

function isStoredHistoricalInvoiceAttempt(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.slotNumber) ||
    Number(value.slotNumber) < 1 ||
    !isCanonicalPositiveDecimal(value.targetSats) ||
    (value.krwShare !== undefined &&
      !isCanonicalPositiveDecimal(value.krwShare)) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !isStoredInvoice(value.invoice) ||
    !isIsoTimestamp(value.retiredAt)
  ) {
    return false;
  }
  const hasNoCompletionEvidence =
    value.settledAt === undefined &&
    value.confirmedAt === undefined &&
    value.settlementEvidence === undefined &&
    value.legacySettlement === undefined;
  const hasNetworkEvidence =
    isIsoTimestamp(value.settledAt) &&
    value.confirmedAt === undefined &&
    isStoredSettlementEvidence(value.settlementEvidence) &&
    value.legacySettlement === undefined;
  const hasManualEvidence =
    value.settledAt === undefined &&
    isIsoTimestamp(value.confirmedAt) &&
    value.settlementEvidence === undefined &&
    value.legacySettlement === undefined;
  const hasLegacyEvidence =
    value.settledAt === undefined &&
    value.confirmedAt === undefined &&
    value.settlementEvidence === undefined &&
    isStoredLegacySettlement(value.legacySettlement);
  return (
    hasNoCompletionEvidence ||
    hasNetworkEvidence ||
    hasManualEvidence ||
    hasLegacyEvidence
  );
}

function isSettlementSession(value: unknown): value is SettlementSession {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.id === "string" &&
    (value.inputMode === "krw" || value.inputMode === "sats") &&
    isCanonicalPositiveDecimal(value.totalAmount) &&
    Number.isSafeInteger(value.totalPeople) &&
    Number(value.totalPeople) >= 2 &&
    Number(value.totalPeople) <= MAX_PEOPLE &&
    typeof value.excludePayer === "boolean" &&
    Number.isSafeInteger(value.invoiceCount) &&
    Number(value.invoiceCount) >= 1 &&
    Number(value.invoiceCount) <= MAX_PEOPLE &&
    typeof value.lightningAddress === "string" &&
    isIsoTimestamp(value.createdAt) &&
    (value.overallNote === undefined ||
      typeof value.overallNote === "string") &&
    (value.payerShareKrw === undefined ||
      isCanonicalPositiveDecimal(value.payerShareKrw)) &&
    (value.payerShareSats === undefined ||
      isCanonicalPositiveDecimal(value.payerShareSats)) &&
    (value.providerCommentStatus === undefined ||
      value.providerCommentStatus === "forwarded" ||
      value.providerCommentStatus === "unsupported" ||
      value.providerCommentStatus === "partial") &&
    (value.providerDomain === undefined ||
      typeof value.providerDomain === "string") &&
    isStoredPaymentHashList(value.issuedPaymentHashes) &&
    (value.invoiceHistory === undefined ||
      (Array.isArray(value.invoiceHistory) &&
        value.invoiceHistory.length <= MAX_INVOICE_HISTORY &&
        value.invoiceHistory.every(isStoredHistoricalInvoiceAttempt))) &&
    Array.isArray(value.participantNameCandidates) &&
    value.participantNameCandidates.every((name) => typeof name === "string") &&
    Array.isArray(value.slots) &&
    value.slots.length === Number(value.invoiceCount) &&
    value.slots.every(isStoredSlot)
  );
}

function assertSession(value: unknown): SettlementSession {
  if (!isSettlementSession(value)) {
    throw new Error("저장된 정산 형식이 올바르지 않습니다.");
  }
  const historicalAttempts = value.invoiceHistory ?? [];
  const allInvoiceAttempts = [
    ...value.slots.flatMap((slot) =>
      slot.invoice
        ? [
            {
              slotNumber: slot.slotNumber,
              attempt: slot.attempt,
              invoice: slot.invoice,
            },
          ]
        : [],
    ),
    ...historicalAttempts,
  ];
  if (
    value.slots.some((slot, index) => slot.slotNumber !== index + 1) ||
    new Set(allInvoiceAttempts.map((attempt) => attempt.invoice.paymentHash))
      .size !== allInvoiceAttempts.length ||
    new Set(
      allInvoiceAttempts.map(
        (attempt) => `${attempt.slotNumber}:${attempt.attempt}`,
      ),
    ).size !== allInvoiceAttempts.length ||
    historicalAttempts.some((attempt) => {
      const slot = value.slots[attempt.slotNumber - 1];
      return (
        !slot ||
        attempt.targetSats !== slot.targetSats ||
        attempt.krwShare !== slot.krwShare
      );
    }) ||
    (value.issuedPaymentHashes !== undefined &&
      allInvoiceAttempts.some(
        (attempt) =>
          !value.issuedPaymentHashes?.includes(attempt.invoice.paymentHash),
      ))
  ) {
    throw new Error("저장된 정산 식별자가 올바르지 않습니다.");
  }
  if (value.priceSnapshot !== undefined) {
    try {
      parsePriceSnapshotDto(value.priceSnapshot);
    } catch {
      throw new Error("저장된 가격 snapshot이 올바르지 않습니다.");
    }
  }
  if (value.inputMode === "krw") {
    if (
      value.priceSnapshot === undefined ||
      value.payerShareSats !== undefined ||
      value.slots.some((slot) => slot.krwShare === undefined)
    ) {
      throw new Error("저장된 원화 정산 형식이 올바르지 않습니다.");
    }
    const plan = createKrwSplitPlan(
      BigInt(value.totalAmount),
      value.totalPeople,
      value.excludePayer,
      BigInt(value.priceSnapshot.priceKrw),
    );
    if (
      value.invoiceCount !== plan.invoiceCount ||
      value.payerShareKrw !== plan.payerShareKrw?.toString() ||
      value.slots.some(
        (slot, index) =>
          slot.krwShare !== plan.invoiceShares[index]?.toString() ||
          slot.targetSats !== plan.targetSats[index]?.toString(),
      )
    ) {
      throw new Error("저장된 원화 정산 합계가 올바르지 않습니다.");
    }
  } else {
    if (
      value.priceSnapshot !== undefined ||
      value.payerShareKrw !== undefined ||
      value.slots.some((slot) => slot.krwShare !== undefined)
    ) {
      throw new Error("저장된 sats 정산 형식이 올바르지 않습니다.");
    }
    const plan = createSatsSplitPlan(
      BigInt(value.totalAmount),
      value.totalPeople,
      value.excludePayer,
    );
    if (
      value.invoiceCount !== plan.invoiceCount ||
      value.payerShareSats !== plan.payerShareSats?.toString() ||
      value.slots.some(
        (slot, index) =>
          slot.targetSats !== plan.invoiceShares[index]?.toString(),
      )
    ) {
      throw new Error("저장된 sats 정산 합계가 올바르지 않습니다.");
    }
  }
  return value;
}

export function serializeSession(session: SettlementSession): string {
  return JSON.stringify(session);
}

function serializeStoredSession(session: SettlementSession): string {
  return JSON.stringify({
    ...session,
    slots: session.slots.map((slot) =>
      slot.status === "verifyingExpired"
        ? { ...slot, status: "pending" as const }
        : slot,
    ),
  });
}

function migrateInvoice(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const {
    paymentRequest: _legacyPaymentRequest,
    verificationToken,
    ...invoice
  } = value;
  void _legacyPaymentRequest;
  return typeof verificationToken === "string" &&
    CURRENT_VERIFICATION_TOKEN.test(verificationToken)
    ? { ...invoice, verificationToken }
    : invoice;
}

function migrateLegacySession(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.slots)) return value;
  const isLegacyV1 = value.version === 1;
  const { paymentDescriptionStatus: _legacyDescriptionStatus, ...session } =
    value;
  void _legacyDescriptionStatus;
  const slots = value.slots.map((slot) => {
    if (!isRecord(slot)) return slot;
    const migratedInvoice =
      slot.invoice === undefined ? undefined : migrateInvoice(slot.invoice);
    if (isLegacyV1 && slot.status === "queued") {
      return {
        slotNumber: slot.slotNumber,
        targetSats: slot.targetSats,
        ...(slot.krwShare === undefined ? {} : { krwShare: slot.krwShare }),
        attempt: slot.attempt,
        status: "failed",
        failure: {
          code: "LEGACY_QUEUE_REMOVED",
          message: "중단된 결제 요청을 다시 만들 수 있습니다.",
          retryable: true,
        },
      };
    }
    const migratedSlot =
      migratedInvoice === undefined
        ? slot
        : { ...slot, invoice: migratedInvoice };
    if (
      isLegacyV1 &&
      migratedSlot.status === "settled" &&
      !isStoredSettlementEvidence(migratedSlot.settlementEvidence)
    ) {
      const {
        settledAt,
        settlementEvidence: _legacyEvidence,
        verificationDelayed: _legacyVerificationDelay,
        ...remaining
      } = migratedSlot;
      void _legacyEvidence;
      void _legacyVerificationDelay;
      return {
        ...remaining,
        status: "legacyReviewRequired",
        legacySettlement: {
          source: "legacyUnknown",
          observedAt: isIsoTimestamp(settledAt) ? settledAt : value.createdAt,
        },
      };
    }
    return migratedSlot;
  });
  const invoiceHistory = Array.isArray(value.invoiceHistory)
    ? value.invoiceHistory.map((attempt) => {
        if (!isRecord(attempt)) return attempt;
        const migratedAttempt =
          attempt.invoice === undefined
            ? attempt
            : { ...attempt, invoice: migrateInvoice(attempt.invoice) };
        if (
          isLegacyV1 &&
          migratedAttempt.settledAt !== undefined &&
          !isStoredSettlementEvidence(migratedAttempt.settlementEvidence)
        ) {
          const {
            settledAt: _legacySettledAt,
            settlementEvidence: _legacyEvidence,
            ...remaining
          } = migratedAttempt;
          void _legacyEvidence;
          return {
            ...remaining,
            legacySettlement: {
              source: "legacyUnknown",
              observedAt: isIsoTimestamp(_legacySettledAt)
                ? _legacySettledAt
                : value.createdAt,
            },
          };
        }
        return migratedAttempt;
      })
    : value.invoiceHistory;
  return {
    ...session,
    ...(isLegacyV1 ? { version: 2 } : {}),
    slots,
    ...(invoiceHistory === undefined ? {} : { invoiceHistory }),
  };
}

export function restoreSession(serialized: string): SettlementSession {
  const parsed: unknown = JSON.parse(serialized);
  return assertSession(migrateLegacySession(parsed));
}

export function recoverInterruptedSession(
  session: SettlementSession,
): SettlementSession {
  let changed = false;
  const slots = session.slots.map((slot) => {
    if (slot.invoice?.awaitingPersistence === true) {
      changed = true;
      const { awaitingPersistence: _awaitingPersistence, ...invoice } =
        slot.invoice;
      void _awaitingPersistence;
      return { ...slot, invoice };
    }
    if (slot.status === "generating") {
      changed = true;
      return {
        ...slot,
        status: "failed" as const,
        failure: {
          code: "GENERATION_INTERRUPTED",
          message: "중단된 결제 요청 생성을 다시 시도할 수 있습니다.",
          retryable: true,
        },
      };
    }
    return slot;
  });
  return changed ? { ...session, slots } : session;
}

function openSettlementDatabase(): ReturnType<typeof openDB> {
  if (databasePromise) return databasePromise;

  const opening = openDB(DATABASE_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME);
    },
    blocking() {
      if (databasePromise === opening) databasePromise = undefined;
      void opening.then((database) => database.close());
    },
    terminated() {
      if (databasePromise === opening) databasePromise = undefined;
    },
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

function serializeDatabaseOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = databaseOperationTail.then(operation);
  databaseOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function saveActiveSession(session: SettlementSession): Promise<void> {
  // The short final-verification state is derived from invoice expiry after
  // reload, so it is persisted as the stable pending state.
  const operationEpoch = persistenceEpoch;
  return serializeDatabaseOperation(async () => {
    assertSession(session);
    const serialized = serializeStoredSession(session);
    if (operationEpoch !== persistenceEpoch) return;
    const database = await openSettlementDatabase();
    if (operationEpoch !== persistenceEpoch) return;
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const storedRevision = parseStoredRevision(
      await transaction.store.get(REVISION_KEY),
    );
    const storedSession = await transaction.store.get(ACTIVE_SESSION_KEY);
    if (knownRevision === undefined) knownRevision = storedRevision;
    if (storedRevision !== knownRevision) {
      if (storedSession === serialized) {
        knownRevision = storedRevision;
        await transaction.done;
        return;
      }
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new SessionPersistenceConflictError();
    }
    if (storedSession === serialized) {
      await transaction.done;
      return;
    }
    const nextRevision = storedRevision + 1;
    await transaction.store.put(serialized, ACTIVE_SESSION_KEY);
    await transaction.store.put(nextRevision, REVISION_KEY);
    await transaction.done;
    knownRevision = nextRevision;
  });
}

export function loadActiveSession(): Promise<SettlementSession | null> {
  return serializeDatabaseOperation(async () => {
    const database = await openSettlementDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    let revision = parseStoredRevision(
      await transaction.store.get(REVISION_KEY),
    );
    let sourceKey = ACTIVE_SESSION_KEY;
    let stored: unknown = await transaction.store.get(ACTIVE_SESSION_KEY);
    if (typeof stored !== "string") {
      sourceKey = LEGACY_ACTIVE_SESSION_KEY;
      stored = await transaction.store.get(LEGACY_ACTIVE_SESSION_KEY);
    }
    if (typeof stored !== "string") {
      await transaction.done;
      knownRevision = revision;
      return null;
    }
    let restored: SettlementSession;
    try {
      restored = restoreSession(stored);
    } catch {
      try {
        await transaction.store.put(stored, QUARANTINED_SESSION_KEY);
        await transaction.store.delete(sourceKey);
        revision += 1;
        await transaction.store.put(revision, REVISION_KEY);
        await transaction.done;
        knownRevision = revision;
      } catch {
        transaction.abort();
        await transaction.done.catch(() => undefined);
      }
      return null;
    }

    const migrated = serializeStoredSession(restored);
    if (sourceKey !== ACTIVE_SESSION_KEY || migrated !== stored) {
      await transaction.store.put(migrated, ACTIVE_SESSION_KEY);
      if (sourceKey !== ACTIVE_SESSION_KEY) {
        await transaction.store.delete(sourceKey);
      }
      revision += 1;
      await transaction.store.put(revision, REVISION_KEY);
    }
    await transaction.done;
    knownRevision = revision;
    return restored;
  });
}

export function clearActiveSession(expectedSessionId?: string): Promise<void> {
  persistenceEpoch += 1;
  return serializeDatabaseOperation(async () => {
    const database = await openSettlementDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const storedRevision = parseStoredRevision(
      await transaction.store.get(REVISION_KEY),
    );
    const storedActive = await transaction.store.get(ACTIVE_SESSION_KEY);
    const storedLegacy = await transaction.store.get(LEGACY_ACTIVE_SESSION_KEY);
    if (
      expectedSessionId !== undefined &&
      (knownRevision === undefined ||
        storedRevision !== knownRevision ||
        ([storedActive, storedLegacy].some(
          (value) => typeof value === "string",
        ) &&
          ![storedActive, storedLegacy].some(
            (value) => storedSessionId(value) === expectedSessionId,
          )))
    ) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new SessionPersistenceConflictError();
    }
    await transaction.store.delete(ACTIVE_SESSION_KEY);
    await transaction.store.delete(LEGACY_ACTIVE_SESSION_KEY);
    await transaction.store.delete(QUARANTINED_SESSION_KEY);
    const nextRevision = storedRevision + 1;
    await transaction.store.put(nextRevision, REVISION_KEY);
    await transaction.done;
    knownRevision = nextRevision;
  });
}
