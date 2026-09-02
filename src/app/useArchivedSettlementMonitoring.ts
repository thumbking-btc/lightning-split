import { useEffect, useRef } from "react";

import { fetchSettlement } from "./api";
import {
  applyLateSettlementTrackingResponse,
  listLateSettlementTrackingTargets,
  type LateSettlementTrackingTarget,
} from "./settlementHistory";

const ARCHIVED_CHECK_INTERVAL_MS = 60_000;
const ARCHIVED_CHECK_CONCURRENCY = 3;

async function checkTarget(
  target: LateSettlementTrackingTarget,
): Promise<boolean> {
  try {
    const response = await fetchSettlement({
      verificationToken: target.verificationToken,
      paymentHash: target.paymentHash,
      bolt11: target.bolt11,
    });
    return await applyLateSettlementTrackingResponse(target, response);
  } catch {
    // Archived checks are best-effort. The encrypted verification context remains
    // local until its bounded retention window expires, so a transient network or
    // provider failure must not erase the ability to check again later.
    return false;
  }
}

async function checkTargets(
  targets: readonly LateSettlementTrackingTarget[],
): Promise<boolean> {
  let changed = false;
  for (
    let index = 0;
    index < targets.length;
    index += ARCHIVED_CHECK_CONCURRENCY
  ) {
    const batch = targets.slice(index, index + ARCHIVED_CHECK_CONCURRENCY);
    const results = await Promise.all(batch.map(checkTarget));
    changed = results.some(Boolean) || changed;
  }
  return changed;
}

export function useArchivedSettlementMonitoring(
  onHistoryChanged: () => Promise<void>,
): void {
  const callbackRef = useRef(onHistoryChanged);
  useEffect(() => {
    callbackRef.current = onHistoryChanged;
  }, [onHistoryChanged]);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), delay);
    };

    const check = async () => {
      if (cancelled || running) return;
      if (document.visibilityState !== "visible") {
        schedule(ARCHIVED_CHECK_INTERVAL_MS);
        return;
      }
      running = true;
      try {
        const targets = await listLateSettlementTrackingTargets();
        if (targets.length > 0 && (await checkTargets(targets))) {
          await callbackRef.current();
        }
      } catch {
        // History monitoring must never make the active settlement unusable.
      } finally {
        running = false;
        schedule(ARCHIVED_CHECK_INTERVAL_MS);
      }
    };

    const checkSoon = () => schedule(250);
    document.addEventListener("visibilitychange", checkSoon);
    window.addEventListener("online", checkSoon);
    schedule(1_000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkSoon);
      window.removeEventListener("online", checkSoon);
    };
  }, []);
}
