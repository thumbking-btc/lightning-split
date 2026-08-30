import { describe, expect, it, vi } from "vitest";

import { scrollCarouselToIndex } from "./carousel";

describe("carousel positioning", () => {
  it("scrolls a restored actionable slot into the visible carousel", () => {
    const scrollIntoView = vi.fn();
    const item = vi.fn((index: number) =>
      index === 1 ? { scrollIntoView } : null,
    );

    expect(scrollCarouselToIndex({ children: { item } }, 1, "auto")).toBe(true);
    expect(item).toHaveBeenCalledWith(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "center",
    });
    expect(scrollCarouselToIndex({ children: { item } }, 9, "auto")).toBe(
      false,
    );
  });
});
