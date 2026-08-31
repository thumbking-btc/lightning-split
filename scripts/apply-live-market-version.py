from pathlib import Path
import re
import textwrap


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8")


# Build identity: use Cloudflare Workers build metadata and distinguish preview builds.
replace_once(
    "vite.config.ts",
    '''  const environmentCommit =\n    process.env.GITHUB_SHA ??\n    process.env.CLOUDFLARE_COMMIT_SHA ??\n    process.env.CF_PAGES_COMMIT_SHA;''',
    '''  const environmentCommit =\n    process.env.WORKERS_CI_COMMIT_SHA ??\n    process.env.GITHUB_SHA ??\n    process.env.CLOUDFLARE_COMMIT_SHA ??\n    process.env.CF_PAGES_COMMIT_SHA;''',
)
replace_once(
    "vite.config.ts",
    '''const appVersion = `v${packageJson.version}`;\nconst gitCommit = resolveGitCommit();''',
    '''function resolveGitBranch(): string {\n  const environmentBranch =\n    process.env.WORKERS_CI_BRANCH ??\n    process.env.GITHUB_REF_NAME ??\n    process.env.CF_PAGES_BRANCH;\n  if (environmentBranch) return environmentBranch;\n  try {\n    return (\n      execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() ||\n      "local"\n    );\n  } catch {\n    return "unknown";\n  }\n}\n\nconst gitCommit = resolveGitCommit();\nconst gitBranch = resolveGitBranch();\nconst previewBuild = !["main", "local", "unknown"].includes(gitBranch);\nconst appVersion = `v${packageJson.version}${\n  previewBuild ? `-preview.${gitCommit}` : ""\n}`;''',
)
replace_once(
    "vite.config.ts",
    '''        source: `${JSON.stringify({ version: appVersion, commit: gitCommit })}\\n`,''',
    '''        source: `${JSON.stringify({\n          version: appVersion,\n          commit: gitCommit,\n          branch: gitBranch,\n        })}\\n`,''',
)
replace_once(
    "vite.config.ts",
    '''    __APP_VERSION__: JSON.stringify(appVersion),\n    __GIT_COMMIT__: JSON.stringify(gitCommit),''',
    '''    __APP_VERSION__: JSON.stringify(appVersion),\n    __GIT_COMMIT__: JSON.stringify(gitCommit),\n    __APP_BRANCH__: JSON.stringify(gitBranch),''',
)

replace_once(
    "src/app/PwaVersionStatus.tsx",
    '''declare const __APP_VERSION__: string;\ndeclare const __GIT_COMMIT__: string;''',
    '''declare const __APP_VERSION__: string;\ndeclare const __GIT_COMMIT__: string;\ndeclare const __APP_BRANCH__: string;''',
)
replace_once(
    "src/app/PwaVersionStatus.tsx",
    '''      {__APP_VERSION__} · {__GIT_COMMIT__} ·{" "}''',
    '''      {__APP_VERSION__} · {__APP_BRANCH__} · {__GIT_COMMIT__} ·{" "}''',
)

