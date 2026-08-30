import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

export const MAX_BOLT11_LENGTH = 2_300;
export const DEFAULT_BOLT11_EXPIRY_SECONDS = 3_600;

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const MAX_SATS = 2_100_000_000_000_000n;
const KNOWN_REQUIRED_INVOICE_FEATURES = new Set([8, 14, 16, 24, 36, 48]);

export class Bolt11InvoiceError extends TypeError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Bolt11InvoiceError";
  }
}

function fail(code: string, message: string): never {
  throw new Bolt11InvoiceError(code, message);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function wordsToBytesPadded(words: readonly number[]): Uint8Array {
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31)
      fail("FORMAT", "Invalid invoice data word.");
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 0xff);
    }
    accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  if (bits > 0) output.push((accumulator << (8 - bits)) & 0xff);
  return Uint8Array.from(output);
}

function wordsToBytesStrict(words: readonly number[]): Uint8Array {
  try {
    return Uint8Array.from(bech32.fromWords([...words]));
  } catch {
    return fail("FORMAT", "Invalid invoice bit padding.");
  }
}

function wordsToBigInt(words: readonly number[], field: string): bigint {
  if (words.length > 11 || (words.length > 1 && words[0] === 0)) {
    return fail("FORMAT", `${field} is not minimally encoded.`);
  }
  let value = 0n;
  for (const word of words) value = (value << 5n) | BigInt(word);
  return value;
}

function parseAmountMsat(prefix: string): bigint {
  if (!prefix.startsWith("lnbc"))
    return fail("NETWORK", "Only Bitcoin mainnet invoices are accepted.");
  const encoded = prefix.slice(4);
  const match = /^(\d+)([munp]?)$/u.exec(encoded);
  if (!match || !match[1] || match[1].startsWith("0"))
    return fail("AMOUNT_FORMAT", "Invalid invoice amount.");
  const value = BigInt(match[1]);
  if (value <= 0n)
    return fail("AMOUNT_RANGE", "Invoice amount must be positive.");
  switch (match[2]) {
    case "p":
      if (value % 10n !== 0n)
        return fail("AMOUNT_SUB_MSAT", "Sub-msat invoices are unsupported.");
      return value / 10n;
    case "n":
      return value * 100n;
    case "u":
      return value * 100_000n;
    case "m":
      return value * 100_000_000n;
    default:
      return value * 100_000_000_000n;
  }
}

function parseTaggedFields(words: readonly number[]): Map<string, number[][]> {
  const fields = new Map<string, number[][]>();
  let cursor = 7;
  while (cursor < words.length) {
    const typeIndex = words[cursor];
    const high = words[cursor + 1];
    const low = words[cursor + 2];
    if (typeIndex === undefined || high === undefined || low === undefined)
      return fail("FORMAT", "Truncated tag.");
    const type = CHARSET[typeIndex];
    const length = high * 32 + low;
    cursor += 3;
    if (!type || cursor + length > words.length)
      return fail("FORMAT", "Invalid tag length.");
    const data = words.slice(cursor, cursor + length);
    cursor += length;
    const entries = fields.get(type) ?? [];
    entries.push(data);
    fields.set(type, entries);
  }
  return fields;
}

function exactlyOne(
  fields: ReadonlyMap<string, number[][]>,
  type: string,
  length: number,
  message: string,
): number[] {
  const entries = fields.get(type) ?? [];
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.length !== length)
    return fail("TAG_REQUIRED", message);
  return entry;
}

