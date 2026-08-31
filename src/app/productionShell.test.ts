import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("production shell parity", () => {
  it("keeps the production brand and installed-app assets", () => {
    const html = readFileSync(
      new URL("../../index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain("/brand-fix.css");
    expect(html).toContain("/lightning-split.jpg");
    expect(html).toContain("/apple-touch-icon.png");
  });

  it("keeps the production update status and creator support surfaces mounted", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toContain("<PwaVersionStatus />");
    expect(main).toContain("<CreatorContact />");
  });
});
