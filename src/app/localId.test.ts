import { describe, expect, it, vi } from "vitest";

import { createLocalSettlementId } from "./localId";

describe("local settlement ID", () => {
  it("uses the native UUID API in secure contexts", () => {
    const randomUUID = vi.fn(() => "native-id");
    expect(createLocalSettlementId({ randomUUID })).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.set(Array.from({ length: 16 }, (_, index) => index));
      return values;
    });
    expect(createLocalSettlementId({ getRandomValues })).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("still creates distinct local IDs without Web Crypto", () => {
    const first = createLocalSettlementId(null, 1_000, () => 0.25);
    const second = createLocalSettlementId(null, 1_000, () => 0.25);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^local-/u);
  });
});
