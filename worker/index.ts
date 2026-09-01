import type {
  ApiErrorDto,
  PriceResponseDto,
  SettlementResponseDto,
  UsdPriceResponseDto,
} from "../src/api/contracts";
import {
  INVOICE_CLIENT_PROTOCOL_HEADER,
  INVOICE_CLIENT_PROTOCOL_VERSION,
  parseBatchInvoiceRequest,
  parseSettlementRequest,
} from "../src/api/contracts";
import { serializePriceSnapshot } from "../src/api/serialization";
import { DEFAULT_LIGHTNING_POLICY } from "../src/config/policies";
import { InfrastructureError } from "../src/infrastructure/errors";
import { checkSettlement } from "../src/lightning/settlement";
import {
  KimchiPremiumService,
  UpbitInternationalPremiumAdapter,
} from "../src/pricing/premium";
import {
  BithumbPriceAdapter,
  PriceSnapshotService,
  PriceSnapshotUnavailableError,
  UpbitPriceAdapter,
} from "../src/pricing/service";
import {
  BinanceUsdtPremiumReferenceAdapter,
  CoinbasePremiumService,
  CoinbaseUsdPriceAdapter,
  KrakenUsdPriceAdapter,
  UsdPriceSnapshotService,
  UsdPriceSnapshotUnavailableError,
} from "../src/pricing/usd";
import {
  WorkerPremiumReferenceCache,
  WorkerPriceSnapshotCache,
  WorkerUsdPremiumReferenceCache,
  WorkerUsdPriceSnapshotCache,
} from "./cache";
import { createInvoiceBatchResponse } from "./invoiceBatch";
import { enforceRateLimit } from "./rateLimit";
import { readBoundedRequestJson } from "./request";
import {
  assertVerificationLink,
  openVerificationContext,
} from "./verification";

type AppEnv = Env & {
  readonly VERIFICATION_TOKEN_SECRET?: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const UPBIT_MARKET_STREAM_URL = "https://api.upbit.com/websocket/v1";

function jsonResponse<T>(
  value: T,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (additionalHeaders) {
    new Headers(additionalHeaders).forEach((headerValue, name) =>
      headers.set(name, headerValue),
    );
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "Cross-origin API requests are not allowed.",
    );
  }
}

function errorStatus(error: InfrastructureError): number {
  if (error.code === "CLIENT_UPGRADE_REQUIRED") return 409;
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "TIMEOUT") return 504;
  if (error.code === "NETWORK_ERROR" || error.code === "HTTP_ERROR") return 502;
  if (error.code === "PROVIDER_REJECTED") return 422;
  if (error.code === "RESPONSE_TOO_LARGE") return 413;
  if (error.code === "CONFIGURATION_ERROR") return 500;
  return 400;
}

function assertInvoiceClientProtocol(request: Request): void {
  if (
    request.headers.get(INVOICE_CLIENT_PROTOCOL_HEADER) !==
    INVOICE_CLIENT_PROTOCOL_VERSION
  ) {
    throw new InfrastructureError(
      "CLIENT_UPGRADE_REQUIRED",
      "새 버전이 필요합니다. 화면 아래 업데이트 버튼을 누른 뒤 다시 시도하십시오.",
    );
  }
}

function errorResponse(error: unknown, path: string): Response {
  const infrastructureError =
    error instanceof InfrastructureError
      ? error
      : error instanceof PriceSnapshotUnavailableError ||
          error instanceof UsdPriceSnapshotUnavailableError
        ? new InfrastructureError(
            "NETWORK_ERROR",
            "현재 BTC 기준가격을 조회할 수 없습니다.",
            {
              retryable: true,
              cause: error,
            },
          )
        : new InfrastructureError(
            "INVALID_RESPONSE",
            "The request could not be completed.",
          );
  console.error(
    JSON.stringify({
      message: "api_request_failed",
      path,
      code: infrastructureError.code,
      upstreamStatus: infrastructureError.upstreamStatus,
    }),
  );
  const body: ApiErrorDto = {
    ok: false,
    error: {
      code: infrastructureError.code,
      message: infrastructureError.message,
      retryable: infrastructureError.retryable,
      ...(infrastructureError.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: infrastructureError.retryAfterSeconds }),
    },
  };
  return jsonResponse(
    body,
    errorStatus(infrastructureError),
    infrastructureError.retryAfterSeconds === undefined
      ? undefined
      : { "Retry-After": String(infrastructureError.retryAfterSeconds) },
  );
}

async function handlePrice(): Promise<Response> {
  const service = new PriceSnapshotService(
    new UpbitPriceAdapter(),
    new BithumbPriceAdapter(),
    new WorkerPriceSnapshotCache(),
  );
  const snapshot = await service.getSnapshot();
  const premium = await new KimchiPremiumService(
    new UpbitInternationalPremiumAdapter(),
    new WorkerPremiumReferenceCache(),
  )
    .getInformation(snapshot.priceKrw)
    .catch(() => undefined);
  const body: PriceResponseDto = {
    ok: true,
    snapshot: serializePriceSnapshot(snapshot),
    ...(premium === undefined
      ? {}
      : {
          premium: {
            basisPoints: premium.basisPoints.toString(),
            referencePriceKrw: premium.referencePriceKrw.toString(),
            retrievedAt: premium.retrievedAt,
          },
        }),
  };
  return jsonResponse(body);
}

