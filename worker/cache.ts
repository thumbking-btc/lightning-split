import {
  parsePriceSnapshotDto,
  serializePriceSnapshot,
} from "../src/api/serialization";
import type { PriceSnapshot } from "../src/domain/models";
import { InfrastructureError } from "../src/infrastructure/errors";
import { isRecord } from "../src/infrastructure/validation";
import type { PriceSnapshotCache } from "../src/pricing/service";

const INTERNAL_CACHE_ORIGIN = "https://cache.lightning-split.invalid";
const PRICE_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/current`;

export class WorkerPriceSnapshotCache implements PriceSnapshotCache {
  constructor(private readonly cache: Cache = caches.default) {}

  async get(): Promise<PriceSnapshot | null> {
    const response = await this.cache.match(PRICE_CACHE_KEY);
    if (!response) return null;
    try {
      return parsePriceSnapshotDto(await response.json<unknown>());
    } catch {
      await this.cache.delete(PRICE_CACHE_KEY);
      return null;
    }
  }

  async put(snapshot: PriceSnapshot): Promise<void> {
    await this.cache.put(
      PRICE_CACHE_KEY,
      Response.json(serializePriceSnapshot(snapshot), {
        headers: { "Cache-Control": "public, max-age=10" },
      }),
    );
  }
}

export interface VerificationContext {
  readonly verifyUrl: string;
  readonly expectedPaymentHash: string;
  readonly expectedInvoice: string;
  readonly expiresAt: string;
}

function contextCacheKey(token: string): string {
  return `${INTERNAL_CACHE_ORIGIN}/verification/${token}`;
}

function parseVerificationContext(value: unknown): VerificationContext {
  if (
    !isRecord(value) ||
    typeof value.verifyUrl !== "string" ||
    typeof value.expectedPaymentHash !== "string" ||
    typeof value.expectedInvoice !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The verification context is invalid.",
    );
  }
  return {
    verifyUrl: value.verifyUrl,
    expectedPaymentHash: value.expectedPaymentHash,
    expectedInvoice: value.expectedInvoice,
    expiresAt: value.expiresAt,
  };
}

export class VerificationContextStore {
  constructor(private readonly cache: Cache = caches.default) {}

  async put(context: VerificationContext): Promise<string> {
    const token = crypto.randomUUID();
    const ttlSeconds = Math.max(
      60,
      Math.floor((Date.parse(context.expiresAt) - Date.now()) / 1_000),
    );
    await this.cache.put(
      contextCacheKey(token),
      Response.json(context, {
        headers: { "Cache-Control": `public, max-age=${ttlSeconds}` },
      }),
    );
    return token;
  }

  async get(token: string): Promise<VerificationContext | null> {
    const response = await this.cache.match(contextCacheKey(token));
    if (!response) return null;
    try {
      return parseVerificationContext(await response.json<unknown>());
    } catch {
      await this.delete(token);
      return null;
    }
  }

  async delete(token: string): Promise<void> {
    await this.cache.delete(contextCacheKey(token));
  }
}
