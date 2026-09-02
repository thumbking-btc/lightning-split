import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AmountInput,
  InvoiceCard,
  MarketSummary,
  SettlementHeader,
  SettlementPreviewDetails,
  SettlementRecordDeleteButton,
} from "../App";
import type { UsdPriceSnapshotDto } from "../api/contracts";
import type { PriceSnapshotDto } from "../api/serialization";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import type { InputMode } from "../domain/models";
import { MAX_PEOPLE, MIN_PEOPLE } from "../domain/money";
import { ApiClientError, requestInvoiceBatch } from "./api";
import { scrollCarouselToIndex } from "./carousel";
import { readTextFromClipboard } from "./clipboard";
import { heroLine1For } from "./heroCopy";
import { uiCopy } from "./i18n";
import {
  isLightningInvoiceInput,
  LIGHTNING_INVOICE_INPUT_MESSAGE,
} from "./lightningInput";
import { parseParticipantNameCandidates } from "./nameCandidates";
import {
  clearActiveSession,
  loadActiveSession,
  recoverInterruptedSession,
  saveActiveSession,
  SessionPersistenceConflictError,
} from "./persistence";
import {
  formatUsdCents,
  initialCurrency,
  initialLanguage,
  localeFor,
  saveCurrency,
  saveLanguage,
  type Language,
  usdInputToCents,
} from "./preferences";
import {
  DELETE_PENDING_SETTLEMENT_BLOCKED,
  DELETE_SETTLEMENT_RECORD_CONFIRMATION,
  hasPendingSettlement,
  NEW_SETTLEMENT_PENDING_BLOCKED,
} from "./sessionActions";
import {
  annotateSettledSlot,
  applyBatchResponse,
  applySlotRetryResponse,
  collectIssuedPaymentHashes,
  createGeneratingSession,
  createSettlementPreview,
  duplicateSettledSlotNumbers,
  failPendingInvoicePersistence,
  firstActionableSlotIndex,
  getSettlementProgress,
  manuallyConfirmSlot,
  markExpiredSlots,
  markPendingInvoicesPersisted,
  nextActionableSlotIndex,
  pendingInvoicePersistenceIdentities,
  prepareSlotRetry,
  type DraftInput,
  undoManualConfirmation,
} from "./session";
import {
  archiveCompletedSettlement,
  isSettlementComplete,
} from "./settlementHistory";
import { SettlementHistoryLaunch } from "./SettlementHistoryLaunch";
import { SettlementHistoryScreen } from "./SettlementHistory";
import type { ClientSlot, SettlementSession } from "./types";
import { useMarketInformation } from "./useMarketInformation";
import { useSettlementHistory } from "./useSettlementHistory";
import { useSettlementPolling } from "./useSettlementPolling";
import { useUsdMarketInformation } from "./useUsdMarketInformation";
import { toUserMessage } from "./userMessage";

function formatInteger(value: bigint, language: Language): string {
  return new Intl.NumberFormat(localeFor(language)).format(Number(value));
}

function requestFailure(
  cause: unknown,
  fallbackCode: string,
  message: string,
): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  return {
    code: cause instanceof ApiClientError ? cause.code : fallbackCode,
    message,
    retryable: cause instanceof ApiClientError ? cause.retryable : true,
  };
}

function formatPriceTime(
  snapshot: { readonly retrievedAt: string },
  language: Language,
): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(snapshot.retrievedAt)) / 1_000),
  );
  if (language === "ko") {
    return seconds < 60 ? "방금 전" : `${Math.floor(seconds / 60)}분 전`;
  }
  return seconds < 60 ? "just now" : `${Math.floor(seconds / 60)} min ago`;
}

function displayMarketPrice(
  inputMode: InputMode,
  priceSnapshot: PriceSnapshotDto | undefined,
  usdPriceSnapshot: UsdPriceSnapshotDto | undefined,
  language: Language,
): string | undefined {
  if (inputMode === "krw" && priceSnapshot) {
    return `${formatInteger(BigInt(priceSnapshot.priceKrw), language)}${language === "ko" ? "원" : " KRW"}`;
  }
  if (inputMode === "usd" && usdPriceSnapshot) {
    return formatUsdCents(BigInt(usdPriceSnapshot.priceUsdCents), language);
  }
  return undefined;
}

function LanguageSwitch({
  language,
  onChange,
}: {
  readonly language: Language;
  readonly onChange: (language: Language) => void;
}) {
  const c = uiCopy(language);
  return (
    <div className="language-switch" role="group" aria-label={c.language}>
      <button
        type="button"
        className={language === "ko" ? "active" : ""}
        aria-pressed={language === "ko"}
        onClick={() => onChange("ko")}
      >
        한국어
      </button>
      <button
        type="button"
        className={language === "en" ? "active" : ""}
        aria-pressed={language === "en"}
        onClick={() => onChange("en")}
      >
        English
      </button>
    </div>
  );
}

