import { describe, expect, it } from "vitest";

import {
  DELETE_PENDING_SETTLEMENT_BLOCKED,
  hasPendingSettlement,
  NEW_SETTLEMENT_PENDING_BLOCKED,
} from "./sessionActions";

describe("settlement lifecycle actions", () => {
  it("keeps unfinished settlements active", () => {
    expect(
      hasPendingSettlement({
        slots: [{ status: "settled" }, { status: "expired" }],
      }),
    ).toBe(true);
    expect(NEW_SETTLEMENT_PENDING_BLOCKED).toContain("재발급");
    expect(DELETE_PENDING_SETTLEMENT_BLOCKED).toContain("삭제할 수 없습니다");
  });

  it("allows completion only when every slot is settled or manually confirmed", () => {
    expect(
      hasPendingSettlement({
        slots: [{ status: "settled" }, { status: "manuallyConfirmed" }],
      }),
    ).toBe(false);
  });
});