# Consolidate the mobile containment fix into the main stylesheet and make translated status labels intentionally two-line.
index = Path("index.html")
index.write_text(
    index.read_text(encoding="utf-8").replace(
        '    <link rel="stylesheet" href="/mobile-fixes.css" />\n', ""
    ),
    encoding="utf-8",
)
Path("public/mobile-fixes.css").unlink(missing_ok=True)
replace_once(
    "src/styles.css",
    '''.card-head > div {\n  display: grid;\n  gap: 0.18rem;\n}''',
    '''.card-head > div {\n  display: grid;\n  min-width: 0;\n  gap: 0.18rem;\n}''',
)
replace_once(
    "src/styles.css",
    '''.status-pill {\n  padding: 0.4rem 0.58rem;\n  border-radius: 99px;\n  font-size: 0.67rem;\n  font-weight: 700;\n  white-space: nowrap;\n}''',
    '''.status-pill {\n  display: inline-grid;\n  max-width: min(62%, 17rem);\n  gap: 0.04rem;\n  padding: 0.4rem 0.58rem;\n  border-radius: 1rem;\n  font-size: 0.67rem;\n  font-weight: 700;\n  line-height: 1.3;\n  text-align: center;\n}\n.status-line {\n  display: block;\n  min-width: 0;\n}''',
)
styles = Path("src/styles.css")
styles.write_text(
    styles.read_text(encoding="utf-8")
    + '''\n@media (max-width: 420px) {\n  .invoice-card {\n    padding: 0.9rem;\n  }\n  .card-head {\n    min-width: 0;\n    gap: 0.65rem;\n  }\n  .status-pill {\n    max-width: 58%;\n    padding: 0.38rem 0.5rem;\n    font-size: 0.64rem;\n  }\n}\n''',
    encoding="utf-8",
)
replace_once(
    "src/App.tsx",
    '''  const status = slotStatus(slot, language);\n  const [copyFeedback, setCopyFeedback] = useState<string>();''',
    '''  const status = slotStatus(slot, language);\n  const statusLines = status.label.split(" · ");\n  const [copyFeedback, setCopyFeedback] = useState<string>();''',
)
replace_once(
    "src/App.tsx",
    '''        >\n          {status.label}\n        </span>''',
    '''        >\n          {statusLines.map((line, index) => (\n            <span className="status-line" key={`${index}-${line}`}>\n              {line}\n              {index === 0 && statusLines.length > 1 ? " ·" : ""}\n            </span>\n          ))}\n        </span>''',
)

# Only activate the market feed that is actually relevant to the current input/settlement currency.
replace_once(
    "src/app/useMarketInformation.ts",
    '''export function useMarketInformation(): {''',
    '''export function useMarketInformation(enabled = true): {''',
)
replace_once(
    "src/app/useMarketInformation.ts",
    '''  useEffect(() => {\n    let disposed = false;\n    let timer: number | undefined;''',
    '''  useEffect(() => {\n    if (!enabled) return undefined;\n    let disposed = false;\n    let timer: number | undefined;''',
)
replace_once(
    "src/app/useMarketInformation.ts",
    '''  }, [livePriceActive, refreshMarket]);''',
    '''  }, [enabled, livePriceActive, refreshMarket]);''',
)
replace_once(
    "src/app/useMarketInformation.ts",
    '''  useEffect(() => {\n    let disposed = false;\n    let socket: WebSocket | undefined;''',
    '''  useEffect(() => {\n    if (!enabled) return undefined;\n    let disposed = false;\n    let socket: WebSocket | undefined;''',
)
replace_once(
    "src/app/useMarketInformation.ts",
    '''  }, [setInformation]);\n\n  return { market, refreshLockedSnapshot };''',
    '''  }, [enabled, setInformation]);\n\n  return { market, refreshLockedSnapshot };''',
)

replace_once(
    "src/App.tsx",
    '''  const { market, refreshLockedSnapshot } = useMarketInformation();\n  const { market: usdMarket, refreshLockedSnapshot: refreshLockedUsdSnapshot } =\n    useUsdMarketInformation(\n      inputMode === "usd" || session?.inputMode === "usd",\n    );''',
    '''  const krwMarketEnabled =\n    inputMode === "krw" || session?.inputMode === "krw";\n  const usdMarketEnabled =\n    inputMode === "usd" || session?.inputMode === "usd";\n  const { market, refreshLockedSnapshot } =\n    useMarketInformation(krwMarketEnabled);\n  const { market: usdMarket, refreshLockedSnapshot: refreshLockedUsdSnapshot } =\n    useUsdMarketInformation(usdMarketEnabled);''',
)

