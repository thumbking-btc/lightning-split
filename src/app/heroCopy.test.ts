import { describe, expect, it } from "vitest";

import { heroLine1For } from "./heroCopy";

describe("hero copy parity", () => {
  it.each(["krw", "usd", "sats"] as const)(
    "keeps the Korean and English hero independent of %s mode",
    (inputMode) => {
      expect(heroLine1For(inputMode, "ko")).toBe("더치페이를");
      expect(heroLine1For(inputMode, "en")).toBe("Split the bill.");
    },
  );
});
