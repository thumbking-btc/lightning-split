import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const LOWER_HEX_32_PATTERN = /^[0-9a-f]{64}$/u;
const LOWER_HEX_64_PATTERN = /^[0-9a-f]{128}$/u;
const MAX_NOSTR_EVENT_BYTES = 128 * 1_024;
const MAX_NOSTR_TAGS = 128;
const MAX_NOSTR_TAG_ELEMENTS = 64;

const textEncoder = new TextEncoder();

export type NostrTag = readonly [string, ...string[]];

export interface UnsignedNostrEvent {
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly NostrTag[];
  readonly content: string;
}

export interface NostrEvent extends UnsignedNostrEvent {
  readonly id: string;
  readonly sig: string;
}

export interface NostrEventTemplate {
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

export class NostrEventError extends TypeError {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NostrEventError";
  }
}

function fail(code: string, message: string): never {
  throw new NostrEventError(code, message);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string, expectedBytes: number): Uint8Array {
  if (value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/u.test(value)) {
    return fail("HEX", "Nostr hexadecimal data is invalid.");
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTags(value: unknown): readonly NostrTag[] {
  if (!Array.isArray(value) || value.length > MAX_NOSTR_TAGS) {
    return fail("TAGS", "Nostr event tags are invalid.");
  }
  const tags: NostrTag[] = [];
  for (const candidate of value) {
    if (
      !Array.isArray(candidate) ||
      candidate.length === 0 ||
      candidate.length > MAX_NOSTR_TAG_ELEMENTS ||
      !candidate.every((part) => typeof part === "string")
    ) {
      return fail("TAGS", "Nostr event tags are invalid.");
    }
    const [name, ...rest] = candidate as string[];
    if (name === undefined) {
      return fail("TAGS", "Nostr event tags are invalid.");
    }
    tags.push(Object.freeze([name, ...rest]));
  }
  return Object.freeze(tags);
}

function normalizeUnsignedEvent(value: unknown): UnsignedNostrEvent {
  if (!isRecord(value)) return fail("EVENT", "Nostr event is invalid.");
  if (
    typeof value.pubkey !== "string" ||
    !isValidNostrPublicKey(value.pubkey)
  ) {
    return fail("PUBKEY", "Nostr public key is invalid.");
  }
  if (
    typeof value.created_at !== "number" ||
    !Number.isSafeInteger(value.created_at) ||
    value.created_at < 0
  ) {
    return fail("CREATED_AT", "Nostr event timestamp is invalid.");
  }
  if (
    typeof value.kind !== "number" ||
    !Number.isInteger(value.kind) ||
    value.kind < 0 ||
    value.kind > 65_535
  ) {
    return fail("KIND", "Nostr event kind is invalid.");
  }
  if (typeof value.content !== "string") {
    return fail("CONTENT", "Nostr event content is invalid.");
  }
  const event = Object.freeze({
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    tags: normalizeTags(value.tags),
    content: value.content,
  });
  assertSerializedSize(event);
  return event;
}

function assertSerializedSize(event: UnsignedNostrEvent): void {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  if (textEncoder.encode(serialized).length > MAX_NOSTR_EVENT_BYTES) {
    fail("EVENT_SIZE", "Nostr event is too large.");
  }
}

export function isValidNostrPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !LOWER_HEX_32_PATTERN.test(value)) {
    return false;
  }
  try {
    schnorr.utils.lift_x(BigInt(`0x${value}`));
    return true;
  } catch {
    return false;
  }
}

/** NIP-01 canonical serialization used to calculate an event id. */
export function serializeNostrEvent(event: UnsignedNostrEvent): string {
  const normalized = normalizeUnsignedEvent(event);
  return JSON.stringify([
    0,
    normalized.pubkey,
    normalized.created_at,
    normalized.kind,
    normalized.tags,
    normalized.content,
  ]);
}

export function calculateNostrEventId(event: UnsignedNostrEvent): string {
  return bytesToHex(sha256(textEncoder.encode(serializeNostrEvent(event))));
}

/**
 * Signs an event with BIP-340. The public key is always derived from the
 * supplied secret key so callers cannot accidentally sign a mismatched key.
 */
export function signNostrEvent(
  template: NostrEventTemplate,
  secretKey: Uint8Array,
  auxiliaryRandom?: Uint8Array,
): NostrEvent {
  let publicKey: Uint8Array;
  try {
    publicKey = schnorr.getPublicKey(secretKey);
  } catch (cause) {
    throw new NostrEventError("SECRET_KEY", "Nostr secret key is invalid.", {
      cause,
    });
  }
  const unsigned = normalizeUnsignedEvent({
    pubkey: bytesToHex(publicKey),
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  });
  const id = calculateNostrEventId(unsigned);
  let signature: Uint8Array;
  try {
    signature =
      auxiliaryRandom === undefined
        ? schnorr.sign(hexToBytes(id, 32), secretKey)
        : schnorr.sign(hexToBytes(id, 32), secretKey, auxiliaryRandom);
  } catch (cause) {
    throw new NostrEventError("SIGNATURE", "Nostr signing failed.", {
      cause,
    });
  }
  return Object.freeze({
    id,
    ...unsigned,
    sig: bytesToHex(signature),
  });
}

/** Parses, canonicalizes and verifies both the NIP-01 id and BIP-340 signature. */
export function parseAndVerifyNostrEvent(value: unknown): NostrEvent {
  if (!isRecord(value)) return fail("EVENT", "Nostr event is invalid.");
  const unsigned = normalizeUnsignedEvent(value);
  if (typeof value.id !== "string" || !LOWER_HEX_32_PATTERN.test(value.id)) {
    return fail("ID", "Nostr event id is invalid.");
  }
  if (typeof value.sig !== "string" || !LOWER_HEX_64_PATTERN.test(value.sig)) {
    return fail("SIGNATURE", "Nostr event signature is invalid.");
  }
  const expectedId = calculateNostrEventId(unsigned);
  if (value.id !== expectedId) {
    return fail("ID", "Nostr event id does not match its contents.");
  }
  if (
    !schnorr.verify(
      hexToBytes(value.sig, 64),
      hexToBytes(expectedId, 32),
      hexToBytes(unsigned.pubkey, 32),
    )
  ) {
    return fail("SIGNATURE", "Nostr event signature is invalid.");
  }
  return Object.freeze({
    id: expectedId,
    ...unsigned,
    sig: value.sig,
  });
}

/** Stable wire JSON for locally-created events and NIP-57 description hashes. */
export function encodeNostrEvent(event: NostrEvent): string {
  const verified = parseAndVerifyNostrEvent(event);
  return JSON.stringify(verified);
}