# Browser-side Coinbase BTC/USD realtime feed, parallel to the existing Upbit KRW feed.
Path("src/market/usdRealtime.ts").write_text(textwrap.dedent('''\
import type { UsdPriceResponseDto, UsdPriceSnapshotDto } from "../api/contracts";

export const USD_REALTIME_MARKET_POLICY = Object.freeze({
  websocketUrl: "wss://advanced-trade-ws.coinbase.com",
  productId: "BTC-USD",
  liveRenderIntervalMs: 1_000,
  reconnectDelayMs: 12_000,
  liveRestRefreshMs: 60_000,
  fallbackRestRefreshMs: 16_000,
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
  if (typeof value !== "string" || !/^(?:0|[1-9]\\d*)(?:\\.\\d{1,12})?$/u.test(value))
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
    product_ids: [USD_REALTIME_MARKET_POLICY.productId],
    channel: "heartbeats",
  });
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
  if (!isRecord(value) || value.channel !== "ticker" || !Array.isArray(value.events))
    return null;
  const observedAtMs = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
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
      if (!isRecord(ticker) || ticker.product_id !== USD_REALTIME_MARKET_POLICY.productId)
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

export function getUsdMarketRestRefreshInterval(livePriceActive: boolean): number {
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
'''), encoding="utf-8")

Path("src/market/usdRealtime.test.ts").write_text(textwrap.dedent('''\
import { describe, expect, it } from "vitest";

import {
  calculateCoinbasePremiumBasisPoints,
  createCoinbaseHeartbeatSubscription,
  createCoinbaseTickerSubscription,
  parseCoinbaseTickerMessage,
  withLiveUsdMarketPrice,
} from "./usdRealtime";

describe("Coinbase realtime BTC/USD", () => {
  it("subscribes to public BTC-USD ticker and heartbeat channels", () => {
    expect(JSON.parse(createCoinbaseTickerSubscription())).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channel: "ticker",
    });
    expect(JSON.parse(createCoinbaseHeartbeatSubscription())).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channel: "heartbeats",
    });
  });

  it("parses a current BTC-USD ticker into exact cents", async () => {
    const now = Date.parse("2030-01-01T00:00:10.000Z");
    const result = await parseCoinbaseTickerMessage(
      JSON.stringify({
        channel: "ticker",
        timestamp: "2030-01-01T00:00:09.500Z",
        events: [
          {
            type: "update",
            tickers: [{ type: "ticker", product_id: "BTC-USD", price: "101234.125" }],
          },
        ],
      }),
      now,
    );
    expect(result).toEqual({
      priceUsdCents: 10_123_413n,
      observedAtMs: Date.parse("2030-01-01T00:00:09.500Z"),
    });
  });

  it("recalculates Coinbase Premium from the live Coinbase price", () => {
    const updated = withLiveUsdMarketPrice(
      {
        ok: true,
        snapshot: {
          priceUsdCents: "10000000",
          source: "coinbase",
          market: "BTC-USD",
          observedAt: "2030-01-01T00:00:00.000Z",
          retrievedAt: "2030-01-01T00:00:00.000Z",
          snapshotAt: "2030-01-01T00:00:00.000Z",
          fallbackUsed: false,
        },
        premium: {
          basisPoints: "0",
          referencePriceUsdCents: "10000000",
          retrievedAt: "2030-01-01T00:00:00.000Z",
        },
      },
      {
        priceUsdCents: 10_100_000n,
        observedAtMs: Date.parse("2030-01-01T00:00:09.000Z"),
      },
      Date.parse("2030-01-01T00:00:10.000Z"),
    );
    expect(updated.snapshot.priceUsdCents).toBe("10100000");
    expect(updated.premium?.basisPoints).toBe("100");
    expect(calculateCoinbasePremiumBasisPoints(9_900_000n, 10_000_000n)).toBe(-100n);
  });
});
'''), encoding="utf-8")

