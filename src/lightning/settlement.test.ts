import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";

import type { Fetcher } from "../infrastructure/http";
import { checkSettlement } from "./settlement";

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function responseFetcher(value: unknown): Fetcher {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(value), { status: 200 })),
  );
}

describe("single LUD-21 settlement check", () => {
  it("does no request when verify is unavailable", async () => {
    const fetcher = responseFetcher({ settled: true });
    await expect(
      checkSettlement(
        { expectedPaymentHash: "11".repeat(32), expectedInvoice: "lnbc-test" },
        { fetcher },
      ),
    ).resolves.toEqual({ status: "notAvailable", settled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports settled=%s without exposing a preimage",
    async (settled) => {
      const preimage = "22".repeat(32);
      const paymentHash = hex(
        sha256(
          Uint8Array.from(
            preimage.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)),
          ),
        ),
      );
      const result = await checkSettlement(
        {
          verifyUrl: "https://wallet.example/verify/one",
          expectedPaymentHash: paymentHash,
          expectedInvoice: "lnbc-test",
        },
        {
          fetcher: responseFetcher({
            settled,
            pr: "lnbc-test",
            ...(settled ? { preimage: preimage.toUpperCase() } : {}),
          }),
          now: () => Date.UTC(2030, 0, 1),
        },
      );
      expect(result.status).toBe(settled ? "settled" : "unsettled");
      expect(result).toHaveProperty("providerStatus", null);
      expect(result).not.toHaveProperty("preimage");
    },
  );

  it("rejects mismatched invoice or preimage evidence", async () => {
    const input = {
      verifyUrl: "https://wallet.example/verify/one",
      expectedPaymentHash: "11".repeat(32),
      expectedInvoice: "lnbc-test",
    };
    await expect(
      checkSettlement(input, {
        fetcher: responseFetcher({ settled: true }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      checkSettlement(input, {
        fetcher: responseFetcher({ settled: true, pr: "other" }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      checkSettlement(input, {
        fetcher: responseFetcher({ settled: true, pr: "lnbc-test" }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      checkSettlement(input, {
        fetcher: responseFetcher({
          settled: true,
          pr: "lnbc-test",
          preimage: "22".repeat(32),
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts equivalent uppercase BOLT11 and bounds provider status evidence", async () => {
    await expect(
      checkSettlement(
        {
          verifyUrl: "https://wallet.example/verify/one",
          expectedPaymentHash: "11".repeat(32),
          expectedInvoice: "lnbc1test",
        },
        {
          fetcher: responseFetcher({
            settled: false,
            pr: "LNBC1TEST",
            status: "x".repeat(129),
          }),
          now: () => Date.UTC(2030, 0, 1),
        },
      ),
    ).resolves.toMatchObject({
      status: "unsettled",
      settled: false,
      providerStatus: null,
    });
  });

  it("rejects a valid preimage paired with settled=false", async () => {
    const preimage = "22".repeat(32);
    const paymentHash = hex(
      sha256(
        Uint8Array.from(
          preimage.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)),
        ),
      ),
    );
    await expect(
      checkSettlement(
        {
          verifyUrl: "https://wallet.example/verify/one",
          expectedPaymentHash: paymentHash,
          expectedInvoice: "lnbc-test",
        },
        {
          fetcher: responseFetcher({
            settled: false,
            pr: "lnbc-test",
            preimage,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
