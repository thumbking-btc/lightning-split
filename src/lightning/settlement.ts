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
  if (value.pr !== input.expectedInvoice) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The settlement response invoice is missing or does not match.",
    );
  }
  let preimagePresent = false;
  if (value.preimage !== undefined && value.preimage !== null) {
    if (typeof value.preimage !== "string" || !isHex(value.preimage, 32)) {
      throw new InfrastructureError(
        "INVALID_RESPONSE",
        "The settlement preimage is invalid.",
      );
    }
    const computed = bytesToHex(sha256(hexToBytes(value.preimage)));
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
  return Object.freeze({
    status: value.settled ? "settled" : "unsettled",
    settled: value.settled,
    checkedAt: new Date(now()).toISOString(),
    preimagePresent,
    providerStatus: typeof value.status === "string" ? value.status : null,
  });
}
