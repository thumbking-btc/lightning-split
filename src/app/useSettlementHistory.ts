import { useCallback, useEffect, useState } from "react";

import {
  deleteSettlementHistoryRecord,
  listSettlementHistory,
  reconcileSettlementHistory,
  type SettlementHistoryRecord,
} from "./settlementHistory";

const RECONCILIATION_INTERVAL_MS = 60_000;

export function useSettlementHistory() {
  const [records, setRecords] = useState<SettlementHistoryRecord[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await listSettlementHistory();
      setRecords(next);
      setError(undefined);
      return next;
    } catch {
      setError("이 기기에 저장된 정산 기록을 불러오지 못했습니다.");
      return [];
    }
  }, []);

  const reconcile = useCallback(async () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    try {
      const next = await reconcileSettlementHistory();
      setRecords(next);
      setError(undefined);
    } catch {
      // Historical reconciliation must never interfere with the active payment
      // flow. Keep the last known history and retry later.
    }
  }, []);

  const deleteRecord = useCallback(async (id: string): Promise<boolean> => {
    try {
      await deleteSettlementHistoryRecord(id);
      setRecords((current) => current.filter((record) => record.id !== id));
      setError(undefined);
      return true;
    } catch {
      setError("이 기기에서 정산 기록을 삭제하지 못했습니다.");
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh().then(() => reconcile());
    const timer = window.setInterval(
      () => void reconcile(),
      RECONCILIATION_INTERVAL_MS,
    );
    const visibility = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    const online = () => void reconcile();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
    };
  }, [reconcile, refresh]);

  return { records, error, refresh, reconcile, deleteRecord } as const;
}
