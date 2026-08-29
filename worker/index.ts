import type {
  ApiErrorDto,
  BatchInvoiceResponseDto,
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
  BithumbPriceAdapter,
  PriceSnapshotService,
  PriceSnapshotUnavailableError,
  UpbitPriceAdapter,
} from "../src/pricing/service";
import { VerificationContextStore, WorkerPriceSnapshotCache } from "./cache";
import { readBoundedRequestJson } from "./request";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonResponse<T>(value: T, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
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
  return jsonResponse(body, errorStatus(infrastructureError));
}

async function handlePrice(): Promise<Response> {
  const service = new PriceSnapshotService(
    new UpbitPriceAdapter(),
    new BithumbPriceAdapter(),
    new WorkerPriceSnapshotCache(),
  );
  const snapshot = await service.getSnapshot();
  const body: PriceResponseDto = {
    ok: true,
    snapshot: serializePriceSnapshot(snapshot),
  };
  return jsonResponse(body);
}

async function handleInvoices(request: Request): Promise<Response> {
  assertSameOrigin(request);
  const input = parseBatchInvoiceRequest(await readBoundedRequestJson(request));
  const result = await generateInvoiceBatch(input, {
    client: new LnurlPayClient(),
  });
  const verificationStore = new VerificationContextStore();
  const slots = await Promise.all(
    result.slots.map(
      async (slot): Promise<PendingInvoiceSlotDto | FailedInvoiceSlotDto> => {
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
        const verificationToken = slot.invoice.verifyUrl
          ? await verificationStore.put({
              verifyUrl: slot.invoice.verifyUrl,
              expectedPaymentHash: slot.invoice.paymentHash,
              expectedInvoice: slot.invoice.bolt11,
              expiresAt: slot.invoice.expiresAt,
            })
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
      automaticSettlementAvailable: slots.some(
        (slot) =>
          slot.status === "pending" &&
          slot.invoice.verificationToken !== undefined,
      ),
    },
    slots,
    completedCount: result.completedCount,
    failedCount: result.failedCount,
  };
  return jsonResponse(body);
}

async function handleSettlement(
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  assertSameOrigin(request);
  const input = parseSettlementRequest(await readBoundedRequestJson(request));
  const store = new VerificationContextStore();
  const context = await store.get(input.verificationToken);
  if (!context) {
    const body: SettlementResponseDto = {
      ok: true,
      status: "notAvailable",
      settled: false,
    };
    return jsonResponse(body);
  }
  if (Date.parse(context.expiresAt) <= Date.now()) {
    ctx.waitUntil(store.delete(input.verificationToken));
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
    expectedInvoice: context.expectedInvoice,
  });
  if (result.status === "notAvailable") {
    const body: SettlementResponseDto = {
      ok: true,
      status: "notAvailable",
      settled: false,
    };
    return jsonResponse(body);
  }
  if (result.settled) ctx.waitUntil(store.delete(input.verificationToken));
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
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/price" && request.method === "GET")
      return await handlePrice();
    if (url.pathname === "/api/invoices" && request.method === "POST")
      return await handleInvoices(request);
    if (url.pathname === "/api/settlement" && request.method === "POST") {
      return await handleSettlement(request, ctx);
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
  fetch(request, _env, ctx): Promise<Response> {
    return handleApiRequest(request, ctx);
  },
} satisfies ExportedHandler<Env>;
