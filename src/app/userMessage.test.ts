import { describe, expect, it } from "vitest";

import { ApiClientError } from "./api";
import { toUserMessage } from "./userMessage";

describe("user-facing API errors", () => {
  it("explains rate limits in Korean with the retry window", () => {
    expect(
      toUserMessage(
        new ApiClientError("RATE_LIMITED", "upstream detail", true, 60),
      ),
    ).toBe(
      "요청이 많습니다. 잠시 후 다시 시도하십시오. 약 60초 후 다시 시도할 수 있습니다.",
    );
  });

  it("does not expose technical provider details for known failures", () => {
    expect(
      toUserMessage(
        new ApiClientError("INVALID_BOLT11", "decoder failed", false),
      ),
    ).toBe("안전하게 확인할 수 없는 결제 요청이 반환되었습니다.");
  });

  it("preserves the provider-specific comment limit guidance", () => {
    expect(
      toUserMessage(
        new ApiClientError(
          "COMMENT_TOO_LONG",
          "이 Lightning Address는 정산 메모를 40자까지 지원합니다. 메모를 줄여 다시 시도하십시오.",
          false,
        ),
      ),
    ).toContain("40자까지");
  });
});
