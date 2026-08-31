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
import type {
  UsdPremiumReference,
  UsdPremiumReferenceCache,
  UsdPriceSnapshot,
  UsdPriceSnapshotCache,
} from "../src/pricing/usd";
import {
  parseUsdPremiumReference,
  USD_PREMIUM_REFERENCE_CACHE_TTL_MS,
} from "../src/pricing/usd";

const INTERNAL_CACHE_ORIGIN = "https://cache.lightning-split.invalid";
const PRICE_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/current`;
const PREMIUM_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/premium-reference`;
const USD_PRICE_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/usd/current`;
const USD_PREMIUM_CACHE_KEY = `${INTERNAL_CACHE_ORIGIN}/price/usd/premium-reference`;

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

export class WorkerUsdPriceSnapshotCache implements UsdPriceSnapshotCache {
  constructor(private readonly cache: Cache = caches.default) {}

  async get(): Promise<UsdPriceSnapshot | null> {
    const response = await this.cache.match(USD_PRICE_CACHE_KEY);
    if (!response) return null;
    try {
      const value: unknown = await response.json();
      if (
        typeof value !== "object" ||
        value === null ||
        !("priceUsdCents" in value) ||
        typeof value.priceUsdCents !== "string" ||
        !/^[1-9]\d*$/u.test(value.priceUsdCents) ||
        !("source" in value) ||
        (value.source !== "coinbase" && value.source !== "kraken") ||
        !("market" in value) ||
        value.market !== "BTC-USD" ||
        !("observedAt" in value) ||
        typeof value.observedAt !== "string" ||
        !("retrievedAt" in value) ||
        typeof value.retrievedAt !== "string" ||
        !("snapshotAt" in value) ||
        typeof value.snapshotAt !== "string" ||
        !("fallbackUsed" in value) ||
        typeof value.fallbackUsed !== "boolean" ||
        !Number.isFinite(Date.parse(value.observedAt)) ||
        !Number.isFinite(Date.parse(value.retrievedAt)) ||
        !Number.isFinite(Date.parse(value.snapshotAt))
      ) {
        throw new Error("Invalid cached USD price snapshot.");
      }
      return Object.freeze({
        priceUsdCents: BigInt(value.priceUsdCents),
        source: value.source,
        market: "BTC-USD",
        observedAt: value.observedAt,
        retrievedAt: value.retrievedAt,
        snapshotAt: value.snapshotAt,
        fallbackUsed: value.fallbackUsed,
      });
    } catch {
      await this.cache.delete(USD_PRICE_CACHE_KEY);
      return null;
    }
  }

  async put(snapshot: UsdPriceSnapshot): Promise<void> {
    await this.cache.put(
      USD_PRICE_CACHE_KEY,
      Response.json(
        { ...snapshot, priceUsdCents: snapshot.priceUsdCents.toString() },
        { headers: { "Cache-Control": "public, max-age=10" } },
      ),
    );
  }
}

export class WorkerUsdPremiumReferenceCache implements UsdPremiumReferenceCache {
  constructor(private readonly cache: Cache = caches.default) {}

  async get(): Promise<UsdPremiumReference | null> {
    const response = await this.cache.match(USD_PREMIUM_CACHE_KEY);
    if (!response) return null;
    try {
      return parseUsdPremiumReference(await response.json<unknown>());
    } catch {
      await this.cache.delete(USD_PREMIUM_CACHE_KEY);
      return null;
    }
  }

  async put(reference: UsdPremiumReference): Promise<void> {
    await this.cache.put(
      USD_PREMIUM_CACHE_KEY,
      Response.json(reference, {
        headers: {
          "Cache-Control": `public, max-age=${USD_PREMIUM_REFERENCE_CACHE_TTL_MS / 1_000}`,
        },
      }),
    );
  }
}
