import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AmountInput, InvoiceCard, SettlementHeader } from "./App";
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

  it("keeps the settlement note visible in the result header", () => {
    const html = renderToStaticMarkup(
      <SettlementHeader note="8/30 고깃집 저녁" onNewSettlement={vi.fn()} />,
    );
    expect(html).toContain("8/30 고깃집 저녁");
    expect(html).toContain("정산 메모");
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
    expect(html).toContain("Lightning이 인증한 송금자");
  });
});
