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
import { DEFAULT_LIGHTNING_POLICY } from "../src/config/policies";
import { InfrastructureError } from "../src/infrastructure/errors";
import { buildPaymentPayload } from "../src/app/paymentUri";
import { generateInvoiceBatch } from "../src/lightning/batch";
import { validateBolt11Invoice } from "../src/lightning/bolt11";
import {
  LnurlPayClient,
  type LnurlSuccessAction,
} from "../src/lightning/lnurl";
import { checkSettlement } from "../src/lightning/settlement";
import {
  createEphemeralZapRecipientAlias,
  createEphemeralZapRequest,
  encodeLnurlPayUrl,
  parseAndValidateZapRequest,
  validateZapReceipt,
} from "../src/nostr/zap";
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
import { Nip57ReceiptRelay, type PaymentSession } from "./nostrRelay";
import { enforceRateLimit } from "./rateLimit";
import { readBoundedRequestJson } from "./request";
import {
  assertVerificationLink,
  openVerificationContext,
  sealVerificationContext,
  type VerificationContext,
} from "./verification";

type AppEnv = Omit<Env, "NIP57_RECEIPTS"> & {
  readonly VERIFICATION_TOKEN_SECRET?: string;
  readonly NIP57_RECEIPTS?: DurableObjectNamespace<Nip57ReceiptRelay>;
};

export { Nip57ReceiptRelay } from "./nostrRelay";

const CHANNEL_PATTERN = /^[0-9a-f]{64}$/u;
const PAYMENT_PATH = /^\/api\/pay\/([0-9a-f]{64})$/u;
const PAYMENT_CALLBACK_PATH = /^\/api\/pay\/([0-9a-f]{64})\/invoice$/u;
const PAYMENT_ACTION_PATH = /^\/api\/pay\/([0-9a-f]{64})\/action$/u;
const NOSTR_RELAY_PATH = /^\/api\/nostr\/([0-9a-f]{64})$/u;

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

function lnurlResponse(value: unknown): Response {
  return jsonResponse(value, 200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
}

function randomChannel(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function payerNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const truncated = [...note].slice(0, 144).join("");
  return truncated.length === 0 ? undefined : truncated;
}

function publicWebSocketUrl(origin: string, channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error("invalid channel");
  const url = new URL(`/api/nostr/${channel}`, origin);
  if (url.protocol !== "https:") throw new Error("public HTTPS is required");
  url.protocol = "wss:";
  return url.toString();
}

function publicLnurlPayUrl(origin: string, channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error("invalid channel");
  return new URL(`/api/pay/${channel}`, origin).toString();
}

function publicPaymentActionUrl(origin: string, channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error("invalid channel");
  return new URL(`/api/pay/${channel}/action`, origin).toString();
}

async function readPaymentSession(
  env: AppEnv,
  channel: string,
): Promise<PaymentSession | null> {
  if (!env.NIP57_RECEIPTS || !CHANNEL_PATTERN.test(channel)) return null;
  return env.NIP57_RECEIPTS.getByName(channel).getPaymentSession();
}

function validateActivePaymentSession(session: PaymentSession): void {
  const amountMsat = BigInt(session.amountMsat);
  if (amountMsat % 1_000n !== 0n) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The stored payment amount is invalid.",
    );
  }
  validateBolt11Invoice(session.invoice, {
    expectedSats: amountMsat / 1_000n,
    expectedDescription: session.providerMetadata,
    minimumRemainingSeconds: 1,
  });
}

