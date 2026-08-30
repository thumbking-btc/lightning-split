import type { SettlementResponseDto } from "../api/contracts";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import {
  applySettlementResponse,
  markExpiredSlots,
  type SettlementInvoiceIdentity,
} from "./session";
import type { ClientSlot, SettlementSession } from "./types";

export const POLLING_BACKOFF_MS = [
  5_000, 8_000, 13_000, 21_000, 30_000,
] as const;
export const VERIFICATION_DELAY_FAILURE_THRESHOLD = 3;

export function shouldMarkVerificationDelayed(failureCount: number): boolean {
  return failureCount >= VERIFICATION_DELAY_FAILURE_THRESHOLD;
}

export function isSlotPollable(slot: ClientSlot, nowMs = Date.now()): boolean {
  const graceMs =
    DEFAULT_LIGHTNING_POLICY.settlementFinalVerificationGraceSeconds * 1_000;
  const retentionMs =
    DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000;
  const pollDeadlineMs =
    Date.parse(slot.invoice?.expiresAt ?? "") +
    (slot.status === "manuallyConfirmed" ? retentionMs : graceMs);
  return (
    (slot.status === "pending" ||
      slot.status === "verifyingExpired" ||
      slot.status === "manuallyConfirmed") &&
    slot.invoice?.verificationToken !== undefined &&
    slot.invoice.awaitingPersistence !== true &&
    pollDeadlineMs > nowMs
  );
}

export interface SettlementPollingTarget {
  readonly invoice: NonNullable<ClientSlot["invoice"]>;
  readonly identity: SettlementInvoiceIdentity;
}

export function settlementPollingTargets(
  session: SettlementSession,
  nowMs = Date.now(),
): readonly SettlementPollingTarget[] {
  const current = session.slots.flatMap((slot) => {
    if (!isSlotPollable(slot, nowMs) || !slot.invoice) return [];
    const identity = settlementInvoiceIdentity(slot);
    return identity ? [{ invoice: slot.invoice, identity }] : [];
  });
  const retentionMs =
    DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000;
  const historical = (session.invoiceHistory ?? []).flatMap((attempt) => {
    const verificationToken = attempt.invoice.verificationToken;
    if (
      verificationToken === undefined ||
      attempt.settledAt !== undefined ||
      Date.parse(attempt.invoice.expiresAt) + retentionMs <= nowMs
    ) {
      return [];
    }
    return [
      {
        invoice: attempt.invoice,
        identity: {
          slotNumber: attempt.slotNumber,
          attempt: attempt.attempt,
          paymentHash: attempt.invoice.paymentHash,
          verificationToken,
        },
      },
    ];
  });
  return [...current, ...historical];
}

export function settlementInvoiceIdentity(
  slot: ClientSlot,
): SettlementInvoiceIdentity | undefined {
  const verificationToken = slot.invoice?.verificationToken;
  if (
    slot.invoice === undefined ||
    verificationToken === undefined ||
    (slot.status !== "pending" &&
      slot.status !== "verifyingExpired" &&
      slot.status !== "manuallyConfirmed")
  ) {
    return undefined;
  }
  return {
    slotNumber: slot.slotNumber,
    attempt: slot.attempt,
    paymentHash: slot.invoice.paymentHash,
    verificationToken,
  };
}

export function settlementIdentityKey(
  identity: SettlementInvoiceIdentity,
): string {
  return `${identity.slotNumber}:${identity.attempt}:${identity.paymentHash}:${identity.verificationToken}`;
}

export function nextPollingDelay(
  failureCount: number,
  retryAfterSeconds?: number,
): number {
  const index = Math.min(
    Math.max(0, failureCount),
    POLLING_BACKOFF_MS.length - 1,
  );
  const backoffMs = POLLING_BACKOFF_MS[index]!;
  const retryAfterMs =
    retryAfterSeconds !== undefined &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : 0;
  return Math.max(backoffMs, retryAfterMs);
}

export function transitionAfterSettlementCheck(
  session: SettlementSession,
  identity: SettlementInvoiceIdentity,
  response: SettlementResponseDto,
  now = new Date(),
): SettlementSession {
  return markExpiredSlots(
    applySettlementResponse(session, identity, response, now),
    now.getTime(),
  );
}
