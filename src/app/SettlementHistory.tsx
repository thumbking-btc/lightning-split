import { useMemo, useState } from "react";

import {
  isCompletedHistorySlot,
  type SettlementHistoryRecord,
  type SettlementHistorySlot,
} from "./settlementHistory";
import "./SettlementHistory.css";

const integerFormatter = new Intl.NumberFormat("ko-KR");

function formatInteger(value: string): string {
  return integerFormatter.format(Number(BigInt(value)));
}

function formatRecordAmount(record: SettlementHistoryRecord): string {
  return record.inputMode === "krw"
    ? `${formatInteger(record.totalAmount)}원`
    : `${formatInteger(record.totalAmount)} sats`;
}

function formatSlotAmount(slot: SettlementHistorySlot): string {
  return slot.krwShare
    ? `${formatInteger(slot.krwShare)}원 · ${formatInteger(slot.targetSats)} sats`
    : `${formatInteger(slot.targetSats)} sats`;
}

function completedCount(record: SettlementHistoryRecord): number {
  return record.slots.filter(isCompletedHistorySlot).length;
}

function recordStatus(record: SettlementHistoryRecord): string {
  const completed = completedCount(record);
  if (completed === record.invoiceCount) return "정산완료";
  if (completed > 0) return `${completed}/${record.invoiceCount} 완료`;
  return "미완료";
}

function slotStatus(slot: SettlementHistorySlot): string {
  if (slot.status === "settled") return "자동 확인 완료";
  if (slot.status === "manuallyConfirmed") return "직접 확인 완료";
  if (slot.status === "legacyReviewRequired") return "확인 필요";
  if (slot.status === "expired") return "만료";
  if (slot.status === "failed") return "생성 실패";
  return "미완료";
}

function monthLabel(createdAt: string): string {
  const date = new Date(createdAt);
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function shortDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function SettlementHistoryDetail({
  record,
  onBack,
  onDelete,
}: {
  readonly record: SettlementHistoryRecord;
  readonly onBack: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const deleteRecord = async () => {
    if (
      !window.confirm(
        "이 기기에서 이 정산 기록을 삭제하시겠습니까? 이미 완료된 실제 Lightning 결제에는 영향을 주지 않습니다.",
      )
    ) {
      return;
    }
    if (await onDelete(record.id)) onBack();
  };

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onBack}>
          ←<span className="sr-only">정산 기록 목록으로</span>
        </button>
        <div>
          <span className="eyebrow">정산 기록</span>
          <h1>{record.overallNote || "정산 상세"}</h1>
        </div>
      </header>

      <section className="history-detail-summary">
        <span>{new Date(record.createdAt).toLocaleString("ko-KR")}</span>
        <strong>{formatRecordAmount(record)}</strong>
        <p>
          전체 {record.totalPeople}명 · 결제 요청 {record.invoiceCount}명 ·{" "}
          {recordStatus(record)}
        </p>
      </section>

      <section className="history-detail-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">참여자별 상태</span>
            <h2>정산 내역</h2>
          </div>
        </div>
        <div className="history-slot-list">
          {record.slots.map((slot) => (
            <article className="history-slot" key={slot.slotNumber}>
              <div>
                <strong>
                  {slot.displayName?.trim() || `${slot.slotNumber}번 결제`}
                </strong>
                <span>{formatSlotAmount(slot)}</span>
                {slot.completedAt && (
                  <small>
                    {new Date(slot.completedAt).toLocaleString("ko-KR")}
                  </small>
                )}
              </div>
              <span className={`history-slot-status ${slot.status}`}>
                {slotStatus(slot)}
              </span>
            </article>
          ))}
        </div>
      </section>

      <div className="history-safety-note">
        과거 기록에는 결제용 QR과 Lightning invoice 원문을 보관하지 않습니다. 이
        화면의 기록은 과거 결제 요청을 다시 결제하거나 공유하는 용도로 사용할 수
        없습니다.
      </div>

      <button
        className="danger-text-button history-delete"
        type="button"
        onClick={() => void deleteRecord()}
      >
        이 정산 기록 삭제
      </button>
    </main>
  );
}

export function SettlementHistoryScreen({
  records,
  error,
  onClose,
  onDelete,
}: {
  readonly records: readonly SettlementHistoryRecord[];
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onDelete: (id: string) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRecord = records.find((record) => record.id === selectedId);
  const groups = useMemo(() => {
    const result = new Map<string, SettlementHistoryRecord[]>();
    for (const record of records) {
      const label = monthLabel(record.createdAt);
      const group = result.get(label) ?? [];
      group.push(record);
      result.set(label, group);
    }
    return [...result.entries()];
  }, [records]);

  if (selectedRecord) {
    return (
      <SettlementHistoryDetail
        record={selectedRecord}
        onBack={() => setSelectedId(undefined)}
        onDelete={onDelete}
      />
    );
  }

  return (
    <main className="app-shell history-screen">
      <header className="history-header">
        <button className="history-back" type="button" onClick={onClose}>
          ←<span className="sr-only">정산 화면으로</span>
        </button>
        <div>
          <span className="eyebrow">LOCAL HISTORY</span>
          <h1>정산 기록</h1>
        </div>
      </header>

      <p className="history-storage-note">
        정산 기록은 계정이나 서버가 아니라 이 브라우저의 기기 저장공간에만
        보관됩니다.
      </p>

      {error && (
        <div className="global-warning" role="alert">
          {error}
        </div>
      )}

      {groups.length === 0 ? (
        <section className="history-empty">
          <strong>아직 저장된 정산 기록이 없습니다.</strong>
          <span>새 정산을 시작하면 이전 정산이 이곳에 보관됩니다.</span>
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
                        {record.overallNote || `${record.totalPeople}명 정산`}
                      </span>
                      <strong>{formatRecordAmount(record)}</strong>
                      <small>{shortDate(record.createdAt)}</small>
                    </div>
                    <span className="history-record-status">
                      {recordStatus(record)}
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
