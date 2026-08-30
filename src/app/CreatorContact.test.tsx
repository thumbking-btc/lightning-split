import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreatorContact } from "./CreatorContact";

describe("creator contact panel", () => {
  it("stays collapsed by default and exposes the creator contact channels", () => {
    const html = renderToStaticMarkup(<CreatorContact />);

    expect(html).toContain("제작자 · 문의");
    expect(html).toContain("문의사항·개선 제안은 언제든 환영합니다");
    expect(html).toContain("엄지왕");
    expect(html).toContain("https://x.com/thumbking0227");
    expect(html).toContain("https://www.threads.com/@thumb.ggul");
    expect(html).toContain("시드 문구·개인키·비밀번호");
    expect(html).not.toContain("<details open");
  });
});
