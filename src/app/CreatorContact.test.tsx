import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreatorContact } from "./CreatorContact";

describe("creator contact panel", () => {
  it("stays collapsed by default and exposes creator, contact, and support details", () => {
    const html = renderToStaticMarkup(<CreatorContact />);

    expect(html).toContain("제작자 · 문의");
    expect(html).toContain("엄지왕");
    expect(html).toContain('src="/creator-logo.jpg"');
    expect(html).toContain("https://x.com/thumbking0227");
    expect(html).toContain("https://www.threads.com/@thumb.ggul");
    expect(html).toContain("라이트닝으로 후원하기");
    expect(html).toContain('src="/lightning-support-qr.png"');
    expect(html).toContain("thumbking@oksu.su");
    expect(html).toContain("라이트닝 주소 복사");
    expect(html).toContain("지속적인 검증과 다음 버전 제작");
    expect(html).toContain("시드 문구·개인키·비밀번호");
    expect(html).not.toContain("<details open");
  });
});
