import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

import { isPublicHostname, safeHttpsUrl } from "../infrastructure/url";
import {
  type ValidatedBolt11Invoice,
  validateBolt11Invoice,
} from "../lightning/bolt11";
import {
  encodeNostrEvent,
  isValidNostrPublicKey,
  type NostrEvent,
  type NostrTag,
  parseAndVerifyNostrEvent,
  signNostrEvent,
} from "./event";

const LOWER_HEX_32_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const MAX_MILLISATS = 2_100_000_000_000_000_000n;
const MAX_LNURL_LENGTH = 5_000;
const MAX_ZAP_REQUEST_BYTES = 64 * 1_024;
const MAX_ZAP_RELAYS = 16;
const DEFAULT_RECEIPT_CLOCK_SKEW_SECONDS = 300;

const textEncoder = new TextEncoder();

export interface ZapRequestInput {
  readonly recipientPubkey: string;
  readonly amountMsat: bigint;
  readonly lnurl: string;
  readonly relays: readonly string[];
  readonly content?: string;
  readonly createdAt?: number;
}

export interface ZapRequestValidationOptions {
  readonly expectedRecipientPubkey?: string;
  readonly expectedAmountMsat?: bigint;
  readonly expectedLnurl?: string;
  readonly expectedProviderPubkey?: string;
}

export interface ValidatedZapRequest {
  readonly event: NostrEvent;
  /** Exact JSON committed to by the BOLT11 description hash. */
  readonly json: string;
  readonly recipientPubkey: string;
  readonly amountMsat: bigint;
  readonly lnurl: string;
  readonly payUrl: string;
  readonly relays: readonly string[];
}

export interface ZapReceiptValidationContext {
  readonly request: ValidatedZapRequest;
  readonly providerPubkey: string;
  readonly expectedInvoice: string;
  readonly expectedPaymentHash: string;
  readonly nowSeconds?: number;
  readonly maximumClockSkewSeconds?: number;
}

export interface ValidatedZapReceipt {
  readonly event: NostrEvent;
  readonly request: ValidatedZapRequest;
  readonly invoice: ValidatedBolt11Invoice;
  readonly paymentHash: string;
  readonly preimage?: string;
  /** NIP-57 is a provider-signed attestation, not payer-held payment proof. */
  readonly providerAttestation: true;
}

export class ZapProtocolError extends TypeError {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ZapProtocolError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ZapProtocolError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array {
  if (!LOWER_HEX_32_PATTERN.test(value)) {
    return fail("HEX", "NIP-57 hexadecimal data is invalid.");
  }
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function equalTag(left: NostrTag, right: NostrTag): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function tagsNamed(event: NostrEvent, name: string): readonly NostrTag[] {
  return event.tags.filter((tag) => tag[0] === name);
}

function singletonTag(event: NostrEvent, name: string): NostrTag {
  const tags = tagsNamed(event, name);
  const tag = tags[0];
  if (tags.length !== 1 || !tag || tag.length !== 2) {
    return fail("TAG", `NIP-57 requires exactly one valid ${name} tag.`);
  }
  return tag;
}

function optionalSingletonTag(
  event: NostrEvent,
  name: string,
): NostrTag | undefined {
  const tags = tagsNamed(event, name);
  const tag = tags[0];
  if (tags.length > 1 || (tag && tag.length !== 2)) {
    return fail("TAG", `NIP-57 ${name} tag is invalid.`);
  }
  return tag;
}

function validateRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    return fail("RELAY", "NIP-57 relay URL is invalid.", cause);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "wss:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.hash !== "" ||
    !isPublicHostname(hostname)
  ) {
    return fail("RELAY", "NIP-57 relay URL is unsafe.");
  }
  url.hostname = hostname;
  return url.toString();
}

function validateRelays(event: NostrEvent): readonly string[] {
  const tags = tagsNamed(event, "relays");
  const tag = tags[0];
  if (
    tags.length !== 1 ||
    !tag ||
    tag.length < 2 ||
    tag.length > MAX_ZAP_RELAYS + 1
  ) {
    return fail("RELAYS", "NIP-57 relays tag is invalid.");
  }
  const relays = tag.slice(1);
  const normalized = relays.map(validateRelayUrl);
  if (new Set(normalized).size !== normalized.length) {
    return fail("RELAYS", "NIP-57 relays must be unique.");
  }
  return Object.freeze(relays);
}

function validateAmount(value: string): bigint {
  if (value.length > 19 || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    return fail("AMOUNT", "NIP-57 amount is invalid.");
  }
  const amount = BigInt(value);
  if (amount > MAX_MILLISATS || amount % 1_000n !== 0n) {
    return fail("AMOUNT", "NIP-57 amount is outside the supported range.");
  }
  return amount;
}

