import type { SettlementResponseDto } from "../api/contracts";
import { applySettlementResponse, markExpiredSlots } from "./session";
import type { ClientSlot, SettlementSession } from "./types";

export const POLLING_BACKOFF_MS = [
  5_000, 8_000, 13_000, 21_000, 30_000,
] as const;

export function isSlotPollable(slot: ClientSlot, nowMs = Date.now()): boolean {
  return (
    slot.status === "pending" &&
    slot.invoice?.verificationToken !== undefined &&
    Date.parse(slot.invoice.expiresAt) > nowMs
  );
}

export function nextPollingDelay(failureCount: number): number {
  const index = Math.min(
    Math.max(0, failureCount),
    POLLING_BACKOFF_MS.length - 1,
  );
  return POLLING_BACKOFF_MS[index]!;
}

export function transitionAfterSettlementCheck(
  session: SettlementSession,
  slotNumber: number,
  response: SettlementResponseDto,
  now = new Date(),
): SettlementSession {
  return markExpiredSlots(
    applySettlementResponse(session, slotNumber, response, now),
    now.getTime(),
  );
}
