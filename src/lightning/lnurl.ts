import type { LightningPolicy } from "../config/policies";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import { isPublicHostname, safeHttpsUrl } from "../infrastructure/url";
import {
  isRecord,
  parseProviderInteger,
  sanitizeProviderReason,
} from "../infrastructure/validation";
import { MAX_BOLT11_LENGTH } from "./bolt11";

const USERNAME_PATTERN = /^[a-z0-9._+-]{1,64}$/u;
const MAX_METADATA_IMAGE_CHARACTERS = 136_536;

export interface NormalizedLightningAddress {
  readonly address: string;
  readonly username: string;
  readonly domain: string;
  readonly discoveryUrl: string;
}

export interface LnurlPayDiscovery extends NormalizedLightningAddress {
  readonly callbackUrl: string;
  readonly minSendableMsat: bigint;
  readonly maxSendableMsat: bigint;
  readonly metadata: string;
  readonly metadataEntries: readonly (readonly [string, ...unknown[]])[];
  readonly payerData: Readonly<
    Record<string, { readonly mandatory: boolean }>
  > | null;
  readonly mandatoryPayerData: readonly string[];
  readonly commentAllowed: number;
}

export interface LnurlInvoiceResponse {
  readonly invoice: string;
  /** LUD-11 hint for storing the initial LNURL link, not callback or invoice concurrency. */
  readonly disposable: boolean;
  readonly commentSent: boolean;
  readonly verifyUrl?: string;
  readonly successAction?: LnurlSuccessAction;
}

export type LnurlSuccessAction =
  | { readonly tag: "message"; readonly message: string }
  | {
      readonly tag: "url";
      readonly description: string;
      readonly url: string;
    }
  | {
      readonly tag: "aes";
      readonly description: string;
      readonly ciphertext: string;
      readonly iv: string;
    };

export interface InvoiceRequestOptions {
  readonly comment?: string;
}

function hasAtMostCharacters(value: string, maximum: number): boolean {
  return [...value].length <= maximum;
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s/gu, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)
  ) {
    return undefined;
  }
  try {
    const binary = atob(compact);
    if (btoa(binary) !== compact) return undefined;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function parseSuccessAction(
  value: unknown,
  callbackUrl: URL,
): LnurlSuccessAction | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.tag !== "string") {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The LNURL provider returned an invalid success action.",
    );
  }
  if (
    value.tag === "message" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    hasAtMostCharacters(value.message, 144)
  ) {
    return Object.freeze({ tag: "message", message: value.message });
  }
  if (
    value.tag === "url" &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    hasAtMostCharacters(value.description, 144) &&
    typeof value.url === "string"
  ) {
    try {
      const url = safeHttpsUrl(value.url);
      if (url.hostname !== callbackUrl.hostname) throw new Error("origin");
      return Object.freeze({
        tag: "url",
        description: value.description,
        url: url.toString(),
      });
    } catch {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The LNURL provider returned an unsafe success action URL.",
      );
    }
  }
  if (
    value.tag === "aes" &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    hasAtMostCharacters(value.description, 144) &&
    typeof value.ciphertext === "string" &&
    value.ciphertext.length > 0 &&
    value.ciphertext.length <= 4_096 &&
    typeof value.iv === "string" &&
    value.iv.length === 24
  ) {
    const ciphertext = decodeStrictBase64(value.ciphertext);
    const iv = decodeStrictBase64(value.iv);
    if (
      ciphertext === undefined ||
      ciphertext.length === 0 ||
      ciphertext.length % 16 !== 0 ||
      iv?.length !== 16
    ) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The LNURL provider returned an invalid encrypted success action.",
      );
    }
    return Object.freeze({
      tag: "aes",
      description: value.description,
      ciphertext: value.ciphertext,
      iv: value.iv,
    });
  }
  // LUD-09 requires a payer that does not understand the advertised action to
  // abort rather than silently pay without the provider's post-payment flow.
  throw new InfrastructureError(
    "INVALID_RESPONSE",
    "The LNURL provider returned an invalid or unsupported success action.",
  );
}

export function normalizeLightningAddress(
  input: string,
): NormalizedLightningAddress {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    input.length > 320
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The Lightning Address is invalid.",
    );
  }
  const parts = input.toLowerCase().split("@");
  if (parts.length !== 2) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The Lightning Address must contain one @.",
    );
  }
  const [username, domain] = parts;
  if (
    !username ||
    !domain ||
    !USERNAME_PATTERN.test(username) ||
    !isPublicHostname(domain)
  ) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The Lightning Address is invalid.",
    );
  }
  const discoveryUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;
  return Object.freeze({
    address: `${username}@${domain}`,
    username,
    domain,
    discoveryUrl,
  });
}

function parseMetadata(value: unknown): {
  raw: string;
  entries: readonly (readonly [string, ...unknown[]])[];
} {
  if (typeof value !== "string" || value.length > 150_000) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "LNURL metadata is invalid.",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "LNURL metadata is invalid JSON.",
      { cause },
    );
  }
  if (
    !Array.isArray(decoded) ||
    !decoded.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string",
    )
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "LNURL metadata entries are invalid.",
    );
  }
  const entries = decoded as [string, ...unknown[]][];
  const plainTextEntries = entries.filter((entry) => entry[0] === "text/plain");
  const imageEntries = entries.filter(
    (entry) =>
      entry[0] === "image/png;base64" || entry[0] === "image/jpeg;base64",
  );
  if (
    plainTextEntries.length !== 1 ||
    typeof plainTextEntries[0]?.[1] !== "string" ||
    imageEntries.length > 1 ||
    imageEntries.some(
      (entry) =>
        typeof entry[1] !== "string" ||
        entry[1].length > MAX_METADATA_IMAGE_CHARACTERS,
    )
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "LNURL metadata descriptions or images are invalid.",
    );
  }
  return { raw: value, entries };
}