function validateDescription(
  fields: ReadonlyMap<string, number[][]>,
  expectedDescription?: string,
): { readonly description?: string; readonly descriptionHash?: string } {
  const descriptions = fields.get("d") ?? [];
  const hashes = fields.get("h") ?? [];
  if (
    (descriptions.length === 1) === (hashes.length === 1) ||
    descriptions.length > 1 ||
    hashes.length > 1
  ) {
    return fail(
      "DESCRIPTION",
      "Exactly one description or description hash is required.",
    );
  }
  const hash = hashes[0];
  if (hash && hash.length !== 52)
    return fail("DESCRIPTION", "Invalid description hash.");
  if (hash) {
    const decodedHash = wordsToBytesStrict(hash);
    const descriptionHash = bytesToHex(decodedHash);
    if (
      expectedDescription !== undefined &&
      descriptionHash !==
        bytesToHex(sha256(new TextEncoder().encode(expectedDescription)))
    ) {
      return fail(
        "DESCRIPTION",
        "Invoice description hash does not match LNURL metadata.",
      );
    }
    return { descriptionHash };
  }
  const description = descriptions[0];
  if (description) {
    const bytes = wordsToBytesStrict(description);
    if (bytes.length > 639)
      return fail("DESCRIPTION", "Description is too long.");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
    } catch {
      return fail("DESCRIPTION", "Description is not valid UTF-8.");
    }
    if (expectedDescription !== undefined && decoded !== expectedDescription) {
      return fail(
        "DESCRIPTION",
        "Invoice description does not match the expected description.",
      );
    }
    return { description: decoded };
  }
  return fail("DESCRIPTION", "Invoice description is missing.");
}

function setFeatureBits(words: readonly number[]): number[] {
  const bits = new Set<number>();
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (word === undefined) continue;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((word & (1 << bit)) !== 0)
        bits.add((words.length - 1 - index) * 5 + bit);
    }
  }
  for (const bit of bits) {
    if (bit % 2 === 0 && !KNOWN_REQUIRED_INVOICE_FEATURES.has(bit)) {
      return fail(
        "FEATURE_REQUIRED",
        `Unsupported required feature bit ${bit}.`,
      );
    }
  }
  return [...bits].sort((left, right) => left - right);
}

