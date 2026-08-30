import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("legacy service worker migration", () => {
  it("activates immediately without starting a second competing navigation", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const claim = vi.fn(() => Promise.resolve());
    const skipWaiting = vi.fn(() => Promise.resolve());
    runInNewContext(
      readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"),
      {
        Promise,
        clients: { claim },
        skipWaiting,
        addEventListener: (type: string, listener: (event: unknown) => void) =>
          listeners.set(type, listener),
      },
    );

    listeners.get("install")?.({});
    expect(skipWaiting).toHaveBeenCalledOnce();

    let activation: Promise<unknown> | undefined;
    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise;
      },
    });
    await activation;

    expect(claim).toHaveBeenCalledOnce();
  });
});
