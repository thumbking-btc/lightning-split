import { openDB } from "idb";

import { parsePriceSnapshotDto } from "../api/serialization";
import { createKrwSplitPlan, createSatsSplitPlan } from "../domain/money";
import { isRecord } from "../infrastructure/validation";
import type { SettlementSession } from "./types";

const DATABASE_NAME = "lightning-split";
const STORE_NAME = "settlements";
const ACTIVE_SESSION_KEY = "active";
const LEGACY_UUID_VERIFICATION_TOKEN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

let databasePromise: ReturnType<typeof openDB> | undefined;
let databaseOperationTail: Promise<void> = Promise.resolve();
let persistenceEpoch = 0;

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
        /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u.test(
          value.verificationToken,
        )))
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
    Number(value.attempt) < 1
  ) {
    return false;
  }
  if (value.status === "generating" || value.status === "queued")
    return value.invoice === undefined;
  if (value.status === "failed") {
    return (
      isRecord(value.failure) &&
      typeof value.failure.code === "string" &&
      typeof value.failure.message === "string" &&
      typeof value.failure.retryable === "boolean"
    );
  }
  if (
    value.status !== "pending" &&
    value.status !== "verifyingExpired" &&
    value.status !== "settled" &&
    value.status !== "expired" &&
    value.status !== "manuallyConfirmed"
  ) {
    return false;
  }
  if (!isStoredInvoice(value.invoice)) return false;
  if (
    value.status === "verifyingExpired" &&
    (!isRecord(value.invoice) ||
      typeof value.invoice.verificationToken !== "string")
  ) {
    return false;
  }
  if (value.status === "settled" && !isIsoTimestamp(value.settledAt)) {
    return false;
  }
  if (
    value.status === "manuallyConfirmed" &&
    !isIsoTimestamp(value.confirmedAt)
  ) {
    return false;
  }
  return value.annotation === undefined || isStoredAnnotation(value.annotation);
}

function isSettlementSession(value: unknown): value is SettlementSession {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    (value.inputMode === "krw" || value.inputMode === "sats") &&
    isCanonicalPositiveDecimal(value.totalAmount) &&
    Number.isSafeInteger(value.totalPeople) &&
    Number(value.totalPeople) >= 2 &&
    Number(value.totalPeople) <= 10 &&
    typeof value.excludePayer === "boolean" &&
    Number.isSafeInteger(value.invoiceCount) &&
    Number(value.invoiceCount) >= 1 &&
    Number(value.invoiceCount) <= 10 &&
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
    (value.paymentDescriptionStatus === undefined ||
      value.paymentDescriptionStatus === "embedded" ||
      value.paymentDescriptionStatus === "notEmbedded" ||
      value.paymentDescriptionStatus === "partial") &&
    (value.providerDomain === undefined ||
      typeof value.providerDomain === "string") &&
    isStoredPaymentHashList(value.issuedPaymentHashes) &&
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
  if (
    value.slots.some((slot, index) => slot.slotNumber !== index + 1) ||
    new Set(
      value.slots.flatMap((slot) =>
        slot.invoice ? [slot.invoice.paymentHash] : [],
      ),
    ).size !== value.slots.filter((slot) => slot.invoice).length ||
    (value.issuedPaymentHashes !== undefined &&
      value.slots.some(
        (slot) =>
          slot.invoice !== undefined &&
          !value.issuedPaymentHashes?.includes(slot.invoice.paymentHash),
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

function migrateLegacyVerificationTokens(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.slots)) return value;

  let changed = false;
  const slots = value.slots.map((slot) => {
    if (!isRecord(slot) || !isRecord(slot.invoice)) return slot;
    const verificationToken = slot.invoice.verificationToken;
    if (
      typeof verificationToken !== "string" ||
      !LEGACY_UUID_VERIFICATION_TOKEN.test(verificationToken)
    ) {
      return slot;
    }

    changed = true;
    const { verificationToken: _legacyToken, ...invoice } = slot.invoice;
    void _legacyToken;
    return { ...slot, invoice };
  });

  return changed ? { ...value, slots } : value;
}

export function restoreSession(serialized: string): SettlementSession {
  const parsed: unknown = JSON.parse(serialized);
  return assertSession(migrateLegacyVerificationTokens(parsed));
}

export function recoverInterruptedSession(
  session: SettlementSession,
): SettlementSession {
  let changed = false;
  const slots = session.slots.map((slot) => {
    if (slot.status !== "generating") return slot;
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
  // Schema v1 must remain readable by the previous production PWA. The new
  // client derives the short final-verification state from invoice expiry.
  const serialized = serializeStoredSession(session);
  const operationEpoch = persistenceEpoch;
  return serializeDatabaseOperation(async () => {
    if (operationEpoch !== persistenceEpoch) return;
    const database = await openSettlementDatabase();
    if (operationEpoch !== persistenceEpoch) return;
    await database.put(STORE_NAME, serialized, ACTIVE_SESSION_KEY);
  });
}

export function loadActiveSession(): Promise<SettlementSession | null> {
  return serializeDatabaseOperation(async () => {
    const database = await openSettlementDatabase();
    const stored: unknown = await database.get(STORE_NAME, ACTIVE_SESSION_KEY);
    if (typeof stored !== "string") return null;
    let restored: SettlementSession;
    try {
      restored = restoreSession(stored);
    } catch {
      return null;
    }

    const migrated = serializeStoredSession(restored);
    if (migrated !== stored) {
      try {
        await database.put(STORE_NAME, migrated, ACTIVE_SESSION_KEY);
      } catch {
        // Keep the valid in-memory recovery even when migration persistence fails.
      }
    }
    return restored;
  });
}

export function clearActiveSession(): Promise<void> {
  persistenceEpoch += 1;
  return serializeDatabaseOperation(async () => {
    const database = await openSettlementDatabase();
    await database.delete(STORE_NAME, ACTIVE_SESSION_KEY);
  });
}