function validateTargetTags(event: NostrEvent): void {
  const eventTag = optionalSingletonTag(event, "e");
  const addressTag = optionalSingletonTag(event, "a");
  const kindTag = optionalSingletonTag(event, "k");
  if (eventTag && !LOWER_HEX_32_PATTERN.test(eventTag[1] ?? "")) {
    fail("TARGET", "NIP-57 target event id is invalid.");
  }
  if (eventTag && addressTag) {
    fail("TARGET", "NIP-57 request has conflicting targets.");
  }
  if (addressTag) {
    const match = /^(3[0-9]{4}):([0-9a-f]{64}):(.*)$/u.exec(
      addressTag[1] ?? "",
    );
    const kind = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (
      !match ||
      kind < 30_000 ||
      kind >= 40_000 ||
      !isValidNostrPublicKey(match[2])
    ) {
      fail("TARGET", "NIP-57 event coordinate is invalid.");
    }
  }
  if (kindTag) {
    const value = kindTag[1] ?? "";
    if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value) || Number(value) > 65_535) {
      fail("TARGET", "NIP-57 target kind is invalid.");
    }
    if (!eventTag && !addressTag) {
      fail("TARGET", "NIP-57 target kind has no target event.");
    }
    if (
      addressTag &&
      Number(value) !== Number(addressTag[1]?.split(":", 1)[0])
    ) {
      fail("TARGET", "NIP-57 target kind does not match its coordinate.");
    }
  }
}

function decodeJson(value: string): unknown {
  if (
    value.length === 0 ||
    textEncoder.encode(value).length > MAX_ZAP_REQUEST_BYTES
  ) {
    return fail("REQUEST_SIZE", "NIP-57 request JSON is invalid.");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    return fail("REQUEST_JSON", "NIP-57 request is not valid JSON.", cause);
  }
}

export function encodeLnurlPayUrl(input: string | URL): string {
  let payUrl: URL;
  try {
    payUrl = safeHttpsUrl(input);
  } catch (cause) {
    return fail("LNURL", "NIP-57 LNURL-pay URL is unsafe.", cause);
  }
  try {
    return bech32.encode(
      "lnurl",
      bech32.toWords(textEncoder.encode(payUrl.toString())),
      MAX_LNURL_LENGTH,
    );
  } catch (cause) {
    return fail("LNURL", "NIP-57 LNURL-pay URL is too long.", cause);
  }
}

export function decodeLnurlPayUrl(input: string): string {
  if (input.length === 0 || input.length > MAX_LNURL_LENGTH) {
    return fail("LNURL", "NIP-57 LNURL is invalid.");
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(input, MAX_LNURL_LENGTH);
  } catch (cause) {
    return fail("LNURL", "NIP-57 LNURL is invalid.", cause);
  }
  if (decoded.prefix.toLowerCase() !== "lnurl") {
    return fail("LNURL", "NIP-57 LNURL prefix is invalid.");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bech32.fromWords(decoded.words));
  } catch (cause) {
    return fail("LNURL", "NIP-57 LNURL payload is invalid.", cause);
  }
  try {
    return safeHttpsUrl(value).toString();
  } catch (cause) {
    return fail("LNURL", "NIP-57 LNURL-pay URL is unsafe.", cause);
  }
}

export function parseAndValidateZapRequest(
  json: string,
  options: ZapRequestValidationOptions = {},
): ValidatedZapRequest {
  let event: NostrEvent;
  try {
    event = parseAndVerifyNostrEvent(decodeJson(json));
  } catch (cause) {
    return fail("REQUEST_EVENT", "NIP-57 zap request is invalid.", cause);
  }
  if (event.kind !== 9_734) {
    return fail("REQUEST_KIND", "NIP-57 zap request kind is invalid.");
  }
  const recipientPubkey = singletonTag(event, "p")[1] ?? "";
  if (!isValidNostrPublicKey(recipientPubkey)) {
    return fail("RECIPIENT", "NIP-57 recipient public key is invalid.");
  }
  const amountMsat = validateAmount(singletonTag(event, "amount")[1] ?? "");
  const lnurl = singletonTag(event, "lnurl")[1] ?? "";
  const payUrl = decodeLnurlPayUrl(lnurl);
  const relays = validateRelays(event);
  validateTargetTags(event);

  const providerHint = optionalSingletonTag(event, "P");
  if (providerHint && !isValidNostrPublicKey(providerHint[1] ?? "")) {
    return fail("PROVIDER", "NIP-57 provider public key hint is invalid.");
  }
  if (
    options.expectedProviderPubkey !== undefined &&
    (!isValidNostrPublicKey(options.expectedProviderPubkey) ||
      (providerHint !== undefined &&
        providerHint[1] !== options.expectedProviderPubkey))
  ) {
    return fail("PROVIDER", "NIP-57 provider public key does not match.");
  }
  if (
    options.expectedRecipientPubkey !== undefined &&
    recipientPubkey !== options.expectedRecipientPubkey
  ) {
    return fail("RECIPIENT", "NIP-57 recipient public key does not match.");
  }
  if (
    options.expectedAmountMsat !== undefined &&
    amountMsat !== options.expectedAmountMsat
  ) {
    return fail("AMOUNT", "NIP-57 amount does not match.");
  }
  if (options.expectedLnurl !== undefined && lnurl !== options.expectedLnurl) {
    return fail("LNURL", "NIP-57 LNURL does not match.");
  }
  return Object.freeze({
    event,
    json,
    recipientPubkey,
    amountMsat,
    lnurl,
    payUrl,
    relays,
  });
}

