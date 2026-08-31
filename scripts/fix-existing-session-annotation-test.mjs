import { readFile, writeFile } from "node:fs/promises";

const path = "src/app/session.test.ts";
let source = await readFile(path, "utf8");

const before = `  it("adds user display metadata only after a slot is settled", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: ["철수"],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    expect(
      annotateSettledSlot(generating, 1, { displayName: "철수", note: "표시" })
        .slots[0]?.annotation,
    ).toBeUndefined();
    const settled = {
      ...generating,
      slots: generating.slots.map((slot) => ({
        ...slot,
        status: "settled" as const,
        settledAt: "2030-01-01T00:00:00.000Z",
      })),
    };
    const annotated = annotateSettledSlot(settled, 1, {
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]?.annotation).toMatchObject({
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]).not.toHaveProperty("payerIdentity");
  });`;

const after = `  it("stores local display metadata independently from payment status", () => {
    const draft: DraftInput = {
      inputMode: "sats",
      totalAmount: "1000",
      totalPeople: 2,
      excludePayer: true,
      lightningAddress: "user@wallet.example",
      participantNameCandidates: ["철수"],
    };
    const generating = createGeneratingSession(
      draft,
      createSettlementPreview(draft),
      undefined,
    );
    const named = annotateSettledSlot(generating, 1, {
      displayName: "철수",
      note: "표시",
    });
    expect(named.slots[0]?.annotation).toMatchObject({
      displayName: "철수",
      note: "표시",
    });
    const settled = {
      ...named,
      slots: named.slots.map((slot) => ({
        ...slot,
        status: "settled" as const,
        settledAt: "2030-01-01T00:00:00.000Z",
      })),
    };
    const annotated = annotateSettledSlot(settled, 1, {
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]?.annotation).toMatchObject({
      displayName: "철수",
      note: "사용자 표시",
    });
    expect(annotated.slots[0]).not.toHaveProperty("payerIdentity");
  });`;

if (!source.includes(before)) {
  throw new Error("Expected stale session annotation test was not found.");
}
source = source.replace(before, after);
await writeFile(path, source, "utf8");
