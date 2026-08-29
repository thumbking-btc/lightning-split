import { describe, expect, it, vi } from "vitest";

import type { HttpFetchPolicy } from "../config/policies";
import { fetchBoundedJson, type Fetcher } from "./http";

const policy: HttpFetchPolicy = {
  timeoutMs: 10,
  maxRedirects: 1,
  maxResponseBytes: 64,
  userAgent: "test",
};

describe("bounded provider HTTP", () => {
  it("surfaces 429 and Retry-After without reading the response body", async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      ),
    );
    await expect(
      fetchBoundedJson("https://wallet.example/api", policy, fetcher),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      upstreamStatus: 429,
      retryAfterSeconds: 30,
    });
  });

  it("aborts a timed-out request", async () => {
    const fetcher: Fetcher = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      fetchBoundedJson("https://wallet.example/api", policy, fetcher),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("revalidates a redirect target and enforces the response-size cap", async () => {
    const unsafeRedirect: Fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/" },
        }),
      ),
    );
    await expect(
      fetchBoundedJson("https://wallet.example/api", policy, unsafeRedirect),
    ).rejects.toMatchObject({
      code: "UNSAFE_URL",
    });

    const tooLarge: Fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ value: "x".repeat(100) }), {
          status: 200,
        }),
      ),
    );
    await expect(
      fetchBoundedJson("https://wallet.example/api", policy, tooLarge),
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });
});