# Rewrite USD hook to use Coinbase WebSocket with REST fallback/ref refresh.
Path("src/app/useUsdMarketInformation.ts").write_text(textwrap.dedent('''\
import { useCallback, useEffect, useRef, useState } from "react";

import type { UsdPriceResponseDto, UsdPriceSnapshotDto } from "../api/contracts";
import { isRecord } from "../infrastructure/validation";
import {
  createCoinbaseHeartbeatSubscription,
  createCoinbaseTickerSubscription,
  getUsdMarketRestRefreshDelay,
  getUsdMarketRestRefreshInterval,
  parseCoinbaseTickerMessage,
  USD_REALTIME_MARKET_POLICY,
  withLiveUsdMarketPrice,
  type LiveUsdMarketPrice,
} from "../market/usdRealtime";
import { ApiClientError } from "./api";

export type UsdMarketConnection =
  | "connecting"
  | "live"
  | "recent"
  | "stale"
  | "unavailable";

export interface UsdMarketInformationState {
  readonly information?: UsdPriceResponseDto;
  readonly connection: UsdMarketConnection;
  readonly error?: string;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseUsdPriceSnapshot(value: unknown): UsdPriceSnapshotDto {
  if (
    !isRecord(value) ||
    typeof value.priceUsdCents !== "string" ||
    !/^[1-9]\\d*$/u.test(value.priceUsdCents) ||
    (value.source !== "coinbase" && value.source !== "kraken") ||
    value.market !== "BTC-USD" ||
    !validTimestamp(value.observedAt) ||
    !validTimestamp(value.retrievedAt) ||
    !validTimestamp(value.snapshotAt) ||
    typeof value.fallbackUsed !== "boolean"
  )
    throw new ApiClientError("INVALID_RESPONSE", "BTC/USD price response is invalid.", false);
  return {
    priceUsdCents: value.priceUsdCents,
    source: value.source,
    market: "BTC-USD",
    observedAt: value.observedAt,
    retrievedAt: value.retrievedAt,
    snapshotAt: value.snapshotAt,
    fallbackUsed: value.fallbackUsed,
  };
}

async function parseApiResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD price response could not be read.",
      response.status >= 500,
    );
  }
  if (!response.ok) {
    if (isRecord(value) && value.ok === false && isRecord(value.error))
      throw new ApiClientError(
        typeof value.error.code === "string" ? value.error.code : "API_ERROR",
        typeof value.error.message === "string"
          ? value.error.message
          : "BTC/USD price request failed.",
        value.error.retryable === true,
      );
    throw new ApiClientError(
      "API_ERROR",
      "BTC/USD price request failed.",
      response.status >= 500,
    );
  }
  return value;
}

export async function fetchUsdPriceInformation(): Promise<UsdPriceResponseDto> {
  const value = await parseApiResponse(
    await fetch("/api/price/usd", { headers: { Accept: "application/json" } }),
  );
  if (!isRecord(value) || value.ok !== true)
    throw new ApiClientError("INVALID_RESPONSE", "BTC/USD price response is invalid.", false);
  const snapshot = parseUsdPriceSnapshot(value.snapshot);
  const premium = value.premium;
  if (
    premium !== undefined &&
    (!isRecord(premium) ||
      typeof premium.basisPoints !== "string" ||
      !/^-?\\d+$/u.test(premium.basisPoints) ||
      typeof premium.referencePriceUsdCents !== "string" ||
      !/^[1-9]\\d*$/u.test(premium.referencePriceUsdCents) ||
      !validTimestamp(premium.retrievedAt))
  )
    throw new ApiClientError("INVALID_RESPONSE", "BTC/USD premium response is invalid.", false);
  return {
    ok: true,
    snapshot,
    ...(isRecord(premium)
      ? {
          premium: {
            basisPoints: String(premium.basisPoints),
            referencePriceUsdCents: String(premium.referencePriceUsdCents),
            retrievedAt: String(premium.retrievedAt),
          },
        }
      : {}),
  };
}

function currentLivePrice(information: UsdPriceResponseDto): LiveUsdMarketPrice | null {
  const observedAtMs = Date.parse(information.snapshot.observedAt);
  if (!Number.isFinite(observedAtMs)) return null;
  return {
    priceUsdCents: BigInt(information.snapshot.priceUsdCents),
    observedAtMs,
  };
}

function mergeRestInformation(
  rest: UsdPriceResponseDto,
  current: UsdPriceResponseDto | undefined,
  livePriceActive: boolean,
): UsdPriceResponseDto {
  if (!livePriceActive || !current) return rest;
  const live = currentLivePrice(current);
  if (!live) return rest;
  const restObservedAtMs = Date.parse(rest.snapshot.observedAt);
  if (Number.isFinite(restObservedAtMs) && restObservedAtMs >= live.observedAtMs)
    return rest;
  return withLiveUsdMarketPrice(
    {
      ok: true,
      snapshot: current.snapshot,
      ...(rest.premium ? { premium: rest.premium } : {}),
    },
    live,
    Date.parse(current.snapshot.retrievedAt),
  );
}

export function useUsdMarketInformation(enabled = true): {
  readonly market: UsdMarketInformationState;
  readonly refreshLockedSnapshot: () => Promise<UsdPriceResponseDto>;
} {
  const [market, setMarket] = useState<UsdMarketInformationState>({
    connection: "connecting",
  });
  const informationRef = useRef<UsdPriceResponseDto | undefined>(undefined);
  const livePriceActiveRef = useRef(false);
  const [livePriceActive, setLivePriceActive] = useState(false);
  const lastRestRequestAtRef = useRef(0);
  const requestInFlightRef = useRef<Promise<UsdPriceResponseDto> | null>(null);

  const setInformation = useCallback(
    (information: UsdPriceResponseDto, connection: UsdMarketConnection) => {
      informationRef.current = information;
      setMarket({ information, connection });
    },
    [],
  );

  const refresh = useCallback(async (): Promise<UsdPriceResponseDto> => {
    if (requestInFlightRef.current) return requestInFlightRef.current;
    const request = fetchUsdPriceInformation();
    requestInFlightRef.current = request;
    try {
      const rest = await request;
      const information = mergeRestInformation(
        rest,
        informationRef.current,
        livePriceActiveRef.current,
      );
      setInformation(information, livePriceActiveRef.current ? "live" : "recent");
      return information;
    } catch (cause) {
      if (!livePriceActiveRef.current) {
        const current = informationRef.current;
        setMarket({
          ...(current ? { information: current } : {}),
          connection: current ? "stale" : "unavailable",
          error:
            cause instanceof Error
              ? cause.message
              : "BTC/USD price is temporarily unavailable.",
        });
      }
      throw cause;
    } finally {
      lastRestRequestAtRef.current = Date.now();
      if (requestInFlightRef.current === request) requestInFlightRef.current = null;
    }
  }, [setInformation]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const interval = getUsdMarketRestRefreshInterval(livePriceActive);
      const delay = getUsdMarketRestRefreshDelay(lastRestRequestAtRef.current, interval);
      timer = window.setTimeout(() => void runWhenDue(), Math.max(1, delay));
    };
    const runWhenDue = async () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const interval = getUsdMarketRestRefreshInterval(livePriceActive);
      const delay = getUsdMarketRestRefreshDelay(lastRestRequestAtRef.current, interval);
      if (delay > 0) {
        timer = window.setTimeout(() => void runWhenDue(), delay);
        return;
      }
      await refresh().catch(() => undefined);
      if (!disposed) schedule();
    };
    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "visible") void runWhenDue();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") void runWhenDue();
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, livePriceActive, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let renderTimer: number | undefined;
    let staleTimer: number | undefined;
    let lastRenderedAt = 0;
    let lastLiveMessageAt = 0;
    let queuedPrice: LiveUsdMarketPrice | undefined;

    const browserIsActive = () =>
      document.visibilityState === "visible" && navigator.onLine !== false;
    const setStreamActive = (active: boolean) => {
      livePriceActiveRef.current = active;
      setLivePriceActive(active);
      if (!active && informationRef.current)
        setMarket((current) => ({ ...current, connection: "recent" }));
    };
    const clearTimers = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (renderTimer !== undefined) window.clearTimeout(renderTimer);
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
      reconnectTimer = undefined;
      renderTimer = undefined;
      staleTimer = undefined;
    };
    const disconnect = () => {
      clearTimers();
      queuedPrice = undefined;
      setStreamActive(false);
      const activeSocket = socket;
      socket = undefined;
      activeSocket?.close();
    };
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (disposed || !browserIsActive()) return;
      reconnectTimer = window.setTimeout(connect, USD_REALTIME_MARKET_POLICY.reconnectDelayMs);
    };
    const checkStale = () => {
      staleTimer = undefined;
      if (
        disposed ||
        !browserIsActive() ||
        !livePriceActiveRef.current ||
        Date.now() - lastLiveMessageAt <= USD_REALTIME_MARKET_POLICY.maximumLivePriceAgeMs
      )
        return;
      const activeSocket = socket;
      socket = undefined;
      setStreamActive(false);
      activeSocket?.close();
      scheduleReconnect();
    };
    const scheduleStaleCheck = () => {
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(
        checkStale,
        USD_REALTIME_MARKET_POLICY.maximumLivePriceAgeMs + 1,
      );
    };
    const flushQueuedPrice = () => {
      if (renderTimer !== undefined) window.clearTimeout(renderTimer);
      renderTimer = undefined;
      const price = queuedPrice;
      queuedPrice = undefined;
      if (!price || disposed || !browserIsActive()) return;
      const current = informationRef.current;
      if (!current) return;
      const next = withLiveUsdMarketPrice(current, price);
      lastRenderedAt = Date.now();
      lastLiveMessageAt = lastRenderedAt;
      setInformation(next, "live");
      setStreamActive(true);
      scheduleStaleCheck();
    };
    const queuePrice = (price: LiveUsdMarketPrice) => {
      if (!browserIsActive()) return;
      if (queuedPrice && queuedPrice.observedAtMs > price.observedAtMs) return;
      queuedPrice = price;
      const delay = USD_REALTIME_MARKET_POLICY.liveRenderIntervalMs - (Date.now() - lastRenderedAt);
      if (delay <= 0) flushQueuedPrice();
      else if (renderTimer === undefined)
        renderTimer = window.setTimeout(flushQueuedPrice, delay);
    };
    const connect = () => {
      if (disposed || !browserIsActive() || socket) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const nextSocket = new WebSocket(USD_REALTIME_MARKET_POLICY.websocketUrl);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket || !browserIsActive()) return;
        nextSocket.send(createCoinbaseTickerSubscription());
        nextSocket.send(createCoinbaseHeartbeatSubscription());
      };
      nextSocket.onmessage = (event) => {
        void parseCoinbaseTickerMessage(event.data).then((price) => {
          if (!price || disposed || socket !== nextSocket) return;
          queuePrice(price);
        });
      };
      nextSocket.onerror = () => {
        if (socket === nextSocket) nextSocket.close();
      };
      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = undefined;
        setStreamActive(false);
        scheduleReconnect();
      };
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") disconnect();
      else connect();
    };
    const handleOnline = () => connect();
    const handleOffline = () => disconnect();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if (browserIsActive()) connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      disconnect();
    };
  }, [enabled, setInformation]);

  return { market, refreshLockedSnapshot: refresh };
}
'''), encoding="utf-8")

