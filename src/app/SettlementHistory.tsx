import { useMemo, useState } from "react";

import { formatUsdCents, localeFor, type Language } from "./preferences";
import {
  createSettlementHistorySnapshot,
  isSettlementComplete,
  type SettlementHistoryRecord,
  type SettlementHistorySlot,
} from "./settlementHistory";
import type { SettlementSession } from "./types";
import "./SettlementHistory.css";

function formatInteger(value: string, language: Language): string {
  return new Intl.NumberFormat(localeFor(language)).format(Number(BigInt(value)));
}

function formatRecordAmount(
  record: SettlementHistoryRecord,
  language: Language,
): string {
  if (record.inputMode === "krw") {
    return `${formatInteger(record.totalAmount, language)}${language === "ko" ? "원" : " KRW"}`;
  }
  if (record.inputMode === "usd") {
    return formatUsdCents(BigInt(record.totalAmount), language);
  }
  return `${formatInteger(record.totalAmount, language)} sats`;
}

function formatSlotAmount(slot: SettlementHistorySlot, language: Language): string {
  if (slot.krwShare) {
    return `${formatInteger(slot.krwShare, language)}${language === "ko" ? "원" : " KRW"} · ${formatInteger(slot.targetSats, language)} sats`;
  }
  if (slot.usdCentsShare) {
    return `${formatUsdCents(BigInt(slot.usdCentsShare), language)} · ${formatInteger(slot.targetSats, language)} sats`;
  }
  return `${formatInteger(slot.targetSats, language)} sats`;
}

function completedCount(record: SettlementHistoryRecord): number {
  return record.slots.filter(
    (slot) => slot.status === "settled" || slot.status === "manuallyConfirmed",
  ).length;
}

function recordStatus(
  record: SettlementHistoryRecord,
  active: boolean,
  language: Language,
): string {
  const completed = completedCount(record);
  if (active && completed < record.invoiceCount) {
    return language === "ko"
      ? `진행 중 · ${completed}/${record.invoiceCount} 완료`
      : `In progress · ${completed}/${record.invoiceCount}`;
  }
  if (completed === record.invoiceCount) {
    return language === "ko" ? "정산 완료" : "Completed";
  }
  return language === "ko"
    ? `${completed}/${record.invoiceCount} 완료`
    : `${completed}/${record.invoiceCount} complete`;
}

function slotStatus(
  slot: SettlementHistorySlot,
  active: boolean,
  nowMs: number,
  language: Language,
): string {
  if (slot.duplicatePaymentDetected) {
    return language === "ko" ? "중복 입금 확인" : "Duplicate detected";
  }
  if (slot.status === "settled") {
    return language === "ko" ? "자동 확인 완료" : "Auto confirmed";
  }
  if (slot.status === "manuallyConfirmed") {
    return language === "ko" ? "직접 확인 완료" : "Manually confirmed";
  }
  if (slot.status === "legacyReviewRequired") {
    return language === "ko" ? "확인 필요" : "Review required";
  }
  if (slot.status === "failed") {
    return language === "ko" ? "생성 실패" : "Creation failed";
  }
  const expired =
    slot.status === "expired" ||
    (slot.invoiceExpiresAt !== undefined &&
      Date.parse(slot.invoiceExpiresAt) <= nowMs);
  if (expired) {
    return active
      ? language === "ko"
        ? "만료 · 재발급 필요"
        : "Expired · reissue needed"
      : language === "ko"
        ? "만료"
        : "Expired";
  }
  return active
    ? language === "ko"
      ? "정산 대기"
      : "Waiting"
    : language === "ko"
      ? "미완료"
      : "Incomplete";
}

function monthLabel(createdAt: string, language: Language): string {
  const date = new Date(createdAt);
  return language === "ko"
    ? `${date.getFullYear()}년 ${date.getMonth() + 1}월`
    : date.toLocaleDateString(localeFor(language), {
        year: "numeric",
        month: "long",
      });
}

