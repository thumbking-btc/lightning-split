import { openDB } from "idb";

import { parsePriceSnapshotDto } from "../api/serialization";
import { isRecord } from "../infrastructure/validation";
import type { SettlementSession } from "./types";

const DATABASE_NAME = "lightning-split";
const STORE_NAME = "settlements";
const ACTIVE_SESSION_KEY = "active";

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
  if (value.status === "generating") return value.invoice === undefined;
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
    value.status !== "settled" &&
    value.status !== "expired" &&
    value.status !== "manuallyConfirmed"
  ) {
    return false;
  }
  if (!isStoredInvoice(value.invoice)) return false;
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
  if (value.priceSnapshot !== undefined) {
    try {
      parsePriceSnapshotDto(value.priceSnapshot);
    } catch {
      throw new Error("저장된 가격 snapshot이 올바르지 않습니다.");
    }
  }
  return value;
}

export function serializeSession(session: SettlementSession): string {
  return JSON.stringify(session);
}

export function restoreSession(serialized: string): SettlementSession {
  const parsed: unknown = JSON.parse(serialized);
  return assertSession(parsed);
}

async function openSettlementDatabase() {
  return openDB(DATABASE_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME);
    },
  });
}

export async function saveActiveSession(
  session: SettlementSession,
): Promise<void> {
  const database = await openSettlementDatabase();
  await database.put(STORE_NAME, serializeSession(session), ACTIVE_SESSION_KEY);
}

export async function loadActiveSession(): Promise<SettlementSession | null> {
  const database = await openSettlementDatabase();
  const stored: unknown = await database.get(STORE_NAME, ACTIVE_SESSION_KEY);
  if (typeof stored !== "string") return null;
  try {
    return restoreSession(stored);
  } catch {
    await database.delete(STORE_NAME, ACTIVE_SESSION_KEY);
    return null;
  }
}

export async function clearActiveSession(): Promise<void> {
  const database = await openSettlementDatabase();
  await database.delete(STORE_NAME, ACTIVE_SESSION_KEY);
}
