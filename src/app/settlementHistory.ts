import { openDB } from "idb";

import type { SettlementResponseDto } from "../api/contracts";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import type { ClientSlot, SettlementSession } from "./types";

const DATABASE_NAME = "lightning-split-history";
const DATABASE_VERSION = 2;
const RECORD_STORE_NAME = "records";
const TRACKING_STORE_NAME = "late-payment-trackers";
const MAX_HISTORY_RECORDS = 200;
const MAX_TRACKING_TARGETS_PER_PASS = 60;
const TRACKING_SELECTION_PERIOD_MS = 60_000;

let databasePromise: ReturnType<typeof openDB> | undefined;
let databaseOperationTail: Promise<void> = Promise.resolve();

export type SettlementHistorySlotStatus =
  | "settled"
  | "manuallyConfirmed"
  | "legacyReviewRequired"
  | "expired"
  | "pending"
  | "failed";

export interface SettlementHistorySlot {
  readonly slotNumber: number;
  readonly displayName?: string;
  readonly krwShare?: string;
  readonly usdCentsShare?: string;
  readonly targetSats: string;
  readonly status: SettlementHistorySlotStatus;
  readonly completedAt?: string;
  readonly invoiceExpiresAt?: string;
  readonly latePaymentWarningAt?: string;
}

export interface SettlementHistoryRecord {
  readonly version: 1;
  readonly id: string;
  readonly inputMode: "krw" | "usd" | "sats";
  readonly totalAmount: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly invoiceCount: number;
  readonly overallNote?: string;
  readonly payerShareKrw?: string;
  readonly payerShareUsdCents?: string;
  readonly payerShareSats?: string;
  readonly createdAt: string;
  readonly archivedAt: string;
  readonly slots: readonly SettlementHistorySlot[];
}

type TrackingAttemptKind = "manual-current" | "retired";

interface SettlementTrackingAttempt {
  readonly kind: TrackingAttemptKind;
  readonly slotNumber: number;
  readonly attempt: number;
  readonly paymentHash: string;
  readonly bolt11: string;
  readonly verificationToken: string;
  readonly trackingExpiresAt: string;
}

interface SettlementTrackingRecord {
  readonly version: 1;
  readonly sessionId: string;
  readonly attempts: readonly SettlementTrackingAttempt[];
}

export interface LateSettlementTrackingTarget extends SettlementTrackingAttempt {
  readonly sessionId: string;
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

function openHistoryDatabase(): ReturnType<typeof openDB> {
  if (databasePromise) return databasePromise;

  const opening = openDB(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(RECORD_STORE_NAME)) {
        database.createObjectStore(RECORD_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(TRACKING_STORE_NAME)) {
        database.createObjectStore(TRACKING_STORE_NAME, {
          keyPath: "sessionId",
        });
      }
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

function normalizeSlotStatus(slot: ClientSlot): SettlementHistorySlotStatus {
  if (slot.status === "settled") return "settled";
  if (slot.status === "manuallyConfirmed") return "manuallyConfirmed";
  if (slot.status === "legacyReviewRequired") return "legacyReviewRequired";
  if (slot.status === "expired") return "expired";
  if (slot.status === "failed") return "failed";
  return "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value);
}

function isHistorySlot(value: unknown): value is SettlementHistorySlot {
  if (!isRecord(value)) return false;
  const status = value.status;
  return (
    Number.isSafeInteger(value.slotNumber) &&
    Number(value.slotNumber) > 0 &&
    (value.displayName === undefined ||
      typeof value.displayName === "string") &&
    (value.krwShare === undefined ||
      isCanonicalPositiveDecimal(value.krwShare)) &&
    (value.usdCentsShare === undefined ||
      isCanonicalPositiveDecimal(value.usdCentsShare)) &&
    isCanonicalPositiveDecimal(value.targetSats) &&
    (status === "settled" ||
      status === "manuallyConfirmed" ||
      status === "legacyReviewRequired" ||
      status === "expired" ||
      status === "pending" ||
      status === "failed") &&
    (value.completedAt === undefined || isIsoTimestamp(value.completedAt)) &&
    (value.invoiceExpiresAt === undefined ||
      isIsoTimestamp(value.invoiceExpiresAt)) &&
    (value.latePaymentWarningAt === undefined ||
      isIsoTimestamp(value.latePaymentWarningAt))
  );
}

function isHistoryRecord(value: unknown): value is SettlementHistoryRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.inputMode === "krw" ||
      value.inputMode === "usd" ||
      value.inputMode === "sats") &&
    isCanonicalPositiveDecimal(value.totalAmount) &&
    Number.isSafeInteger(value.totalPeople) &&
    Number(value.totalPeople) >= 2 &&
    typeof value.excludePayer === "boolean" &&
    Number.isSafeInteger(value.invoiceCount) &&
    Number(value.invoiceCount) >= 1 &&
    (value.overallNote === undefined ||
      typeof value.overallNote === "string") &&
    (value.payerShareKrw === undefined ||
      isCanonicalPositiveDecimal(value.payerShareKrw)) &&
    (value.payerShareUsdCents === undefined ||
      isCanonicalPositiveDecimal(value.payerShareUsdCents)) &&
    (value.payerShareSats === undefined ||
      isCanonicalPositiveDecimal(value.payerShareSats)) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.archivedAt) &&
    Array.isArray(value.slots) &&
    value.slots.length === Number(value.invoiceCount) &&
    value.slots.every(isHistorySlot)
  );
}

