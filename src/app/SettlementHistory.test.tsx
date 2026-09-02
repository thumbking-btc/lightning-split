import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettlementHistoryScreen } from "./SettlementHistory";
import type { SettlementHistoryRecord } from "./settlementHistory";
import type { SettlementSession } from "./types";

const noop = () => undefined;
const deleteRecord = async () => true;

function activeSession(): SettlementSession {
  return {
    version: 2,
    id: "active-history-ui",
    inputMode: "sats",
    totalAmount: "42000",
    totalPeople: 2,
    excludePayer: true,
    invoiceCount: 1,
    lightningAddress: "receiver@example.com",
    participantNameCandidates: ["민수"],
    payerShareSats: "21000",
    createdAt: "2030-08-31T12:00:00.000Z",
    slots: [
      {
        slotNumber: 1,
        targetSats: "21000",
        attempt: 1,
        status: "expired",
      },
    ],
  };
}

function completedRecord(
  overrides: Partial<SettlementHistoryRecord> = {},
): SettlementHistoryRecord {
  return {
    version: 1,
    id: "completed-history-ui",
    inputMode: "sats",
    totalAmount: "42000",
    totalPeople: 2,
    excludePayer: true,
    invoiceCount: 1,
    overallNote: "저녁 식사",
    payerShareSats: "21000",
    createdAt: "2030-08-31T12:00:00.000Z",
    archivedAt: "2030-08-31T13:00:00.000Z",
    slots: [
      {
        slotNumber: 1,
        displayName: "민수",
        targetSats: "21000",
        status: "settled",
        completedAt: "2030-08-31T12:30:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderHistory(
  props: Partial<Parameters<typeof SettlementHistoryScreen>[0]> = {},
): string {
  return renderToStaticMarkup(
    <SettlementHistoryScreen
      records={[]}
      activeSession={null}
      error={undefined}
      language="ko"
      onClose={noop}
      onOpenActive={noop}
      onDelete={deleteRecord}
      {...props}
    />,
  );
}

describe("SettlementHistoryScreen", () => {
  it("keeps an unfinished settlement visible as an active settlement", () => {
    const html = renderHistory({ activeSession: activeSession() });

    expect(html).toContain("진행 중인 정산");
    expect(html).toContain("0/1명 완료");
    expect(html).toContain(
      "만료된 QR은 정산 화면에서 새로 만들어 다시 공유할 수 있습니다",
    );
    expect(html).toContain("정산 현황 열기");
  });

  it("shows a late-payment duplicate warning on a completed record", () => {
    const html = renderHistory({
      records: [
        completedRecord({
          slots: [
            {
              slotNumber: 1,
              displayName: "민수",
              targetSats: "21000",
              status: "settled",
              completedAt: "2030-08-31T12:30:00.000Z",
              latePaymentWarningAt: "2030-08-31T12:40:00.000Z",
            },
          ],
        }),
      ],
    });

    expect(html).toContain("저녁 식사");
    expect(html).toContain("42,000 sats");
    expect(html).toContain("정산완료");
  });

  it("renders USD completed history with an explicit dollar amount", () => {
    const html = renderHistory({
      language: "en",
      records: [
        completedRecord({
          inputMode: "usd",
          totalAmount: "2500",
          payerShareSats: undefined,
          payerShareUsdCents: "1250",
          slots: [
            {
              slotNumber: 1,
              usdCentsShare: "1250",
              targetSats: "21000",
              status: "settled",
              completedAt: "2030-08-31T12:30:00.000Z",
            },
          ],
        }),
      ],
    });

    expect(html).toContain("$25.00");
    expect(html).toContain("Settlement history");
  });
});
