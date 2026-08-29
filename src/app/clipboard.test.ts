import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard, readTextFromClipboard } from "./clipboard";

describe("clipboard helpers", () => {
  it("copies and reads when the clipboard API is available", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await expect(copyTextToClipboard("invoice", { writeText })).resolves.toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith("invoice");
    await expect(
      readTextFromClipboard({ readText: () => Promise.resolve(" user@test ") }),
    ).resolves.toBe("user@test");
  });

  it("returns a fallback result when clipboard permission is unavailable", async () => {
    await expect(copyTextToClipboard("invoice", undefined)).resolves.toBe(
      false,
    );
    await expect(readTextFromClipboard(undefined)).resolves.toBeNull();
    await expect(
      copyTextToClipboard("invoice", {
        writeText: () => Promise.reject(new Error("denied")),
      }),
    ).resolves.toBe(false);
  });
});