function isTrackingAttempt(value: unknown): value is SettlementTrackingAttempt {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "manual-current" || value.kind === "retired") &&
    Number.isSafeInteger(value.slotNumber) &&
    Number(value.slotNumber) > 0 &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0 &&
    typeof value.paymentHash === "string" &&
    /^[0-9a-f]{64}$/u.test(value.paymentHash) &&
    typeof value.bolt11 === "string" &&
    /^lnbc[0123456789acdefghjklmnpqrstuvwxyz]+$/u.test(value.bolt11) &&
    typeof value.verificationToken === "string" &&
    /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u.test(
      value.verificationToken,
    ) &&
    isIsoTimestamp(value.trackingExpiresAt)
  );
}

function isTrackingRecord(value: unknown): value is SettlementTrackingRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isTrackingAttempt)
  );
}

export function isCompletedHistorySlot(slot: SettlementHistorySlot): boolean {
  return slot.status === "settled" || slot.status === "manuallyConfirmed";
}

export function isSettlementComplete(
  session: Pick<SettlementSession, "slots">,
): boolean {
  return (
    session.slots.length > 0 &&
    session.slots.every(
      (slot) =>
        slot.status === "settled" || slot.status === "manuallyConfirmed",
    )
  );
}

function trackingExpiresAt(expiresAt: string): string {
  return new Date(
    Date.parse(expiresAt) +
      DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000,
  ).toISOString();
}

function alreadyPaidHistoricalSlots(session: SettlementSession): Set<number> {
  return new Set(
    (session.invoiceHistory ?? []).flatMap((attempt) =>
      attempt.settledAt !== undefined || attempt.confirmedAt !== undefined
        ? [attempt.slotNumber]
        : [],
    ),
  );
}

export function createSettlementHistoryRecord(
  session: SettlementSession,
  archivedAt = new Date().toISOString(),
): SettlementHistoryRecord {
  const historicalPaidSlots = alreadyPaidHistoricalSlots(session);
  return {
    version: 1,
    id: session.id,
    inputMode: session.inputMode,
    totalAmount: session.totalAmount,
    totalPeople: session.totalPeople,
    excludePayer: session.excludePayer,
    invoiceCount: session.invoiceCount,
    ...(session.overallNote ? { overallNote: session.overallNote } : {}),
    ...(session.payerShareKrw ? { payerShareKrw: session.payerShareKrw } : {}),
    ...(session.payerShareUsdCents
      ? { payerShareUsdCents: session.payerShareUsdCents }
      : {}),
    ...(session.payerShareSats
      ? { payerShareSats: session.payerShareSats }
      : {}),
    createdAt: session.createdAt,
    archivedAt,
    slots: session.slots.map((slot) => ({
      slotNumber: slot.slotNumber,
      ...(slot.annotation?.displayName
        ? { displayName: slot.annotation.displayName }
        : {}),
      ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),
      ...(slot.usdCentsShare ? { usdCentsShare: slot.usdCentsShare } : {}),
      targetSats: slot.targetSats,
      status: normalizeSlotStatus(slot),
      ...(slot.settledAt || slot.confirmedAt
        ? { completedAt: slot.settledAt ?? slot.confirmedAt }
        : {}),
      ...(slot.invoice?.expiresAt
        ? { invoiceExpiresAt: slot.invoice.expiresAt }
        : {}),
      ...(historicalPaidSlots.has(slot.slotNumber)
        ? { latePaymentWarningAt: archivedAt }
        : {}),
    })),
  };
}