export function AppWithSettlementHistory() {
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [inputMode, setInputMode] = useState<InputMode>(() =>
    initialCurrency(initialLanguage()),
  );
  const [totalAmount, setTotalAmount] = useState("");
  const [totalPeople, setTotalPeople] = useState(4);
  const [excludePayer, setExcludePayer] = useState(true);
  const [lightningAddress, setLightningAddress] = useState("");
  const [overallNote, setOverallNote] = useState("");
  const [candidateText, setCandidateText] = useState("");
  const [session, setSession] = useState<SettlementSession | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const {
    records: historyRecords,
    error: historyError,
    refresh: refreshHistory,
    deleteRecord: deleteHistoryRecord,
  } = useSettlementHistory();

  const krwMarketEnabled = inputMode === "krw" || session?.inputMode === "krw";
  const usdMarketEnabled = inputMode === "usd" || session?.inputMode === "usd";
  const {
    market,
    prepareForActivation: prepareKrwMarket,
    refreshLockedSnapshot,
  } = useMarketInformation(krwMarketEnabled);
  const {
    market: usdMarket,
    prepareForActivation: prepareUsdMarket,
    refreshLockedSnapshot: refreshLockedUsdSnapshot,
  } = useUsdMarketInformation(usdMarketEnabled);
  const [busy, setBusy] = useState(false);
  const [retryingSlot, setRetryingSlot] = useState<number>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [persistenceError, setPersistenceError] = useState<string>();
  const [restoring, setRestoring] = useState(true);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const activeSlotIndexRef = useRef(0);
  const restoredCarouselIndexRef = useRef<number | undefined>(undefined);
  const carouselRef = useRef<HTMLElement>(null);
  const previousCarouselSessionRef = useRef<{
    readonly id: string;
    readonly statuses: readonly ClientSlot["status"][];
  } | null>(null);
  const sessionEpochRef = useRef(0);
  const retryOperationRef = useRef<string | undefined>(undefined);
  const languageRef = useRef(language);
  const c = uiCopy(language);
  const priceInformation = market.information;
  const priceSnapshot = priceInformation?.snapshot;
  const usdPriceSnapshot = usdMarket.information?.snapshot;
  const lightningInvoiceInput = isLightningInvoiceInput(lightningAddress);
  const lightningInvoiceMessage =
    language === "ko"
      ? LIGHTNING_INVOICE_INPUT_MESSAGE
      : "Enter a Lightning Address instead of a BOLT11 invoice.";

  useEffect(() => {
    languageRef.current = language;
    document.documentElement.lang = language;
  }, [language]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    saveLanguage(next);
  };

  const changeInputMode = (next: InputMode) => {
    if (next === inputMode) return;
    if (next === "krw") prepareKrwMarket();
    if (next === "usd") prepareUsdMarket();
    setInputMode(next);
    saveCurrency(next);
    setTotalAmount("");
    setError(undefined);
  };

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

  const refreshUsdPrice = useCallback(async () => {
    return (await refreshLockedUsdSnapshot()).snapshot;
  }, [refreshLockedUsdSnapshot]);

  useEffect(() => {
    const restoreEpoch = sessionEpochRef.current;
    void loadActiveSession()
      .then((stored) => {
        if (stored && sessionEpochRef.current === restoreEpoch) {
          const recovered = markExpiredSlots(recoverInterruptedSession(stored));
          const restoredIndex = firstActionableSlotIndex(recovered);
          activeSlotIndexRef.current = restoredIndex;
          restoredCarouselIndexRef.current = restoredIndex;
          setActiveSlotIndex(restoredIndex);
          setSession(recovered);
        }
      })
      .catch(() =>
        setPersistenceError(
          languageRef.current === "ko"
            ? "저장된 정산을 불러오지 못했습니다. 이 브라우저에서는 자동 복구가 제한될 수 있습니다."
            : "Could not load the saved settlement. Automatic recovery may be limited in this browser.",
        ),
      )
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const pendingPersistence = pendingInvoicePersistenceIdentities(session);
    void saveActiveSession(session)
      .then(() => {
        setPersistenceError(undefined);
        if (pendingPersistence.length > 0) {
          updateSession((current) =>
            markPendingInvoicesPersisted(current, pendingPersistence),
          );
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof SessionPersistenceConflictError) {
          sessionEpochRef.current += 1;
          retryOperationRef.current = undefined;
          setBusy(false);
          setRetryingSlot(undefined);
          setPersistenceError(
            language === "ko"
              ? "다른 탭의 최신 정산 기록을 불러왔습니다. 한 탭에서 계속 진행하십시오."
              : "A newer settlement from another tab was loaded. Continue in one tab.",
          );
          void loadActiveSession()
            .then((stored) => {
              if (!stored) {
                setSession(null);
                return;
              }
              const recovered = markExpiredSlots(
                recoverInterruptedSession(stored),
              );
              const restoredIndex = firstActionableSlotIndex(recovered);
              activeSlotIndexRef.current = restoredIndex;
              restoredCarouselIndexRef.current = restoredIndex;
              setActiveSlotIndex(restoredIndex);
              setSession(recovered);
            })
            .catch(() => {
              setPersistenceError(
                language === "ko"
                  ? "다른 탭의 최신 정산 기록을 불러오지 못했습니다. 새로고침 후 한 탭에서 계속 진행하십시오."
                  : "Could not load the newer settlement from another tab. Refresh and continue in one tab.",
              );
            });
          return;
        }
        setPersistenceError(
          language === "ko"
            ? "정산을 기기에 저장하지 못했습니다. 화면을 닫으면 복구되지 않을 수 있습니다."
            : "Could not save the settlement on this device. It may not be recoverable after closing the page.",
        );
        if (pendingPersistence.length > 0) {
          updateSession((current) =>
            failPendingInvoicePersistence(current, pendingPersistence),
          );
        }
      });
  }, [language, session, updateSession]);

  const canonicalTotalAmount =
    inputMode === "usd" ? usdInputToCents(totalAmount) : totalAmount;
  const draft: DraftInput = useMemo(
    () => ({
      inputMode,
      totalAmount: canonicalTotalAmount,
      totalPeople,
      excludePayer,
      lightningAddress: lightningAddress.trim(),
      ...(overallNote.trim() ? { overallNote: overallNote.trim() } : {}),
      participantNameCandidates: parseParticipantNameCandidates(candidateText),
    }),
    [
      candidateText,
      canonicalTotalAmount,
      excludePayer,
      inputMode,
      lightningAddress,
      overallNote,
      totalPeople,
    ],
  );

  const preview = useMemo(() => {
    try {
      return {
        value: createSettlementPreview(draft, priceSnapshot, usdPriceSnapshot),
        error: undefined,
      };
    } catch (cause) {
      return {
        value: undefined,
        error:
          cause instanceof Error
            ? cause.message
            : language === "ko"
              ? "금액을 확인하십시오."
              : "Check the amount.",
      };
    }
  }, [draft, language, priceSnapshot, usdPriceSnapshot]);

  const startSettlement = async () => {
    if (!lightningAddress.trim()) {
      setError(c.lightningAddressRequired);
      return;
    }
    if (lightningInvoiceInput) {
      setError(lightningInvoiceMessage);
      return;
    }
    const operationEpoch = sessionEpochRef.current + 1;
    let startedSessionId: string | undefined;
    sessionEpochRef.current = operationEpoch;
    setBusy(true);
    setError(undefined);
    try {
      const lockedSnapshot =
        inputMode === "krw" ? await refreshPrice() : undefined;
      const lockedUsdSnapshot =
        inputMode === "usd" ? await refreshUsdPrice() : undefined;
      if (sessionEpochRef.current !== operationEpoch) return;
      const lockedPreview = createSettlementPreview(
        draft,
        lockedSnapshot,
        lockedUsdSnapshot,
      );
      const generating = createGeneratingSession(
        draft,
        lockedPreview,
        lockedSnapshot,
        lockedUsdSnapshot,
      );
      startedSessionId = generating.id;
      if (sessionEpochRef.current !== operationEpoch) return;
      activeSlotIndexRef.current = 0;
      restoredCarouselIndexRef.current = undefined;
      setActiveSlotIndex(0);
      setSession(generating);
      const response = await requestInvoiceBatch({
        requestId: generating.id,
        address: draft.lightningAddress,
        ...(draft.overallNote ? { providerComment: draft.overallNote } : {}),
        slots: generating.slots.map((slot) => ({
          slotNumber: slot.slotNumber,
          targetSats: slot.targetSats,
          attempt: slot.attempt,
          ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),
        })),
      });
      if (sessionEpochRef.current === operationEpoch) {
        setSession((current) =>
          current?.id === generating.id
            ? applyBatchResponse(current, response)
            : current,
        );
      }
    } catch (cause) {
      if (sessionEpochRef.current !== operationEpoch) return;
      const message = toUserMessage(cause, c.settlementStartFailed, language);
      setError(message);
      if (
        cause instanceof ApiClientError &&
        cause.code === "COMMENT_TOO_LONG" &&
        startedSessionId !== undefined
      ) {
        const expectedSessionId = startedSessionId;
        try {
          await clearActiveSession(expectedSessionId);
          setSession((current) =>
            current?.id === expectedSessionId ? null : current,
          );
        } catch (persistenceCause) {
          if (persistenceCause instanceof SessionPersistenceConflictError) {
            setPersistenceError(
              language === "ko"
                ? "다른 탭의 최신 정산 기록을 불러왔습니다. 한 탭에서 계속 진행하십시오."
                : "A newer settlement from another tab was loaded. Continue in one tab.",
            );
            try {
              const stored = await loadActiveSession();
              if (!stored) {
                setSession(null);
              } else {
                const recovered = markExpiredSlots(
                  recoverInterruptedSession(stored),
                );
                const restoredIndex = firstActionableSlotIndex(recovered);
                activeSlotIndexRef.current = restoredIndex;
                restoredCarouselIndexRef.current = restoredIndex;
                setActiveSlotIndex(restoredIndex);
                setSession(recovered);
              }
            } catch {
              setPersistenceError(
                language === "ko"
                  ? "다른 탭의 최신 정산 기록을 불러오지 못했습니다. 새로고침 후 한 탭에서 계속 진행하십시오."
                  : "Could not load the newer settlement from another tab. Refresh and continue in one tab.",
              );
            }
          } else {
            setPersistenceError(
              language === "ko"
                ? "정산을 기기에서 정리하지 못했습니다. 메모를 수정한 뒤 다시 시도하십시오."
                : "Could not clear the settlement from this device. Edit the note and try again.",
            );
          }
        }
      } else {
        setSession((current) =>
          current
            ? {
                ...current,
                slots: current.slots.map((slot) =>
                  slot.status === "generating"
                    ? {
                        ...slot,
                        status: "failed" as const,
                        failure: requestFailure(cause, "BATCH_FAILED", message),
                      }
                    : slot,
                ),
              }
            : current,
        );
      }
    } finally {
      if (sessionEpochRef.current === operationEpoch) setBusy(false);
    }
  };

  const retrySlot = async (slotNumber: number) => {
    if (!session || retryOperationRef.current !== undefined) return;
    const excludedPaymentHashes = collectIssuedPaymentHashes(session);
    let prepared: SettlementSession;
    try {
      prepared = prepareSlotRetry(session, slotNumber);
    } catch (cause) {
      setError(toUserMessage(cause, undefined, language));
      return;
    }
    const target = prepared.slots.find(
      (slot) => slot.slotNumber === slotNumber,
    )!;
    const operationEpoch = sessionEpochRef.current;
    const operationKey = `${prepared.id}:${slotNumber}:${target.attempt}`;
    retryOperationRef.current = operationKey;
    setRetryingSlot(slotNumber);
    setError(undefined);
    setSession(prepared);
    try {
      const response = await requestInvoiceBatch({
        requestId: `${prepared.id}:${slotNumber}:${target.attempt}`,
        address: prepared.lightningAddress,
        ...(prepared.overallNote
          ? { providerComment: prepared.overallNote }
          : {}),
        slots: [
          {
            slotNumber: target.slotNumber,
            targetSats: target.targetSats,
            attempt: target.attempt,
            ...(target.krwShare ? { krwShare: target.krwShare } : {}),
          },
        ],
        excludedPaymentHashes,
      });
      if (sessionEpochRef.current === operationEpoch) {
        setSession((current) =>
          current?.id === prepared.id
            ? applySlotRetryResponse(
                current,
                slotNumber,
                response,
                excludedPaymentHashes,
              )
            : current,
        );
      }
    } catch (cause) {
      if (sessionEpochRef.current !== operationEpoch) return;
      const message = toUserMessage(cause, c.retryFailed, language);
      setError(message);
      setSession((current) =>
        current?.id === prepared.id
          ? {
              ...current,
              slots: current.slots.map((slot) =>
                slot.slotNumber === slotNumber && slot.status === "generating"
                  ? {
                      ...slot,
                      status: "failed" as const,
                      failure: requestFailure(cause, "RETRY_FAILED", message),
                    }
                  : slot,
              ),
            }
          : current,
      );
    } finally {
      if (retryOperationRef.current === operationKey) {
        retryOperationRef.current = undefined;
        setRetryingSlot(undefined);
      }
    }
  };

  const resetSession = async () => {
    const expectedSessionId = session?.id;
    sessionEpochRef.current += 1;
    retryOperationRef.current = undefined;
    setBusy(false);
    setRetryingSlot(undefined);
    activeSlotIndexRef.current = 0;
    restoredCarouselIndexRef.current = undefined;
    setActiveSlotIndex(0);
    setError(undefined);
    try {
      await clearActiveSession(expectedSessionId);
      setSession((current) =>
        expectedSessionId === undefined || current?.id === expectedSessionId
          ? null
          : current,
      );
      setPersistenceError(undefined);
    } catch (cause) {
      if (cause instanceof SessionPersistenceConflictError) {
        setPersistenceError(
          language === "ko"
            ? "다른 탭의 최신 정산 기록을 불러왔습니다. 삭제하려면 내용을 확인한 뒤 다시 시도하십시오."
            : "A newer settlement from another tab was loaded. Review it before trying to delete it again.",
        );
        try {
          const stored = await loadActiveSession();
          if (!stored) {
            setSession(null);
            return;
          }
          const recovered = markExpiredSlots(recoverInterruptedSession(stored));
          const restoredIndex = firstActionableSlotIndex(recovered);
          activeSlotIndexRef.current = restoredIndex;
          restoredCarouselIndexRef.current = restoredIndex;
          setActiveSlotIndex(restoredIndex);
          setSession(recovered);
        } catch {
          setPersistenceError(
            language === "ko"
              ? "다른 탭의 최신 정산 기록을 불러오지 못했습니다. 새로고침 후 한 탭에서 계속 진행하십시오."
              : "Could not load the newer settlement from another tab. Refresh and continue in one tab.",
          );
        }
      } else {
        setPersistenceError(
          language === "ko"
            ? "기기에 저장된 정산 기록을 삭제하지 못했습니다."
            : "Could not delete the settlement record stored on this device.",
        );
      }
    }
  };

  const newSettlement = async () => {
    if (session && hasPendingSettlement(session)) {
      window.alert(
        language === "ko"
          ? NEW_SETTLEMENT_PENDING_BLOCKED
          : "This settlement is still in progress. Reissue expired invoices and finish every participant before starting a new settlement.",
      );
      return;
    }
    if (session) {
      try {
        await archiveCompletedSettlement(session);
        await refreshHistory();
      } catch {
        setPersistenceError(
          language === "ko"
            ? "완료된 정산을 기록에 안전하게 보관하지 못해 새 정산으로 넘어가지 않았습니다."
            : "The completed settlement could not be archived safely, so a new settlement was not started.",
        );
        return;
      }
    }
    await resetSession();
  };

  const deleteSettlementRecord = async () => {
    if (session && hasPendingSettlement(session)) {
      window.alert(
        language === "ko"
          ? DELETE_PENDING_SETTLEMENT_BLOCKED
          : "This settlement is still in progress and cannot be deleted. Resolve the remaining payments first.",
      );
      return;
    }
    const confirmation =
      language === "ko"
        ? DELETE_SETTLEMENT_RECORD_CONFIRMATION
        : "Delete this completed current settlement from this device? Completed Lightning payments are not affected.";
    if (window.confirm(confirmation)) await resetSession();
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
    if (!window.confirm(c.manualConfirmQuestion)) return;
    updateSession((current) => manuallyConfirmSlot(current, slotNumber));
  };

  const undoManualConfirm = (slotNumber: number) => {
    if (!window.confirm(c.undoManualQuestion)) return;
    updateSession((current) => undoManualConfirmation(current, slotNumber));
  };

  const pasteLightningAddress = async () => {
    const pasted = await readTextFromClipboard();
    if (!pasted) {
      setNotice(c.pasteUnavailable);
      return;
    }
    setLightningAddress(pasted);
    setNotice(
      isLightningInvoiceInput(pasted) ? lightningInvoiceMessage : c.pasted,
    );
  };

  const moveCarousel = (nextIndex: number) => {
    if (!session) return;
    const index = Math.min(Math.max(nextIndex, 0), session.slots.length - 1);
    activeSlotIndexRef.current = index;
    setActiveSlotIndex(index);
    scrollCarouselToIndex(carouselRef.current, index, "smooth");
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
    activeSlotIndexRef.current = closestIndex;
    setActiveSlotIndex(closestIndex);
  };

  useEffect(() => {
    if (!session || restoredCarouselIndexRef.current === undefined) return;
    if (
      scrollCarouselToIndex(
        carouselRef.current,
        restoredCarouselIndexRef.current,
        "auto",
      )
    ) {
      restoredCarouselIndexRef.current = undefined;
    }
  }, [session]);

  useEffect(() => {
    if (!session) {
      previousCarouselSessionRef.current = null;
      return;
    }
    const previous = previousCarouselSessionRef.current;
    previousCarouselSessionRef.current = {
      id: session.id,
      statuses: session.slots.map((slot) => slot.status),
    };
    if (!previous || previous.id !== session.id) return;

    const previousStatus = previous.statuses[activeSlotIndex];
    const currentStatus = session.slots[activeSlotIndex]?.status;
    if (previousStatus === "settled" || currentStatus !== "settled") return;

    const nextIndex = nextActionableSlotIndex(session, activeSlotIndex);
    if (nextIndex === undefined) return;
    const operationEpoch = sessionEpochRef.current;
    window.setTimeout(() => {
      if (
        sessionEpochRef.current !== operationEpoch ||
        activeSlotIndexRef.current !== activeSlotIndex
      ) {
        return;
      }
      activeSlotIndexRef.current = nextIndex;
      setActiveSlotIndex(nextIndex);
      scrollCarouselToIndex(carouselRef.current, nextIndex, "smooth");
    }, 0);
  }, [activeSlotIndex, session]);

  if (restoring) {
    return (
      <main className="app-shell loading-screen" aria-live="polite">
        {c.settlementLoading}
      </main>
    );
  }

  if (historyOpen) {
    return (
      <SettlementHistoryScreen
        activeSession={session}
        records={historyRecords}
        error={historyError}
        language={language}
        onClose={() => setHistoryOpen(false)}
        onDelete={deleteHistoryRecord}
      />
    );
  }

  const historyCount = historyRecords.length + (session ? 1 : 0);

  if (session) {
    const progress = getSettlementProgress(session);
    const duplicateSettledSlots = duplicateSettledSlotNumbers(session);
    const progressPercent =
      progress.totalCount === 0
        ? 0
        : (progress.completedCount / progress.totalCount) * 100;
    return (
      <main className="app-shell layout-stack">
        <LanguageSwitch language={language} onChange={changeLanguage} />
        <MarketSummary
          market={market}
          usdMarket={usdMarket}
          currency={session.inputMode}
          language={language}
        />
        <SettlementHeader
          note={session.overallNote}
          language={language}
          onNewSettlement={() => void newSettlement()}
        />
        <SettlementHistoryLaunch
          count={historyCount}
          hasActiveSettlement
          language={language}
          onOpen={() => setHistoryOpen(true)}
        />
        {session.overallNote &&
          session.providerCommentStatus === "forwarded" && (
            <p className="provider-comment-status" role="status">
              {c.providerForwarded}
            </p>
          )}
        {session.overallNote && session.providerCommentStatus === "partial" && (
          <div className="global-warning" role="status">
            {c.providerPartial}
          </div>
        )}
        {session.overallNote &&
          session.providerCommentStatus === "unsupported" && (
            <div className="global-warning" role="status">
              {c.providerUnsupported}
            </div>
          )}
        <section className="progress-card" aria-live="polite">
          <div className="progress-main">
            <strong>
              {progress.completedCount} / {progress.totalCount}
              {language === "ko" ? "명 완료" : " complete"}
            </strong>
            <span>
              {formatInteger(progress.completedSats, language)} /{" "}
              {formatInteger(progress.totalSats, language)} sats
            </span>
          </div>
          {session.inputMode === "krw" && (
            <p>
              {formatInteger(progress.completedKrw, language)}
              {language === "ko" ? "원" : " KRW"} /{" "}
              {formatInteger(progress.totalKrw, language)}
              {language === "ko"
                ? "원 상당 정산 완료"
                : " KRW equivalent settled"}
            </p>
          )}
          {session.inputMode === "usd" && (
            <p>
              {formatUsdCents(progress.completedUsdCents, language)} /{" "}
              {formatUsdCents(progress.totalUsdCents, language)}{" "}
              {language === "ko" ? "상당 정산 완료" : "equivalent settled"}
            </p>
          )}
          {progress.manuallyConfirmedCount > 0 && (
            <p className="manual-progress">
              {language === "ko"
                ? `직접 확인 ${progress.manuallyConfirmedCount}명 포함`
                : `${progress.manuallyConfirmedCount} ${c.directConfirmIncluded}`}
            </p>
          )}
          <div
            className="progress-track"
            role="progressbar"
            aria-label={
              language === "ko" ? "전체 정산 진행률" : "Settlement progress"
            }
            aria-valuemin={0}
            aria-valuemax={progress.totalCount}
            aria-valuenow={progress.completedCount}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          {session.priceSnapshot && (
            <small>
              {c.fixedPrice}{" "}
              {formatInteger(BigInt(session.priceSnapshot.priceKrw), language)}
              {language === "ko" ? "원" : " KRW"} ·{" "}
              {new Date(session.priceSnapshot.snapshotAt).toLocaleTimeString(
                localeFor(language),
              )}
            </small>
          )}
          {session.usdPriceSnapshot && (
            <small>
              {c.fixedPrice}{" "}
              {formatUsdCents(
                BigInt(session.usdPriceSnapshot.priceUsdCents),
                language,
              )}{" "}
              ·{" "}
              {new Date(session.usdPriceSnapshot.snapshotAt).toLocaleTimeString(
                localeFor(language),
              )}
            </small>
          )}
        </section>
        {isSettlementComplete(session) && (
          <div className="settlement-complete-note" role="status">
            {language === "ko"
              ? "모든 참여자의 정산이 완료되었습니다. 새 정산을 시작하면 이 정산은 과거 기록으로 안전하게 보관됩니다."
              : "Everyone is complete. Starting a new settlement will safely archive this settlement."}
          </div>
        )}
        {persistenceError && (
          <div className="global-warning" role="alert">
            {persistenceError}
          </div>
        )}
        {historyError && (
          <div className="global-warning" role="alert">
            {historyError}
          </div>
        )}
        {error && (
          <div className="global-error" role="alert">
            {error}
          </div>
        )}
        {duplicateSettledSlots.length > 0 && (
          <div className="global-error" role="alert">
            {language === "ko"
              ? `${duplicateSettledSlots.join(", ")}번 결제에서 서로 다른 결제 요청의 중복 입금이 확인되었습니다. 받는 지갑의 거래내역을 확인하십시오.`
              : `Duplicate deposits were detected for payment ${duplicateSettledSlots.join(", ")} across different payment requests. Check the receiving wallet history.`}
          </div>
        )}
        <nav className="carousel-controls" aria-label={c.paymentQrNavigation}>
          <button
            type="button"
            aria-label={c.previousPayment}
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
            aria-label={c.nextPayment}
            disabled={activeSlotIndex === session.slots.length - 1}
            onClick={() => moveCarousel(activeSlotIndex + 1)}
          >
            ›
          </button>
        </nav>
        <section
          ref={carouselRef}
          className="invoice-carousel"
          aria-label={c.settlementQr}
          onScroll={trackCarouselPosition}
        >
          {session.slots.map((slot, index) => (
            <InvoiceCard
              key={`${slot.slotNumber}-${slot.attempt}`}
              slot={slot}
              candidates={session.participantNameCandidates}
              retrying={retryingSlot !== undefined}
              renderQr={Math.abs(index - activeSlotIndex) <= 1}
              language={language}
              onAnnotate={annotate}
              onRetry={(slotNumber) => void retrySlot(slotNumber)}
              onManualConfirm={manualConfirm}
              onUndoManualConfirm={undoManualConfirm}
            />
          ))}
        </section>
        <p className="swipe-hint">{c.swipeHint}</p>
        <SettlementRecordDeleteButton
          language={language}
          onDelete={() => void deleteSettlementRecord()}
        />
      </main>
    );
  }

  const selectedPrice = displayMarketPrice(
    inputMode,
    priceSnapshot,
    usdPriceSnapshot,
    language,
  );
  const selectedSnapshotAt =
    inputMode === "krw"
      ? priceSnapshot?.snapshotAt
      : inputMode === "usd"
        ? usdPriceSnapshot?.snapshotAt
        : undefined;
  const selectedSnapshot =
    inputMode === "krw" ? priceSnapshot : usdPriceSnapshot;
  const selectedMarketError =
    inputMode === "usd" ? usdMarket.error : market.error;

  return (
    <main className="app-shell layout-stack">
      <LanguageSwitch language={language} onChange={changeLanguage} />
      <MarketSummary
        market={market}
        usdMarket={usdMarket}
        currency={inputMode}
        language={language}
      />
      <header className="hero">
        <img
          className="brand-mark large"
          src="/lightning-split.jpg"
          alt="Lightning Split"
        />
        <span className="eyebrow">LIGHTNING SPLIT</span>
        <h1>
          {heroLine1For(inputMode, language)}
          <br />
          {c.heroLine2}
        </h1>
        <p>{c.heroDescription}</p>
      </header>
      <SettlementHistoryLaunch
        count={historyCount}
        hasActiveSettlement={false}
        language={language}
        onOpen={() => setHistoryOpen(true)}
      />
      <section className="form-card">
        <AmountInput
          inputMode={inputMode}
          totalAmount={totalAmount}
          language={language}
          onInputModeChange={changeInputMode}
          onTotalAmountChange={setTotalAmount}
        />
        <div className="people-row">
          <div>
            <label htmlFor="people">{c.totalPeople}</label>
            <small>
              {c.includeMe} ·{" "}
              {language === "ko"
                ? `최대 ${MAX_PEOPLE}명`
                : `up to ${MAX_PEOPLE}`}
            </small>
          </div>
          <div className="stepper">
            <button
              type="button"
              aria-label={c.decreasePeople}
              disabled={totalPeople <= MIN_PEOPLE}
              onClick={() =>
                setTotalPeople((value) => Math.max(MIN_PEOPLE, value - 1))
              }
            >
              −
            </button>
            <input
              id="people"
              aria-label={c.totalPeople}
              type="number"
              min={MIN_PEOPLE}
              max={MAX_PEOPLE}
              value={totalPeople}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isFinite(value)) return;
                setTotalPeople(
                  Math.min(MAX_PEOPLE, Math.max(MIN_PEOPLE, Math.trunc(value))),
                );
              }}
            />
            <button
              type="button"
              aria-label={c.increasePeople}
              disabled={totalPeople >= MAX_PEOPLE}
              onClick={() =>
                setTotalPeople((value) => Math.min(MAX_PEOPLE, value + 1))
              }
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
            <strong>{c.payerPaid}</strong>
            <small>{c.payerPaidHelp}</small>
          </span>
        </label>
        <label className="stacked-field">
          {c.myLightningAddress}
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
              {c.paste}
            </button>
          </span>
          <small
            id="lightning-address-feedback"
            className={`field-feedback ${lightningInvoiceInput ? "input-error" : ""}`}
            aria-live="polite"
          >
            {lightningInvoiceInput ? lightningInvoiceMessage : notice}
          </small>
        </label>
        <details className="optional-fields">
          <summary>
            {c.optionalDetails} <span>{c.optional}</span>
          </summary>
          <label className="stacked-field">
            {c.settlementNote}
            <input
              value={overallNote}
              onChange={(event) => setOverallNote(event.target.value)}
              placeholder={c.notePlaceholder}
              maxLength={
                DEFAULT_LIGHTNING_POLICY.maximumProviderCommentCharacters
              }
            />
            <small>
              {[...overallNote].length}/
              {DEFAULT_LIGHTNING_POLICY.maximumProviderCommentCharacters}
              {language === "ko" ? "자" : " chars"} · {c.noteDeliveryHelp}
            </small>
          </label>
          <label className="stacked-field">
            {c.participantCandidates}
            <textarea
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
              placeholder={c.participantPlaceholder}
              rows={2}
            />
            <small>{c.participantHelp}</small>
          </label>
        </details>
      </section>
      <section className="preview-card" aria-live="polite">
        <div className="section-title">
          <div>
            <span className="eyebrow">{c.review}</span>
            <h2>{c.reviewBeforeStart}</h2>
          </div>
          {selectedSnapshot && inputMode !== "sats" && (
            <button
              className="text-button touch-target"
              type="button"
              onClick={() =>
                void (
                  inputMode === "krw" ? refreshPrice() : refreshUsdPrice()
                ).catch(() => undefined)
              }
            >
              {c.priceRefresh}
            </button>
          )}
        </div>
        {selectedSnapshot && inputMode !== "sats" && selectedPrice && (
          <p className="price-line">
            {inputMode === "krw"
              ? language === "ko"
                ? "BTC 기준가격"
                : "BTC/KRW"
              : "BTC/USD"}{" "}
            <strong>{selectedPrice}</strong> ·{" "}
            {formatPriceTime(selectedSnapshot, language)}
          </p>
        )}
        {selectedMarketError && inputMode !== "sats" && (
          <p className="inline-error">{selectedMarketError}</p>
        )}
        {preview.value ? (
          <>
            <SettlementPreviewDetails
              inputMode={inputMode}
              totalAmount={totalAmount}
              totalPeople={totalPeople}
              preview={preview.value}
              language={language}
              {...(selectedSnapshotAt
                ? { priceSnapshotAt: selectedSnapshotAt }
                : {})}
            />
            <p className="preview-note">
              {excludePayer ? c.splitPayerRemainder : c.splitFrontRemainder}
            </p>
            {inputMode !== "sats" && (
              <p className="preview-note">{c.priceLockedNote}</p>
            )}
          </>
        ) : totalAmount.trim() ? (
          <p className="inline-error">{preview.error}</p>
        ) : (
          <p className="preview-note">{c.enterAmount}</p>
        )}
      </section>
      {persistenceError && (
        <div className="global-warning" role="alert">
          {persistenceError}
        </div>
      )}
      {historyError && (
        <div className="global-warning" role="alert">
          {historyError}
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
        {busy ? c.creatingPayments : c.startSettlement}
      </button>
      <p className="privacy-note">{c.privacy}</p>
    </main>
  );
}
