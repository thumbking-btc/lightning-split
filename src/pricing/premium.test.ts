import { describe, expect, it, vi } from "vitest";
import {
  KimchiPremiumService,
  UpbitDatalabPremiumAdapter,
  UPBIT_PREMIUM_URL,
  type PremiumReference,
  type PremiumReferenceCache,
} from "./premium";
const now = Date.parse("2030-01-01T00:00:00Z");
const record = {
  code: "CRIX.UPBIT.KRW-BTC",
  pair: "BTC/KRW",
  disparityRate: 1.63563823,
  realDisparityRate: 0.08408681,
};
function adapter(records: unknown[] = [record], code = 0) {
  const fetcher = vi.fn((input: string | URL) => {
    expect(String(input)).toBe(UPBIT_PREMIUM_URL);
    return Promise.resolve(Response.json({ code, data: { records } }));
  });
  return {
    fetcher,
    source: new UpbitDatalabPremiumAdapter(fetcher, undefined, () => now),
  };
}
describe("Upbit BTC premium", () => {
  it("selects BTC disparityRate, never realDisparityRate or another asset", async () => {
    const { source, fetcher } = adapter([
      {
        ...record,
        code: "CRIX.UPBIT.KRW-ETH",
        pair: "ETH/KRW",
        disparityRate: 9,
      },
      record,
    ]);
    const service = new KimchiPremiumService(
      source,
      undefined,
      undefined,
      () => now,
    );
    expect((await service.getInformation(108_910_000n)).basisPoints).toBe(164n);
    expect((await service.getInformation(120_000_000n)).basisPoints).toBe(164n);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(UPBIT_PREMIUM_URL);
  });
  it.each([
    [0, "0"],
    [-1.63563823, "-164"],
    [1.005, "101"],
    [-1.005, "-101"],
    [50, "5000"],
    [-50, "-5000"],
  ])("rounds percent %s to basis points %s", async (rate, expected) => {
    expect(
      (
        await adapter([
          { ...record, disparityRate: rate },
        ]).source.fetchReference()
      ).basisPoints,
    ).toBe(expected);
  });
  it.each([null, "", "NaN", 50.01, -50.01, true, undefined])(
    "rejects invalid or missing disparityRate %s",
    async (rate) => {
      await expect(
        adapter([{ ...record, disparityRate: rate }]).source.fetchReference(),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );
  it("rejects missing, duplicate, mismatched BTC records and failed API status", async () => {
    for (const source of [
      adapter([]).source,
      adapter([record, record]).source,
      adapter([{ ...record, pair: "BTC/USDT" }]).source,
      adapter([record], 1).source,
    ]) {
      await expect(source.fetchReference()).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });
  it("expires cache after 60 seconds without recomputing the indicator from live BTC prices", async () => {
    let clock = now;
    let stored: PremiumReference | null = null;
    const { source, fetcher } = adapter();
    const cache: PremiumReferenceCache = {
      get: async () => stored,
      put: async (value) => {
        stored = value;
      },
    };
    const service = new KimchiPremiumService(
      source,
      cache,
      undefined,
      () => clock,
    );
    await service.getInformation(100_000_000n);
    clock += 59_000;
    expect((await service.getInformation(110_000_000n)).basisPoints).toBe(164n);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await service.getInformation(110_000_000n);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("ignores old-format cached references and tolerates cache failures", async () => {
    const { source, fetcher } = adapter();
    const caches: PremiumReferenceCache[] = [
      {
        get: async () =>
          ({
            internationalPriceKrw: "100000000",
            retrievedAt: new Date(now).toISOString(),
          }) as unknown as PremiumReference,
        put: async () => {},
      },
      {
        get: async () => {
          throw new Error("unavailable");
        },
        put: async () => {
          throw new Error("unavailable");
        },
      },
    ];
    for (const cache of caches)
      expect(
        (
          await new KimchiPremiumService(
            source,
            cache,
            undefined,
            () => now,
          ).getInformation(100_000_000n)
        ).basisPoints,
      ).toBe(164n);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("propagates upstream failure instead of using a different premium", async () => {
    const source = new UpbitDatalabPremiumAdapter(async () =>
      Response.json({}, { status: 503 }),
    );
    await expect(source.fetchReference()).rejects.toThrow();
  });
});
