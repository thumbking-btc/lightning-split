import { describe, expect, it } from "vitest";

import { parseParticipantNameCandidates } from "./nameCandidates";

describe("participant name candidate parser", () => {
  it("prioritizes commas and newlines while preserving spaces inside names", () => {
    expect(parseParticipantNameCandidates("홍 길동, 김 철수\n박 영희")).toEqual(
      ["홍 길동", "김 철수", "박 영희"],
    );
  });

  it("treats whitespace as a convenience delimiter when no explicit delimiter exists", () => {
    expect(parseParticipantNameCandidates("민수  철수\t영희")).toEqual([
      "민수",
      "철수",
      "영희",
    ]);
  });

  it("removes duplicates and caps the convenience list", () => {
    const values = Array.from(
      { length: 12 },
      (_, index) => `이름${index}`,
    ).join(",");
    expect(
      parseParticipantNameCandidates(`민수, 민수, ${values}`),
    ).toHaveLength(10);
  });
});
