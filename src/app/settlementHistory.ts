import { openDB } from "idb";

import type { ClientSlot, SettlementSession } from "./types";

const DATABASE_NAME = "lightning-split-history";
const STORE_NAME = "records";
const MAX_HISTORY_RECORDS = 200;

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
  readonly targetSats: string;
  readonly status: SettlementHistorySlotStatus;
  readonly completedAt?: string;
  readonly invoiceExpiresAt?: string;
}

export interface SettlementHistoryRecord {
  readonly version: 1;
  readonly id: string;
  readonly inputMode: "krw" | "sats";
  readonly totalAmount: string;
  readonly totalPeople: number;
  readonly excludePayer: boolean;
  readonly invoiceCount: number;
  readonly overallNote?: string;
  readonly payerShareKrw?: string;
  readonly payerShareSats?: string;
  readonly createdAt: string;
  readonly archivedAt: string;
  readonly slots: readonly SettlementHistorySlot[];
}

function serializeDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = databaseOperationTail.then(operation);
  databaseOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function openHistoryDatabase(): ReturnType<typeof openDB> {
  if (databasePromise) return databasePromise;

  const opening = openDB(DATABASE_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
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

export function createSettlementHistoryRecord(
  session: SettlementSession,
  archivedAt = new Date().toISOString(),
): SettlementHistoryRecord {
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
      targetSats: slot.targetSats,
      status: normalizeSlotStatus(slot),
      ...(slot.settledAt || slot.confirmedAt
        ? { completedAt: slot.settledAt ?? slot.confirmedAt }
        : {}),
      ...(slot.invoice?.expiresAt
        ? { invoiceExpiresAt: slot.invoice.expiresAt }
        : {}),
    })),
  };
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
    (value.displayName === undefined || typeof value.displayName === "string") &&
    (value.krwShare === undefined ||
      isCanonicalPositiveDecimal(value.krwShare)) &&
    isCanonicalPositiveDecimal(value.targetSats) &&
    (status === "settled" ||
      status === "manuallyConfirmed" ||
      status === "legacyReviewRequired" ||
      status === "expired" ||
      status === "pending" ||
      status === "failed") &&
    (value.completedAt === undefined || isIsoTimestamp(value.completedAt)) &&
    (value.invoiceExpiresAt === undefined ||
      isIsoTimestamp(value.invoiceExpiresAt))
  );
}

function isHistoryRecord(value: unknown): value is SettlementHistoryRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.inputMode === "krw" || value.inputMode === "sats") &&
    isCanonicalPositiveDecimal(value.totalAmount) &&
    Number.isSafeInteger(value.totalPeople) &&
    Number(value.totalPeople) >= 2 &&
    typeof value.excludePayer === "boolean" &&
    Number.isSafeInteger(value.invoiceCount) &&
    Number(value.invoiceCount) >= 1 &&
    (value.overallNote === undefined || typeof value.overallNote === "string") &&
    (value.payerShareKrw === undefined ||
      isCanonicalPositiveDecimal(value.payerShareKrw)) &&
    (value.payerShareSats === undefined ||
      isCanonicalPositiveDecimal(value.payerShareSats)) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.archivedAt) &&
    Array.isArray(value.slots) &&
    value.slots.length === Number(value.invoiceCount) &&
    value.slots.every(isHistorySlot)
  );
}

export function isCompletedHistorySlot(slot: SettlementHistorySlot): boolean {
  return slot.status === "settled" || slot.status === "manuallyConfirmed";
}

export function archiveSettlementSession(
  session: SettlementSession,
): Promise<SettlementHistoryRecord> {
  const record = createSettlementHistoryRecord(session);
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    await transaction.store.put(record);

    const stored = await transaction.store.getAll();
    const validRecords = stored.filter(isHistoryRecord).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const invalid of stored.filter((value) => !isHistoryRecord(value))) {
      if (isRecord(invalid) && typeof invalid.id === "string") {
        await transaction.store.delete(invalid.id);
      }
    }
    for (const oldRecord of validRecords.slice(MAX_HISTORY_RECORDS)) {
      await transaction.store.delete(oldRecord.id);
    }
    await transaction.done;
    return record;
  });
}

export function listSettlementHistory(): Promise<SettlementHistoryRecord[]> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const stored = await database.getAll(STORE_NAME);
    return stored
      .filter(isHistoryRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function deleteSettlementHistoryRecord(id: string): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    await database.delete(STORE_NAME, id);
  });
}

export function clearSettlementHistory(): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    await database.clear(STORE_NAME);
  });
}