export function createSignedZapRequest(
  input: ZapRequestInput,
  secretKey: Uint8Array,
  auxiliaryRandom?: Uint8Array,
): ValidatedZapRequest {
  if (!isValidNostrPublicKey(input.recipientPubkey)) {
    return fail("RECIPIENT", "NIP-57 recipient public key is invalid.");
  }
  validateAmount(input.amountMsat.toString());
  decodeLnurlPayUrl(input.lnurl);
  const relays = input.relays.map((relay) => {
    validateRelayUrl(relay);
    return relay;
  });
  if (
    relays.length === 0 ||
    relays.length > MAX_ZAP_RELAYS ||
    new Set(relays.map(validateRelayUrl)).size !== relays.length
  ) {
    return fail("RELAYS", "NIP-57 relays are invalid.");
  }
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1_000);
  const event = signNostrEvent(
    {
      created_at: createdAt,
      kind: 9_734,
      tags: [
        ["relays", ...relays],
        ["amount", input.amountMsat.toString()],
        ["lnurl", input.lnurl],
        ["p", input.recipientPubkey],
      ],
      content: input.content ?? "",
    },
    secretKey,
    auxiliaryRandom,
  );
  return parseAndValidateZapRequest(encodeNostrEvent(event), {
    expectedRecipientPubkey: input.recipientPubkey,
    expectedAmountMsat: input.amountMsat,
    expectedLnurl: input.lnurl,
  });
}

/** Creates a one-use sender identity and erases the secret immediately after signing. */
export function createEphemeralZapRequest(
  input: ZapRequestInput,
): ValidatedZapRequest {
  const secretKey = schnorr.utils.randomSecretKey();
  try {
    return createSignedZapRequest(input, secretKey);
  } finally {
    secretKey.fill(0);
  }
}

/** Creates a valid one-use x-only key for a private per-slot NIP-57 p alias. */
export function createEphemeralZapRecipientAlias(): string {
  const secretKey = schnorr.utils.randomSecretKey();
  try {
    return bytesToHex(schnorr.getPublicKey(secretKey));
  } finally {
    secretKey.fill(0);
  }
}

export function validateZapInvoice(
  invoice: string,
  request: ValidatedZapRequest,
): ValidatedBolt11Invoice {
  const parsedRequest = parseAndValidateZapRequest(request.json, {
    expectedRecipientPubkey: request.recipientPubkey,
    expectedAmountMsat: request.amountMsat,
    expectedLnurl: request.lnurl,
  });
  if (parsedRequest.event.id !== request.event.id) {
    return fail("REQUEST_EVENT", "NIP-57 request identity does not match.");
  }
  let validated: ValidatedBolt11Invoice;
  try {
    validated = validateBolt11Invoice(invoice, {
      expectedSats: parsedRequest.amountMsat / 1_000n,
      expectedDescription: parsedRequest.json,
      nowSeconds: parsedRequest.event.created_at,
      minimumRemainingSeconds: 0,
    });
  } catch (cause) {
    return fail("INVOICE", "NIP-57 invoice is invalid.", cause);
  }
  const expectedDescriptionHash = bytesToHex(
    sha256(textEncoder.encode(parsedRequest.json)),
  );
  if (validated.descriptionHash !== expectedDescriptionHash) {
    return fail(
      "DESCRIPTION_HASH",
      "NIP-57 invoice does not commit to the exact zap request.",
    );
  }
  return validated;
}

