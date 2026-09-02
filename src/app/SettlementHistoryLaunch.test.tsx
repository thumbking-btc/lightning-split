import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettlementHistoryLaunch } from "./SettlementHistoryLaunch";

describe("settlement history navigation card", () => {
  it("renders as a navigation-style card with completed-history count", () => {
    const html = renderToStaticMarkup(
      <SettlementHistoryLaunch
        count={3}
        hasActiveSettlement={false}
        language="ko"
        onOpen={vi.fn()}
      />,
    );

    expect(html).toContain('class="history-launch"');
    expect(html).toContain("정산 기록");
    expect(html).toContain("완료된 정산 3건");
    expect(html).toContain('aria-label="정산 기록 3건 보기"');
  });

  it("distinguishes the current settlement from archived history", () => {
    const html = renderToStaticMarkup(
      <SettlementHistoryLaunch
        count={4}
        hasActiveSettlement
        language="ko"
        onOpen={vi.fn()}
      />,
    );

    expect(html).toContain("정산 중 1건 · 완료 기록 3건");
    expect(html).toContain("›");
  });
});
