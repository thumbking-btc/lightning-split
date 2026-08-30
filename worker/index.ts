import type {
  ApiErrorDto,
  BatchInvoiceResponseDto,
  DeferredInvoiceSlotDto,
  FailedInvoiceSlotDto,
  PendingInvoiceSlotDto,
  PriceResponseDto,
  SettlementResponseDto,
} from "../src/api/contracts";
import {
  parseBatchInvoiceRequest,
  parseSettlementRequest,
} from "../src/api/contracts";
import {
  serializeBigIntDecimal,
  serializePriceSnapshot,
} from "../src/api/serialization";
import { InfrastructureError } from "../src/infrastructure/errors";
import { generateInvoiceBatch } from "../src/lightning/batch";
import { LnurlPayClient } from "../src/lightning/lnurl";
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
import { WorkerPremiumReferenceCache, WorkerPriceSnapshotCache } from "./cache";
import { enforceRateLimit } from "./rateLimit";
import { readBoundedRequestJson } from "./request";
import {
  assertVerificationLink,
  openVerificationContext,
  sealVerificationContext,
} from "./verification";

type AppEnv = Env & {
  readonly VERIFICATION_TOKEN_SECRET?: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

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
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "TIMEOUT") return 504;
  if (error.code === "NETWORK_ERROR" || error.code === "HTTP_ERROR") return 502;
  if (error.code === "PROVIDER_REJECTED") return 422;
  if (error.code === "RESPONSE_TOO_LARGE") return 413;
  if (error.code === "CONFIGURATION_ERROR") return 500;
  return 400;
}

function errorResponse(error: unknown, path: string): Response {
  const infrastructureError =
    error instanceof InfrastructureError
      ? error
      : error instanceof PriceSnapshotUnavailableError
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

function verificationSecret(env: AppEnv): string {
  if (
    !env.VERIFICATION_TOKEN_SECRET ||
    !/^[0-9a-f]{64}$/u.test(env.VERIFICATION_TOKEN_SECRET)
  ) {
    throw new InfrastructureError(
      "CONFIGURATION_ERROR",
      "결제 확인 보안 설정이 준비되지 않았습니다.",
    );
  }
  return env.VERIFICATION_TOKEN_SECRET;
}

async function handleInvoices(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  assertSameOrigin(request);
  await enforceRateLimit(request, env.INVOICE_RATE_LIMITER, "invoices");
  const input = parseBatchInvoiceRequest(await readBoundedRequestJson(request));
  const result = await generateInvoiceBatch(input, {
    client: new LnurlPayClient(),
  });
  let secret: string | undefined;
  const slots = await Promise.all(
    result.slots.map(
      async (
        slot,
      ): Promise<
        PendingInvoiceSlotDto | FailedInvoiceSlotDto | DeferredInvoiceSlotDto
      > => {
        const base = {
          slotNumber: slot.slotNumber,
          targetSats: serializeBigIntDecimal(slot.targetSats),
          attempt: slot.attempt,
          ...(slot.krwShare === undefined
            ? {}
            : { krwShare: serializeBigIntDecimal(slot.krwShare) }),
        };
        if (slot.status === "failed") {
          return { ...base, status: "failed", failure: slot.failure };
        }
        if (slot.status === "deferred") {
          return input.supportsDeferredSlots
            ? { ...base, status: "deferred" }
            : {
                ...base,
                status: "failed",
                failure: {
                  code: "INVOICE_DEFERRED",
                  message:
                    "앞 결제를 완료한 뒤 이 결제 요청을 다시 만드십시오.",
                  retryable: true,
                },
              };
        }
        const verificationToken = slot.invoice.verifyUrl
          ? await sealVerificationContext(
              {
                verifyUrl: slot.invoice.verifyUrl,
                expectedPaymentHash: slot.invoice.paymentHash,
                expectedInvoice: slot.invoice.bolt11,
                expiresAt: slot.invoice.expiresAt,
              },
              (secret ??= verificationSecret(env)),
            )
          : undefined;
        return {
          ...base,
          status: "pending",
          invoice: {
            bolt11: slot.invoice.bolt11,
            paymentHash: slot.invoice.paymentHash,
            timestampSeconds: slot.invoice.timestampSeconds,
            expirySeconds: slot.invoice.expirySeconds,
            expiresAt: slot.invoice.expiresAt,
            payeeNodeId: slot.invoice.payeeNodeId,
            featureBits: slot.invoice.featureBits,
            providerDomain: slot.invoice.provider.domain,
            ...(slot.invoice.disposable === undefined
              ? {}
              : { disposable: slot.invoice.disposable }),
            ...(verificationToken === undefined ? {} : { verificationToken }),
          },
        };
      },
    ),
  );
  const body: BatchInvoiceResponseDto = {
    ok: true,
    provider: {
      domain: result.discovery.domain,
      commentAllowed: result.discovery.commentAllowed,
      ...(result.providerCommentStatus === undefined
        ? {}
        : { commentStatus: result.providerCommentStatus }),
      ...(result.paymentDescriptionStatus === undefined
        ? {}
        : { descriptionStatus: result.paymentDescriptionStatus }),
      automaticSettlementAvailable: slots.some(
        (slot) =>
          slot.status === "pending" &&
          slot.invoice.verificationToken !== undefined,
      ),
    },
    slots,
    completedCount: result.completedCount,
    failedCount: slots.filter((slot) => slot.status === "failed").length,
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
  if (context.expiresAtMs <= Date.now()) {
    const body: SettlementResponseDto = {
      ok: true,
      status: "expired",
      settled: false,
    };
    return jsonResponse(body);
  }
  const result = await checkSettlement({
    verifyUrl: context.verifyUrl,
    expectedPaymentHash: context.expectedPaymentHash,
    expectedInvoice: input.bolt11,
  });
  if (result.status === "notAvailable") {
    const body: SettlementResponseDto = {
      ok: true,
      status: "notAvailable",
      settled: false,
    };
    return jsonResponse(body);
  }
  const body: SettlementResponseDto = {
    ok: true,
    status: result.status,
    settled: result.settled,
    checkedAt: result.checkedAt,
    preimagePresent: result.preimagePresent,
    providerStatus: result.providerStatus,
  };
  return jsonResponse(body);
}

export async function handleApiRequest(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/price" && request.method === "GET")
      return await handlePrice();
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
