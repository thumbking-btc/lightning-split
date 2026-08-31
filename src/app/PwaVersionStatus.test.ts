import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkForPwaUpdate,
  installPwaUpdate,
  shouldAutoInstallPreviewUpdate,
  subscribeToPwaUpdateChecks,
} from "./pwaUpdate";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PWA update checks", () => {
  it("auto-installs newer Preview builds but never production builds", () => {
    expect(
      shouldAutoInstallPreviewUpdate(
        "refactor/stateless-invoice-issuance",
        "updateAvailable",
      ),
    ).toBe(true);
    expect(shouldAutoInstallPreviewUpdate("main", "updateAvailable")).toBe(
      false,
    );
    expect(
      shouldAutoInstallPreviewUpdate(
        "refactor/stateless-invoice-issuance",
        "latest",
      ),
    ).toBe(false);
  });

  it("checks again when the app is online and visible", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi.fn().mockResolvedValue({ update });
    const fetchBuild = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "v0.1.4", commit: "abcdef0" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    vi.stubGlobal("fetch", fetchBuild);

    await expect(checkForPwaUpdate("v0.1.4", "abcdef0")).resolves.toBe(
      "latest",
    );

    expect(getRegistration).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(fetchBuild).toHaveBeenCalledWith(
      expect.stringMatching(/^\/build\.json\?check=\d+$/u),
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("keeps update lookup failures from becoming unhandled errors", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update }),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(checkForPwaUpdate("v0.1.4", "abcdef0")).resolves.toBe(
      "unknown",
    );
  });

  it("does not report an older running commit as latest", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ version: "v0.1.4", commit: "1234567" }),
            { status: 200 },
          ),
        ),
    );

    await expect(checkForPwaUpdate("v0.1.4", "abcdef0")).resolves.toBe(
      "updateAvailable",
    );
  });

  it("rejects malformed deployment identity instead of claiming latest", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: "latest", commit: "main" }), {
          status: 200,
        }),
      ),
    );

    await expect(checkForPwaUpdate("v0.1.4", "abcdef0")).resolves.toBe(
      "unknown",
    );
  });

  it("never treats unknown build identities as latest", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ version: "v0.1.4", commit: "unknown" }),
            { status: 200 },
          ),
        ),
    );

    await expect(checkForPwaUpdate("v0.1.4", "unknown")).resolves.toBe(
      "unknown",
    );
  });

  it("waits for an installing update before requesting activation", async () => {
    let controllerChange: EventListener | undefined;
    const installing = {
      state: "installing",
      postMessage: vi.fn(() => controllerChange?.({} as Event)),
    };
    const registration: {
      installing?: typeof installing;
      waiting?: typeof installing;
      update: ReturnType<typeof vi.fn>;
    } = {
      update: vi.fn(async () => {
        registration.installing = installing;
        setTimeout(() => {
          installing.state = "installed";
          registration.waiting = installing;
        }, 1);
      }),
    };
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn(
        (_type: string, listener: EventListener) =>
          (controllerChange = listener),
      ),
    };
    vi.stubGlobal("navigator", { serviceWorker });

    await expect(installPwaUpdate(100)).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(installing.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });
  });

  it("never activates an older waiting worker while a newer one installs", async () => {
    let controllerChange: EventListener | undefined;
    const oldWaiting = { state: "installed", postMessage: vi.fn() };
    const newInstalling = {
      state: "installing",
      postMessage: vi.fn(() => controllerChange?.({} as Event)),
    };
    const registration: {
      installing?: typeof newInstalling;
      waiting?: typeof oldWaiting | typeof newInstalling;
      update: ReturnType<typeof vi.fn>;
    } = {
      waiting: oldWaiting,
      update: vi.fn(async () => {
        registration.installing = newInstalling;
        setTimeout(() => {
          newInstalling.state = "installed";
          registration.waiting = newInstalling;
        }, 1);
      }),
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(registration),
        addEventListener: vi.fn(
          (_type: string, listener: EventListener) =>
            (controllerChange = listener),
        ),
      },
    });

    await expect(installPwaUpdate(100)).resolves.toBe(true);
    expect(oldWaiting.postMessage).not.toHaveBeenCalled();
    expect(newInstalling.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });
  });

  it("keeps the update action retryable when no waiting worker appears", async () => {
    const registration = {
      waiting: undefined,
      update: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(registration),
        addEventListener: vi.fn(),
      },
    });

    await expect(installPwaUpdate(5)).resolves.toBe(false);
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
