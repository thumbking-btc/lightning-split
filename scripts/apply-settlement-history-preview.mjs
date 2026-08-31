import { readFile, writeFile } from "node:fs/promises";

async function patchFile(path, transform) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next === source) throw new Error(`No changes applied to ${path}`);
  await writeFile(path, next);
}

function replaceOnce(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error(`Patch anchor is ambiguous: ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

await patchFile("src/App.tsx", (initial) => {
  let source = initial;
  source = replaceOnce(
    source,
    '} from "./app/lightningInput";\nimport { parseParticipantNameCandidates } from "./app/nameCandidates";\n',
    '} from "./app/lightningInput";\nimport { shareInvoicePaymentRequest } from "./app/invoiceShare";\nimport { parseParticipantNameCandidates } from "./app/nameCandidates";\nimport { SettlementHistoryScreen } from "./app/SettlementHistory";\nimport {\n  archiveSettlementSession,\n  deleteSettlementHistoryRecord,\n  listSettlementHistory,\n  type SettlementHistoryRecord,\n} from "./app/settlementHistory";\n',
    "history imports",
  );

  source = replaceOnce(
    source,
    '  const statusLines = status.label.split(" · ");\n  const [copyFeedback, setCopyFeedback] = useState<string>();\n\n  const copyInvoice = async () => {\n',
    '  const statusLines = status.label.split(" · ");\n  const [copyFeedback, setCopyFeedback] = useState<string>();\n  const [shareFeedback, setShareFeedback] = useState<string>();\n\n  const shareInvoice = async () => {\n    if (!slot.invoice) return;\n    const result = await shareInvoicePaymentRequest({\n      slotNumber: slot.slotNumber,\n      ...(slot.annotation?.displayName\n        ? { displayName: slot.annotation.displayName }\n        : {}),\n      ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),\n      ...(slot.usdCentsShare ? { usdCentsShare: slot.usdCentsShare } : {}),\n      targetSats: slot.targetSats,\n      invoice: slot.invoice.bolt11,\n      expiresAt: slot.invoice.expiresAt,\n    });\n    setShareFeedback(\n      result === "shared"\n        ? language === "ko"\n          ? "QR과 결제 요청을 공유했습니다."\n          : "Shared the QR and payment request."\n        : result === "copied"\n          ? language === "ko"\n            ? "공유 기능을 사용할 수 없어 결제 요청 정보를 복사했습니다."\n            : "Sharing is unavailable, so the payment request was copied."\n          : result === "failed"\n            ? language === "ko"\n              ? "공유하지 못했습니다. 결제 요청 복사를 사용하십시오."\n              : "Could not share. Use Copy payment request instead."\n            : undefined,\n    );\n  };\n\n  const copyInvoice = async () => {\n',
    "invoice share state",
  );

  source = replaceOnce(
    source,
    '            <button\n              className="secondary-button full"\n              type="button"\n              onClick={() => void copyInvoice()}\n            >\n              {c.copyPaymentRequest}\n            </button>\n',
    '            <button\n              className="secondary-button full"\n              type="button"\n              onClick={() => void shareInvoice()}\n            >\n              {language === "ko" ? "QR · 결제 요청 공유" : "Share QR · payment request"}\n            </button>\n            <div className="copy-feedback" aria-live="polite">\n              {shareFeedback}\n            </div>\n            <button\n              className="secondary-button full"\n              type="button"\n              onClick={() => void copyInvoice()}\n            >\n              {c.copyPaymentRequest}\n            </button>\n',
    "share button",
  );

  source = replaceOnce(
    source,
    '  const [overallNote, setOverallNote] = useState("");\n  const [candidateText, setCandidateText] = useState("");\n  const [session, setSession] = useState<SettlementSession | null>(null);\n',
    '  const [overallNote, setOverallNote] = useState("");\n  const [candidateText, setCandidateText] = useState("");\n  const [historyRecords, setHistoryRecords] = useState<\n    SettlementHistoryRecord[]\n  >([]);\n  const [historyOpen, setHistoryOpen] = useState(false);\n  const [historyError, setHistoryError] = useState<string>();\n  const [session, setSession] = useState<SettlementSession | null>(null);\n',
    "history state",
  );

  source = replaceOnce(
    source,
    '  const refreshUsdPrice = useCallback(async () => {\n    return (await refreshLockedUsdSnapshot()).snapshot;\n  }, [refreshLockedUsdSnapshot]);\n\n  useEffect(() => {\n',
    '  const refreshUsdPrice = useCallback(async () => {\n    return (await refreshLockedUsdSnapshot()).snapshot;\n  }, [refreshLockedUsdSnapshot]);\n\n  const refreshHistory = useCallback(async () => {\n    const records = await listSettlementHistory();\n    setHistoryRecords(records);\n    setHistoryError(undefined);\n  }, []);\n\n  useEffect(() => {\n    void refreshHistory().catch(() =>\n      setHistoryError(\n        languageRef.current === "ko"\n          ? "이 기기에 저장된 정산 기록을 불러오지 못했습니다."\n          : "Could not load settlement history stored on this device.",\n      ),\n    );\n  }, [refreshHistory]);\n\n  useEffect(() => {\n',
    "history loader",
  );

  source = replaceOnce(
    source,
    '    if (hasPendingSettlement(session) && !window.confirm(confirmation)) return;\n    await resetSession();\n  };\n\n  const deleteSettlementRecord = async () => {\n',
    '    if (hasPendingSettlement(session) && !window.confirm(confirmation)) return;\n    if (session) {\n      try {\n        await archiveSettlementSession(session);\n        await refreshHistory();\n      } catch {\n        setPersistenceError(\n          language === "ko"\n            ? "현재 정산을 기록에 보관하지 못해 새 정산으로 넘어가지 않았습니다."\n            : "The current settlement could not be archived, so a new settlement was not started.",\n        );\n        return;\n      }\n    }\n    await resetSession();\n  };\n\n  const deleteSettlementRecord = async () => {\n',
    "archive before reset",
  );

  source = replaceOnce(
    source,
    '    if (window.confirm(confirmation)) await resetSession();\n  };\n\n  const annotate = (slotNumber: number, displayName: string) => {\n',
    '    if (window.confirm(confirmation)) await resetSession();\n  };\n\n  const deleteHistoryRecord = async (id: string): Promise<boolean> => {\n    try {\n      await deleteSettlementHistoryRecord(id);\n      await refreshHistory();\n      return true;\n    } catch {\n      setHistoryError(\n        language === "ko"\n          ? "이 기기에서 정산 기록을 삭제하지 못했습니다."\n          : "Could not delete the settlement history record from this device.",\n      );\n      return false;\n    }\n  };\n\n  const annotate = (slotNumber: number, displayName: string) => {\n',
    "history delete",
  );

  source = replaceOnce(
    source,
    '  if (session) {\n    const progress = getSettlementProgress(session);\n',
    '  if (historyOpen) {\n    return (\n      <SettlementHistoryScreen\n        records={historyRecords}\n        error={historyError}\n        onClose={() => setHistoryOpen(false)}\n        onDelete={deleteHistoryRecord}\n      />\n    );\n  }\n\n  if (session) {\n    const progress = getSettlementProgress(session);\n',
    "history route",
  );

  source = replaceOnce(
    source,
    '        <SettlementHeader\n          note={session.overallNote}\n          language={language}\n          onNewSettlement={() => void newSettlement()}\n        />\n',
    '        <SettlementHeader\n          note={session.overallNote}\n          language={language}\n          onNewSettlement={() => void newSettlement()}\n        />\n        <button\n          className="secondary-button full history-launch-button"\n          type="button"\n          onClick={() => setHistoryOpen(true)}\n        >\n          {language === "ko" ? "정산 기록 보기" : "Settlement history"}\n          {historyRecords.length > 0\n            ? language === "ko"\n              ? ` · ${historyRecords.length}건`\n              : ` · ${historyRecords.length}`\n            : ""}\n        </button>\n',
    "active history button",
  );

  source = replaceOnce(
    source,
    '      </header>\n      <section className="form-card">\n',
    '      </header>\n      <button\n        className="secondary-button full history-launch-button"\n        type="button"\n        onClick={() => setHistoryOpen(true)}\n      >\n        {language === "ko" ? "정산 기록 보기" : "Settlement history"}\n        {historyRecords.length > 0\n          ? language === "ko"\n            ? ` · ${historyRecords.length}건`\n            : ` · ${historyRecords.length}`\n          : ""}\n      </button>\n      <section className="form-card">\n',
    "home history button",
  );

  return source;
});

await patchFile("src/app/settlementHistory.ts", (initial) => {
  let source = initial;
  source = source.replace(
    '  readonly krwShare?: string;\n  readonly targetSats: string;\n',
    '  readonly krwShare?: string;\n  readonly usdCentsShare?: string;\n  readonly targetSats: string;\n',
  );
  source = source.replace(
    '  readonly inputMode: "krw" | "sats";\n',
    '  readonly inputMode: "krw" | "usd" | "sats";\n',
  );
  source = source.replace(
    '  readonly payerShareKrw?: string;\n  readonly payerShareSats?: string;\n',
    '  readonly payerShareKrw?: string;\n  readonly payerShareUsdCents?: string;\n  readonly payerShareSats?: string;\n',
  );
  source = source.replace(
    '    ...(session.payerShareKrw ? { payerShareKrw: session.payerShareKrw } : {}),\n    ...(session.payerShareSats\n',
    '    ...(session.payerShareKrw ? { payerShareKrw: session.payerShareKrw } : {}),\n    ...(session.payerShareUsdCents\n      ? { payerShareUsdCents: session.payerShareUsdCents }\n      : {}),\n    ...(session.payerShareSats\n',
  );
  source = source.replace(
    '      ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),\n      targetSats: slot.targetSats,\n',
    '      ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),\n      ...(slot.usdCentsShare ? { usdCentsShare: slot.usdCentsShare } : {}),\n      targetSats: slot.targetSats,\n',
  );
  source = source.replace(
    '    (value.krwShare === undefined ||\n      isCanonicalPositiveDecimal(value.krwShare)) &&\n    isCanonicalPositiveDecimal(value.targetSats) &&\n',
    '    (value.krwShare === undefined ||\n      isCanonicalPositiveDecimal(value.krwShare)) &&\n    (value.usdCentsShare === undefined ||\n      isCanonicalPositiveDecimal(value.usdCentsShare)) &&\n    isCanonicalPositiveDecimal(value.targetSats) &&\n',
  );
  source = source.replace(
    '    (value.inputMode === "krw" || value.inputMode === "sats") &&\n',
    '    (value.inputMode === "krw" ||\n      value.inputMode === "usd" ||\n      value.inputMode === "sats") &&\n',
  );
  source = source.replace(
    '    (value.payerShareKrw === undefined ||\n      isCanonicalPositiveDecimal(value.payerShareKrw)) &&\n    (value.payerShareSats === undefined ||\n',
    '    (value.payerShareKrw === undefined ||\n      isCanonicalPositiveDecimal(value.payerShareKrw)) &&\n    (value.payerShareUsdCents === undefined ||\n      isCanonicalPositiveDecimal(value.payerShareUsdCents)) &&\n    (value.payerShareSats === undefined ||\n',
  );
  return source;
});

await patchFile("src/app/invoiceShare.ts", (initial) => {
  let source = initial;
  source = source.replace(
    '  readonly krwShare?: string;\n  readonly targetSats: string;\n',
    '  readonly krwShare?: string;\n  readonly usdCentsShare?: string;\n  readonly targetSats: string;\n',
  );
  source = source.replace(
    'function formatAmount(input: InvoiceShareInput): string {\n  return input.krwShare\n    ? `${formatInteger(input.krwShare)}원 (${formatInteger(input.targetSats)} sats)`\n    : `${formatInteger(input.targetSats)} sats`;\n}\n',
    'function formatUsdCents(value: string): string {\n  const cents = BigInt(value);\n  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;\n}\n\nfunction formatAmount(input: InvoiceShareInput): string {\n  if (input.krwShare)\n    return `${formatInteger(input.krwShare)}원 (${formatInteger(input.targetSats)} sats)`;\n  if (input.usdCentsShare)\n    return `${formatUsdCents(input.usdCentsShare)} (${formatInteger(input.targetSats)} sats)`;\n  return `${formatInteger(input.targetSats)} sats`;\n}\n',
  );
  return source;
});

await patchFile("src/app/SettlementHistory.tsx", (initial) => {
  let source = initial;
  source = source.replace(
    'function formatRecordAmount(record: SettlementHistoryRecord): string {\n  return record.inputMode === "krw"\n    ? `${formatInteger(record.totalAmount)}원`\n    : `${formatInteger(record.totalAmount)} sats`;\n}\n\nfunction formatSlotAmount(slot: SettlementHistorySlot): string {\n  return slot.krwShare\n    ? `${formatInteger(slot.krwShare)}원 · ${formatInteger(slot.targetSats)} sats`\n    : `${formatInteger(slot.targetSats)} sats`;\n}\n',
    'function formatUsdCents(value: string): string {\n  const cents = BigInt(value);\n  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;\n}\n\nfunction formatRecordAmount(record: SettlementHistoryRecord): string {\n  if (record.inputMode === "krw") return `${formatInteger(record.totalAmount)}원`;\n  if (record.inputMode === "usd") return formatUsdCents(record.totalAmount);\n  return `${formatInteger(record.totalAmount)} sats`;\n}\n\nfunction formatSlotAmount(slot: SettlementHistorySlot): string {\n  if (slot.krwShare)\n    return `${formatInteger(slot.krwShare)}원 · ${formatInteger(slot.targetSats)} sats`;\n  if (slot.usdCentsShare)\n    return `${formatUsdCents(slot.usdCentsShare)} · ${formatInteger(slot.targetSats)} sats`;\n  return `${formatInteger(slot.targetSats)} sats`;\n}\n',
  );
  return source;
});
