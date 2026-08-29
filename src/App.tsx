import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PriceSnapshotDto } from "./api/serialization";
import { requestInvoiceBatch } from "./app/api";
import { copyTextToClipboard, readTextFromClipboard } from "./app/clipboard";
import {
  isLightningInvoiceInput,
  LIGHTNING_INVOICE_INPUT_MESSAGE,
} from "./app/lightningInput";
import { parseParticipantNameCandidates } from "./app/nameCandidates";
import {
  clearActiveSession,
  loadActiveSession,
  saveActiveSession,
} from "./app/persistence";
import { QrCode } from "./app/QrCode";
import {
  annotateSettledSlot,
  applyBatchResponse,
  applySlotRetryResponse,
  collectIssuedPaymentHashes,
  createGeneratingSession,
  createSettlementPreview,
  getSettlementProgress,
  manuallyConfirmSlot,
  markExpiredSlots,
  prepareSlotRetry,
  type DraftInput,
} from "./app/session";
import type { ClientSlot, SettlementSession } from "./app/types";
import {
  useMarketInformation,
  type MarketInformationState,
} from "./app/useMarketInformation";
import { toUserMessage } from "./app/userMessage";
import { useSettlementPolling } from "./app/useSettlementPolling";
import type { InputMode } from "./domain/models";
import "./styles.css";

const integerFormatter = new Intl.NumberFormat("ko-KR");
const formatInteger = (value: bigint) => integerFormatter.format(Number(value));

function formatPriceTime(snapshot: PriceSnapshotDto): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(snapshot.retrievedAt)) / 1_000),
  );
  return seconds < 60 ? "방금 전" : `${Math.floor(seconds / 60)}분 전`;
}

function formatPremium(basisPoints: string): string {
  const value = BigInt(basisPoints);
  const absolute = value < 0n ? -value : value;
  const sign = value > 0n ? "+" : value < 0n ? "−" : "";
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}%`;
}

function formatAmountRange(values: readonly bigint[], unit: string): string {
  if (values.length === 0) return `0${unit}`;
  const minimum = values.reduce((result, value) =>
    value < result ? value : result,
  );
  const maximum = values.reduce((result, value) =>
    value > result ? value : result,
  );
  return minimum === maximum
    ? `${formatInteger(minimum)}${unit}`
    : `${formatInteger(minimum)}~${formatInteger(maximum)}${unit}`;
}

function formatRemainingTime(expiresAt: string, nowMs: number): string {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - nowMs) / 1_000),
  );
  if (seconds === 0) return "만료됨";
  if (seconds < 60) return `${seconds}초 남음`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}분 남음`;
  return `${Math.ceil(minutes / 60)}시간 남음`;
}

function slotStatus(slot: ClientSlot): { label: string; tone: string } {
  if (slot.status === "generating")
    return { label: "결제 요청 생성 중", tone: "working" };
  if (slot.status === "settled") return { label: "결제 완료", tone: "done" };
  if (slot.status === "manuallyConfirmed")
    return { label: "사용자 확인", tone: "manual" };
  if (slot.status === "expired") return { label: "만료", tone: "muted" };
  if (slot.status === "failed") return { label: "생성 실패", tone: "error" };
  return slot.invoice?.verificationToken
    ? { label: "결제 대기 · 자동 확인 중", tone: "waiting" }
    : { label: "결제 대기 · 사용자 확인 필요", tone: "waiting" };
}

function ExpiryCountdown({ expiresAt }: { readonly expiresAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="expiry" aria-live="polite">
      {formatRemainingTime(expiresAt, nowMs)} ·{" "}
      {new Date(expiresAt).toLocaleString("ko-KR")}까지
    </p>
  );
}

