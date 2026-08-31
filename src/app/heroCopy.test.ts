import { describe, expect, it } from "vitest";

import { heroLine1For } from "./heroCopy";

describe("hero copy parity", () => {
  it("preserves the production KRW hero while keeping new modes neutral", () => {
    expect(heroLine1For("krw", "ko")).toBe("원화 더치페이를");
    expect(heroLine1For("usd", "ko")).toBe("비용을 나누고");
    expect(heroLine1For("sats", "ko")).toBe("비용을 나누고");
    expect(heroLine1For("krw", "en")).toBe("Split the bill.");
  });
});
