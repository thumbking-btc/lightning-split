import type { PriceResponseDto } from "../api/contracts";
import type { PriceSnapshotDto } from "../api/serialization";

export const REALTIME_MARKET_POLICY = Object.freeze({
  websocketPath: "/api/market/krw/stream",
  market: "KRW-BTC",
  liveRenderIntervalMs: 1_000,
  reconnectDelaysMs: Object.freeze([15_000, 30_000, 60_000]),
  restRefreshMs: 5 * 60_000,
  maximumLivePriceAgeMs: 2 * 60_000,
  maximumFutureClockSkewMs: 30_000,
});

export interface LiveMarketPrice {
  readonly priceKrw: bigint;
  readonly observedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function messageText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return data.text();
  return null;
}

function positiveSafeInteger(value: unknown): bigint | null {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0
    ? BigInt(numberValue)
    : null;
}

export async function parseUpbitTradeMessage(
  data: unknown,
  nowMs = Date.now(),
): Promise<LiveMarketPrice | null> {
  const text = await messageText(data);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const market = value.code ?? value.cd ?? value.mk;
  if (market !== REALTIME_MARKET_POLICY.market) return null;
  const priceKrw = positiveSafeInteger(value.trade_price ?? value.tp);
  const observedAtMs = Number(value.trade_timestamp ?? value.ttms);
  if (priceKrw === null || !Number.isSafeInteger(observedAtMs)) return null;
  const ageMs = nowMs - observedAtMs;
  if (
    ageMs > REALTIME_MARKET_POLICY.maximumLivePriceAgeMs ||
    ageMs < -REALTIME_MARKET_POLICY.maximumFutureClockSkewMs
  )
    return null;
  return Object.freeze({ priceKrw, observedAtMs });
}

export function createUpbitTradeSubscription(ticket: string): string {
  return JSON.stringify([
    { ticket },
    {
      type: "trade",
      codes: [REALTIME_MARKET_POLICY.market],
    },
    { format: "SIMPLE" },
  ]);
}

export function getMarketReconnectDelay(attempt: number): number {
  const delays = REALTIME_MARKET_POLICY.reconnectDelaysMs;
  const index = Math.min(
    Math.max(Number.isFinite(attempt) ? Math.trunc(attempt) : 0, 0),
    delays.length - 1,
  );
  return delays[index]!;
}

export function getMarketWebSocketUrl(
  pageLocation: Pick<Location, "host" | "protocol"> = window.location,
): string {
  const protocol = pageLocation.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${pageLocation.host}${REALTIME_MARKET_POLICY.websocketPath}`;
}

export function getMarketRestRefreshInterval(): number {
  return REALTIME_MARKET_POLICY.restRefreshMs;
}

export function getMarketRestRefreshDelay(
  lastRequestAtMs: number,
  intervalMs: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(lastRequestAtMs) || lastRequestAtMs <= 0) return 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.max(0, intervalMs - Math.max(0, nowMs - lastRequestAtMs));
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function calculatePremiumBasisPoints(
  domesticPriceKrw: bigint,
  internationalPriceKrw: bigint,
): bigint {
  if (domesticPriceKrw <= 0n || internationalPriceKrw <= 0n)
    throw new RangeError("Market prices must be positive.");
  return (
    roundHalfUp(domesticPriceKrw * 10_000n, internationalPriceKrw) - 10_000n
  );
}

export function withLiveMarketPrice(
  information: PriceResponseDto,
  price: LiveMarketPrice,
  retrievedAtMs = Date.now(),
): PriceResponseDto {
  const observedAt = new Date(price.observedAtMs).toISOString();
  const retrievedAt = new Date(retrievedAtMs).toISOString();
  const priceKrw = price.priceKrw.toString() as PriceSnapshotDto["priceKrw"];
  const snapshot: PriceSnapshotDto = {
    ...information.snapshot,
    priceKrw,
    source: "upbit",
    observedAt,
    retrievedAt,
    snapshotAt: retrievedAt,
    fallbackUsed: false,
  };
  return Object.freeze({
    ok: true,
    snapshot,
    ...(information.premium ? { premium: information.premium } : {}),
  });
}