async function handleUsdPrice(): Promise<Response> {
  const coinbase = new CoinbaseUsdPriceAdapter();
  const kraken = new KrakenUsdPriceAdapter();
  const snapshot = await new UsdPriceSnapshotService(
    coinbase,
    kraken,
    new WorkerUsdPriceSnapshotCache(),
  ).getSnapshot();
  const premium =
    snapshot.source === "coinbase"
      ? await new CoinbasePremiumService(
          new BinanceUsdtPremiumReferenceAdapter(),
          new WorkerUsdPremiumReferenceCache(),
        )
          .getInformation(snapshot.priceUsdCents)
          .catch(() => undefined)
      : undefined;
  const body: UsdPriceResponseDto = {
    ok: true,
    snapshot: {
      priceUsdCents: snapshot.priceUsdCents.toString(),
      source: snapshot.source,
      market: snapshot.market,
      observedAt: snapshot.observedAt,
      retrievedAt: snapshot.retrievedAt,
      snapshotAt: snapshot.snapshotAt,
      fallbackUsed: snapshot.fallbackUsed,
    },
    ...(premium === undefined
      ? {}
      : {
          premium: {
            basisPoints: premium.basisPoints.toString(),
            referencePriceUsdCents: premium.referencePriceUsdCents.toString(),
            retrievedAt: premium.retrievedAt,
          },
        }),
  };
  return jsonResponse(body);
}

async function handleKrwMarketStream(request: Request): Promise<Response> {
  assertSameOrigin(request);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse<ApiErrorDto>(
      {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "A WebSocket upgrade is required.",
          retryable: false,
        },
      },
      426,
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("origin");
  return await fetch(UPBIT_MARKET_STREAM_URL, { headers });
}

function optionalVerificationSecret(env: AppEnv): string | undefined {
  return env.VERIFICATION_TOKEN_SECRET &&
    /^[0-9a-f]{64}$/u.test(env.VERIFICATION_TOKEN_SECRET)
    ? env.VERIFICATION_TOKEN_SECRET
    : undefined;
}

function verificationSecret(env: AppEnv): string {
  const secret = optionalVerificationSecret(env);
  if (!secret) {
    throw new InfrastructureError(
      "CONFIGURATION_ERROR",
      "결제 확인 보안 설정이 준비되지 않았습니다.",
    );
  }
  return secret;
}

async function handleInvoices(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  assertSameOrigin(request);
  assertInvoiceClientProtocol(request);
  await enforceRateLimit(request, env.INVOICE_RATE_LIMITER, "invoices");
  const input = parseBatchInvoiceRequest(await readBoundedRequestJson(request));
  const secret = optionalVerificationSecret(env);
  return jsonResponse(
    await createInvoiceBatchResponse(
      input,
      secret === undefined ? {} : { VERIFICATION_TOKEN_SECRET: secret },
    ),
  );
}

function settlementResponse(
  result: Awaited<ReturnType<typeof checkSettlement>>,
): Response {
  if (result.status === "notAvailable") {
    return jsonResponse<SettlementResponseDto>({
      ok: true,
      status: "notAvailable",
      settled: false,
    });
  }
  const evidence = {
    ok: true as const,
    checkedAt: result.checkedAt,
    providerStatus: result.providerStatus,
  };
  const body: SettlementResponseDto =
    result.status === "settled"
      ? {
          ...evidence,
          status: "settled",
          settled: true,
          preimagePresent: true,
        }
      : {
          ...evidence,
          status: "unsettled",
          settled: false,
          preimagePresent: false,
        };
  return jsonResponse(body);
}

async function handleSettlement(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  assertSameOrigin(request);
  await enforceRateLimit(request, env.SETTLEMENT_RATE_LIMITER, "settlement");
  const input = parseSettlementRequest(await readBoundedRequestJson(request));
  const context = await openVerificationContext(
    input.verificationToken,
    verificationSecret(env),
  );
  await assertVerificationLink(context, input.paymentHash, input.bolt11);
  const finalVerificationDeadlineMs =
    context.expiresAtMs +
    DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds * 1_000;
  if (finalVerificationDeadlineMs <= Date.now()) {
    const body: SettlementResponseDto = {
      ok: true,
      status: "expired",
      settled: false,
    };
    return jsonResponse(body);
  }
  return settlementResponse(
    await checkSettlement({
      verifyUrl: context.verifyUrl,
      expectedPaymentHash: context.expectedPaymentHash,
      expectedInvoice: input.bolt11,
    }),
  );
}

export async function handleApiRequest(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/price" && request.method === "GET")
      return await handlePrice();
    if (url.pathname === "/api/price/usd" && request.method === "GET")
      return await handleUsdPrice();
    if (url.pathname === "/api/market/krw/stream" && request.method === "GET")
      return await handleKrwMarketStream(request);
    if (url.pathname === "/api/invoices" && request.method === "POST")
      return await handleInvoices(request, env);
    if (url.pathname === "/api/settlement" && request.method === "POST") {
      return await handleSettlement(request, env);
    }
    return jsonResponse<ApiErrorDto>(
      {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "API endpoint not found.",
          retryable: false,
        },
      },
      404,
    );
  } catch (error) {
    return errorResponse(error, url.pathname);
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return handleApiRequest(request, env);
  },
} satisfies ExportedHandler<AppEnv>;