function shortDate(createdAt: string, language: Language): string {
  return new Date(createdAt).toLocaleDateString(localeFor(language), {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function SettlementHistoryDetail({
  record,
  active,
  language,
  onBack,
  onReturnToSettlement,
  onDelete,
}: {
  readonly record: SettlementHistoryRecord;
  readonly active: boolean;
  readonly language: Language;
  readonly onBack: () => void;
  readonly onReturnToSettlement: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const [nowMs] = useState(() => Date.now());
  const deleteRecord = async () => {
    if (active) return;
    const confirmed = window.confirm(
      language === "ko"
        ? "이 기기에서 이 정산 기록을 삭제하시겠습니까? 이미 완료된 실제 Lightning 결제에는 영향을 주지 않습니다."
        : "Delete this settlement history from this device? Completed Lightning payments are not affected.",
    );
    if (!confirmed) return;
    if (await onDelete(record.id)) onBack();
  };

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onBack}>
          ←
          <span className="sr-only">
            {language === "ko" ? "정산 기록 목록으로" : "Back to history"}
          </span>
        </button>
        <div>
          <span className="eyebrow">
            {active
              ? language === "ko"
                ? "진행 중 정산"
                : "ACTIVE SETTLEMENT"
              : language === "ko"
                ? "정산 기록"
                : "SETTLEMENT HISTORY"}
          </span>
          <h1>{record.overallNote || (language === "ko" ? "정산 상세" : "Settlement details")}</h1>
        </div>
      </header>

      <section className="history-detail-summary">
        <span>{new Date(record.createdAt).toLocaleString(localeFor(language))}</span>
        <strong>{formatRecordAmount(record, language)}</strong>
        <p>
          {language === "ko"
            ? `전체 ${record.totalPeople}명 · 결제 요청 ${record.invoiceCount}명 · ${recordStatus(record, active, language)}`
            : `${record.totalPeople} people · ${record.invoiceCount} payment requests · ${recordStatus(record, active, language)}`}
        </p>
      </section>

      <section className="history-detail-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">
              {language === "ko" ? "참여자별 상태" : "PARTICIPANTS"}
            </span>
            <h2>{language === "ko" ? "정산 내역" : "Settlement status"}</h2>
          </div>
        </div>
        <div className="history-slot-list">
          {record.slots.map((slot) => (
            <article className="history-slot" key={slot.slotNumber}>
              <div>
                <strong>
                  {slot.displayName?.trim() ||
                    (language === "ko"
                      ? `${slot.slotNumber}번 결제`
                      : `Payment ${slot.slotNumber}`)}
                </strong>
                <span>{formatSlotAmount(slot, language)}</span>
                {slot.completedAt && (
                  <small>
                    {new Date(slot.completedAt).toLocaleString(localeFor(language))}
                  </small>
                )}
              </div>
              <span
                className={`history-slot-status ${slot.status}${slot.duplicatePaymentDetected ? " duplicate" : ""}`}
              >
                {slotStatus(slot, active, nowMs, language)}
              </span>
            </article>
          ))}
        </div>
      </section>

      {active ? (
        <>
          <div className="history-safety-note">
            {language === "ko"
              ? "이 정산은 아직 현재 정산입니다. 만료된 결제 요청은 정산 화면으로 돌아가 새 invoice를 만든 뒤 당사자에게 다시 공유하십시오. 모두 완료되기 전에는 과거 기록으로 종료되지 않습니다."
              : "This is still the active settlement. Reissue expired payment requests from the settlement screen and share the new invoice. It is not archived until everyone is complete."}
          </div>
          <button
            className="secondary-button full history-return-button"
            type="button"
            onClick={onReturnToSettlement}
          >
            {language === "ko" ? "정산 화면으로 돌아가기" : "Return to settlement"}
          </button>
        </>
      ) : (
        <>
          <div className="history-safety-note">
            {language === "ko"
              ? "과거 기록에는 결제용 QR과 Lightning invoice 원문을 보관하지 않습니다. 늦은 결제·중복 결제 확인에 필요한 정보만 제한된 기간 동안 별도 내부 추적 영역에 보관한 뒤 자동 제거합니다."
              : "Past history does not keep payment QR images or raw Lightning invoices. Only temporary internal tracking data needed to detect late or duplicate payments is retained for a limited period and then removed."}
          </div>
          <button
            className="danger-text-button history-delete"
            type="button"
            onClick={() => void deleteRecord()}
          >
            {language === "ko" ? "이 정산 기록 삭제" : "Delete this history"}
          </button>
        </>
      )}
    </main>
  );
}

export function SettlementHistoryScreen({
  activeSession,
  records,
  error,
  language,
  onClose,
  onDelete,
}: {
  readonly activeSession: SettlementSession | null;
  readonly records: readonly SettlementHistoryRecord[];
  readonly error: string | undefined;
  readonly language: Language;
  readonly onClose: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const activeRecord = activeSession
    ? createSettlementHistorySnapshot(activeSession, activeSession.createdAt)
    : undefined;
  const selectedActive = activeRecord?.id === selectedId;
  const selectedRecord = selectedActive
    ? activeRecord
    : records.find((record) => record.id === selectedId);
  const groups = useMemo(() => {
    const result = new Map<string, SettlementHistoryRecord[]>();
    for (const record of records) {
      const label = monthLabel(record.createdAt, language);
      const group = result.get(label) ?? [];
      group.push(record);
      result.set(label, group);
    }
    return [...result.entries()];
  }, [language, records]);

  if (selectedRecord) {
    return (
      <SettlementHistoryDetail
        record={selectedRecord}
        active={selectedActive}
        language={language}
        onBack={() => setSelectedId(undefined)}
        onReturnToSettlement={onClose}
        onDelete={onDelete}
      />
    );
  }

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onClose}>
          ←
          <span className="sr-only">
            {language === "ko" ? "정산 화면으로" : "Back to settlement"}
          </span>
        </button>
        <div>
          <span className="eyebrow">
            {language === "ko" ? "정산 현황 · 기록" : "SETTLEMENTS"}
          </span>
          <h1>{language === "ko" ? "정산 기록" : "Settlement history"}</h1>
        </div>
      </header>

      <p className="history-storage-note">
        {language === "ko"
          ? "현재 정산은 모두 완료될 때까지 계속 진행 상태로 남습니다. 완료된 과거 기록은 계정이나 서버가 아니라 이 브라우저의 기기 저장공간에만 보관됩니다."
          : "The current settlement remains active until everyone is complete. Completed history is stored only in this browser on this device, not in an account or server."}
      </p>

      {error && (
        <div className="global-warning" role="alert">
          {error}
        </div>
      )}

      {activeRecord && (
        <section className="history-current-section">
          <h2>{language === "ko" ? "현재 정산" : "Current settlement"}</h2>
          <button
            className="history-card active-history-card"
            type="button"
            onClick={() => setSelectedId(activeRecord.id)}
          >
            <div>
              <span>{activeRecord.overallNote || (language === "ko" ? `${activeRecord.totalPeople}명 정산` : `${activeRecord.totalPeople} people`)}</span>
              <strong>{formatRecordAmount(activeRecord, language)}</strong>
              <small>{shortDate(activeRecord.createdAt, language)}</small>
            </div>
            <span className="history-record-status">
              {recordStatus(activeRecord, true, language)}
            </span>
          </button>
          {!isSettlementComplete(activeSession!) && (
            <p className="history-current-help">
              {language === "ko"
                ? "미정산 또는 만료된 결제 요청이 있으면 현재 정산 화면에서 계속 처리하십시오."
                : "Continue unresolved or expired payment requests from the active settlement screen."}
            </p>
          )}
        </section>
      )}

      {groups.length === 0 ? (
        <section className="history-empty">
          <strong>
            {language === "ko"
              ? "완료되어 보관된 정산 기록이 없습니다."
              : "No completed settlement history yet."}
          </strong>
          <span>
            {language === "ko"
              ? "현재 정산이 모두 완료된 뒤 새 정산을 시작하면 이곳에 보관됩니다."
              : "A completed settlement is archived here when you start the next one."}
          </span>
        </section>
      ) : (
        <div className="history-groups">
          {groups.map(([label, group]) => (
            <section className="history-month" key={label}>
              <h2>{label}</h2>
              <div className="history-list">
                {group.map((record) => (
                  <button
                    className="history-card"
                    type="button"
                    key={record.id}
                    onClick={() => setSelectedId(record.id)}
                  >
                    <div>
                      <span>
                        {record.overallNote ||
                          (language === "ko"
                            ? `${record.totalPeople}명 정산`
                            : `${record.totalPeople} people`)}
                      </span>
                      <strong>{formatRecordAmount(record, language)}</strong>
                      <small>{shortDate(record.createdAt, language)}</small>
                    </div>
                    <span className="history-record-status">
                      {recordStatus(record, false, language)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
