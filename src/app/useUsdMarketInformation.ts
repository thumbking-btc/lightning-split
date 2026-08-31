import { useCallback, useEffect, useRef, useState } from "react";

import type {
  UsdPriceResponseDto,
  UsdPriceSnapshotDto,
} from "../api/contracts";
import { isRecord } from "../infrastructure/validation";
import { ApiClientError } from "./api";

const USD_REST_REFRESH_MS = 16_000;

export type UsdMarketConnection =
  "connecting" | "recent" | "stale" | "unavailable";

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
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD price response is invalid.",
      false,
    );
  }
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
    if (isRecord(value) && value.ok === false && isRecord(value.error)) {
      throw new ApiClientError(
        typeof value.error.code === "string" ? value.error.code : "API_ERROR",
        typeof value.error.message === "string"
          ? value.error.message
          : "BTC/USD price request failed.",
        value.error.retryable === true,
      );
    }
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
  if (!isRecord(value) || value.ok !== true) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD price response is invalid.",
      false,
    );
  }
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
  ) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "BTC/USD premium response is invalid.",
      false,
    );
  }
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

export function useUsdMarketInformation(enabled = true): {
  readonly market: UsdMarketInformationState;
  readonly refreshLockedSnapshot: () => Promise<UsdPriceResponseDto>;
} {
  const [market, setMarket] = useState<UsdMarketInformationState>({
    connection: "connecting",
  });
  const requestInFlightRef = useRef<Promise<UsdPriceResponseDto> | null>(null);

  const refresh = useCallback(async (): Promise<UsdPriceResponseDto> => {
    if (requestInFlightRef.current) return requestInFlightRef.current;
    const request = fetchUsdPriceInformation();
    requestInFlightRef.current = request;
    try {
      const information = await request;
      setMarket({ information, connection: "recent" });
      return information;
    } catch (cause) {
      setMarket((current) => ({
        ...current,
        connection: current.information ? "stale" : "unavailable",
        error:
          cause instanceof Error
            ? cause.message
            : "BTC/USD price is temporarily unavailable.",
      }));
      throw cause;
    } finally {
      if (requestInFlightRef.current === request)
        requestInFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        // State is updated in refresh().
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (active) void poll();
    }, USD_REST_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return {
    market,
    refreshLockedSnapshot: refresh,
  };
}