# Coinbase Premium: Coinbase BTC/USD compared against Binance BTC/USDT, while Kraken remains only the USD fallback.
replace_once(
    "src/pricing/usd.ts",
    '''export interface UsdPriceSourceAdapter {\n  readonly source: UsdPriceSource;\n  fetchObservation(): Promise<UsdPriceObservation>;\n}\n''',
    '''export interface UsdPriceSourceAdapter {\n  readonly source: UsdPriceSource;\n  fetchObservation(): Promise<UsdPriceObservation>;\n}\n\nexport interface UsdPremiumReferenceObservation {\n  readonly priceUsdCents: bigint;\n  readonly observedAtMs: number;\n  readonly retrievedAtMs: number;\n}\n\nexport interface UsdPremiumReferenceAdapter {\n  fetchObservation(): Promise<UsdPremiumReferenceObservation>;\n}\n''',
)
insert_anchor = '''export class UsdPriceSnapshotUnavailableError extends AggregateError {'''
text = Path("src/pricing/usd.ts").read_text(encoding="utf-8")
if insert_anchor not in text:
    raise SystemExit("USD adapter insertion anchor missing")
binance_class = '''export class BinanceUsdtPremiumReferenceAdapter\n  implements UsdPremiumReferenceAdapter\n{\n  constructor(\n    private readonly fetcher: Fetcher = fetch,\n    private readonly policy: PricePolicy = DEFAULT_PRICE_POLICY,\n    private readonly clock: () => number = Date.now,\n  ) {}\n\n  async fetchObservation(): Promise<UsdPremiumReferenceObservation> {\n    const response = await fetchBoundedJson(\n      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",\n      this.policy.http,\n      this.fetcher,\n      this.clock,\n    );\n    if (\n      !isRecord(response.value) ||\n      response.value.symbol !== "BTCUSDT"\n    ) {\n      throw new InfrastructureError(\n        "INVALID_RESPONSE",\n        "Binance BTC-USDT ticker is invalid.",\n      );\n    }\n    const retrievedAtMs = this.clock();\n    return Object.freeze({\n      priceUsdCents: parseUsdCents(\n        response.value.price,\n        "Binance BTC-USDT price",\n      ),\n      observedAtMs: retrievedAtMs,\n      retrievedAtMs,\n    });\n  }\n}\n\n'''
Path("src/pricing/usd.ts").write_text(
    text.replace(insert_anchor, binance_class + insert_anchor, 1),
    encoding="utf-8",
)
replace_once(
    "src/pricing/usd.ts",
    '''    private readonly referenceAdapter: UsdPriceSourceAdapter,''',
    '''    private readonly referenceAdapter: UsdPremiumReferenceAdapter,''',
)

