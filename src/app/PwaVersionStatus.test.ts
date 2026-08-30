import { afterEach, describe, expect, it, vi } from "vitest";

import { checkForPwaUpdate, subscribeToPwaUpdateChecks } from "./pwaUpdate";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PWA update checks", () => {
  it("checks again when the app is online and visible", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi.fn().mockResolvedValue({ update });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(checkForPwaUpdate()).resolves.toBe(true);

    expect(getRegistration).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("keeps update lookup failures from becoming unhandled errors", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update }),
      },
    });

    await expect(checkForPwaUpdate()).resolves.toBe(false);
  });

  it("subscribes to both visibility and online recovery events", () => {
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const fakeDocument = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        documentListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        documentListeners.delete(type);
      }),
    };
    const fakeWindow = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        windowListeners.delete(type);
      }),
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);
    const checkForUpdate = vi.fn();

    const unsubscribe = subscribeToPwaUpdateChecks(checkForUpdate);
    windowListeners.get("online")?.({} as Event);
    documentListeners.get("visibilitychange")?.({} as Event);

    expect(checkForUpdate).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(fakeDocument.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      checkForUpdate,
    );
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith(
      "online",
      checkForUpdate,
    );
  });
});
