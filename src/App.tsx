import { useCallback, useEffect, useMemo, useState } from "react";

import type { PriceSnapshotDto } from "./api/serialization";
import {
  ApiClientError,
  fetchPriceSnapshot,
  requestInvoiceBatch,
} from "./app/api";
import {
  clearActiveSession,
  loadActiveSession,
  saveActiveSession,
} from "./app/persistence";
import { QrCode } from "./app/QrCode";
import {
  annotateSettledSlot,
  applyBatchResponse,
  createGeneratingSession,
  createSettlementPreview,
  getSettlementProgress,
  markExpiredSlots,
  type DraftInput,
} from "./app/session";
import type { ClientSlot, SettlementSession } from "./app/types";
import { useSettlementPolling } from "./app/useSettlementPolling";
import type { InputMode } from "./domain/models";
import "./styles.css";

const integerFormatter = new Intl.NumberFormat("ko-KR");

function formatInteger(value: bigint): string {
  return integerFormatter.format(Number(value));
}

function formatPriceTime(snapshot: PriceSnapshotDto): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(snapshot.retrievedAt)) / 1_000),
  );
  return elapsedSeconds < 60
    ? "방금 전"
    : `${Math.floor(elapsedSeconds / 60)}분 전`;
}

function parseNameCandidates(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/u)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

function slotStatus(slot: ClientSlot): { label: string; tone: string } {
  if (slot.status === "generating")
    return { label: "인보이스 생성 중", tone: "working" };
  if (slot.status === "settled") return { label: "결제 완료", tone: "done" };
  if (slot.status === "expired") return { label: "만료", tone: "muted" };
  if (slot.status === "failed") return { label: "생성 실패", tone: "error" };
  if (!slot.invoice?.verificationToken)
    return { label: "결제 대기 · 자동 확인 미지원", tone: "waiting" };
  return { label: "결제 대기 · 자동 확인 중", tone: "waiting" };
}

function InvoiceCard({
  slot,
  candidates,
  onAnnotate,
}: {
  readonly slot: ClientSlot;
  readonly candidates: readonly string[];
  readonly onAnnotate: (
    slotNumber: number,
    displayName: string,
    note: string,
  ) => void;
}) {
  const status = slotStatus(slot);
  const copyInvoice = async () => {
    if (slot.invoice) await navigator.clipboard.writeText(slot.invoice.bolt11);
  };

  return (
    <article className="invoice-card">
      <div className="card-head">
        <div>
          <span className="slot-number">{slot.slotNumber}번</span>
          <strong>
            {slot.krwShare
              ? `${formatInteger(BigInt(slot.krwShare))}원`
              : `${formatInteger(BigInt(slot.targetSats))} sats`}
          </strong>
        </div>
        <span className={`status-pill ${status.tone}`}>{status.label}</span>
      </div>
      {slot.krwShare && (
        <p className="sats-line">
          {formatInteger(BigInt(slot.targetSats))} sats
        </p>
      )}

      {slot.invoice && (
        <>
          <div className="qr-shell">
            <QrCode invoice={slot.invoice.bolt11} />
          </div>
          <button
            className="secondary-button full"
            type="button"
            onClick={() => void copyInvoice()}
          >
            인보이스 복사
          </button>
          <p className="expiry">
            {new Date(slot.invoice.expiresAt).toLocaleString("ko-KR")}까지
          </p>
        </>
      )}

      {slot.status === "generating" && (
        <div className="loading-panel">
          안전하게 인보이스를 확인하고 있습니다.
        </div>
      )}
      {slot.status === "failed" && (
        <div className="error-panel">
          <strong>
            {slot.failure?.message ?? "인보이스를 만들지 못했습니다."}
          </strong>
          <span>다른 슬롯의 성공 결과는 그대로 유지됩니다.</span>
        </div>
      )}

      {slot.status === "settled" && (
        <div className="annotation-panel">
          <label>
            표시 이름 <span>선택</span>
            <input
              value={slot.annotation?.displayName ?? ""}
              onChange={(event) =>
                onAnnotate(
                  slot.slotNumber,
                  event.target.value,
                  slot.annotation?.note ?? "",
                )
              }
              placeholder="예: 철수"
            />
          </label>
          {candidates.length > 0 && (
            <div className="candidate-list" aria-label="참여자 이름 후보">
              {candidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate}
                  onClick={() =>
                    onAnnotate(
                      slot.slotNumber,
                      candidate,
                      slot.annotation?.note ?? "",
                    )
                  }
                >
                  {candidate}
                </button>
              ))}
            </div>
          )}
          <label>
            결제 메모 <span>선택</span>
            <input
              value={slot.annotation?.note ?? ""}
              onChange={(event) =>
                onAnnotate(
                  slot.slotNumber,
                  slot.annotation?.displayName ?? "",
                  event.target.value,
                )
              }
              placeholder="사용자가 붙이는 표시정보"
            />
          </label>
          <p>이름과 메모는 Lightning이 인증한 송금자 정보가 아닙니다.</p>
        </div>
      )}
    </article>
  );
}