# Pricing tests: verify Binance reference parsing and use a dedicated reference adapter.
pricing_test = Path("src/pricing/usd.test.ts")
text = pricing_test.read_text(encoding="utf-8")
text = text.replace(
    '''  CoinbasePremiumService,\n  CoinbaseUsdPriceAdapter,''',
    '''  BinanceUsdtPremiumReferenceAdapter,\n  CoinbasePremiumService,\n  CoinbaseUsdPriceAdapter,''',
    1,
)
text = text.replace(
    '''  type UsdPremiumReference,\n  type UsdPremiumReferenceCache,''',
    '''  type UsdPremiumReference,\n  type UsdPremiumReferenceAdapter,\n  type UsdPremiumReferenceCache,\n  type UsdPremiumReferenceObservation,''',
    1,
)
fake_anchor = '''function fakeAdapter(\n  source: "coinbase" | "kraken",\n  observation: UsdPriceObservation | Error,\n): UsdPriceSourceAdapter {\n  return {\n    source,\n    fetchObservation: vi.fn(() =>\n      observation instanceof Error\n        ? Promise.reject(observation)\n        : Promise.resolve(observation),\n    ),\n  };\n}\n'''
if fake_anchor not in text:
    raise SystemExit("pricing fake adapter anchor missing")
text = text.replace(
    fake_anchor,
    fake_anchor
    + '''\nfunction fakePremiumReference(\n  observation: UsdPremiumReferenceObservation | Error,\n): UsdPremiumReferenceAdapter {\n  return {\n    fetchObservation: vi.fn(() =>\n      observation instanceof Error\n        ? Promise.reject(observation)\n        : Promise.resolve(observation),\n    ),\n  };\n}\n''',
    1,
)
kraken_test_end = '''    expect(observation.observedAtMs).toBe(NOW);\n  });\n});'''
if kraken_test_end not in text:
    raise SystemExit("pricing adapter test anchor missing")
