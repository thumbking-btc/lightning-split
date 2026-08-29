import { InfrastructureError } from "../src/infrastructure/errors";
import { safeHttpsUrl } from "../src/infrastructure/url";
import { isRecord } from "../src/infrastructure/validation";

const TOKEN_PREFIX = "v1";
const TOKEN_AAD = new TextEncoder().encode("lightning-split:verification:v1");
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,4096}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_TOKEN_LIFETIME_MS = 31 * 24 * 60 * 60 * 1_000;

export interface VerificationContext {
  readonly verifyUrl: string;
  readonly expectedPaymentHash: string;
  readonly expectedInvoiceHash: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

interface SealedPayload {
  readonly v: 1;
  readonly u: string;
  readonly p: string;
  readonly i: string;
  readonly a: number;
  readonly e: number;
}

function hexToBytes(value: string): Uint8Array {
  if (!SECRET_PATTERN.test(value)) {
    throw new InfrastructureError(
      "CONFIGURATION_ERROR",
      "Verification token secret is not configured.",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (base64UrlEncode(decoded) !== value)
    throw new Error("non-canonical base64url");
  return decoded;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function hashInvoice(invoice: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(invoice),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parsePayload(value: unknown, nowMs: number): VerificationContext {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.u !== "string" ||
    typeof value.p !== "string" ||
    typeof value.i !== "string" ||
    !HASH_PATTERN.test(value.p) ||
    !HASH_PATTERN.test(value.i) ||
    !Number.isSafeInteger(value.a) ||
    !Number.isSafeInteger(value.e) ||
    Number(value.a) > nowMs + 30_000 ||
    Number(value.e) <= Number(value.a) ||
    Number(value.e) - Number(value.a) > MAX_TOKEN_LIFETIME_MS
  ) {
    throw new Error("invalid payload");
  }
  return Object.freeze({
    verifyUrl: safeHttpsUrl(value.u).toString(),
    expectedPaymentHash: value.p,
    expectedInvoiceHash: value.i,
    issuedAtMs: Number(value.a),
    expiresAtMs: Number(value.e),
  });
}

function invalidToken(cause?: unknown): InfrastructureError {
  return new InfrastructureError(
    "INVALID_INPUT",
    "결제 확인 정보가 올바르지 않습니다.",
    cause === undefined ? {} : { cause },
  );
}

export async function sealVerificationContext(
  input: {
    readonly verifyUrl: string;
    readonly expectedPaymentHash: string;
    readonly expectedInvoice: string;
    readonly expiresAt: string;
  },
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const expiresAtMs = Date.parse(input.expiresAt);
  if (
    !HASH_PATTERN.test(input.expectedPaymentHash) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > MAX_TOKEN_LIFETIME_MS
  ) {
    throw invalidToken();
  }
  const payload: SealedPayload = {
    v: 1,
    u: safeHttpsUrl(input.verifyUrl).toString(),
    p: input.expectedPaymentHash,
    i: await hashInvoice(input.expectedInvoice),
    a: nowMs,
    e: expiresAtMs,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: TOKEN_AAD, tagLength: 128 },
    await importKey(secret),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${TOKEN_PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function openVerificationContext(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<VerificationContext> {
  if (!TOKEN_PATTERN.test(token)) throw invalidToken();
  try {
    const [, encodedIv, encodedCiphertext] = token.split(".");
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(encodedIv!),
        additionalData: TOKEN_AAD,
        tagLength: 128,
      },
      await importKey(secret),
      base64UrlDecode(encodedCiphertext!),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decrypted));
    return parsePayload(parsed, nowMs);
  } catch (cause) {
    if (
      cause instanceof InfrastructureError &&
      cause.code === "CONFIGURATION_ERROR"
    ) {
      throw cause;
    }
    throw invalidToken(cause);
  }
}

export async function assertVerificationLink(
  context: VerificationContext,
  paymentHash: string,
  invoice: string,
): Promise<void> {
  if (
    paymentHash !== context.expectedPaymentHash ||
    (await hashInvoice(invoice)) !== context.expectedInvoiceHash
  ) {
    throw invalidToken();
  }
}
