import type { HttpFetchPolicy } from "../config/policies";
import { InfrastructureError } from "./errors";
import { safeHttpsUrl } from "./url";

export type Fetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BoundedJsonResponse {
  readonly value: unknown;
  readonly finalUrl: URL;
  readonly headers: Headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return Number(value);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1_000));
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelBody(response);
    throw new InfrastructureError(
      "RESPONSE_TOO_LARGE",
      "The provider response is too large.",
    );
  }
  if (!response.body) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The provider returned an empty response.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new InfrastructureError(
          "RESPONSE_TOO_LARGE",
          "The provider response is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (received === 0) {
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The provider returned an empty response.",
    );
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    if (cause instanceof InfrastructureError) throw cause;
    throw new InfrastructureError(
      "INVALID_RESPONSE",
      "The provider returned invalid JSON.",
      {
        cause,
      },
    );
  }
}

export async function fetchBoundedJson(
  startUrl: string | URL,
  policy: HttpFetchPolicy,
  fetcher: Fetcher = fetch,
  now: () => number = Date.now,
): Promise<BoundedJsonResponse> {
  let current = safeHttpsUrl(startUrl);

  for (
    let redirectCount = 0;
    redirectCount <= policy.maxRedirects;
    redirectCount += 1
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    let response: Response;

    try {
      response = await fetcher(current, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": policy.userAgent,
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timeout);
      if (
        controller.signal.aborted ||
        (cause instanceof Error && cause.name === "AbortError")
      ) {
        throw new InfrastructureError(
          "TIMEOUT",
          "The provider request timed out.",
          {
            retryable: true,
            cause,
          },
        );
      }
      throw new InfrastructureError(
        "NETWORK_ERROR",
        "The provider could not be reached.",
        {
          retryable: true,
          cause,
        },
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelBody(response);
      clearTimeout(timeout);
      if (!location || redirectCount >= policy.maxRedirects) {
        throw new InfrastructureError(
          "INVALID_RESPONSE",
          "The provider redirect is invalid.",
        );
      }
      current = safeHttpsUrl(location, current);
      continue;
    }

    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(
        response.headers.get("retry-after"),
        now(),
      );
      const status = response.status;
      await cancelBody(response);
      clearTimeout(timeout);
      if (status === 429) {
        throw new InfrastructureError(
          "RATE_LIMITED",
          "The provider rate limit was reached.",
          {
            retryable: true,
            upstreamStatus: status,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          },
        );
      }
      throw new InfrastructureError(
        "HTTP_ERROR",
        "The provider returned an HTTP error.",
        {
          retryable: status >= 500,
          upstreamStatus: status,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
      );
    }

    try {
      return {
        value: await readBoundedJson(response, policy.maxResponseBytes),
        finalUrl: current,
        headers: response.headers,
      };
    } catch (cause) {
      if (
        controller.signal.aborted ||
        (cause instanceof Error && cause.name === "AbortError")
      ) {
        throw new InfrastructureError(
          "TIMEOUT",
          "The provider response timed out.",
          { retryable: true, cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new InfrastructureError(
    "INVALID_RESPONSE",
    "The provider redirect could not be resolved.",
  );
}
