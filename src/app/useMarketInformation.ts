import { useCallback, useEffect, useRef, useState } from "react";

import type { PriceResponseDto } from "../api/contracts";
import {
  createUpbitTradeSubscription,
  getMarketRestRefreshDelay,
  getMarketRestRefreshInterval,
  parseUpbitTradeMessage,
  REALTIME_MARKET_POLICY,
  withLiveMarketPrice,
  type LiveMarketPrice,
} from "../market/realtime";
import { fetchPriceInformation } from "./api";
import { toUserMessage } from "./userMessage";

export type MarketConnectionState =
  "loading" | "live" | "recent" | "stale" | "unavailable";

export interface MarketInformationState {
  readonly information?: PriceResponseDto;
  readonly connection: MarketConnectionState;
  readonly error?: string;
}

function currentLivePrice(
  information: PriceResponseDto,
): LiveMarketPrice | null {
  const observedAtMs = Date.parse(information.snapshot.observedAt);
  if (!Number.isFinite(observedAtMs)) return null;
  return {
    priceKrw: BigInt(information.snapshot.priceKrw),
    observedAtMs,
  };
}

export function mergeRestMarketInformation(
  restInformation: PriceResponseDto,
  current: PriceResponseDto | undefined,
  livePriceActive: boolean,
): PriceResponseDto {
  if (!livePriceActive || !current) return restInformation;
  const livePrice = currentLivePrice(current);
  if (!livePrice) return restInformation;
  const restObservedAtMs = Date.parse(restInformation.snapshot.observedAt);
  if (
    Number.isFinite(restObservedAtMs) &&
    restObservedAtMs >= livePrice.observedAtMs
  ) {
    return restInformation;
  }

  return withLiveMarketPrice(
    {
      ok: true,
      snapshot: current.snapshot,
      ...(restInformation.premium ? { premium: restInformation.premium } : {}),
    },
    livePrice,
    Date.parse(current.snapshot.retrievedAt),
  );
}

export function completeMarketRefresh(
  restInformation: PriceResponseDto,
  current: PriceResponseDto | undefined,
  livePriceActive: boolean,
  setInformation: (
    information: PriceResponseDto,
    connection: MarketConnectionState,
  ) => void,
): PriceResponseDto {
  const next = mergeRestMarketInformation(
    restInformation,
    current,
    livePriceActive,
  );
  setInformation(next, livePriceActive ? "live" : "recent");
  return next;
}

export function useMarketInformation(enabled = true): {
  readonly market: MarketInformationState;
  readonly refreshLockedSnapshot: () => Promise<PriceResponseDto>;
} {
  const [market, setMarket] = useState<MarketInformationState>({
    connection: "loading",
  });
  const informationRef = useRef<PriceResponseDto | undefined>(undefined);
  const livePriceActiveRef = useRef(false);
  const [livePriceActive, setLivePriceActive] = useState(false);
  const lastRestRequestAtRef = useRef(0);

  const setInformation = useCallback(
    (information: PriceResponseDto, connection: MarketConnectionState) => {
      informationRef.current = information;
      setMarket({ information, connection });
    },
    [],
  );

  const refreshMarket = useCallback(async () => {
    try {
      const information = await fetchPriceInformation();
      return completeMarketRefresh(
        information,
        informationRef.current,
        livePriceActiveRef.current,
        setInformation,
      );
    } catch (cause) {
      if (!livePriceActiveRef.current) {
        const current = informationRef.current;
        setMarket({
          ...(current ? { information: current } : {}),
          connection: current ? "stale" : "unavailable",
          error: toUserMessage(cause, "현재 시세를 확인하지 못했습니다."),
        });
      }
      throw cause;
    } finally {
      lastRestRequestAtRef.current = Date.now();
    }
  }, [setInformation]);

  const refreshLockedSnapshot = useCallback(async () => {
    const information = await refreshMarket();
    return information;
  }, [refreshMarket]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const interval = getMarketRestRefreshInterval(livePriceActive);
      const delay = getMarketRestRefreshDelay(
        lastRestRequestAtRef.current,
        interval,
      );
      timer = window.setTimeout(() => void runWhenDue(), Math.max(1, delay));
    };
    const runWhenDue = async () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const interval = getMarketRestRefreshInterval(livePriceActive);
      const delay = getMarketRestRefreshDelay(
        lastRestRequestAtRef.current,
        interval,
      );
      if (delay > 0) {
        timer = window.setTimeout(() => void runWhenDue(), delay);
        return;
      }
      await refreshMarket().catch(() => undefined);
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
  }, [enabled, livePriceActive, refreshMarket]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let renderTimer: number | undefined;
    let staleTimer: number | undefined;
    let lastRenderedAt = 0;
    let lastLiveMessageAt = 0;
    let queuedPrice: LiveMarketPrice | undefined;

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
    const checkStale = () => {
      staleTimer = undefined;
      if (
        disposed ||
        !browserIsActive() ||
        !livePriceActiveRef.current ||
        Date.now() - lastLiveMessageAt <=
          REALTIME_MARKET_POLICY.maximumLivePriceAgeMs
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
        REALTIME_MARKET_POLICY.maximumLivePriceAgeMs + 1,
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
      const next = withLiveMarketPrice(current, price);
      lastRenderedAt = Date.now();
      lastLiveMessageAt = lastRenderedAt;
      setInformation(next, "live");
      setStreamActive(true);
      scheduleStaleCheck();
    };
    const queuePrice = (price: LiveMarketPrice) => {
      if (!browserIsActive()) return;
      if (queuedPrice && queuedPrice.observedAtMs > price.observedAtMs) return;
      queuedPrice = price;
      const delay =
        REALTIME_MARKET_POLICY.liveRenderIntervalMs -
        (Date.now() - lastRenderedAt);
      if (delay <= 0) flushQueuedPrice();
      else if (renderTimer === undefined)
        renderTimer = window.setTimeout(flushQueuedPrice, delay);
    };
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (disposed || !browserIsActive()) return;
      reconnectTimer = window.setTimeout(
        connect,
        REALTIME_MARKET_POLICY.reconnectDelayMs,
      );
    };
    const connect = () => {
      if (disposed || !browserIsActive() || socket) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(REALTIME_MARKET_POLICY.websocketUrl);
      } catch {
        setStreamActive(false);
        scheduleReconnect();
        return;
      }
      nextSocket.binaryType = "arraybuffer";
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket || !browserIsActive()) return;
        nextSocket.send(
          createUpbitTradeSubscription(`lightning-split-${Date.now()}`),
        );
      };
      nextSocket.onmessage = (event) => {
        void parseUpbitTradeMessage(event.data).then((price) => {
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

  return { market, refreshLockedSnapshot };
}