async function handlePayDiscovery(
  request: Request,
  env: AppEnv,
  channel: string,
): Promise<Response> {
  if (request.method === "OPTIONS") return lnurlResponse({});
  if (request.method !== "GET") {
    return lnurlResponse({ status: "ERROR", reason: "GET is required." });
  }
  try {
    const session = await readPaymentSession(env, channel);
    if (!session) throw new Error("Payment request not found.");
    validateActivePaymentSession(session);
    const amountMsat = BigInt(session.amountMsat);
    if (amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Payment amount is too large for LNURL-pay.");
    }
    return lnurlResponse({
      callback: new URL(
        `/api/pay/${channel}/invoice`,
        new URL(request.url).origin,
      ).toString(),
      minSendable: Number(amountMsat),
      maxSendable: Number(amountMsat),
      metadata: session.providerMetadata,
      tag: "payRequest",
    });
  } catch {
    return lnurlResponse({
      status: "ERROR",
      reason: "This payment request is unavailable or expired.",
    });
  }
}

async function handlePayCallback(
  request: Request,
  env: AppEnv,
  channel: string,
): Promise<Response> {
  if (request.method === "OPTIONS") return lnurlResponse({});
  if (request.method !== "GET") {
    return lnurlResponse({ status: "ERROR", reason: "GET is required." });
  }
  try {
    const session = await readPaymentSession(env, channel);
    if (!session) throw new Error("Payment request not found.");
    validateActivePaymentSession(session);
    const url = new URL(request.url);
    if (url.searchParams.get("amount") !== session.amountMsat) {
      throw new Error("Payment amount does not match.");
    }
    let successAction: LnurlSuccessAction | undefined = session.successAction;
    if (successAction?.tag === "url") {
      successAction = {
        tag: "url",
        description: successAction.description,
        url: publicPaymentActionUrl(new URL(request.url).origin, channel),
      };
    } else if (successAction === undefined && session.note !== undefined) {
      successAction = { tag: "message", message: session.note };
    }
    return lnurlResponse({
      pr: session.invoice,
      routes: [],
      disposable: true,
      ...(successAction === undefined ? {} : { successAction }),
    });
  } catch {
    return lnurlResponse({
      status: "ERROR",
      reason: "This payment request is unavailable, expired, or invalid.",
    });
  }
}

