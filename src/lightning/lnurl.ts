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

const USERNAME_PATTERN = /^[a-z0-9._+-]{1,64}$/u;

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
  readonly allowsNostr: boolean;
  readonly nostrPubkey?: string;
}

export interface LnurlInvoiceResponse {
  readonly invoice: string;
  readonly disposable: boolean;
  readonly commentSent: boolean;
  readonly verifyUrl?: string;
}

export interface InvoiceRequestOptions {
  readonly comment?: string;
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
  if (
    !entries.some(
      (entry) => entry[0] === "text/plain" && typeof entry[1] === "string",
    )
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "LNURL metadata has no text/plain description.",
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
    const nostrPubkey =
      value.allowsNostr === true &&
      typeof value.nostrPubkey === "string" &&
      /^[0-9a-f]{64}$/iu.test(value.nostrPubkey)
        ? value.nostrPubkey.toLowerCase()
        : undefined;
    const allowsNostr = nostrPubkey !== undefined;
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
      allowsNostr,
      ...(nostrPubkey === undefined ? {} : { nostrPubkey }),
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
      value.pr.length > 1_200
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
    return Object.freeze({
      invoice: value.pr,
      disposable: value.disposable === false ? false : true,
      commentSent: options.comment !== undefined,
      ...(verifyUrl === undefined ? {} : { verifyUrl }),
    });
  }
}