function parsePayerData(value: unknown): {
  payerData: Readonly<Record<string, { readonly mandatory: boolean }>> | null;
  mandatory: readonly string[];
} {
  if (value === undefined) return { payerData: null, mandatory: [] };
  if (!isRecord(value)) return { payerData: null, mandatory: [] };
  const result: Record<string, { readonly mandatory: boolean }> = {};
  const mandatory: string[] = [];
  for (const [key, descriptor] of Object.entries(value)) {
    if (!isRecord(descriptor) || typeof descriptor.mandatory !== "boolean")
      continue;
    result[key] = Object.freeze({ mandatory: descriptor.mandatory });
    if (descriptor.mandatory) mandatory.push(key);
  }
  return {
    payerData: Object.freeze(result),
    mandatory: Object.freeze(mandatory),
  };
}

export class LnurlPayClient {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly policy: LightningPolicy = DEFAULT_LIGHTNING_POLICY,
  ) {}

  async discover(addressInput: string): Promise<LnurlPayDiscovery> {
    const normalized = normalizeLightningAddress(addressInput);
    const { value } = await fetchBoundedJson(
      normalized.discoveryUrl,
      this.policy.discoveryHttp,
      this.fetcher,
    );
    if (!isRecord(value))
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "LNURL discovery is invalid.",
      );
    if (value.status === "ERROR") {
      throw new InfrastructureError(
        "PROVIDER_REJECTED",
        sanitizeProviderReason(
          value.reason,
          "The provider rejected discovery.",
        ),
      );
    }
    if (value.tag !== "payRequest" || typeof value.callback !== "string") {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "LNURL pay discovery fields are invalid.",
      );
    }
    const callbackUrl = safeHttpsUrl(value.callback).toString();
    const minSendableMsat = parseProviderInteger(
      value.minSendable,
      "minSendable",
    );
    const maxSendableMsat = parseProviderInteger(
      value.maxSendable,
      "maxSendable",
    );
    if (minSendableMsat < 1n || maxSendableMsat < minSendableMsat) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "LNURL sendable range is invalid.",
      );
    }
    const metadata = parseMetadata(value.metadata);
    const payerData = parsePayerData(value.payerData);
    let commentAllowed = 0;
    if (value.commentAllowed !== undefined) {
      try {
        const parsed = Number(
          parseProviderInteger(value.commentAllowed, "commentAllowed"),
        );
        if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535)
          commentAllowed = parsed;
      } catch {
        // LUD-12 is optional. A malformed capability must not break LUD-06.
      }
    }
    return Object.freeze({
      ...normalized,
      callbackUrl,
      minSendableMsat,
      maxSendableMsat,
      metadata: metadata.raw,
      metadataEntries: Object.freeze(metadata.entries),
      payerData: payerData.payerData,
      mandatoryPayerData: payerData.mandatory,
      commentAllowed,
    });
  }

  async requestInvoice(
    discovery: LnurlPayDiscovery,
    amountSats: bigint,
    options: InvoiceRequestOptions = {},
  ): Promise<LnurlInvoiceResponse> {
    const amountMsat = amountSats * 1_000n;
    if (
      amountSats < 1n ||
      amountMsat < discovery.minSendableMsat ||
      amountMsat > discovery.maxSendableMsat
    ) {
      throw new InfrastructureError(
        "AMOUNT_OUT_OF_RANGE",
        "The requested amount is outside the provider range.",
      );
    }
    if (discovery.mandatoryPayerData.length > 0) {
      throw new InfrastructureError(
        "PAYER_DATA_REQUIRED",
        "The provider requires payer data.",
      );
    }
    const callback = safeHttpsUrl(discovery.callbackUrl);
    callback.searchParams.set("amount", amountMsat.toString());
    if (options.comment !== undefined) {
      if (discovery.commentAllowed === 0) {
        throw new InfrastructureError(
          "COMMENT_NOT_SUPPORTED",
          "The provider does not support comments.",
        );
      }
      if ([...options.comment].length > discovery.commentAllowed) {
        throw new InfrastructureError(
          "COMMENT_TOO_LONG",
          "The provider comment is too long.",
        );
      }
      callback.searchParams.set("comment", options.comment);
    }
    const { value } = await fetchBoundedJson(
      callback,
      this.policy.callbackHttp,
      this.fetcher,
    );
    if (!isRecord(value))
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The invoice response is invalid.",
      );
    if (value.status === "ERROR") {
      throw new InfrastructureError(
        "PROVIDER_REJECTED",
        sanitizeProviderReason(
          value.reason,
          "The provider rejected the invoice request.",
        ),
      );
    }
    if (
      typeof value.pr !== "string" ||
      value.pr.length === 0 ||
      value.pr.length > MAX_BOLT11_LENGTH
    ) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The provider did not return a valid invoice string.",
      );
    }
    let verifyUrl: string | undefined;
    if (typeof value.verify === "string") {
      try {
        verifyUrl = safeHttpsUrl(value.verify).toString();
      } catch {
        // LUD-21 is optional. Invalid verify data falls back to manual checks.
      }
    }
    const successAction = parseSuccessAction(value.successAction, callback);
    return Object.freeze({
      invoice: value.pr,
      disposable: value.disposable === false ? false : true,
      commentSent: options.comment !== undefined,
      ...(verifyUrl === undefined ? {} : { verifyUrl }),
      ...(successAction === undefined ? {} : { successAction }),
    });
  }
}
