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

export function isSlotPollable(slot: ClientSlot, nowMs = Date.now()): boolean {
  const graceMs =
    DEFAULT_LIGHTNING_POLICY.settlementFinalVerificationGraceSeconds * 1_000;
  return (
    (slot.status === "pending" || slot.status === "verifyingExpired") &&
    slot.invoice?.verificationToken !== undefined &&
    Date.parse(slot.invoice.expiresAt) + graceMs > nowMs
  );
}

export function settlementInvoiceIdentity(
  slot: ClientSlot,
): SettlementInvoiceIdentity | undefined {
  const verificationToken = slot.invoice?.verificationToken;
  if (
    slot.invoice === undefined ||
    verificationToken === undefined ||
    (slot.status !== "pending" && slot.status !== "verifyingExpired")
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