function createTrackingRecord(
  session: SettlementSession,
  nowMs = Date.now(),
): SettlementTrackingRecord | undefined {
  const attempts: SettlementTrackingAttempt[] = [];

  for (const slot of session.slots) {
    const invoice = slot.invoice;
    if (slot.status !== "manuallyConfirmed" || !invoice?.verificationToken) {
      continue;
    }
    const deadline = Date.parse(trackingExpiresAt(invoice.expiresAt));
    if (deadline <= nowMs) continue;
    attempts.push({
      kind: "manual-current",
      slotNumber: slot.slotNumber,
      attempt: slot.attempt,
      paymentHash: invoice.paymentHash,
      bolt11: invoice.bolt11,
      verificationToken: invoice.verificationToken,
      trackingExpiresAt: new Date(deadline).toISOString(),
    });
  }

  for (const historical of session.invoiceHistory ?? []) {
    const invoice = historical.invoice;
    if (
      historical.settledAt !== undefined ||
      historical.confirmedAt !== undefined ||
      !invoice.verificationToken
    ) {
      continue;
    }
    const deadline = Date.parse(trackingExpiresAt(invoice.expiresAt));
    if (deadline <= nowMs) continue;
    attempts.push({
      kind: "retired",
      slotNumber: historical.slotNumber,
      attempt: historical.attempt,
      paymentHash: invoice.paymentHash,
      bolt11: invoice.bolt11,
      verificationToken: invoice.verificationToken,
      trackingExpiresAt: new Date(deadline).toISOString(),
    });
  }

  if (attempts.length === 0) return undefined;
  return { version: 1, sessionId: session.id, attempts };
}

export function archiveCompletedSettlement(
  session: SettlementSession,
): Promise<SettlementHistoryRecord> {
  if (!isSettlementComplete(session)) {
    return Promise.reject(
      new Error(
        "정산이 아직 진행 중입니다. 모든 결제를 확인한 뒤 기록으로 완료하십시오.",
      ),
    );
  }
  const archivedAt = new Date().toISOString();
  const record = createSettlementHistoryRecord(session, archivedAt);
  const tracker = createTrackingRecord(session);

  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(
      [RECORD_STORE_NAME, TRACKING_STORE_NAME],
      "readwrite",
    );
    const records = transaction.objectStore(RECORD_STORE_NAME);
    const tracking = transaction.objectStore(TRACKING_STORE_NAME);
    await records.put(record);
    if (tracker) await tracking.put(tracker);
    else await tracking.delete(record.id);

    const stored = await records.getAll();
    const validRecords = stored
      .filter(isHistoryRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const invalid of stored.filter((value) => !isHistoryRecord(value))) {
      if (isRecord(invalid) && typeof invalid.id === "string") {
        await records.delete(invalid.id);
        await tracking.delete(invalid.id);
      }
    }
    for (const oldRecord of validRecords.slice(MAX_HISTORY_RECORDS)) {
      await records.delete(oldRecord.id);
      await tracking.delete(oldRecord.id);
    }
    await transaction.done;
    return record;
  });
}

