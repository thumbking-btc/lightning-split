import type {
  UsdPriceResponseDto,
  UsdPriceSnapshotDto,
} from "../api/contracts";

export const USD_REALTIME_MARKET_POLICY = Object.freeze({
  websocketUrl: "wss://advanced-trade-ws.coinbase.com",
  binanceWebsocketUrl: "wss://data-stream.binance.vision:443/ws/btcusdt@trade",
  productId: "BTC-USD",
  liveRenderIntervalMs: 1_000,
  reconnectDelaysMs: Object.freeze([15_000, 30_000, 60_000]),
  liveRestRefreshMs: 60_000,
  fallbackRestRefreshMs: 60_000,
  maximumLivePriceAgeMs: 2 * 60_000,
  maximumFutureClockSkewMs: 30_000,
});

export interface LiveUsdMarketPrice {
  readonly priceUsdCents: bigint;
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

function decimalUsdToCents(value: unknown): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(value)
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  const padded = fraction.padEnd(3, "0");
  let cents = BigInt(whole!) * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2] ?? "0") >= 5) cents += 1n;
  return cents > 0n ? cents : null;
}

export function createCoinbaseTickerSubscription(): string {
  return JSON.stringify({
    type: "subscribe",
    product_ids: [USD_REALTIME_MARKET_POLICY.productId],
    channel: "ticker",
  });
}

export function createCoinbaseHeartbeatSubscription(): string {
  return JSON.stringify({
    type: "subscribe",
    channel: "heartbeats",
  });
}

export async function parseBinanceTradeMessage(
  data: unknown,
  nowMs = Date.now(),
): Promise<LiveUsdMarketPrice | null> {
  const text = await messageText(data);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.e !== "trade" ||
    value.s !== "BTCUSDT" ||
    typeof value.E !== "number"
  )
    return null;
  const ageMs = nowMs - value.E;
  if (
    ageMs > USD_REALTIME_MARKET_POLICY.maximumLivePriceAgeMs ||
    ageMs < -USD_REALTIME_MARKET_POLICY.maximumFutureClockSkewMs
  )
    return null;
  const priceUsdCents = decimalUsdToCents(value.p);
  return priceUsdCents === null
    ? null
    : Object.freeze({ priceUsdCents, observedAtMs: value.E });
}

export async function parseCoinbaseTickerMessage(
  data: unknown,
  nowMs = Date.now(),
): Promise<LiveUsdMarketPrice | null> {
  const text = await messageText(data);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.channel !== "ticker" ||
    !Array.isArray(value.events)
  )
    return null;
  const observedAtMs =
    typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
  if (!Number.isFinite(observedAtMs)) return null;
  const ageMs = nowMs - observedAtMs;
  if (
    ageMs > USD_REALTIME_MARKET_POLICY.maximumLivePriceAgeMs ||
    ageMs < -USD_REALTIME_MARKET_POLICY.maximumFutureClockSkewMs
  )
    return null;

  for (const event of value.events) {
    if (!isRecord(event) || !Array.isArray(event.tickers)) continue;
    for (const ticker of event.tickers) {
      if (
        !isRecord(ticker) ||
        ticker.product_id !== USD_REALTIME_MARKET_POLICY.productId
      )
        continue;
      const priceUsdCents = decimalUsdToCents(ticker.price);
      if (priceUsdCents !== null)
        return Object.freeze({ priceUsdCents, observedAtMs });
    }
  }
  return null;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function calculateCoinbasePremiumBasisPoints(
  coinbasePriceUsdCents: bigint,
  referencePriceUsdCents: bigint,
): bigint {
  if (coinbasePriceUsdCents <= 0n || referencePriceUsdCents <= 0n)
    throw new RangeError("Market prices must be positive.");
  return (
    roundHalfUp(coinbasePriceUsdCents * 10_000n, referencePriceUsdCents) -
    10_000n
  );
}

export function withLiveUsdPremiumReference(
  information: UsdPriceResponseDto,
  reference: LiveUsdMarketPrice,
  retrievedAtMs = Date.now(),
): UsdPriceResponseDto {
  return Object.freeze({
    ...information,
    premium: {
      basisPoints: calculateCoinbasePremiumBasisPoints(
        BigInt(information.snapshot.priceUsdCents),
        reference.priceUsdCents,
      ).toString(),
      referencePriceUsdCents: reference.priceUsdCents.toString(),
      retrievedAt: new Date(retrievedAtMs).toISOString(),
    },
  });
}

export function withLiveUsdMarketPrice(
  information: UsdPriceResponseDto,
  price: LiveUsdMarketPrice,
  retrievedAtMs = Date.now(),
): UsdPriceResponseDto {
  const observedAt = new Date(price.observedAtMs).toISOString();
  const retrievedAt = new Date(retrievedAtMs).toISOString();
  const snapshot: UsdPriceSnapshotDto = {
    ...information.snapshot,
    priceUsdCents: price.priceUsdCents.toString(),
    source: "coinbase",
    market: "BTC-USD",
    observedAt,
    retrievedAt,
    snapshotAt: retrievedAt,
    fallbackUsed: false,
  };
  return Object.freeze({
    ok: true,
    snapshot,
    ...(information.premium
      ? {
          premium: {
            ...information.premium,
            basisPoints: calculateCoinbasePremiumBasisPoints(
              price.priceUsdCents,
              BigInt(information.premium.referencePriceUsdCents),
            ).toString(),
          },
        }
      : {}),
  });
}

export function getUsdMarketReconnectDelay(attempt: number): number {
  const delays = USD_REALTIME_MARKET_POLICY.reconnectDelaysMs;
  const index = Math.min(
    Math.max(Number.isFinite(attempt) ? Math.trunc(attempt) : 0, 0),
    delays.length - 1,
  );
  return delays[index]!;
}

export function getUsdMarketRestRefreshInterval(
  livePriceActive: boolean,
): number {
  return livePriceActive
    ? USD_REALTIME_MARKET_POLICY.liveRestRefreshMs
    : USD_REALTIME_MARKET_POLICY.fallbackRestRefreshMs;
}

export function getUsdMarketRestRefreshDelay(
  lastRequestAtMs: number,
  intervalMs: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(lastRequestAtMs) || lastRequestAtMs <= 0) return 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.max(0, intervalMs - Math.max(0, nowMs - lastRequestAtMs));
}
