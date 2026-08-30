import { describe, expect, it } from "vitest";

import {
  calculateNostrEventId,
  encodeNostrEvent,
  isValidNostrPublicKey,
  parseAndVerifyNostrEvent,
  serializeNostrEvent,
  signNostrEvent,
} from "./event";

const auxiliaryRandom = new Uint8Array(32);

function secret(value: number): Uint8Array {
  const result = new Uint8Array(32);
  result[31] = value;
  return result;
}

describe("NIP-01 event primitives", () => {
  it("uses canonical NIP-01 serialization and deterministic BIP-340 vectors", () => {
    const event = signNostrEvent(
      {
        created_at: 1_700_000_000,
        kind: 1,
        tags: [
          [
            "p",
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          ],
        ],
        content: 'line\n"quoted"\\tab\t',
      },
      secret(1),
      auxiliaryRandom,
    );

    expect(event.pubkey).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    expect(serializeNostrEvent(event)).toBe(
      '[0,"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",1700000000,1,[["p","79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]],"line\\n\\"quoted\\"\\\\tab\\t"]',
    );
    expect(event.id).toBe(
      "514e4314abe675dffac075129615d312fbfb3190ad6f0e638b7d95e05462e71e",
    );
    expect(calculateNostrEventId(event)).toBe(event.id);
    expect(event.sig).toBe(
      "645fa3232eeee7c53093c55071015a82c56221b3e158c92528610c9bd63140285807e69a1c01db10770816431c12faaa6238b523d549999ec5a191c1c66c8cfa",
    );
    expect(
      parseAndVerifyNostrEvent(JSON.parse(encodeNostrEvent(event))),
    ).toEqual(event);
  });

  it("rejects content, id and signature tampering", () => {
    const event = signNostrEvent(
      { created_at: 1_700_000_000, kind: 1, tags: [], content: "original" },
      secret(2),
      auxiliaryRandom,
    );

    expect(() =>
      parseAndVerifyNostrEvent({ ...event, content: "tampered" }),
    ).toThrowError(expect.objectContaining({ code: "ID" }));
    expect(() =>
      parseAndVerifyNostrEvent({ ...event, id: "00".repeat(32) }),
    ).toThrowError(expect.objectContaining({ code: "ID" }));
    expect(() =>
      parseAndVerifyNostrEvent({ ...event, sig: "00".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE" }));
  });

  it("rejects non-canonical hex, non-curve keys and malformed tags", () => {
    expect(isValidNostrPublicKey("ff".repeat(32))).toBe(false);
    expect(isValidNostrPublicKey("79BE".repeat(16))).toBe(false);

    const event = signNostrEvent(
      { created_at: 1_700_000_000, kind: 1, tags: [], content: "ok" },
      secret(3),
      auxiliaryRandom,
    );
    expect(() =>
      parseAndVerifyNostrEvent({
        ...event,
        pubkey: event.pubkey.toUpperCase(),
      }),
    ).toThrowError(expect.objectContaining({ code: "PUBKEY" }));
    expect(() =>
      parseAndVerifyNostrEvent({ ...event, tags: [["p", null]] }),
    ).toThrowError(expect.objectContaining({ code: "TAGS" }));
    expect(() =>
      parseAndVerifyNostrEvent({ ...event, kind: 65_536 }),
    ).toThrowError(expect.objectContaining({ code: "KIND" }));
  });
});
