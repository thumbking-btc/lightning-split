import { sha256 } from "@noble/hashes/sha2.js";

import type { LightningPolicy } from "../config/policies";
import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";
import { InfrastructureError } from "../infrastructure/errors";
import { fetchBoundedJson, type Fetcher } from "../infrastructure/http";
import {
  isHex,
  isRecord,
  sanitizeProviderReason,
} from "../infrastructure/validation";

export type SettlementCheckResult =
  | { readonly status: "notAvailable"; readonly settled: false }
  | {
      readonly status: "unsettled" | "settled";
      readonly settled: boolean;
      readonly checkedAt: string;
      readonly preimagePresent: boolean;
      readonly providerStatus: string | null;
    };

/**
 * The automatic-settlement method is selected from capabilities advertised for
 * the individual invoice. Provider names and domains are intentionally not part
 * of this input, so a wallet cannot require an allowlist entry to participate.
 */
export type SettlementCapability =
  | { readonly method: "lud21"; readonly verifyUrl: string }
  | { readonly method: "manual" };

export function selectSettlementCapability(input: {
  readonly verifyUrl?: string;
}): SettlementCapability {
  return input.verifyUrl === undefined
    ? Object.freeze({ method: "manual" })
    : Object.freeze({ method: "lud21", verifyUrl: input.verifyUrl });
}

export interface SettlementCheckInput {
  readonly verifyUrl?: string;
  readonly expectedPaymentHash: string;
  readonly expectedInvoice: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function isSameBolt11(left: unknown, right: string): boolean {
  return (
    typeof left === "string" &&
    (left === left.toLowerCase() || left === left.toUpperCase()) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export async function checkSettlement(
  input: SettlementCheckInput,
  dependencies: {
    readonly fetcher?: Fetcher;
    readonly policy?: LightningPolicy;
    readonly now?: () => number;
  } = {},
): Promise<SettlementCheckResult> {
  if (!input.verifyUrl)
    return Object.freeze({ status: "notAvailable", settled: false });
  if (!isHex(input.expectedPaymentHash, 32)) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The expected payment hash is invalid.",
    );
  }
  const policy = dependencies.policy ?? DEFAULT_LIGHTNING_POLICY;
  const now = dependencies.now ?? Date.now;
  const { value } = await fetchBoundedJson(
    input.verifyUrl,
    policy.settlementHttp,
    dependencies.fetcher,
    now,
  );
  if (!isRecord(value))
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settlement response is invalid.",
    );
  if (value.status === "ERROR") {
    throw new InfrastructureError(
      "PROVIDER_REJECTED",
      sanitizeProviderReason(
        value.reason,
        "The provider rejected settlement verification.",
      ),
    );
  }
  if (typeof value.settled !== "boolean") {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settlement response has no boolean settled field.",
    );
  }
  if (!isSameBolt11(value.pr, input.expectedInvoice)) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settlement response invoice is missing or does not match.",
    );
  }
  let preimagePresent = false;
  if (value.preimage !== undefined && value.preimage !== null) {
    const normalizedPreimage =
      typeof value.preimage === "string"
        ? value.preimage.toLowerCase()
        : undefined;
    if (normalizedPreimage === undefined || !isHex(normalizedPreimage, 32)) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The settlement preimage is invalid.",
      );
    }
    const computed = bytesToHex(sha256(hexToBytes(normalizedPreimage)));
    if (computed !== input.expectedPaymentHash) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The settlement preimage does not match the payment hash.",
      );
    }
    preimagePresent = true;
  }
  if (preimagePresent && !value.settled) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settlement response contradicts its payment preimage.",
    );
  }
  if (value.settled && !preimagePresent) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settled response is missing a matching payment preimage.",
    );
  }
  return Object.freeze({
    status: value.settled ? "settled" : "unsettled",
    settled: value.settled,
    checkedAt: new Date(now()).toISOString(),
    preimagePresent,
    providerStatus:
      typeof value.status === "string" && value.status.length <= 128
        ? value.status
        : null,
  });
}
