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
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('placeholder="0"');
    expect(html).toContain('pattern="[0-9]*"');
    expect(html).toContain(">원</button>");
    expect(html).toContain(">달러</button>");
    expect(html).toContain(">sats</button>");
    expect(html).not.toContain("₩ KRW");
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
    expect(html).toContain("사람별 원화 몫");
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
    expect(html).toContain("업비트 프리미엄");
    expect(html).not.toContain("김치프리미엄");
    expect(html).toContain("5분마다 갱신");
    expect(html).toContain("실시간");
    expect(html).not.toContain("upbit");
    expect(html).not.toContain("fallback");

    const enKrwHtml = renderToStaticMarkup(
      <MarketSummary language="en" market={{ connection: "loading" }} />,
    );
    expect(enKrwHtml).toContain("Upbit Premium");
    expect(enKrwHtml).not.toContain("Kimchi Premium");

    const usdHtml = renderToStaticMarkup(
      <MarketSummary
        currency="usd"
        language="en"
        market={{ connection: "loading" }}
        usdMarket={{
          connection: "live",
          information: {
            ok: true,
            snapshot: {
              priceUsdCents: "7871873",
              source: "coinbase",
              market: "BTC-USD",
              observedAt: new Date().toISOString(),
              retrievedAt: new Date().toISOString(),
              snapshotAt: new Date().toISOString(),
              fallbackUsed: false,
            },
            premium: {
              basisPoints: "-2",
              referencePriceUsdCents: "7873448",
              retrievedAt: new Date().toISOString(),
            },
          },
        }}
      />,
    );
    expect(usdHtml).toContain("Coinbase Premium");
    expect(usdHtml).not.toContain("Upbit Premium");
    expect(usdHtml).toContain("Updated every 5 min");

    const koUsdHtml = renderToStaticMarkup(
      <MarketSummary
        currency="usd"
        language="ko"
        market={{ connection: "loading" }}
        usdMarket={{ connection: "connecting" }}
      />,
    );
    expect(koUsdHtml).toContain("코인베이스 프리미엄");
    expect(koUsdHtml).not.toContain("Coinbase Premium");
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
    expect(html).toContain("최근 시세 · 실시간 연결 중");
    expect(html).toContain("연결 중");
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

  it("keeps participant labels before payment and makes manual completion reversible", () => {
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
        onUndoManualConfirm={vi.fn()}
      />,
    );
    expect(html).toContain("직접 확인 완료");
    expect(html).toContain("이 결제의 참여자");
    expect(html).toContain(
      "결제 QR이나 라이트닝 네트워크에는 포함되지 않습니다",
    );
    expect(html).toContain("완료 표시 취소");
    expect(html).not.toContain("누가 보냈나요?");
    expect(html).not.toContain("결제 요청 복사");

    const settledHtml = renderToStaticMarkup(
      <InvoiceCard
        slot={{
          ...slot,
          status: "settled",
          settledAt: "2030-01-01T00:01:00.000Z",
        }}
        candidates={[]}
        retrying={false}
        onAnnotate={vi.fn()}
        onRetry={vi.fn()}
        onManualConfirm={vi.fn()}
        onUndoManualConfirm={vi.fn()}
      />,
    );
    expect(settledHtml).not.toContain("결제 요청 복사");
    expect(settledHtml).not.toContain("완료 표시 취소");
  });

  it("states automatic, delayed, and manual verification modes explicitly", () => {
    const pending: ClientSlot = {
      slotNumber: 1,
      targetSats: "1000",
      attempt: 1,
      status: "pending",
      invoice: {
        bolt11: "lnbc1automatic",
        paymentHash: "11".repeat(32),
        timestampSeconds: 1,
        expirySeconds: 3600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"11".repeat(32)}`,
        featureBits: [],
        providerDomain: "wallet.example",
        payerMemo: "full",
        payeeMemo: "full",
        verificationToken: `v2.${"a".repeat(16)}.${"b".repeat(32)}`,
      },
    };
    const renderCard = (slot: ClientSlot) =>
      renderToStaticMarkup(
        <InvoiceCard
          slot={slot}
          candidates={[]}
          retrying={false}
          onAnnotate={vi.fn()}
          onRetry={vi.fn()}
          onManualConfirm={vi.fn()}
          onUndoManualConfirm={vi.fn()}
        />,
      );

    const pendingHtml = renderCard(pending);
    expect(pendingHtml).toContain("결제 대기 · 자동 확인 중");
    expect(pendingHtml).toContain("입금이 확인되면 자동으로 완료됩니다");
    expect(pendingHtml).toContain(
      'data-payment-capability="automatic-both-memos"',
    );
    expect(pendingHtml).toContain(
      "결제 요청에 메모 포함 · 받는 서비스에 메모 전달",
    );
    expect(pendingHtml).toContain("직접 확인 후 완료로 표시");
    expect(pendingHtml.indexOf("이 결제의 참여자")).toBeLessThan(
      pendingHtml.indexOf("qr-shell"),
    );

    const delayedHtml = renderCard({
      ...pending,
      verificationDelayed: true,
    });
    expect(delayedHtml).toContain("자동 확인 지연 · 직접 확인 가능");
    expect(delayedHtml).toContain("결제 완료로 표시");

    const { verificationToken: _verificationToken, ...manualInvoice } =
      pending.invoice!;
    void _verificationToken;
    const manualHtml = renderCard({ ...pending, invoice: manualInvoice });
    expect(manualHtml).toContain("결제 대기 · 직접 확인 필요");
    expect(manualHtml).toContain("자동 확인을 사용할 수 없습니다");
    expect(manualHtml).toContain('data-payment-capability="both-memos"');

    const verifyingHtml = renderCard({
      ...pending,
      status: "verifyingExpired",
    });
    expect(verifyingHtml).toContain("결제 완료로 표시");
    expect(verifyingHtml).not.toContain("결제 요청 복사");
  });

  it("offers exactly one canonical payment path without technical toggles", () => {
    const html = renderToStaticMarkup(
      <InvoiceCard
        slot={{
          slotNumber: 1,
          targetSats: "1000",
          attempt: 1,
          status: "pending",
          invoice: {
            bolt11: "lnbc1canonical",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
          },
        }}
        candidates={[]}
        retrying={false}
        onAnnotate={vi.fn()}
        onRetry={vi.fn()}
        onManualConfirm={vi.fn()}
        onUndoManualConfirm={vi.fn()}
      />,
    );
    expect(html.match(/qr-shell/gu)).toHaveLength(1);
    expect(html).toContain("결제 요청 복사");
    expect(html).not.toContain("BOLT11");
    expect(html).not.toContain("메모 포함 결제 QR");
  });

  it("does not offer a futile retry when mandatory payer data is unsupported", () => {
    const html = renderToStaticMarkup(
      <InvoiceCard
        slot={{
          slotNumber: 1,
          targetSats: "1000",
          attempt: 1,
          status: "failed",
          failure: {
            code: "PAYER_DATA_REQUIRED",
            message: "payer data required",
            retryable: false,
          },
        }}
        candidates={[]}
        retrying={false}
        onAnnotate={vi.fn()}
        onRetry={vi.fn()}
        onManualConfirm={vi.fn()}
        onUndoManualConfirm={vi.fn()}
      />,
    );
    expect(html).toContain("필수 송금자 정보");
    expect(html).not.toContain("이 결제만 다시 만들기");
  });

  it("does not expose a new invoice until its session is durably stored", () => {
    const html = renderToStaticMarkup(
      <InvoiceCard
        slot={{
          slotNumber: 1,
          targetSats: "1000",
          attempt: 1,
          status: "pending",
          invoice: {
            bolt11: "lnbc1awaiting",
            paymentHash: "11".repeat(32),
            timestampSeconds: 1,
            expirySeconds: 3600,
            expiresAt: "2030-01-01T01:00:00.000Z",
            payeeNodeId: `02${"11".repeat(32)}`,
            featureBits: [],
            providerDomain: "wallet.example",
            awaitingPersistence: true,
          },
        }}
        candidates={[]}
        retrying={false}
        onAnnotate={vi.fn()}
        onRetry={vi.fn()}
        onManualConfirm={vi.fn()}
        onUndoManualConfirm={vi.fn()}
      />,
    );
    expect(html).toContain("기기에 안전하게 저장");
    expect(html).not.toContain("결제 요청 복사");
    expect(html).not.toContain("결제 완료로 표시");
  });
});