text = text.replace(
    kraken_test_end,
    '''    expect(observation.observedAtMs).toBe(NOW);\n  });\n\n  it("parses Binance BTC-USDT as the Coinbase Premium reference", async () => {\n    const fetcher: Fetcher = vi.fn(() =>\n      Promise.resolve(jsonResponse({ symbol: "BTCUSDT", price: "100000.005" })),\n    );\n    const observation = await new BinanceUsdtPremiumReferenceAdapter(\n      fetcher,\n      undefined,\n      () => NOW,\n    ).fetchObservation();\n\n    expect(observation).toEqual({\n      priceUsdCents: 10_000_001n,\n      observedAtMs: NOW,\n      retrievedAtMs: NOW,\n    });\n  });\n});''',
    1,
)
old_premium = '''    const reference = fakeAdapter("kraken", {\n      source: "kraken",\n      market: "BTC-USD",\n      priceUsdCents: 10_000_000n,\n      observedAtMs: NOW,\n      retrievedAtMs: NOW,\n    });'''
new_premium = '''    const reference = fakePremiumReference({\n      priceUsdCents: 10_000_000n,\n      observedAtMs: NOW,\n      retrievedAtMs: NOW,\n    });'''
if old_premium not in text:
    raise SystemExit("premium reference test anchor missing")
