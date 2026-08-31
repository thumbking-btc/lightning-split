import { describe, expect, it } from "vitest";

import {
  formatUsdCents,
  sanitizeIntegerInput,
  sanitizeUsdInput,
  usdInputToCents,
} from "./preferences";

describe("currency input preferences", () => {
  it("keeps KRW and sats inputs integer-only", () => {
    expect(sanitizeIntegerInput("₩12,345.67 sats")).toBe("1234567");
  });

  it("keeps a single USD decimal point and at most two decimals", () => {
    expect(sanitizeUsdInput("$1,234.567.89")).toBe("1234.56");
    expect(sanitizeUsdInput(".5")).toBe("0.5");
  });

  it("converts a valid USD input to canonical integer cents", () => {
    expect(usdInputToCents("12")).toBe("1200");
    expect(usdInputToCents("12.3")).toBe("1230");
    expect(usdInputToCents("12.34")).toBe("1234");
    expect(usdInputToCents("0.01")).toBe("1");
    expect(usdInputToCents("0")).toBe("");
  });

  it("formats canonical USD cents without floating-point arithmetic", () => {
    expect(formatUsdCents(123_456n, "en")).toBe("$1,234.56");
    expect(formatUsdCents(123_456n, "ko")).toBe("$1,234.56");
    expect(formatUsdCents(-1n, "en")).toBe("−$0.01");
  });
});
