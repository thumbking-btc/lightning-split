import { useEffect, useRef } from "react";

import { fetchSettlement } from "./api";
import {
  isSlotPollable,
  nextPollingDelay,
  transitionAfterSettlementCheck,
} from "./polling";
import { markExpiredSlots } from "./session";
import type { SettlementSession } from "./types";

export function useSettlementPolling(
  session: SettlementSession | null,
  updateSession: (
    updater: (current: SettlementSession) => SettlementSession,
  ) => void,
): void {
  const sessionRef = useRef(session);
  const sessionId = session?.id;

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failures = new Map<number, number>();
    const nextDue = new Map<number, number>();

    const schedule = (delay: number) => {
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const current = sessionRef.current;
      if (!current) return;
      const now = Date.now();
      updateSession((value) => markExpiredSlots(value, now));
      if (document.visibilityState !== "visible") {
        schedule(5_000);
        return;
      }

      for (const slot of current.slots) {
        if (
          cancelled ||
          !isSlotPollable(slot, now) ||
          (nextDue.get(slot.slotNumber) ?? 0) > now
        ) {
          continue;
        }
        const token = slot.invoice?.verificationToken;
        if (!token) continue;
        try {
          const invoice = slot.invoice;
          if (!invoice) continue;
          const response = await fetchSettlement({
            verificationToken: token,
            paymentHash: invoice.paymentHash,
            bolt11: invoice.bolt11,
          });
          if (cancelled) return;
          failures.set(slot.slotNumber, 0);
          nextDue.set(slot.slotNumber, Date.now() + nextPollingDelay(0));
          updateSession((value) =>
            transitionAfterSettlementCheck(
              value,
              slot.slotNumber,
              response,
              new Date(),
            ),
          );
        } catch {
          const failureCount = (failures.get(slot.slotNumber) ?? 0) + 1;
          failures.set(slot.slotNumber, failureCount);
          nextDue.set(
            slot.slotNumber,
            Date.now() + nextPollingDelay(failureCount),
          );
        }
      }
      schedule(1_000);
    };

    schedule(500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, updateSession]);
}
