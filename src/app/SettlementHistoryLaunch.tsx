import type { Language } from "./preferences";
import "./SettlementHistory.css";

export function SettlementHistoryLaunch({
  count,
  hasActiveSettlement,
  language,
  onOpen,
}: {
  readonly count: number;
  readonly hasActiveSettlement: boolean;
  readonly language: Language;
  readonly onOpen: () => void;
}) {
  return (
    <button className="history-nav-card" type="button" onClick={onOpen}>
      <span className="history-nav-copy">
        <strong>
          {language === "ko" ? "정산 기록" : "Settlement history"}
        </strong>
        <small>
          {hasActiveSettlement
            ? language === "ko"
              ? "진행 중인 정산과 지난 내역을 확인합니다."
              : "View the active settlement and past history."
            : language === "ko"
              ? "지난 정산 내역을 확인합니다."
              : "View past settlement history."}
        </small>
      </span>
      <span className="history-nav-meta" aria-hidden="true">
        {count > 0 ? `${count}${language === "ko" ? "건" : ""}` : ""}
        <span>›</span>
      </span>
    </button>
  );
}
