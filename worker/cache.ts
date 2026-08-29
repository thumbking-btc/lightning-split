import {
  parsePriceSnapshotDto,
  serializePriceSnapshot,
} from "../src/api/serialization";
import type { PriceSnapshot } from "../src/domain/models";
import type { PriceSnapshotCache } from "../src/pricing/service";
import type {
  PremiumReference,
  PremiumReferenceCache,
} from "../src/pricing/premium";
import {
  parsePremiumReference,
  PREMIUM_REFERENCE_CACHE_TTL_MS,
} from "../src/pricing/premium";

const INTERNAL_CACHE_ORIGIN = "https://cache.lightning-split.invalid";
const PRICE_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/current`;
const PREMIUM_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/premium-reference`;

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

export class WorkerPremiumReferenceCache implements PremiumReferenceCache {
  constructor(private readonly cache: Cache = caches.default) {}

  async get(): Promise<PremiumReference | null> {
    const response = await this.cache.match(PREMIUM_CACHE_KEY);
    if (!response) return null;
    try {
      return parsePremiumReference(await response.json<unknown>());
    } catch {
      await this.cache.delete(PREMIUM_CACHE_KEY);
      return null;
    }
  }

  async put(reference: PremiumReference): Promise<void> {
    await this.cache.put(
      PREMIUM_CACHE_KEY,
      Response.json(reference, {
        headers: {
          "Cache-Control": `public, max-age=${PREMIUM_REFERENCE_CACHE_TTL_MS / 1_000}`,
        },
      }),
    );
  }
}
