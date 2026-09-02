import { useMemo, useState } from "react";

import { getSettlementProgress } from "./session";
import {
  isCompletedHistorySlot,
  type SettlementHistoryRecord,
  type SettlementHistorySlot,
} from "./settlementHistory";
import { formatUsdCents, localeFor, type Language } from "./preferences";
import type { SettlementSession } from "./types";
import "./SettlementHistory.css";

function copy(language: Language) {
  return language === "ko"
    ? {
        history: "정산 기록",
        localHistory: "LOCAL HISTORY",
        active: "진행 중인 정산",
        activeHelp:
          "미정산 결제가 남아 있습니다. 만료된 QR은 정산 화면에서 새로 만들어 다시 공유할 수 있습니다.",
        activeComplete: "모든 결제 확인 완료",
        openActive: "정산 현황 열기",
        storage:
          "정산 중인 결제는 완료될 때까지 이 기기에서 계속 추적합니다. 완료 기록에는 Lightning invoice 원문과 결제 확인 token을 장기 보관하지 않습니다.",
        emptyTitle: "아직 저장된 완료 정산이 없습니다.",
        emptyHelp:
          "정산이 모두 완료된 뒤 새 정산을 시작하면 이곳에 보관됩니다.",
        detail: "정산 상세",
        participants: "참여자별 상태",
        settlementDetails: "정산 내역",
        total: "전체",
        people: "명",
        requests: "결제 요청",
        completed: "정산완료",
        incomplete: "미완료",
        auto: "자동 확인 완료",
        manual: "직접 확인 완료",
        review: "확인 필요",
        expired: "만료",
        failed: "생성 실패",
        pending: "미완료",
        lateWarning:
          "이전에 교체된 결제 요청에도 뒤늦은 입금이 확인되었습니다. 중복 입금 가능성이 있으므로 받는 지갑의 거래내역을 확인하십시오.",
        privacy:
          "완료 기록에는 결제용 QR, Lightning invoice 원문, payment hash, verification token, provider 정보를 보관하지 않습니다.",
        delete: "이 완료 기록 삭제",
        deleteConfirm:
          "이 기기에서 이 완료 정산 기록을 삭제하시겠습니까? 이미 완료된 실제 Lightning 결제에는 영향을 주지 않습니다.",
      }
    : {
        history: "Settlement history",
        localHistory: "LOCAL HISTORY",
        active: "Active settlement",
        activeHelp:
          "Payments are still pending. Expired QRs can be regenerated and shared again from the settlement screen.",
        activeComplete: "All payments confirmed",
        openActive: "Open settlement status",
        storage:
          "Active payments remain tracked on this device until settlement is complete. Completed records do not retain Lightning invoices or verification tokens long-term.",
        emptyTitle: "No completed settlements saved yet.",
        emptyHelp:
          "After a settlement is complete, starting the next one archives it here.",
        detail: "Settlement details",
        participants: "Participant status",
        settlementDetails: "Settlement details",
        total: "Total",
        people: " people",
        requests: "payment requests",
        completed: "Complete",
        incomplete: "Incomplete",
        auto: "Automatically confirmed",
        manual: "Manually confirmed",
        review: "Review required",
        expired: "Expired",
        failed: "Creation failed",
        pending: "Pending",
        lateWarning:
          "A payment was later detected on a replaced payment request. Check the receiving wallet for a possible duplicate deposit.",
        privacy:
          "Completed records do not retain payment QRs, Lightning invoices, payment hashes, verification tokens, or provider information.",
        delete: "Delete completed record",
        deleteConfirm:
          "Delete this completed settlement record from this device? This does not affect completed Lightning payments.",
      };
}

function formatInteger(value: string, language: Language): string {
  return new Intl.NumberFormat(localeFor(language)).format(
    Number(BigInt(value)),
  );
}

function formatAmount(
  inputMode: SettlementHistoryRecord["inputMode"],
  amount: string,
  language: Language,
): string {
  if (inputMode === "krw")
    return `${formatInteger(amount, language)}${language === "ko" ? "원" : " KRW"}`;
  if (inputMode === "usd") return formatUsdCents(BigInt(amount), language);
  return `${formatInteger(amount, language)} sats`;
}

function formatSlotAmount(
  slot: Pick<
    SettlementHistorySlot,
    "krwShare" | "usdCentsShare" | "targetSats"
  >,
  language: Language,
): string {
  if (slot.krwShare)
    return `${formatInteger(slot.krwShare, language)}${language === "ko" ? "원" : " KRW"} · ${formatInteger(slot.targetSats, language)} sats`;
  if (slot.usdCentsShare)
    return `${formatUsdCents(BigInt(slot.usdCentsShare), language)} · ${formatInteger(slot.targetSats, language)} sats`;
  return `${formatInteger(slot.targetSats, language)} sats`;
}

function completedCount(record: SettlementHistoryRecord): number {
  return record.slots.filter(isCompletedHistorySlot).length;
}

function recordStatus(
  record: SettlementHistoryRecord,
  language: Language,
): string {
  const c = copy(language);
  const completed = completedCount(record);
  if (completed === record.invoiceCount) return c.completed;
  if (completed > 0)
    return `${completed}/${record.invoiceCount} ${c.completed}`;
  return c.incomplete;
}

