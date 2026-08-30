import { useEffect, useRef } from "react";

import { ApiClientError, fetchSettlement } from "./api";
import {
  isSlotPollable,
  nextPollingDelay,
  settlementIdentityKey,
  settlementInvoiceIdentity,
  transitionAfterSettlementCheck,
} from "./polling";
import { disableAutomaticVerification, markExpiredSlots } from "./session";
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
    const failures = new Map<string, number>();
    const nextDue = new Map<string, number>();

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

      const due = current.slots.flatMap((slot) => {
        if (!isSlotPollable(slot, now)) return [];
        const identity = settlementInvoiceIdentity(slot);
        if (!identity) return [];
        const key = settlementIdentityKey(identity);
        return (nextDue.get(key) ?? 0) <= now ? [{ slot, identity, key }] : [];
      });
      await Promise.all(
        due.map(async ({ slot, identity, key }) => {
          const invoice = slot.invoice;
          if (!invoice) return;
          try {
            const response = await fetchSettlement({
              verificationToken: identity.verificationToken,
              paymentHash: identity.paymentHash,
              bolt11: invoice.bolt11,
            });
            if (cancelled) return;
            failures.set(key, 0);
            nextDue.set(key, Date.now() + nextPollingDelay(0));
            updateSession((value) =>
              transitionAfterSettlementCheck(
                value,
                identity,
                response,
                new Date(),
              ),
            );
          } catch (cause) {
            if (cancelled) return;
            const failureCount = (failures.get(key) ?? 0) + 1;
            const permanentFailure =
              cause instanceof ApiClientError && !cause.retryable;
            if (permanentFailure) {
              failures.delete(key);
              nextDue.delete(key);
              updateSession((value) =>
                disableAutomaticVerification(value, identity, new Date()),
              );
              return;
            }
            failures.set(key, failureCount);
            const retryAfterSeconds =
              cause instanceof ApiClientError &&
              cause.retryAfterSeconds !== undefined
                ? cause.retryAfterSeconds
                : undefined;
            nextDue.set(
              key,
              Date.now() + nextPollingDelay(failureCount, retryAfterSeconds),
            );
          }
        }),
      );
      schedule(1_000);
    };

    schedule(500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, updateSession]);
}
