import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AmountInput,
  InvoiceCard,
  MarketSummary,
  SettlementRecordDeleteButton,
  SettlementHeader,
  SettlementPreviewDetails,
} from "./App";
import { serializeBigIntDecimal } from "./api/serialization";
import {
  DELETE_SETTLEMENT_RECORD_CONFIRMATION,
  hasPendingSettlement,
  NEW_SETTLEMENT_PENDING_CONFIRMATION,
} from "./app/sessionActions";
import type { ClientSlot } from "./app/types";

describe("v1 mobile accessibility states", () => {
  it("starts with a blank KRW amount and exposes the selected unit", () => {
    const html = renderToStaticMarkup(
      <AmountInput
        inputMode="krw"
        totalAmount=""
        onInputModeChange={vi.fn()}
        onTotalAmountChange={vi.fn()}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('placeholder="0"');
    expect(html).not.toContain('value="86000"');
  });

  it("keeps the settlement memo visible in the result header", () => {
    const html = renderToStaticMarkup(
      <SettlementHeader note="8/30 고깃집 저녁" onNewSettlement={vi.fn()} />,
    );
    expect(html).toContain("8/30 고깃집 저녁");
    expect(html).toContain("정산 메모");
  });

  it("shows sats-specific group-cost and receivable labels without KRW wording", () => {
    const html = renderToStaticMarkup(
      <SettlementPreviewDetails
        inputMode="sats"
        totalAmount="3002"
        totalPeople={3}
        preview={{
          invoiceShares: [1_000n, 1_000n],
          targetSats: [1_000n, 1_000n],
          invoiceCount: 2,
          payerShareKrw: null,
          payerShareSats: 1_002n,
        }}
      />,
    );
    expect(html).toContain("3,002 sats");
    expect(html).toContain("내 부담");
    expect(html).toContain("1,002 sats");
    expect(html).toContain("1인당 결제 금액");
    expect(html).toContain("받을 총 sats");
    expect(html).toContain("2,000 sats");
    expect(html).not.toContain("사람별 원화 몫");
    expect(html).not.toContain("직접 입력 기준");
  });

  it("keeps the KRW snapshot card outside the two-column auto-placement grid", () => {
    const html = renderToStaticMarkup(
      <SettlementPreviewDetails
        inputMode="krw"
        totalAmount="300"
        totalPeople={3}
        priceSnapshotAt="2026-08-30T04:40:23.000Z"
        preview={{
          invoiceShares: [100n, 100n],
          targetSats: [92n, 92n],
          invoiceCount: 2,
          payerShareKrw: 100n,
          payerShareSats: null,
        }}
      />,
    );
    expect(html.match(/class="preview-grid"/gu)).toHaveLength(1);
    expect(html).toContain('class="preview-details"');
    expect(html).toContain('class="preview-time-card"');
    expect(html).not.toContain('class="wide-preview-item"');
    expect(html).toContain("가격 확인 시각");
  });

  it("gives live market price and premium a clear non-technical status", () => {
    const html = renderToStaticMarkup(
      <MarketSummary
        market={{
          connection: "live",
          information: {
            ok: true,
            snapshot: {
              priceKrw: serializeBigIntDecimal(162_345_000n),
              source: "upbit",
              market: "KRW-BTC",
              observedAt: new Date().toISOString(),
              retrievedAt: new Date().toISOString(),
              snapshotAt: new Date().toISOString(),
              fallbackUsed: false,
            },
            premium: {
              basisPoints: "182",
              referencePriceKrw: "159444000",
              retrievedAt: new Date().toISOString(),
            },
          },
        }}
      />,
    );
    expect(html).toContain("162,345,000원");
    expect(html).toContain("+1.82%");
    expect(html).toContain("실시간");
    expect(html).not.toContain("upbit");
    expect(html).not.toContain("fallback");
  });

  it("explains a temporarily unavailable premium without implying a permanent absence", () => {
    const html = renderToStaticMarkup(
      <MarketSummary
        market={{
          connection: "recent",
          information: {
            ok: true,
            snapshot: {
              priceKrw: serializeBigIntDecimal(162_345_000n),
              source: "upbit",
              market: "KRW-BTC",
              observedAt: new Date().toISOString(),
              retrievedAt: new Date().toISOString(),
              snapshotAt: new Date().toISOString(),
              fallbackUsed: false,
            },
          },
        }}
      />,
    );
    expect(html).toContain("일시적으로 불러올 수 없음");
    expect(html).not.toContain("정보 없음");
  });

  it("distinguishes starting a new settlement from deleting its local record", () => {
    const pendingSession = {
      slots: [{ status: "pending" }],
    } as const;
    const completedSession = {
      slots: [{ status: "settled" }],
    } as const;
    const expiredSession = {
      slots: [{ status: "expired" }],
    } as const;

    expect(hasPendingSettlement(pendingSession)).toBe(true);
    expect(hasPendingSettlement(completedSession)).toBe(false);
    expect(hasPendingSettlement(expiredSession)).toBe(true);
    expect(NEW_SETTLEMENT_PENDING_CONFIRMATION).toContain("새 정산을 시작");
    expect(NEW_SETTLEMENT_PENDING_CONFIRMATION).not.toContain("지우");
    expect(DELETE_SETTLEMENT_RECORD_CONFIRMATION).toContain("기기에 저장된");
    expect(DELETE_SETTLEMENT_RECORD_CONFIRMATION).toContain(
      "취소되지 않습니다",
    );

    const newSettlement = renderToStaticMarkup(
      <SettlementHeader note={undefined} onNewSettlement={vi.fn()} />,
    );
    const deleteRecord = renderToStaticMarkup(
      <SettlementRecordDeleteButton onDelete={vi.fn()} />,
    );
    expect(newSettlement).toContain("새 정산");
    expect(newSettlement).not.toContain("danger-text-button");
    expect(deleteRecord).toContain("danger-text-button");
    expect(deleteRecord).toContain("이 정산 기록 삭제");
  });

  it("labels manual confirmation and post-payment sender annotation clearly", () => {
    const slot: ClientSlot = {
      slotNumber: 1,
      targetSats: "1000",
      attempt: 1,
      status: "manuallyConfirmed",
      confirmedAt: "2030-01-01T00:00:00.000Z",
      invoice: {
        bolt11: "lnbc1manual",
        paymentHash: "11".repeat(32),
        timestampSeconds: 1,
        expirySeconds: 3600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [],
        providerDomain: "wallet.example",
      },
    };
    const html = renderToStaticMarkup(
      <InvoiceCard
        slot={slot}
        candidates={["철수"]}
        retrying={false}
        onAnnotate={vi.fn()}
        onRetry={vi.fn()}
        onManualConfirm={vi.fn()}
      />,
    );
    expect(html).toContain("사용자 확인");
    expect(html).toContain("누가 보냈나요?");
    expect(html).toContain("라이트닝 네트워크가 인증한 송금자");
  });
});
