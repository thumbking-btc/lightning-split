import { useCallback, useEffect, useRef, useState } from "react";

import type {
  UsdPriceResponseDto,
  UsdPriceSnapshotDto,
} from "../api/contracts";
import { isRecord } from "../infrastructure/validation";
import {
  createCoinbaseHeartbeatSubscription,
  createCoinbaseTickerSubscription,
  getUsdMarketRestRefreshDelay,
  getUsdMarketRestRefreshInterval,
  parseBinanceTradeMessage,
  parseCoinbaseTickerMessage,
  USD_REALTIME_MARKET_POLICY,
  withLiveUsdMarketPrice,
  withLiveUsdPremiumReference,
  type LiveUsdMarketPrice,
} from "../market/usdRealtime";
import { ApiClientError } from "./api";

export type UsdMarketConnection =
  "connecting" | "live" | "recent" | "stale" | "unavailable";

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
    !/^[1-9]\d*$/u.test(value.priceUsdCents) ||
    (value.source !== "coinbase" && value.source !== "kraken") ||
    value.market !== "BTC-USD" ||
    !validTimestamp(value.observedAt) ||
    !validTimestamp(value.retrievedAt) ||
    !validTimestamp(value.snapshotAt) ||
    typeof value.fallbackUsed !== "boolean"
  )
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD price response is invalid.",
      false,
    );
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
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD price response is invalid.",
      false,
    );
  const snapshot = parseUsdPriceSnapshot(value.snapshot);
  const premium = value.premium;
  if (
    premium !== undefined &&
    (!isRecord(premium) ||
      typeof premium.basisPoints !== "string" ||
      !/^-?\d+$/u.test(premium.basisPoints) ||
      typeof premium.referencePriceUsdCents !== "string" ||
      !/^[1-9]\d*$/u.test(premium.referencePriceUsdCents) ||
      !validTimestamp(premium.retrievedAt))
  )
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD premium response is invalid.",
      false,
    );
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

function currentLivePrice(
  information: UsdPriceResponseDto,
): LiveUsdMarketPrice | null {
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
  if (
    Number.isFinite(restObservedAtMs) &&
    restObservedAtMs >= live.observedAtMs
  )
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
  const premiumReferenceRef = useRef<LiveUsdMarketPrice | undefined>(undefined);
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
      setInformation(
        information,
        livePriceActiveRef.current ? "live" : "recent",
      );
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
      if (requestInFlightRef.current === request)
        requestInFlightRef.current = null;
    }
  }, [setInformation]);

  useEffect(() => {
    if (!enabled) return;
    // Re-selecting a currency is a new active viewing session. Do not inherit
    // the previous fallback polling delay; fetch once immediately instead.
    lastRestRequestAtRef.current = 0;
  }, [enabled]);

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
      const delay = getUsdMarketRestRefreshDelay(
        lastRestRequestAtRef.current,
        interval,
      );
      timer = window.setTimeout(() => void runWhenDue(), Math.max(1, delay));
    };
    const runWhenDue = async () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const interval = getUsdMarketRestRefreshInterval(livePriceActive);
      const delay = getUsdMarketRestRefreshDelay(
        lastRestRequestAtRef.current,
        interval,
      );
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
      reconnectTimer = window.setTimeout(
        connect,
        USD_REALTIME_MARKET_POLICY.reconnectDelayMs,
      );
    };
    const checkStale = () => {
      staleTimer = undefined;
      if (
        disposed ||
        !browserIsActive() ||
        !livePriceActiveRef.current ||
        Date.now() - lastLiveMessageAt <=
          USD_REALTIME_MARKET_POLICY.maximumLivePriceAgeMs
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
      let next = withLiveUsdMarketPrice(current, price);
      if (premiumReferenceRef.current)
        next = withLiveUsdPremiumReference(next, premiumReferenceRef.current);
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
      const delay =
        USD_REALTIME_MARKET_POLICY.liveRenderIntervalMs -
        (Date.now() - lastRenderedAt);
      if (delay <= 0) flushQueuedPrice();
      else if (renderTimer === undefined)
        renderTimer = window.setTimeout(flushQueuedPrice, delay);
    };
    const connect = () => {
      if (disposed || !browserIsActive() || socket) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(USD_REALTIME_MARKET_POLICY.websocketUrl);
      } catch {
        setStreamActive(false);
        scheduleReconnect();
        return;
      }
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

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;

    const browserIsActive = () =>
      document.visibilityState === "visible" && navigator.onLine !== false;
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (disposed || !browserIsActive()) return;
      reconnectTimer = window.setTimeout(
        connect,
        USD_REALTIME_MARKET_POLICY.reconnectDelayMs,
      );
    };
    const disconnect = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const activeSocket = socket;
      socket = undefined;
      activeSocket?.close();
    };
    const connect = () => {
      if (disposed || !browserIsActive() || socket) return;
      try {
        const nextSocket = new WebSocket(
          USD_REALTIME_MARKET_POLICY.binanceWebsocketUrl,
        );
        socket = nextSocket;
        nextSocket.onmessage = (event) => {
          void parseBinanceTradeMessage(event.data).then((reference) => {
            if (!reference || disposed || socket !== nextSocket) return;
            premiumReferenceRef.current = reference;
            const current = informationRef.current;
            if (!current || current.snapshot.source !== "coinbase") return;
            setInformation(
              withLiveUsdPremiumReference(current, reference),
              livePriceActiveRef.current ? "live" : "recent",
            );
          });
        };
        nextSocket.onerror = () => {
          if (socket === nextSocket) nextSocket.close();
        };
        nextSocket.onclose = () => {
          if (socket !== nextSocket) return;
          socket = undefined;
          scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      }
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
