import { readFile, writeFile } from "node:fs/promises";

const path = "src/App.tsx";
let source = await readFile(path, "utf8");

function replaceOnce(needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`App patch anchor not found: ${label}`);
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error(`App patch anchor is ambiguous: ${label}`);
  }
  source = source.slice(0, index) + replacement + source.slice(index + needle.length);
}

replaceOnce(
  'import { parseParticipantNameCandidates } from "./app/nameCandidates";\n',
  'import { shareInvoicePaymentRequest } from "./app/invoiceShare";\n' +
    'import { parseParticipantNameCandidates } from "./app/nameCandidates";\n' +
    'import { SettlementHistoryScreen } from "./app/SettlementHistory";\n' +
    'import {\n' +
    '  archiveSettlementSession,\n' +
    '  deleteSettlementHistoryRecord,\n' +
    '  listSettlementHistory,\n' +
    '  type SettlementHistoryRecord,\n' +
    '} from "./app/settlementHistory";\n',
  "history imports",
);

replaceOnce(
  '  const status = slotStatus(slot);\n' +
    '  const [copyFeedback, setCopyFeedback] = useState<string>();\n\n' +
    '  const copyInvoice = async () => {\n',
  '  const status = slotStatus(slot);\n' +
    '  const [copyFeedback, setCopyFeedback] = useState<string>();\n' +
    '  const [shareFeedback, setShareFeedback] = useState<string>();\n\n' +
    '  const shareInvoice = async () => {\n' +
    '    if (!slot.invoice) return;\n' +
    '    const result = await shareInvoicePaymentRequest({\n' +
    '      slotNumber: slot.slotNumber,\n' +
    '      ...(slot.annotation?.displayName\n' +
    '        ? { displayName: slot.annotation.displayName }\n' +
    '        : {}),\n' +
    '      ...(slot.krwShare ? { krwShare: slot.krwShare } : {}),\n' +
    '      targetSats: slot.targetSats,\n' +
    '      invoice: slot.invoice.bolt11,\n' +
    '      expiresAt: slot.invoice.expiresAt,\n' +
    '    });\n' +
    '    setShareFeedback(\n' +
    '      result === "shared"\n' +
    '        ? "QR과 결제 요청을 공유했습니다."\n' +
    '        : result === "copied"\n' +
    '          ? "공유 기능을 사용할 수 없어 결제 요청 정보를 복사했습니다."\n' +
    '          : result === "failed"\n' +
    '            ? "공유하지 못했습니다. 결제 요청 복사를 사용하십시오."\n' +
    '            : undefined,\n' +
    '    );\n' +
    '  };\n\n' +
    '  const copyInvoice = async () => {\n',
  "invoice share state",
);

replaceOnce(
  '            <button\n' +
    '              className="secondary-button full"\n' +
    '              type="button"\n' +
    '              onClick={() => void copyInvoice()}\n' +
    '            >\n' +
    '              결제 요청 복사\n' +
    '            </button>\n' +
    '            <div className="copy-feedback" aria-live="polite">\n' +
    '              {copyFeedback}\n' +
    '            </div>\n',
  '            <button\n' +
    '              className="secondary-button full"\n' +
    '              type="button"\n' +
    '              onClick={() => void shareInvoice()}\n' +
    '            >\n' +
    '              QR · 결제 요청 공유\n' +
    '            </button>\n' +
    '            <div className="copy-feedback" aria-live="polite">\n' +
    '              {shareFeedback}\n' +
    '            </div>\n' +
    '            <button\n' +
    '              className="secondary-button full"\n' +
    '              type="button"\n' +
    '              onClick={() => void copyInvoice()}\n' +
    '            >\n' +
    '              결제 요청 복사\n' +
    '            </button>\n' +
    '            <div className="copy-feedback" aria-live="polite">\n' +
    '              {copyFeedback}\n' +
    '            </div>\n',
  "invoice share button",
);

replaceOnce(
  '  const [candidateText, setCandidateText] = useState("");\n' +
    '  const { market, refreshLockedSnapshot } = useMarketInformation();\n',
  '  const [candidateText, setCandidateText] = useState("");\n' +
    '  const [historyRecords, setHistoryRecords] = useState<\n' +
    '    SettlementHistoryRecord[]\n' +
    '  >([]);\n' +
    '  const [historyOpen, setHistoryOpen] = useState(false);\n' +
    '  const [historyError, setHistoryError] = useState<string>();\n' +
    '  const { market, refreshLockedSnapshot } = useMarketInformation();\n',
  "history state",
);

replaceOnce(
  '  const refreshPrice = useCallback(async () => {\n' +
    '    return (await refreshLockedSnapshot()).snapshot;\n' +
    '  }, [refreshLockedSnapshot]);\n\n' +
    '  useEffect(() => {\n',
  '  const refreshPrice = useCallback(async () => {\n' +
    '    return (await refreshLockedSnapshot()).snapshot;\n' +
    '  }, [refreshLockedSnapshot]);\n\n' +
    '  const refreshHistory = useCallback(async () => {\n' +
    '    const records = await listSettlementHistory();\n' +
    '    setHistoryRecords(records);\n' +
    '    setHistoryError(undefined);\n' +
    '  }, []);\n\n' +
    '  useEffect(() => {\n' +
    '    void refreshHistory().catch(() =>\n' +
    '      setHistoryError(\n' +
    '        "이 기기에 저장된 정산 기록을 불러오지 못했습니다.",\n' +
    '      ),\n' +
    '    );\n' +
    '  }, [refreshHistory]);\n\n' +
    '  useEffect(() => {\n',
  "history loader",
);