export function InvoiceCard({
  slot,
  candidates,
  retrying,
  onAnnotate,
  onRetry,
  onManualConfirm,
}: {
  readonly slot: ClientSlot;
  readonly candidates: readonly string[];
  readonly retrying: boolean;
  readonly onAnnotate: (slotNumber: number, displayName: string) => void;
  readonly onRetry: (slotNumber: number) => void;
  readonly onManualConfirm: (slotNumber: number) => void;
}) {
  const status = slotStatus(slot);
  const [copyFeedback, setCopyFeedback] = useState<string>();
  const completed =
    slot.status === "settled" || slot.status === "manuallyConfirmed";
  const copyInvoice = async () => {
    if (!slot.invoice) return;
    const copied = await copyTextToClipboard(slot.invoice.bolt11);
    setCopyFeedback(
      copied
        ? "결제 요청을 복사했습니다."
        : "자동 복사에 실패했습니다. 결제 요청을 길게 눌러 복사하십시오.",
    );
  };

  return (
    <article
      className="invoice-card"
      aria-label={`${slot.slotNumber}번 결제, ${status.label}`}
    >
      <div className="card-head">
        <div>
          <span className="slot-number">{slot.slotNumber}번</span>
          <strong>
            {slot.krwShare
              ? `${formatInteger(BigInt(slot.krwShare))}원`
              : `${formatInteger(BigInt(slot.targetSats))} sats`}
          </strong>
        </div>
        <span
          className={`status-pill ${status.tone}`}
          role="status"
          aria-live="polite"
        >
          {status.label}
        </span>
      </div>
      {slot.krwShare && (
        <p className="sats-line">
          {formatInteger(BigInt(slot.targetSats))} sats
        </p>
      )}

      {slot.invoice && slot.status !== "expired" && (
        <>
          <div className="qr-shell">
            <QrCode invoice={slot.invoice.bolt11} />
          </div>
          <button
            className="secondary-button full"
            type="button"
            onClick={() => void copyInvoice()}
          >
            결제 요청 복사
          </button>
          <div className="copy-feedback" aria-live="polite">
            {copyFeedback}
          </div>
          {slot.status === "pending" && (
            <ExpiryCountdown expiresAt={slot.invoice.expiresAt} />
          )}
        </>
      )}

      {slot.status === "generating" && (
        <div className="loading-panel" aria-live="polite">
          안전하게 결제 요청을 확인하고 있습니다.
        </div>
      )}
      {slot.status === "failed" && (
        <div className="error-panel" role="alert">
          <strong>결제 요청을 만들지 못했습니다.</strong>
          <span>다른 결제의 성공 결과는 그대로 유지됩니다.</span>
          <button
            className="secondary-button"
            type="button"
            disabled={retrying}
            onClick={() => onRetry(slot.slotNumber)}
          >
            {retrying ? "다시 만드는 중…" : "이 결제만 다시 만들기"}
          </button>
        </div>
      )}
      {slot.status === "expired" && (
        <div className="expired-panel">
          <strong>이 QR은 만료되었습니다.</strong>
          <span>다른 결제는 유지하고 이 결제만 새로 만들 수 있습니다.</span>
          <button
            className="secondary-button"
            type="button"
            disabled={retrying}
            onClick={() => onRetry(slot.slotNumber)}
          >
            {retrying ? "다시 만드는 중…" : "새 결제 요청 만들기"}
          </button>
        </div>
      )}
      {slot.status === "pending" &&
        slot.invoice &&
        !slot.invoice.verificationToken && (
          <div className="manual-panel">
            <strong>자동 결제 확인을 지원하지 않는 주소입니다.</strong>
            <span>실제 입금을 직접 확인한 뒤에만 표시하십시오.</span>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onManualConfirm(slot.slotNumber)}
            >
              결제 완료로 표시
            </button>
          </div>
        )}
      {completed && (
        <div className="annotation-panel">
          <label>
            누가 보냈나요? <span>선택</span>
            <input
              value={slot.annotation?.displayName ?? ""}
              onChange={(event) =>
                onAnnotate(slot.slotNumber, event.target.value)
              }
              placeholder="이름을 입력하십시오"
            />
          </label>
          {candidates.length > 0 && (
            <div className="candidate-list" aria-label="참여자 이름 후보">
              {candidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate}
                  aria-pressed={slot.annotation?.displayName === candidate}
                  onClick={() => onAnnotate(slot.slotNumber, candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>
          )}
          <p>
            이 이름은 사용자가 붙인 표시정보이며 라이트닝 네트워크가 인증한
            송금자 신원이 아닙니다.
          </p>
        </div>
      )}
    </article>
  );
}

export function MarketSummary({
  market,
}: {
  readonly market: MarketInformationState;
}) {
  const information = market.information;
  const status =
    market.connection === "live"
      ? "실시간"
      : market.connection === "recent"
        ? "최근 시세 · 실시간 연결 중"
        : market.connection === "stale"
          ? "시세 지연"
          : market.connection === "unavailable"
            ? "시세 확인 필요"
            : "시세 연결 중";
  return (
    <section className="market-summary" aria-label="현재 비트코인 시장정보">
      <div className="market-summary-head">
        <span>현재 시장</span>
        <span
          className={`market-status ${market.connection}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </span>
      </div>
      <div className="market-values">
        <div>
          <span>BTC/KRW</span>
          <strong>
            {information
              ? `${formatInteger(BigInt(information.snapshot.priceKrw))}원`
              : "확인 중…"}
          </strong>
        </div>
        <div>
          <span>김치프리미엄</span>
          <strong>
            {information?.premium
              ? formatPremium(information.premium.basisPoints)
              : "정보 없음"}
          </strong>
        </div>
      </div>
      <small>
        {information
          ? `최근 가격 ${formatPriceTime(information.snapshot)}`
          : market.error || "시세를 확인하고 있습니다."}
      </small>
    </section>
  );
}

export function SettlementHeader({
  note,
  onNewSettlement,
}: {
  readonly note: string | undefined;
  readonly onNewSettlement: () => void;
}) {
  return (
    <header className="result-header">
      <div className="brand-mark">ϟ</div>
      <div>
        <span className="eyebrow">LIGHTNING SPLIT</span>
        <h1>{note || "정산 진행 중"}</h1>
        {note && <small>정산 메모</small>}
      </div>
      <button
        className="text-button touch-target"
        type="button"
        onClick={onNewSettlement}
      >
        새 정산
      </button>
    </header>
  );
}

export function AmountInput({
  inputMode,
  totalAmount,
  onInputModeChange,
  onTotalAmountChange,
}: {
  readonly inputMode: InputMode;
  readonly totalAmount: string;
  readonly onInputModeChange: (mode: InputMode) => void;
  readonly onTotalAmountChange: (amount: string) => void;
}) {
  return (
    <>
      <div className="field-head">
        <label htmlFor="amount">총 금액</label>
        <div className="unit-switch" role="group" aria-label="금액 단위">
          <button
            type="button"
            className={inputMode === "krw" ? "active" : ""}
            aria-pressed={inputMode === "krw"}
            onClick={() => onInputModeChange("krw")}
          >
            원
          </button>
          <button
            type="button"
            className={inputMode === "sats" ? "active" : ""}
            aria-pressed={inputMode === "sats"}
            onClick={() => onInputModeChange("sats")}
          >
            sats
          </button>
        </div>
      </div>
      <div className="amount-input">
        <input
          id="amount"
          aria-label="총 금액"
          inputMode="numeric"
          pattern="[0-9]*"
          value={totalAmount}
          placeholder="0"
          onChange={(event) =>
            onTotalAmountChange(event.target.value.replace(/\D/gu, ""))
          }
        />
        <span>{inputMode === "krw" ? "원" : "sats"}</span>
      </div>
    </>
  );
}

export function App() {
  const [inputMode, setInputMode] = useState<InputMode>("krw");
  const [totalAmount, setTotalAmount] = useState("");
  const [totalPeople, setTotalPeople] = useState(4);
  const [excludePayer, setExcludePayer] = useState(true);
  const [lightningAddress, setLightningAddress] = useState("");
  const [overallNote, setOverallNote] = useState("");
  const [candidateText, setCandidateText] = useState("");
  const { market, refreshLockedSnapshot } = useMarketInformation();
  const [session, setSession] = useState<SettlementSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryingSlot, setRetryingSlot] = useState<number>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [persistenceError, setPersistenceError] = useState<string>();
  const [restoring, setRestoring] = useState(true);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const carouselRef = useRef<HTMLElement>(null);
  const priceInformation = market.information;
  const priceSnapshot = priceInformation?.snapshot;
  const lightningInvoiceInput = isLightningInvoiceInput(lightningAddress);

  const updateSession = useCallback(
    (updater: (current: SettlementSession) => SettlementSession) => {
      setSession((current) => (current ? updater(current) : current));
    },
    [],
  );
  useSettlementPolling(session, updateSession);

  const refreshPrice = useCallback(async () => {
    return (await refreshLockedSnapshot()).snapshot;
  }, [refreshLockedSnapshot]);

  useEffect(() => {
    void loadActiveSession()
      .then((stored) => {
        if (stored) {
          setActiveSlotIndex(0);
          setSession(markExpiredSlots(stored));
        }
      })
      .catch(() =>
        setPersistenceError(
          "저장된 정산을 불러오지 못했습니다. 이 브라우저에서는 자동 복구가 제한될 수 있습니다.",
        ),
      )
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    void saveActiveSession(session)
      .then(() => setPersistenceError(undefined))
      .catch(() =>
        setPersistenceError(
          "정산을 기기에 저장하지 못했습니다. 화면을 닫으면 복구되지 않을 수 있습니다.",
        ),
      );
  }, [session]);

  const draft: DraftInput = useMemo(
    () => ({
      inputMode,
      totalAmount,
      totalPeople,
      excludePayer,
      lightningAddress: lightningAddress.trim(),
      ...(overallNote.trim() ? { overallNote: overallNote.trim() } : {}),
      participantNameCandidates: parseParticipantNameCandidates(candidateText),
    }),
    [
      candidateText,
      excludePayer,
      inputMode,
      lightningAddress,
      overallNote,
      totalAmount,
      totalPeople,
    ],
  );

  const preview = useMemo(() => {
    try {
      return {
        value: createSettlementPreview(draft, priceSnapshot),
        error: undefined,
      };
    } catch (cause) {
      return {
        value: undefined,
        error: cause instanceof Error ? cause.message : "금액을 확인하십시오.",
      };
    }
  }, [draft, priceSnapshot]);

  const startSettlement = async () => {
    if (!lightningAddress.trim()) {
      setError("Lightning Address를 입력하십시오.");
      return;
    }
    if (lightningInvoiceInput) {
      setError(LIGHTNING_INVOICE_INPUT_MESSAGE);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const lockedSnapshot =
        inputMode === "krw" ? await refreshPrice() : undefined;
      const lockedPreview = createSettlementPreview(draft, lockedSnapshot);
      const generating = createGeneratingSession(
        draft,
        lockedPreview,
        lockedSnapshot,
      );
      setActiveSlotIndex(0);
      setSession(generating);
      const response = await requestInvoiceBatch({
        address: draft.lightningAddress,
        slots: generating.slots.map((slot) => ({
          slotNumber: slot.slotNumber,
          targetSats: slot.targetSats,
          attempt: slot.attempt,
          ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),
        })),
      });
      setSession(applyBatchResponse(generating, response));
    } catch (cause) {
      const message = toUserMessage(cause, "정산을 시작하지 못했습니다.");
      setError(message);
      setSession((current) =>
        current
          ? {
              ...current,
              slots: current.slots.map((slot) =>
                slot.status === "generating"
                  ? {
                      ...slot,
                      status: "failed" as const,
                      failure: {
                        code: "BATCH_FAILED",
                        message,
                        retryable: true,
                      },
                    }
                  : slot,
              ),
            }
          : current,
      );
    } finally {
      setBusy(false);
    }
  };

  const retrySlot = async (slotNumber: number) => {
    if (!session) return;
    const excludedPaymentHashes = collectIssuedPaymentHashes(session);
    const excludedInvoices = session.slots.flatMap((slot) =>
      slot.invoice ? [slot.invoice.bolt11] : [],
    );
    let prepared: SettlementSession;
    try {
      prepared = prepareSlotRetry(session, slotNumber);
    } catch (cause) {
      setError(toUserMessage(cause));
      return;
    }
    const target = prepared.slots.find(
      (slot) => slot.slotNumber === slotNumber,
    )!;
    setRetryingSlot(slotNumber);
    setError(undefined);
    setSession(prepared);
    try {
      const response = await requestInvoiceBatch({
        address: prepared.lightningAddress,
        slots: [
          {
            slotNumber: target.slotNumber,
            targetSats: target.targetSats,
            attempt: target.attempt,
            ...(target.krwShare ? { krwShare: target.krwShare } : {}),
          },
        ],
        excludedPaymentHashes,
        excludedInvoices,
      });
      setSession((current) =>
        current
          ? applySlotRetryResponse(
              current,
              slotNumber,
              response,
              excludedPaymentHashes,
              excludedInvoices,
            )
          : current,
      );
    } catch (cause) {
      const message = toUserMessage(
        cause,
        "결제 요청을 다시 만들지 못했습니다.",
      );
      setError(message);
      setSession((current) =>
        current
          ? {
              ...current,
              slots: current.slots.map((slot) =>
                slot.slotNumber === slotNumber && slot.status === "generating"
                  ? {
                      ...slot,
                      status: "failed" as const,
                      failure: {
                        code: "RETRY_FAILED",
                        message,
                        retryable: true,
                      },
                    }
                  : slot,
              ),
            }
          : current,
      );
    } finally {
      setRetryingSlot(undefined);
    }
  };

  const resetSession = async () => {
    try {
      await clearActiveSession();
      setActiveSlotIndex(0);
      setSession(null);
      setError(undefined);
      setPersistenceError(undefined);
    } catch {
      setPersistenceError("기기에 저장된 정산 기록을 삭제하지 못했습니다.");
    }
  };

  const newSettlement = async () => {
    const hasPending = session?.slots.some(
      (slot) => slot.status === "pending" || slot.status === "generating",
    );
    if (
      hasPending &&
      !window.confirm(
        "아직 완료되지 않은 결제가 있습니다. 현재 정산 기록을 지우고 새로 시작하시겠습니까?",
      )
    )
      return;
    await resetSession();
  };

  const deleteSettlementRecord = async () => {
    if (
      window.confirm(
        "이 기기에 저장된 현재 정산 기록을 삭제하시겠습니까? 결제 요청은 취소되지 않습니다.",
      )
    )
      await resetSession();
  };

  const annotate = (slotNumber: number, displayName: string) => {
    updateSession((current) => {
      const existing = current.slots.find(
        (slot) => slot.slotNumber === slotNumber,
      );
      return annotateSettledSlot(current, slotNumber, {
        displayName,
        note: existing?.annotation?.note ?? "",
      });
    });
  };

  const manualConfirm = (slotNumber: number) => {
    if (
      !window.confirm(
        "실제 입금을 직접 확인했습니까? 이 표시는 Lightning 네트워크가 검증한 결과가 아닙니다.",
      )
    )
      return;
    updateSession((current) => manuallyConfirmSlot(current, slotNumber));
  };

  const pasteLightningAddress = async () => {
    const pasted = await readTextFromClipboard();
    if (!pasted) {
      setNotice(
        "자동 붙여넣기를 사용할 수 없습니다. 입력칸을 길게 눌러 직접 붙여넣으십시오.",
      );
      return;
    }
    setLightningAddress(pasted);
    setNotice(
      isLightningInvoiceInput(pasted)
        ? LIGHTNING_INVOICE_INPUT_MESSAGE
        : "Lightning Address를 붙여넣었습니다.",
    );
  };

  const moveCarousel = (nextIndex: number) => {
    if (!session) return;
    const index = Math.min(Math.max(nextIndex, 0), session.slots.length - 1);
    setActiveSlotIndex(index);
    const card = carouselRef.current?.children.item(index);
    if (card instanceof HTMLElement)
      card.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
  };

  const trackCarouselPosition = () => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    const center = carousel.scrollLeft + carousel.clientWidth / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    [...carousel.children].forEach((child, index) => {
      if (!(child instanceof HTMLElement)) return;
      const distance = Math.abs(
        child.offsetLeft + child.offsetWidth / 2 - center,
      );
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    setActiveSlotIndex(closestIndex);
  };

  if (restoring)
    return (
      <main className="app-shell loading-screen" aria-live="polite">
        정산을 불러오고 있습니다.
      </main>
    );

  if (session) {
    const progress = getSettlementProgress(session);
    const progressPercent =
      progress.totalCount === 0
        ? 0
        : (progress.completedCount / progress.totalCount) * 100;
    return (
      <main className="app-shell">
        <MarketSummary market={market} />
        <SettlementHeader
          note={session.overallNote}
          onNewSettlement={() => void newSettlement()}
        />
        <section className="progress-card" aria-live="polite">
          <div className="progress-main">
            <strong>
              {progress.completedCount} / {progress.totalCount}명 완료
            </strong>
            <span>
              {formatInteger(progress.completedSats)} /{" "}
              {formatInteger(progress.totalSats)} sats
            </span>
          </div>
          {session.inputMode === "krw" && (
            <p>
              {formatInteger(progress.completedKrw)}원 /{" "}
              {formatInteger(progress.totalKrw)}원 상당 정산 완료
            </p>
          )}
          {progress.manuallyConfirmedCount > 0 && (
            <p className="manual-progress">
              사용자 확인 {progress.manuallyConfirmedCount}명 포함
            </p>
          )}
          <div
            className="progress-track"
            role="progressbar"
            aria-label="전체 정산 진행률"
            aria-valuemin={0}
            aria-valuemax={progress.totalCount}
            aria-valuenow={progress.completedCount}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          {session.priceSnapshot && (
            <small>
              고정 기준가격{" "}
              {formatInteger(BigInt(session.priceSnapshot.priceKrw))}원 ·{" "}
              {new Date(session.priceSnapshot.snapshotAt).toLocaleTimeString(
                "ko-KR",
              )}
            </small>
          )}
        </section>
        {persistenceError && (
          <div className="global-warning" role="alert">
            {persistenceError}
          </div>
        )}
        {error && (
          <div className="global-error" role="alert">
            {error}
          </div>
        )}
        <nav className="carousel-controls" aria-label="결제 QR 이동">
          <button
            type="button"
            aria-label="이전 결제"
            disabled={activeSlotIndex === 0}
            onClick={() => moveCarousel(activeSlotIndex - 1)}
          >
            ‹
          </button>
          <strong aria-live="polite">
            {activeSlotIndex + 1} / {session.slots.length}
          </strong>
          <button
            type="button"
            aria-label="다음 결제"
            disabled={activeSlotIndex === session.slots.length - 1}
            onClick={() => moveCarousel(activeSlotIndex + 1)}
          >
            ›
          </button>
        </nav>
        <section
          ref={carouselRef}
          className="invoice-carousel"
          aria-label="정산 결제 QR"
          onScroll={trackCarouselPosition}
        >
          {session.slots.map((slot) => (
            <InvoiceCard
              key={`${slot.slotNumber}-${slot.attempt}`}
              slot={slot}
              candidates={session.participantNameCandidates}
              retrying={retryingSlot === slot.slotNumber}
              onAnnotate={annotate}
              onRetry={(slotNumber) => void retrySlot(slotNumber)}
              onManualConfirm={manualConfirm}
            />
          ))}
        </section>
        <p className="swipe-hint">
          버튼이나 좌우 스와이프로 각 QR을 보여주십시오.
        </p>
        <button
          className="danger-text-button"
          type="button"
          onClick={() => void deleteSettlementRecord()}
        >
          이 정산 기록 삭제
        </button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <MarketSummary market={market} />
      <header className="hero">
        <div className="brand-mark large">ϟ</div>
        <span className="eyebrow">LIGHTNING SPLIT</span>
        <h1>
          원화 더치페이를
          <br />
          Lightning으로.
        </h1>
        <p>금액과 인원을 정하면 결제용 QR을 바로 만듭니다.</p>
      </header>
      <section className="form-card">
        <AmountInput
          inputMode={inputMode}
          totalAmount={totalAmount}
          onInputModeChange={setInputMode}
          onTotalAmountChange={setTotalAmount}
        />
        <div className="people-row">
          <div>
            <label htmlFor="people">전체 인원</label>
            <small>나를 포함합니다</small>
          </div>
          <div className="stepper">
            <button
              type="button"
              aria-label="인원 줄이기"
              onClick={() => setTotalPeople((value) => Math.max(2, value - 1))}
            >
              −
            </button>
            <input
              id="people"
              aria-label="전체 인원"
              type="number"
              min="2"
              max="10"
              value={totalPeople}
              onChange={(event) => setTotalPeople(Number(event.target.value))}
            />
            <button
              type="button"
              aria-label="인원 늘리기"
              onClick={() => setTotalPeople((value) => Math.min(10, value + 1))}
            >
              ＋
            </button>
          </div>
        </div>
        <label className="payer-toggle">
          <input
            type="checkbox"
            checked={excludePayer}
            onChange={(event) => setExcludePayer(event.target.checked)}
          />
          <span>
            <strong>내가 전체 금액을 결제했어요</strong>
            <small>내 몫을 제외한 사람에게만 QR을 만듭니다</small>
          </span>
        </label>
        <label className="stacked-field">
          내 Lightning Address
          <span className="input-with-action">
            <input
              type="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={lightningAddress}
              aria-invalid={lightningInvoiceInput}
              aria-describedby="lightning-address-feedback"
              onChange={(event) => {
                setLightningAddress(event.target.value);
                setNotice(undefined);
              }}
              placeholder="name@example.com"
            />
            <button type="button" onClick={() => void pasteLightningAddress()}>
              붙여넣기
            </button>
          </span>
          <small
            id="lightning-address-feedback"
            className={`field-feedback ${lightningInvoiceInput ? "input-error" : ""}`}
            aria-live="polite"
          >
            {lightningInvoiceInput ? LIGHTNING_INVOICE_INPUT_MESSAGE : notice}
          </small>
        </label>
        <details className="optional-fields">
          <summary>
            메모와 참여자 이름 추가 <span>선택</span>
          </summary>
          <label className="stacked-field">
            정산 메모
            <input
              value={overallNote}
              onChange={(event) => setOverallNote(event.target.value)}
              placeholder="예: 8/30 고깃집 저녁"
              maxLength={120}
            />
            <small>이 메모는 앱 내부에만 저장됩니다.</small>
          </label>
          <label className="stacked-field">
            참여자 이름 미리 입력 (선택)
            <textarea
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
              placeholder="민수, 철수, 영희"
              rows={2}
            />
            <small>
              쉼표·줄바꿈을 권장합니다. 구분자가 없으면 공백으로 나눕니다. 결제
              후 누가 보냈는지 표시할 때만 사용합니다.
            </small>
          </label>
        </details>
      </section>
      <section className="preview-card" aria-live="polite">
        <div className="section-title">
          <div>
            <span className="eyebrow">확인</span>
            <h2>정산 시작 전 확인</h2>
          </div>
          {priceSnapshot && inputMode === "krw" && (
            <button
              className="text-button touch-target"
              type="button"
              onClick={() => void refreshPrice().catch(() => undefined)}
            >
              가격 새로고침
            </button>
          )}
        </div>
        {priceSnapshot && inputMode === "krw" && (
          <p className="price-line">
            BTC 기준가격{" "}
            <strong>{formatInteger(BigInt(priceSnapshot.priceKrw))}원</strong> ·{" "}
            {formatPriceTime(priceSnapshot)}
          </p>
        )}
        {market.error && <p className="inline-error">{market.error}</p>}
        {preview.value ? (
          <>
            <div className="preview-grid">
              <div>
                <span>총 금액</span>
                <strong>
                  {totalAmount ? formatInteger(BigInt(totalAmount)) : "0"}
                  {inputMode === "krw" ? "원" : " sats"}
                </strong>
              </div>
              <div>
                <span>전체 인원</span>
                <strong>{totalPeople}명</strong>
              </div>
              <div>
                <span>정산받을 인원</span>
                <strong>{preview.value.invoiceCount}명</strong>
              </div>
              {inputMode === "krw" && preview.value.payerShareKrw !== null && (
                <div>
                  <span>내 최종 부담</span>
                  <strong>
                    {formatInteger(preview.value.payerShareKrw)}원
                  </strong>
                </div>
              )}
              <div>
                <span>사람별 원화 몫</span>
                <strong>
                  {inputMode === "krw"
                    ? formatAmountRange(preview.value.invoiceShares, "원")
                    : "직접 입력 기준"}
                </strong>
              </div>
              <div>
                <span>QR별 결제 금액</span>
                <strong>
                  {formatAmountRange(preview.value.targetSats, " sats")}
                </strong>
              </div>
              {inputMode === "krw" && priceSnapshot && (
                <div className="wide-preview-item">
                  <span>가격 확인 시각</span>
                  <strong>
                    {new Date(priceSnapshot.snapshotAt).toLocaleString("ko-KR")}
                  </strong>
                </div>
              )}
            </div>
            <p className="preview-note">
              {inputMode === "krw"
                ? "정산 시작 시 가격을 한 번 더 확인해 고정하며 이후 결제 금액은 바뀌지 않습니다."
                : "입력한 총 sats를 정확히 나누고 남는 1 sat은 앞 번호부터 배분합니다."}
            </p>
          </>
        ) : (
          <p className="inline-error">{preview.error}</p>
        )}
      </section>
      {persistenceError && (
        <div className="global-warning" role="alert">
          {persistenceError}
        </div>
      )}
      {error && (
        <div className="global-error" role="alert">
          {error}
        </div>
      )}
      <button
        className="primary-button"
        type="button"
        disabled={busy || !preview.value || lightningInvoiceInput}
        onClick={() => void startSettlement()}
      >
        {busy ? "결제 요청 만드는 중…" : "정산 시작"}
      </button>
      <p className="privacy-note">계정·수탁·서버 영구 저장 없이 동작합니다.</p>
    </main>
  );
}
