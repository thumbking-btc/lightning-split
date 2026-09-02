import { openDB } from "idb";

import { fetchSettlement } from "./api";
import { duplicateSettledSlotNumbers } from "./session";
import {
  settlementPollingTargets,
  transitionAfterSettlementCheck,
} from "./polling";
import type { ClientSlot, SettlementSession } from "./types";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";

const DATABASE_NAME = "lightning-split-history";
const DATABASE_VERSION = 2;
const RECORD_STORE = "records";
const TRACKER_STORE = "trackers";
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
  readonly usdCentsShare?: string;
  readonly targetSats: string;
  readonly status: SettlementHistorySlotStatus;
  readonly completedAt?: string;
  readonly invoiceExpiresAt?: string;
  readonly duplicatePaymentDetected?: true;
}

export interface SettlementHistoryRecord {
  readonly version: 2;
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

interface SettlementHistoryTracker {
  readonly id: string;
  readonly archivedAt: string;
  readonly session: SettlementSession;
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
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        database.createObjectStore(RECORD_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(TRACKER_STORE)) {
        database.createObjectStore(TRACKER_STORE, { keyPath: "id" });
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

export function isSettlementComplete(session: SettlementSession): boolean {
  return session.slots.every(
    (slot) => slot.status === "settled" || slot.status === "manuallyConfirmed",
  );
}

export function createSettlementHistorySnapshot(
  session: SettlementSession,
  archivedAt = new Date().toISOString(),
): SettlementHistoryRecord {
  const duplicates = new Set(duplicateSettledSlotNumbers(session));
  return {
    version: 2,
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
      ...(duplicates.has(slot.slotNumber)
        ? { duplicatePaymentDetected: true as const }
        : {}),
    })),
  };
}

function trackingDeadlineMs(session: SettlementSession): number {
  const expiryTimes = [
    ...session.slots.flatMap((slot) =>
      slot.invoice ? [Date.parse(slot.invoice.expiresAt)] : [],
    ),
    ...(session.invoiceHistory ?? []).map((attempt) =>
      Date.parse(attempt.invoice.expiresAt),
    ),
  ].filter(Number.isFinite);
  if (expiryTimes.length === 0) return 0;
  return (
    Math.max(...expiryTimes) +
    DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000
  );
}

function needsHistoricalTracking(
  session: SettlementSession,
  nowMs: number,
): boolean {
  return (
    trackingDeadlineMs(session) > nowMs &&
    settlementPollingTargets(session, nowMs).length > 0
  );
}

async function trimHistoryRecords(
  database: Awaited<ReturnType<typeof openHistoryDatabase>>,
) {
  const stored = (await database.getAll(
    RECORD_STORE,
  )) as SettlementHistoryRecord[];
  const sorted = stored
    .filter((record) => record?.version === 2 && typeof record.id === "string")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const oldRecord of sorted.slice(MAX_HISTORY_RECORDS)) {
    await database.delete(RECORD_STORE, oldRecord.id);
    await database.delete(TRACKER_STORE, oldRecord.id);
  }
}

export function archiveCompletedSettlement(
  session: SettlementSession,
  archivedAt = new Date().toISOString(),
): Promise<SettlementHistoryRecord> {
  if (!isSettlementComplete(session)) {
    return Promise.reject(
      new Error(
        "정산이 모두 완료되기 전에는 과거 기록으로 종료할 수 없습니다.",
      ),
    );
  }
  const record = createSettlementHistorySnapshot(session, archivedAt);
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    await database.put(RECORD_STORE, record);
    const nowMs = Date.now();
    if (needsHistoricalTracking(session, nowMs)) {
      const tracker: SettlementHistoryTracker = {
        id: session.id,
        archivedAt,
        session,
      };
      await database.put(TRACKER_STORE, tracker);
    } else {
      // A fully network-confirmed settlement with no unresolved historical
      // invoice has nothing left to verify. Do not retain BOLT11/hash/token data.
      await database.delete(TRACKER_STORE, session.id);
    }
    await trimHistoryRecords(database);
    return record;
  });
}

export function listSettlementHistory(): Promise<SettlementHistoryRecord[]> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const stored = (await database.getAll(
      RECORD_STORE,
    )) as SettlementHistoryRecord[];
    return stored
      .filter(
        (record) => record?.version === 2 && typeof record.id === "string",
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function deleteSettlementHistoryRecord(id: string): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    await Promise.all([
      database.delete(RECORD_STORE, id),
      database.delete(TRACKER_STORE, id),
    ]);
  });
}

export function clearSettlementHistory(): Promise<void> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    await Promise.all([
      database.clear(RECORD_STORE),
      database.clear(TRACKER_STORE),
    ]);
  });
}

async function reconcileTracker(
  tracker: SettlementHistoryTracker,
  nowMs: number,
): Promise<SettlementHistoryTracker> {
  let session = tracker.session;
  const targets = settlementPollingTargets(session, nowMs);
  for (const { invoice, identity } of targets) {
    try {
      const response = await fetchSettlement({
        verificationToken: identity.verificationToken,
        paymentHash: identity.paymentHash,
        bolt11: invoice.bolt11,
      });
      session = transitionAfterSettlementCheck(
        session,
        identity,
        response,
        new Date(nowMs),
      );
    } catch {
      // Historical reconciliation is best-effort. The active settlement flow
      // remains authoritative and network failures must never delete evidence.
    }
  }
  return { ...tracker, session };
}

export function reconcileSettlementHistory(
  nowMs = Date.now(),
): Promise<SettlementHistoryRecord[]> {
  return serializeDatabaseOperation(async () => {
    const database = await openHistoryDatabase();
    const trackers = (await database.getAll(
      TRACKER_STORE,
    )) as SettlementHistoryTracker[];
    for (const tracker of trackers) {
      if (!tracker?.session || typeof tracker.id !== "string") continue;
      if (!needsHistoricalTracking(tracker.session, nowMs)) {
        await database.delete(TRACKER_STORE, tracker.id);
        continue;
      }
      const reconciled = await reconcileTracker(tracker, nowMs);
      await database.put(
        RECORD_STORE,
        createSettlementHistorySnapshot(
          reconciled.session,
          reconciled.archivedAt,
        ),
      );
      if (needsHistoricalTracking(reconciled.session, nowMs)) {
        await database.put(TRACKER_STORE, reconciled);
      } else {
        await database.delete(TRACKER_STORE, tracker.id);
      }
    }
    const records = (await database.getAll(
      RECORD_STORE,
    )) as SettlementHistoryRecord[];
    return records
      .filter(
        (record) => record?.version === 2 && typeof record.id === "string",
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}