export function listSettlementHistory(): Promise<SettlementHistoryRecord[]> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const stored = await database.getAll(RECORD_STORE_NAME);
    return stored
      .filter(isHistoryRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function selectLateSettlementTrackingTargets(
  targets: readonly LateSettlementTrackingTarget[],
  nowMs: number,
): LateSettlementTrackingTarget[] {
  const ordered = [...targets].sort((a, b) => {
    const expiryOrder = a.trackingExpiresAt.localeCompare(b.trackingExpiresAt);
    if (expiryOrder !== 0) return expiryOrder;
    return `${a.sessionId}:${a.slotNumber}:${a.attempt}:${a.paymentHash}`.localeCompare(
      `${b.sessionId}:${b.slotNumber}:${b.attempt}:${b.paymentHash}`,
    );
  });
  if (ordered.length <= MAX_TRACKING_TARGETS_PER_PASS) return ordered;

  const period = Math.floor(nowMs / TRACKING_SELECTION_PERIOD_MS);
  const start = (period * MAX_TRACKING_TARGETS_PER_PASS) % ordered.length;
  return Array.from(
    { length: MAX_TRACKING_TARGETS_PER_PASS },
    (_, offset) => ordered[(start + offset) % ordered.length]!,
  );
}

export function listLateSettlementTrackingTargets(
  nowMs = Date.now(),
): Promise<LateSettlementTrackingTarget[]> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(TRACKING_STORE_NAME, "readwrite");
    const store = transaction.store;
    const raw = await store.getAll();
    const targets: LateSettlementTrackingTarget[] = [];

    for (const value of raw) {
      if (!isTrackingRecord(value)) {
        if (isRecord(value) && typeof value.sessionId === "string") {
          await store.delete(value.sessionId);
        }
        continue;
      }
      const activeAttempts = value.attempts.filter(
        (attempt) => Date.parse(attempt.trackingExpiresAt) > nowMs,
      );
      if (activeAttempts.length === 0) {
        await store.delete(value.sessionId);
        continue;
      }
      if (activeAttempts.length !== value.attempts.length) {
        await store.put({ ...value, attempts: activeAttempts });
      }
      for (const attempt of activeAttempts) {
        targets.push({ sessionId: value.sessionId, ...attempt });
      }
    }
    await transaction.done;
    return selectLateSettlementTrackingTargets(targets, nowMs);
  });
}

function sameTrackingAttempt(
  attempt: SettlementTrackingAttempt,
  target: LateSettlementTrackingTarget,
): boolean {
  return (
    attempt.kind === target.kind &&
    attempt.slotNumber === target.slotNumber &&
    attempt.attempt === target.attempt &&
    attempt.paymentHash === target.paymentHash &&
    attempt.verificationToken === target.verificationToken
  );
}

export function applyLateSettlementTrackingResponse(
  target: LateSettlementTrackingTarget,
  response: SettlementResponseDto,
): Promise<boolean> {
  if (response.status === "unsettled" || response.status === "notAvailable") {
    return Promise.resolve(false);
  }

  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(
      [RECORD_STORE_NAME, TRACKING_STORE_NAME],
      "readwrite",
    );
    const records = transaction.objectStore(RECORD_STORE_NAME);
    const tracking = transaction.objectStore(TRACKING_STORE_NAME);
    const rawTracker = await tracking.get(target.sessionId);
    if (!isTrackingRecord(rawTracker)) {
      if (rawTracker !== undefined) await tracking.delete(target.sessionId);
      await transaction.done;
      return false;
    }
    if (
      !rawTracker.attempts.some((attempt) =>
        sameTrackingAttempt(attempt, target),
      )
    ) {
      await transaction.done;
      return false;
    }

    if (response.status === "settled") {
      const rawRecord = await records.get(target.sessionId);
      if (isHistoryRecord(rawRecord)) {
        const checkedAt = response.checkedAt;
        const updated: SettlementHistoryRecord = {
          ...rawRecord,
          slots: rawRecord.slots.map((slot) => {
            if (slot.slotNumber !== target.slotNumber) return slot;
            if (target.kind === "manual-current") {
              return {
                ...slot,
                status: "settled",
                completedAt: checkedAt,
              };
            }
            return { ...slot, latePaymentWarningAt: checkedAt };
          }),
        };
        await records.put(updated);
      }
    }

    const attempts = rawTracker.attempts.filter(
      (attempt) => !sameTrackingAttempt(attempt, target),
    );
    if (attempts.length === 0) await tracking.delete(target.sessionId);
    else await tracking.put({ ...rawTracker, attempts });
    await transaction.done;
    return true;
  });
}

export function deleteSettlementHistoryRecord(id: string): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(
      [RECORD_STORE_NAME, TRACKING_STORE_NAME],
      "readwrite",
    );
    await transaction.objectStore(RECORD_STORE_NAME).delete(id);
    await transaction.objectStore(TRACKING_STORE_NAME).delete(id);
    await transaction.done;
  });
}

export function clearSettlementHistory(): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(
      [RECORD_STORE_NAME, TRACKING_STORE_NAME],
      "readwrite",
    );
    await transaction.objectStore(RECORD_STORE_NAME).clear();
    await transaction.objectStore(TRACKING_STORE_NAME).clear();
    await transaction.done;
  });
}