function slotStatus(slot: SettlementHistorySlot, language: Language): string {
  const c = copy(language);
  if (slot.status === "settled") return c.auto;
  if (slot.status === "manuallyConfirmed") return c.manual;
  if (slot.status === "legacyReviewRequired") return c.review;
  if (slot.status === "expired") return c.expired;
  if (slot.status === "failed") return c.failed;
  return c.pending;
}

function monthLabel(createdAt: string, language: Language): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    year: "numeric",
    month: "long",
  }).format(new Date(createdAt));
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
  language,
  onBack,
  onDelete,
}: {
  readonly record: SettlementHistoryRecord;
  readonly language: Language;
  readonly onBack: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const c = copy(language);
  const deleteRecord = async () => {
    if (!window.confirm(c.deleteConfirm)) return;
    if (await onDelete(record.id)) onBack();
  };

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onBack}>
          ←<span className="sr-only">{c.history}</span>
        </button>
        <div>
          <span className="eyebrow">{c.history}</span>
          <h1>{record.overallNote || c.detail}</h1>
        </div>
      </header>

      <section className="history-detail-summary">
        <span>
          {new Date(record.createdAt).toLocaleString(localeFor(language))}
        </span>
        <strong>
          {formatAmount(record.inputMode, record.totalAmount, language)}
        </strong>
        <p>
          {language === "ko"
            ? `${c.total} ${record.totalPeople}${c.people} · ${c.requests} ${record.invoiceCount}명 · ${recordStatus(record, language)}`
            : `${c.total} ${record.totalPeople}${c.people} · ${record.invoiceCount} ${c.requests} · ${recordStatus(record, language)}`}
        </p>
      </section>

      <section className="history-detail-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">{c.participants}</span>
            <h2>{c.settlementDetails}</h2>
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
                      : `Payment #${slot.slotNumber}`)}
                </strong>
                <span>{formatSlotAmount(slot, language)}</span>
                {slot.completedAt && (
                  <small>
                    {new Date(slot.completedAt).toLocaleString(
                      localeFor(language),
                    )}
                  </small>
                )}
                {slot.latePaymentWarningAt && (
                  <p className="history-late-warning" role="alert">
                    {c.lateWarning}
                  </p>
                )}
              </div>
              <span className={`history-slot-status ${slot.status}`}>
                {slotStatus(slot, language)}
              </span>
            </article>
          ))}
        </div>
      </section>

      <div className="history-safety-note">{c.privacy}</div>
      <button
        className="danger-text-button history-delete"
        type="button"
        onClick={() => void deleteRecord()}
      >
        {c.delete}
      </button>
    </main>
  );
}

function ActiveSettlementCard({
  session,
  language,
  onOpen,
}: {
  readonly session: SettlementSession;
  readonly language: Language;
  readonly onOpen: () => void;
}) {
  const c = copy(language);
  const progress = getSettlementProgress(session);
  const complete = progress.completedCount === progress.totalCount;
  return (
    <section className="history-active-section">
      <h2>{c.active}</h2>
      <button className="history-active-card" type="button" onClick={onOpen}>
        <div>
          <span>{session.overallNote || c.active}</span>
          <strong>
            {formatAmount(session.inputMode, session.totalAmount, language)}
          </strong>
          <small>
            {complete
              ? c.activeComplete
              : `${progress.completedCount}/${progress.totalCount} ${language === "ko" ? "명 완료" : "complete"}`}
          </small>
        </div>
        <span>{c.openActive} ›</span>
      </button>
      {!complete && <p className="history-active-help">{c.activeHelp}</p>}
    </section>
  );
}

export function SettlementHistoryScreen({
  records,
  activeSession,
  error,
  language,
  onClose,
  onOpenActive,
  onDelete,
}: {
  readonly records: readonly SettlementHistoryRecord[];
  readonly activeSession: SettlementSession | null;
  readonly error: string | undefined;
  readonly language: Language;
  readonly onClose: () => void;
  readonly onOpenActive: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const c = copy(language);
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRecord = records.find((record) => record.id === selectedId);
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
        language={language}
        onBack={() => setSelectedId(undefined)}
        onDelete={onDelete}
      />
    );
  }

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onClose}>
          ←<span className="sr-only">Lightning Split</span>
        </button>
        <div>
          <span className="eyebrow">{c.localHistory}</span>
          <h1>{c.history}</h1>
        </div>
      </header>

      <p className="history-storage-note">{c.storage}</p>

      {error && (
        <div className="global-warning" role="alert">
          {error}
        </div>
      )}

      {activeSession && (
        <ActiveSettlementCard
          session={activeSession}
          language={language}
          onOpen={onOpenActive}
        />
      )}

      {groups.length === 0 ? (
        <section className="history-empty">
          <strong>{c.emptyTitle}</strong>
          <span>{c.emptyHelp}</span>
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
                            : `${record.totalPeople}-person settlement`)}
                      </span>
                      <strong>
                        {formatAmount(
                          record.inputMode,
                          record.totalAmount,
                          language,
                        )}
                      </strong>
                      <small>{shortDate(record.createdAt, language)}</small>
                    </div>
                    <span className="history-record-status">
                      {recordStatus(record, language)}
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