async function handlePayAction(
  request: Request,
  env: AppEnv,
  channel: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("GET is required.", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }
  const session = await readPaymentSession(env, channel);
  if (session?.successAction?.tag !== "url") {
    return new Response("Payment action is unavailable.", { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: session.successAction.url,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
  await enforceRateLimit(request, env.INVOICE_RATE_LIMITER, "invoices");
  const input = parseBatchInvoiceRequest(await readBoundedRequestJson(request));
  const requestOrigin = new URL(request.url).origin;
  const result = await generateInvoiceBatch(input, {
    client: new LnurlPayClient(),
    ...(env.NIP57_RECEIPTS === undefined
      ? {}
      : {
          prepareNostrPayment: async (discovery, slot, providerComment) => {
            const relayChannel = randomChannel();
            const relayUrl = publicWebSocketUrl(requestOrigin, relayChannel);
            const lnurl = encodeLnurlPayUrl(discovery.discoveryUrl);
            const request = createEphemeralZapRequest({
              recipientPubkey: createEphemeralZapRecipientAlias(),
              amountMsat: slot.targetSats * 1_000n,
              lnurl,
              relays: [relayUrl],
              ...(providerComment === undefined
                ? {}
                : { content: providerComment }),
            });
            return {
              request,
              relayChannel,
              relayUrl,
              providerPubkey: discovery.nostrPubkey!,
            };
          },
        }),
  });
  const secret = optionalVerificationSecret(env);
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
        const nostrVerification = slot.invoice.nostrVerification;
        const relayChannel = nostrVerification?.relayChannel ?? randomChannel();
        let paymentSessionInitialized = false;
        if (
          env.NIP57_RECEIPTS !== undefined &&
          slot.invoice.provider.metadata !== undefined
        ) {
          try {
            const expiresAtMs = Date.parse(slot.invoice.expiresAt);
            const sessionNote = payerNote(input.providerComment);
            await env.NIP57_RECEIPTS.getByName(relayChannel).initialize({
              expiresAtMs:
                expiresAtMs +
                DEFAULT_LIGHTNING_POLICY.settlementHistoricalRetentionSeconds *
                  1_000,
              providerMetadata: slot.invoice.provider.metadata,
              amountMsat: (slot.targetSats * 1_000n).toString(),
              invoice: slot.invoice.bolt11,
              ...(sessionNote === undefined ? {} : { note: sessionNote }),
              ...(slot.invoice.successAction === undefined
                ? {}
                : { successAction: slot.invoice.successAction }),
              ...(nostrVerification === undefined
                ? {}
                : {
                    nip57: {
                      providerPubkey: nostrVerification.providerPubkey,
                      requestJson: nostrVerification.requestJson,
                      expectedPaymentHash: slot.invoice.paymentHash,
                    },
                  }),
            });
            paymentSessionInitialized = true;
          } catch {
            // The invoice remains payable as raw BOLT11 when ephemeral state
            // cannot be prepared.
          }
        }
        let verificationToken: string | undefined;
        if (
          secret &&
          (slot.invoice.verifyUrl !== undefined ||
            (nostrVerification !== undefined && paymentSessionInitialized))
        ) {
          try {
            verificationToken = await sealVerificationContext(
              {
                ...(slot.invoice.verifyUrl === undefined
                  ? {}
                  : { verifyUrl: slot.invoice.verifyUrl }),
                ...(nostrVerification === undefined ||
                !paymentSessionInitialized
                  ? {}
                  : {
                      nip57: {
                        relayChannel,
                        providerPubkey: nostrVerification.providerPubkey,
                        requestJson: nostrVerification.requestJson,
                      },
                    }),
                expectedPaymentHash: slot.invoice.paymentHash,
                expectedInvoice: slot.invoice.bolt11,
                expiresAt: slot.invoice.expiresAt,
              },
              secret,
            );
          } catch {
            // Settlement automation is optional. Keep the payable invoice.
          }
        }
        let paymentRequest = slot.invoice.bolt11;
        if (
          nostrVerification === undefined &&
          paymentSessionInitialized &&
          slot.invoice.provider.metadata !== undefined &&
          slot.targetSats * 1_000n <= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          try {
            // Only expose an LNURL wrapper if the downstream description hash
            // is valid for the exact metadata the payer will receive.
            validateBolt11Invoice(slot.invoice.bolt11, {
              expectedSats: slot.targetSats,
              expectedDescription: slot.invoice.provider.metadata,
              minimumRemainingSeconds:
                DEFAULT_LIGHTNING_POLICY.minimumInvoiceRemainingSeconds,
            });
            paymentRequest = encodeLnurlPayUrl(
              publicLnurlPayUrl(requestOrigin, relayChannel),
            );
          } catch {
            // Fall through to BIP-321/raw BOLT11 below.
          }
        }
        if (paymentRequest === slot.invoice.bolt11) {
          try {
            paymentRequest = buildPaymentPayload(
              slot.invoice.bolt11,
              input.providerComment,
            );
          } catch {
            paymentRequest = slot.invoice.bolt11;
          }
        }
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
            paymentRequest,
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

async function checkNip57Settlement(
  env: AppEnv,
  context: VerificationContext,
  invoice: string,
): Promise<{
  readonly status: "notAvailable" | "unsettled" | "settled";
  readonly settled: boolean;
  readonly checkedAt?: string;
  readonly preimagePresent?: boolean;
  readonly providerStatus?: string;
}> {
  if (context.nip57 === undefined || env.NIP57_RECEIPTS === undefined) {
    return { status: "notAvailable", settled: false };
  }
  const receipt = await env.NIP57_RECEIPTS.getByName(
    context.nip57.relayChannel,
  ).getReceipt();
  const checkedAt = new Date().toISOString();
  if (receipt === null) {
    return {
      status: "unsettled",
      settled: false,
      checkedAt,
      preimagePresent: false,
      providerStatus: "NIP57_RECEIPT_PENDING",
    };
  }
  try {
    const request = parseAndValidateZapRequest(context.nip57.requestJson, {
      expectedProviderPubkey: context.nip57.providerPubkey,
    });
    const validated = validateZapReceipt(receipt, {
      request,
      providerPubkey: context.nip57.providerPubkey,
      expectedInvoice: invoice,
      expectedPaymentHash: context.expectedPaymentHash,
    });
    return {
      status: "settled",
      settled: true,
      checkedAt,
      preimagePresent: validated.preimage !== undefined,
      providerStatus: "NIP57_PROVIDER_ATTESTATION",
    };
  } catch (cause) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The NIP-57 settlement receipt is invalid.",
      { cause },
    );
  }
}

function settlementResponse(result: {
  readonly status: "notAvailable" | "unsettled" | "settled";
  readonly settled: boolean;
  readonly checkedAt?: string;
  readonly preimagePresent?: boolean;
  readonly providerStatus?: string | null;
}): Response {
  const body: SettlementResponseDto = {
    ok: true,
    status: result.status,
    settled: result.settled,
    ...(result.checkedAt === undefined ? {} : { checkedAt: result.checkedAt }),
    ...(result.preimagePresent === undefined
      ? {}
      : { preimagePresent: result.preimagePresent }),
    ...(result.providerStatus === undefined
      ? {}
      : { providerStatus: result.providerStatus }),
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
  let lud21Result: Awaited<ReturnType<typeof checkSettlement>> | undefined;
  let lud21Error: unknown;
  if (context.verifyUrl !== undefined) {
    try {
      lud21Result = await checkSettlement({
        verifyUrl: context.verifyUrl,
        expectedPaymentHash: context.expectedPaymentHash,
        expectedInvoice: input.bolt11,
      });
      if (lud21Result.status === "settled") {
        return settlementResponse(lud21Result);
      }
    } catch (cause) {
      lud21Error = cause;
    }
  }
  let nip57Result: Awaited<ReturnType<typeof checkNip57Settlement>> | undefined;
  let nip57Error: unknown;
  if (context.nip57 !== undefined) {
    try {
      nip57Result = await checkNip57Settlement(env, context, input.bolt11);
      if (nip57Result.status === "settled")
        return settlementResponse(nip57Result);
    } catch (cause) {
      nip57Error = cause;
    }
  }
  const successfulResult =
    [lud21Result, nip57Result].find(
      (result) => result?.status === "unsettled",
    ) ??
    lud21Result ??
    nip57Result;
  if (successfulResult !== undefined)
    return settlementResponse(successfulResult);
  if (lud21Error !== undefined) throw lud21Error;
  if (nip57Error !== undefined) throw nip57Error;
  return settlementResponse({ status: "notAvailable", settled: false });
}

export async function handleApiRequest(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    const paymentChannel = PAYMENT_PATH.exec(url.pathname)?.[1];
    if (paymentChannel !== undefined) {
      return await handlePayDiscovery(request, env, paymentChannel);
    }
    const paymentCallbackChannel = PAYMENT_CALLBACK_PATH.exec(
      url.pathname,
    )?.[1];
    if (paymentCallbackChannel !== undefined) {
      return await handlePayCallback(request, env, paymentCallbackChannel);
    }
    const paymentActionChannel = PAYMENT_ACTION_PATH.exec(url.pathname)?.[1];
    if (paymentActionChannel !== undefined) {
      return await handlePayAction(request, env, paymentActionChannel);
    }
    const relayChannel = NOSTR_RELAY_PATH.exec(url.pathname)?.[1];
    if (relayChannel !== undefined) {
      if (env.NIP57_RECEIPTS === undefined) {
        return new Response("Receipt relay is unavailable.", { status: 503 });
      }
      return env.NIP57_RECEIPTS.getByName(relayChannel).fetch(request);
    }
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