pricing_test.write_text(text.replace(old_premium, new_premium, 1), encoding="utf-8")

# Worker uses Binance only for Coinbase Premium reference.
replace_once(
    "worker/index.ts",
    '''  CoinbasePremiumService,\n  CoinbaseUsdPriceAdapter,''',
    '''  BinanceUsdtPremiumReferenceAdapter,\n  CoinbasePremiumService,\n  CoinbaseUsdPriceAdapter,''',
)
replace_once(
    "worker/index.ts",
    '''      ? await new CoinbasePremiumService(\n          kraken,\n          new WorkerUsdPremiumReferenceCache(),\n        )''',
    '''      ? await new CoinbasePremiumService(\n          new BinanceUsdtPremiumReferenceAdapter(),\n          new WorkerUsdPremiumReferenceCache(),\n        )''',
)

worker_test = Path("worker/usdPrice.test.ts")
text = worker_test.read_text(encoding="utf-8")
text = text.replace(
    'it("returns Coinbase BTC/USD with a Kraken premium reference", async () => {',
    'it("returns Coinbase BTC/USD with a Binance BTC-USDT premium reference", async () => {',
    1,
)
kraken_mock = '''      http.get("https://api.kraken.com/0/public/Ticker", () =>\n        HttpResponse.json({\n          error: [],\n          result: { XXBTZUSD: { c: ["100000.00", "0.1"] } },\n        }),\n      ),'''
binance_mock = '''      http.get("https://api.binance.com/api/v3/ticker/price", ({ request }) => {\n        expect(new URL(request.url).searchParams.get("symbol")).toBe("BTCUSDT");\n        return HttpResponse.json({ symbol: "BTCUSDT", price: "100000.00" });\n      }),'''
if kraken_mock not in text:
    raise SystemExit("worker USD reference mock anchor missing")
worker_test.write_text(text.replace(kraken_mock, binance_mock, 1), encoding="utf-8")

print("Applied live market, efficient feed selection, preview version, premium reference, and status layout improvements.")