function validateCopiedTag(
  request: NostrEvent,
  receipt: NostrEvent,
  name: "e" | "a",
): void {
  const source = optionalSingletonTag(request, name);
  const copy = optionalSingletonTag(receipt, name);
  if ((source === undefined) !== (copy === undefined)) {
    fail("RECEIPT_TARGET", `NIP-57 receipt ${name} tag does not match.`);
  }
  if (source && copy && !equalTag(source, copy)) {
    fail("RECEIPT_TARGET", `NIP-57 receipt ${name} tag does not match.`);
  }
}

export function validateZapReceipt(
  value: unknown,
  context: ZapReceiptValidationContext,
): ValidatedZapReceipt {
  const request = parseAndValidateZapRequest(context.request.json, {
    expectedRecipientPubkey: context.request.recipientPubkey,
    expectedAmountMsat: context.request.amountMsat,
    expectedLnurl: context.request.lnurl,
    expectedProviderPubkey: context.providerPubkey,
  });
  if (request.event.id !== context.request.event.id) {
    return fail("REQUEST_EVENT", "NIP-57 request identity does not match.");
  }
  if (!isValidNostrPublicKey(context.providerPubkey)) {
    return fail("PROVIDER", "NIP-57 provider public key is invalid.");
  }
  if (!LOWER_HEX_32_PATTERN.test(context.expectedPaymentHash)) {
    return fail("PAYMENT_HASH", "NIP-57 expected payment hash is invalid.");
  }
  const invoice = validateZapInvoice(context.expectedInvoice, request);
  if (invoice.canonicalInvoice !== context.expectedInvoice) {
    return fail("INVOICE", "NIP-57 expected invoice is not canonical.");
  }
  if (invoice.paymentHash !== context.expectedPaymentHash) {
    return fail("PAYMENT_HASH", "NIP-57 payment hash does not match.");
  }

  let event: NostrEvent;
  try {
    event = parseAndVerifyNostrEvent(value);
  } catch (cause) {
    return fail("RECEIPT_EVENT", "NIP-57 zap receipt is invalid.", cause);
  }
  if (event.kind !== 9_735) {
    return fail("RECEIPT_KIND", "NIP-57 zap receipt kind is invalid.");
  }
  if (event.pubkey !== context.providerPubkey) {
    return fail("PROVIDER", "NIP-57 receipt signer does not match.");
  }

  const bolt11 = singletonTag(event, "bolt11")[1] ?? "";
  if (bolt11 !== context.expectedInvoice) {
    return fail("INVOICE", "NIP-57 receipt invoice does not match.");
  }
  const description = singletonTag(event, "description")[1] ?? "";
  if (description !== request.json) {
    return fail("DESCRIPTION", "NIP-57 receipt description does not match.");
  }
  const recipient = singletonTag(event, "p")[1] ?? "";
  if (recipient !== request.recipientPubkey) {
    return fail("RECIPIENT", "NIP-57 receipt recipient does not match.");
  }
  const sender = optionalSingletonTag(event, "P");
  if (sender && sender[1] !== request.event.pubkey) {
    return fail("SENDER", "NIP-57 receipt sender does not match.");
  }
  validateCopiedTag(request.event, event, "e");
  validateCopiedTag(request.event, event, "a");

  const requestKind = optionalSingletonTag(request.event, "k");
  const receiptKind = optionalSingletonTag(event, "k");
  if (
    receiptKind !== undefined &&
    (requestKind === undefined || !equalTag(requestKind, receiptKind))
  ) {
    return fail("RECEIPT_TARGET", "NIP-57 receipt target kind does not match.");
  }

  const nowSeconds = context.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const clockSkew =
    context.maximumClockSkewSeconds ?? DEFAULT_RECEIPT_CLOCK_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds <= 0 ||
    !Number.isSafeInteger(clockSkew) ||
    clockSkew < 0 ||
    event.created_at < request.event.created_at - clockSkew ||
    event.created_at > nowSeconds + clockSkew
  ) {
    return fail("RECEIPT_TIME", "NIP-57 receipt timestamp is invalid.");
  }

  const preimageTag = optionalSingletonTag(event, "preimage");
  let preimage: string | undefined;
  if (preimageTag) {
    const candidate = preimageTag[1] ?? "";
    if (
      !LOWER_HEX_32_PATTERN.test(candidate) ||
      bytesToHex(sha256(hexToBytes(candidate))) !== invoice.paymentHash
    ) {
      return fail("PREIMAGE", "NIP-57 receipt preimage does not match.");
    }
    preimage = candidate;
  }
  return Object.freeze({
    event,
    request,
    invoice,
    paymentHash: invoice.paymentHash,
    ...(preimage === undefined ? {} : { preimage }),
    providerAttestation: true,
  });
}