replaceOnce(
  '  const newSettlement = async () => {\n' +
    '    if (\n' +
    '      hasPendingSettlement(session) &&\n' +
    '      !window.confirm(NEW_SETTLEMENT_PENDING_CONFIRMATION)\n' +
    '    )\n' +
    '      return;\n' +
    '    await resetSession();\n' +
    '  };\n',
  '  const newSettlement = async () => {\n' +
    '    if (\n' +
    '      hasPendingSettlement(session) &&\n' +
    '      !window.confirm(NEW_SETTLEMENT_PENDING_CONFIRMATION)\n' +
    '    )\n' +
    '      return;\n' +
    '    if (session) {\n' +
    '      try {\n' +
    '        await archiveSettlementSession(session);\n' +
    '        await refreshHistory();\n' +
    '      } catch {\n' +
    '        setPersistenceError(\n' +
    '          "현재 정산을 기록에 보관하지 못해 새 정산으로 넘어가지 않았습니다.",\n' +
    '        );\n' +
    '        return;\n' +
    '      }\n' +
    '    }\n' +
    '    await resetSession();\n' +
    '  };\n',
  "archive before new settlement",
);

replaceOnce(
  '  const deleteSettlementRecord = async () => {\n' +
    '    if (window.confirm(DELETE_SETTLEMENT_RECORD_CONFIRMATION))\n' +
    '      await resetSession();\n' +
    '  };\n\n' +
    '  const annotate = (slotNumber: number, displayName: string) => {\n',
  '  const deleteSettlementRecord = async () => {\n' +
    '    if (window.confirm(DELETE_SETTLEMENT_RECORD_CONFIRMATION))\n' +
    '      await resetSession();\n' +
    '  };\n\n' +
    '  const deleteHistoryRecord = async (id: string): Promise<boolean> => {\n' +
    '    try {\n' +
    '      await deleteSettlementHistoryRecord(id);\n' +
    '      await refreshHistory();\n' +
    '      return true;\n' +
    '    } catch {\n' +
    '      setHistoryError("이 기기에서 정산 기록을 삭제하지 못했습니다.");\n' +
    '      return false;\n' +
    '    }\n' +
    '  };\n\n' +
    '  const annotate = (slotNumber: number, displayName: string) => {\n',
  "history delete handler",
);

replaceOnce(
  '  if (session) {\n' + '    const progress = getSettlementProgress(session);\n',
  '  if (historyOpen) {\n' +
    '    return (\n' +
    '      <SettlementHistoryScreen\n' +
    '        records={historyRecords}\n' +
    '        error={historyError}\n' +
    '        onClose={() => setHistoryOpen(false)}\n' +
    '        onDelete={deleteHistoryRecord}\n' +
    '      />\n' +
    '    );\n' +
    '  }\n\n' +
    '  if (session) {\n' +
    '    const progress = getSettlementProgress(session);\n',
  "history screen route",
);

replaceOnce(
  '        <SettlementHeader\n' +
    '          note={session.overallNote}\n' +
    '          onNewSettlement={() => void newSettlement()}\n' +
    '        />\n',
  '        <SettlementHeader\n' +
    '          note={session.overallNote}\n' +
    '          onNewSettlement={() => void newSettlement()}\n' +
    '        />\n' +
    '        <button\n' +
    '          className="secondary-button full history-launch-button"\n' +
    '          type="button"\n' +
    '          onClick={() => setHistoryOpen(true)}\n' +
    '        >\n' +
    '          정산 기록 보기\n' +
    '          {historyRecords.length > 0\n' +
    '            ? " · " + historyRecords.length + "건"\n' +
    '            : ""}\n' +
    '        </button>\n' +
    '        {historyError && (\n' +
    '          <div className="global-warning" role="alert">\n' +
    '            {historyError}\n' +
    '          </div>\n' +
    '        )}\n',
  "active history launcher",
);

replaceOnce(
  '      </header>\n' + '      <section className="form-card">\n',
  '      </header>\n' +
    '      <button\n' +
    '        className="secondary-button full history-launch-button"\n' +
    '        type="button"\n' +
    '        onClick={() => setHistoryOpen(true)}\n' +
    '      >\n' +
    '        정산 기록 보기\n' +
    '        {historyRecords.length > 0\n' +
    '          ? " · " + historyRecords.length + "건"\n' +
    '          : ""}\n' +
    '      </button>\n' +
    '      {historyError && (\n' +
    '        <div className="global-warning" role="alert">\n' +
    '          {historyError}\n' +
    '        </div>\n' +
    '      )}\n' +
    '      <section className="form-card">\n',
  "home history launcher",
);

await writeFile(path, source, "utf8");