export function App() {
  const [inputMode, setInputMode] = useState<InputMode>("krw");
  const [totalAmount, setTotalAmount] = useState("86000");
  const [totalPeople, setTotalPeople] = useState(4);
  const [excludePayer, setExcludePayer] = useState(true);
  const [lightningAddress, setLightningAddress] = useState("");
  const [overallNote, setOverallNote] = useState("");
  const [candidateText, setCandidateText] = useState("");
  const [priceSnapshot, setPriceSnapshot] = useState<PriceSnapshotDto>();
  const [priceError, setPriceError] = useState<string>();
  const [session, setSession] = useState<SettlementSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState(true);

  const updateSession = useCallback(
    (updater: (current: SettlementSession) => SettlementSession) => {
      setSession((current) => (current ? updater(current) : current));
    },
    [],
  );
  useSettlementPolling(session, updateSession);

  const refreshPrice = useCallback(async () => {
    setPriceError(undefined);
    try {
      const snapshot = await fetchPriceSnapshot();
      setPriceSnapshot(snapshot);
      return snapshot;
    } catch (cause) {
      setPriceError(
        cause instanceof Error ? cause.message : "가격을 조회하지 못했습니다.",
      );
      throw cause;
    }
  }, []);

  useEffect(() => {
    void fetchPriceSnapshot()
      .then((snapshot) => setPriceSnapshot(snapshot))
      .catch((cause: unknown) =>
        setPriceError(
          cause instanceof Error
            ? cause.message
            : "가격을 조회하지 못했습니다.",
        ),
      );
    void loadActiveSession()
      .then((stored) => {
        if (stored) setSession(markExpiredSlots(stored));
      })
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (session) void saveActiveSession(session);
  }, [session]);

  const draft: DraftInput = useMemo(
    () => ({
      inputMode,
      totalAmount,
      totalPeople,
      excludePayer,
      lightningAddress: lightningAddress.trim(),
      ...(overallNote.trim() ? { overallNote: overallNote.trim() } : {}),
      participantNameCandidates: parseNameCandidates(candidateText),
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
      const message =
        cause instanceof ApiClientError || cause instanceof Error
          ? cause.message
          : "정산을 시작하지 못했습니다.";
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

  const newSettlement = async () => {
    await clearActiveSession();
    setSession(null);
    setError(undefined);
  };

  const annotate = (slotNumber: number, displayName: string, note: string) => {
    updateSession((current) =>
      annotateSettledSlot(current, slotNumber, { displayName, note }),
    );
  };

  if (restoring) {
    return (
      <main className="app-shell loading-screen">
        정산을 불러오고 있습니다.
      </main>
    );
  }

  if (session) {
    const progress = getSettlementProgress(session);
    return (
      <main className="app-shell">
        <header className="result-header">
          <div className="brand-mark">ϟ</div>
          <div>
            <span className="eyebrow">LIGHTNING SPLIT</span>
            <h1>{session.overallNote || "정산 진행 중"}</h1>
          </div>
          <button
            className="text-button"
            type="button"
            onClick={() => void newSettlement()}
          >
            새 정산
          </button>
        </header>

        <section className="progress-card">
          <div className="progress-main">
            <strong>
              {progress.settledCount} / {progress.totalCount}명 완료
            </strong>
            <span>
              {formatInteger(progress.settledSats)} /{" "}
              {formatInteger(progress.totalSats)} sats
            </span>
          </div>
          {session.inputMode === "krw" && (
            <p>
              {formatInteger(progress.settledKrw)}원 /{" "}
              {formatInteger(progress.totalKrw)}원 상당 정산 완료
            </p>
          )}
          <div className="progress-track">
            <span
              style={{
                width: `${progress.totalCount === 0 ? 0 : (progress.settledCount / progress.totalCount) * 100}%`,
              }}
            />
          </div>
          {session.priceSnapshot && (
            <small>
              고정 기준가격{" "}
              {formatInteger(BigInt(session.priceSnapshot.priceKrw))}원 ·{" "}
              {session.priceSnapshot.source}
            </small>
          )}
        </section>

        {error && <div className="global-error">{error}</div>}
        <section className="invoice-carousel" aria-label="정산 인보이스">
          {session.slots.map((slot) => (
            <InvoiceCard
              key={slot.slotNumber}
              slot={slot}
              candidates={session.participantNameCandidates}
              onAnnotate={annotate}
            />
          ))}
        </section>
        <p className="swipe-hint">옆으로 넘겨 각 QR을 보여주십시오.</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
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
        <div className="field-head">
          <label htmlFor="amount">총 금액</label>
          <div className="unit-switch" role="group" aria-label="금액 단위">
            <button
              type="button"
              className={inputMode === "krw" ? "active" : ""}
              onClick={() => setInputMode("krw")}
            >
              원
            </button>
            <button
              type="button"
              className={inputMode === "sats" ? "active" : ""}
              onClick={() => setInputMode("sats")}
            >
              sats
            </button>
          </div>
        </div>
        <div className="amount-input">
          <input
            id="amount"
            inputMode="numeric"
            pattern="[0-9]*"
            value={totalAmount}
            onChange={(event) =>
              setTotalAmount(event.target.value.replace(/\D/gu, ""))
            }
          />
          <span>{inputMode === "krw" ? "원" : "sats"}</span>
        </div>

        <div className="people-row">
          <div>
            <label htmlFor="people">전체 인원</label>
            <small>나를 포함합니다</small>
          </div>
          <div className="stepper">
            <button
              type="button"
              onClick={() => setTotalPeople((value) => Math.max(2, value - 1))}
            >
              −
            </button>
            <input
              id="people"
              type="number"
              min="2"
              max="10"
              value={totalPeople}
              onChange={(event) => setTotalPeople(Number(event.target.value))}
            />
            <button
              type="button"
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
          <input
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            value={lightningAddress}
            onChange={(event) => setLightningAddress(event.target.value)}
            placeholder="name@example.com"
          />
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
          </label>
          <label className="stacked-field">
            참여자 이름 미리 입력
            <textarea
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
              placeholder="민수, 철수, 영희"
              rows={2}
            />
            <small>
              결제 후 누가 보냈는지 표시할 때 빠르게 선택할 수 있습니다.
            </small>
          </label>
        </details>
      </section>

      <section className="preview-card">
        <div className="section-title">
          <div>
            <span className="eyebrow">미리보기</span>
            <h2>이렇게 정산합니다</h2>
          </div>
          {priceSnapshot && inputMode === "krw" && (
            <button
              className="text-button"
              type="button"
              onClick={() => void refreshPrice().catch(() => undefined)}
            >
              새로고침
            </button>
          )}
        </div>
        {priceSnapshot && (
          <p className="price-line">
            BTC 기준가격{" "}
            <strong>{formatInteger(BigInt(priceSnapshot.priceKrw))}원</strong> ·{" "}
            {formatPriceTime(priceSnapshot)}
            <small>
              {priceSnapshot.source}
              {priceSnapshot.fallbackUsed ? " fallback" : ""}
            </small>
          </p>
        )}
        {priceError && <p className="inline-error">{priceError}</p>}
        {preview.value ? (
          <>
            <div className="preview-grid">
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
                <span>
                  {inputMode === "krw" ? "1인당 원화" : "총 정산 sats"}
                </span>
                <strong>
                  {formatInteger(
                    inputMode === "krw"
                      ? (preview.value.invoiceShares[0] ?? 0n)
                      : preview.value.targetSats.reduce(
                          (total, amount) => total + amount,
                          0n,
                        ),
                  )}
                  {inputMode === "krw" ? "원" : " sats"}
                </strong>
              </div>
              <div>
                <span>첫 invoice</span>
                <strong>
                  {formatInteger(preview.value.targetSats[0] ?? 0n)} sats
                </strong>
              </div>
            </div>
            <p className="preview-note">
              {inputMode === "krw"
                ? "정산을 시작하면 최신 가격으로 한 번 더 확정하며 이후 sats는 바뀌지 않습니다."
                : "입력한 총 sats를 invoice들에 정확히 나누며 나머지는 앞 슬롯부터 1 sat씩 배분합니다."}
            </p>
          </>
        ) : (
          <p className="inline-error">{preview.error}</p>
        )}
      </section>

      {error && <div className="global-error">{error}</div>}
      <button
        className="primary-button"
        type="button"
        disabled={busy || !preview.value}
        onClick={() => void startSettlement()}
      >
        {busy ? "인보이스 만드는 중…" : "정산 시작"}
      </button>
      <p className="privacy-note">계정·수탁·서버 영구 저장 없이 동작합니다.</p>
    </main>
  );
}
