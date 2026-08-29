import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

import { wordsToBytesPadded } from "../lightning/bolt11";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function integerWords(value: bigint, width?: number): number[] {
  const words: number[] = [];
  let remaining = value;
  do {
    words.unshift(Number(remaining & 31n));
    remaining >>= 5n;
  } while (remaining > 0n);
  while (width && words.length < width) words.unshift(0);
  return words;
}

function tag(type: string, words: number[]): number[] {
  const typeIndex = CHARSET.indexOf(type);
  if (typeIndex < 0 || words.length > 1_023)
    throw new Error("Invalid test tag.");
  return [
    typeIndex,
    Math.floor(words.length / 32),
    words.length % 32,
    ...words,
  ];
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createTestBolt11(options: {
  readonly amountSats: bigint;
  readonly fixtureId: string;
  readonly timestamp?: number;
  readonly expirySeconds?: number;
}): { readonly invoice: string; readonly paymentHash: string } {
  const timestamp = options.timestamp ?? 1_900_000_000;
  const expiry = options.expirySeconds ?? 3_600;
  const paymentHash = sha256(
    new TextEncoder().encode(`hash:${options.fixtureId}`),
  );
  const paymentSecret = sha256(
    new TextEncoder().encode(`secret:${options.fixtureId}`),
  );
  const description = new TextEncoder().encode("Lightning Split test invoice");
  const prefix = `lnbc${options.amountSats * 10n}n`;
  const signedWords = [
    ...integerWords(BigInt(timestamp), 7),
    ...tag("p", bech32.toWords(paymentHash)),
    ...tag("s", bech32.toWords(paymentSecret)),
    ...tag("d", bech32.toWords(description)),
    ...tag("x", integerWords(BigInt(expiry))),
  ];
  const digest = sha256(
    concatBytes(
      new TextEncoder().encode(prefix),
      wordsToBytesPadded(signedWords),
    ),
  );
  const ephemeralSigningKey = secp256k1.utils.randomSecretKey();
  const recoveredSignature = secp256k1.sign(digest, ephemeralSigningKey, {
    prehash: false,
    format: "recovered",
  });
  const encodedSignature = concatBytes(
    recoveredSignature.slice(1),
    recoveredSignature.slice(0, 1),
  );
  return Object.freeze({
    invoice: bech32.encode(
      prefix,
      [...signedWords, ...bech32.toWords(encodedSignature)],
      false,
    ),
    paymentHash: hex(paymentHash),
  });
}