function verifySignature(
  prefix: string,
  signedWords: readonly number[],
  signatureWords: readonly number[],
  payeeWords: readonly number[] | undefined,
): Uint8Array {
  const encoded = wordsToBytesStrict(signatureWords);
  const recovery = encoded[64];
  if (encoded.length !== 65 || recovery === undefined || recovery > 3)
    return fail("SIGNATURE", "Invalid invoice signature.");
  const signature = encoded.slice(0, 64);
  const digest = sha256(
    concatBytes(
      new TextEncoder().encode(prefix),
      wordsToBytesPadded(signedWords),
    ),
  );
  if (payeeWords) {
    const payee = wordsToBytesStrict(payeeWords);
    if (
      payee.length !== 33 ||
      !secp256k1.verify(signature, digest, payee, {
        prehash: false,
        lowS: true,
      })
    ) {
      return fail("SIGNATURE", "Invoice payee does not match its signature.");
    }
    return payee;
  }
  try {
    const recovered = secp256k1.recoverPublicKey(
      concatBytes(Uint8Array.of(recovery), signature),
      digest,
      { prehash: false },
    );
    if (
      !secp256k1.verify(signature, digest, recovered, {
        prehash: false,
        lowS: false,
      })
    )
      throw new Error("verify");
    return recovered;
  } catch {
    return fail("SIGNATURE", "Invoice signature recovery failed.");
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export interface Bolt11ValidationOptions {
  readonly expectedSats: bigint;
  readonly expectedDescription?: string;
  readonly nowSeconds?: number;
  readonly minimumRemainingSeconds?: number;
}

export interface ValidatedBolt11Invoice {
  readonly amountMsat: bigint;
  readonly amountSats: bigint;
  readonly canonicalInvoice: string;
  readonly expiresAt: number;
  readonly expirySeconds: number;
  readonly featureBits: readonly number[];
  readonly payeeNodeId: string;
  readonly paymentHash: string;
  readonly timestamp: number;
  readonly description?: string;
  readonly descriptionHash?: string;
}

export function validateBolt11Invoice(
  input: string,
  options: Bolt11ValidationOptions,
): ValidatedBolt11Invoice {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_BOLT11_LENGTH
  )
    return fail("INPUT_LENGTH", "Invalid invoice length.");
  if (
    typeof options.expectedSats !== "bigint" ||
    options.expectedSats < 1n ||
    options.expectedSats > MAX_SATS
  )
    return fail("EXPECTED_AMOUNT", "Invalid expected amount.");
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const minimumRemainingSeconds = options.minimumRemainingSeconds ?? 60;
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds <= 0 ||
    !Number.isSafeInteger(minimumRemainingSeconds) ||
    minimumRemainingSeconds < 0
  )
    return fail("CLOCK", "Invalid validation clock.");
  let invoice = input;
  if (/^lightning:/iu.test(invoice))
    invoice = invoice.slice("lightning:".length);
  if (!invoice || invoice.includes(":") || invoice !== invoice.trim())
    return fail("INPUT_FORMAT", "Invalid invoice input.");
  if (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase())
    return fail("INPUT_FORMAT", "Mixed-case invoice.");
  invoice = invoice.toLowerCase();
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(invoice, false);
  } catch {
    return fail("CHECKSUM", "Invalid invoice checksum.");
  }
  const amountMsat = parseAmountMsat(decoded.prefix);
  if (amountMsat % 1_000n !== 0n)
    return fail("AMOUNT_SUB_SAT", "Invoice is not whole sats.");
  if (amountMsat !== options.expectedSats * 1_000n)
    return fail("AMOUNT_MISMATCH", "Invoice amount does not match.");
  if (decoded.words.length < 111)
    return fail("FORMAT", "Invoice data is too short.");
  const signedWords = decoded.words.slice(0, -104);
  const signatureWords = decoded.words.slice(-104);
  const timestampBig = wordsToBigInt(signedWords.slice(0, 7), "timestamp");
  if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER))
    return fail("TIMESTAMP", "Invalid timestamp.");
  const timestamp = Number(timestampBig);
  if (timestamp > nowSeconds + 300)
    return fail("TIMESTAMP", "Invoice timestamp is in the future.");
  const fields = parseTaggedFields(signedWords);
  const paymentHashWords = exactlyOne(
    fields,
    "p",
    52,
    "One payment hash is required.",
  );
  wordsToBytesStrict(
    exactlyOne(fields, "s", 52, "One payment secret is required."),
  );
  const description = validateDescription(fields, options.expectedDescription);
  const payees = fields.get("n") ?? [];
  if (payees.length > 1 || (payees[0] && payees[0].length !== 53))
    return fail("PAYEE", "Invalid payee tag.");
  if ((fields.get("x") ?? []).length > 1 || (fields.get("9") ?? []).length > 1)
    return fail("TAG_DUPLICATE", "Duplicate singleton tag.");
  const expiryWords = (fields.get("x") ?? [])[0];
  const expiryBig = expiryWords
    ? wordsToBigInt(expiryWords, "expiry")
    : BigInt(DEFAULT_BOLT11_EXPIRY_SECONDS);
  if (expiryBig > BigInt(Number.MAX_SAFE_INTEGER))
    return fail("EXPIRY", "Invalid expiry.");
  const expirySeconds = Number(expiryBig);
  const expiresAt = timestamp + expirySeconds;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - nowSeconds < minimumRemainingSeconds
  )
    return fail("EXPIRED", "Invoice is expired or near expiry.");
  const featureWords = (fields.get("9") ?? [])[0] ?? [];
  if (featureWords.length > 1 && featureWords[0] === 0)
    return fail("FEATURE_FORMAT", "Feature bits are not minimally encoded.");
  const featureBits = setFeatureBits(featureWords);
  const payeeNodeId = verifySignature(
    decoded.prefix,
    signedWords,
    signatureWords,
    payees[0],
  );
  return Object.freeze({
    amountMsat,
    amountSats: amountMsat / 1_000n,
    canonicalInvoice: invoice,
    expiresAt,
    expirySeconds,
    featureBits: Object.freeze(featureBits),
    payeeNodeId: bytesToHex(payeeNodeId),
    paymentHash: bytesToHex(wordsToBytesStrict(paymentHashWords)),
    timestamp,
    ...description,
  });
}
