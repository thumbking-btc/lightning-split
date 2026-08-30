export type PwaDeploymentState = "latest" | "updateAvailable" | "unknown";

interface BuildIdentity {
  readonly version: string;
  readonly commit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBuildIdentity(value: unknown): BuildIdentity | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
    typeof value.commit !== "string" ||
    !/^(?:[0-9a-f]{7,40}|unknown)$/u.test(value.commit)
  ) {
    return undefined;
  }
  return { version: value.version, commit: value.commit };
}

export async function updatePwaRegistration(
  registration: ServiceWorkerRegistration | undefined,
): Promise<boolean> {
  if (!registration) return false;
  try {
    await registration.update();
    return true;
  } catch {
    // A transient network failure must not change the displayed installed version.
    return false;
  }
}

export async function checkForPwaUpdate(
  currentVersion: string,
  currentCommit: string,
): Promise<PwaDeploymentState> {
  if (
    typeof document === "undefined" ||
    document.visibilityState !== "visible" ||
    typeof navigator === "undefined"
  ) {
    return "unknown";
  }

  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      await updatePwaRegistration(registration);
    }
    const response = await fetch(`/build.json?check=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "unknown";
    const deployed = parseBuildIdentity(await response.json());
    if (!deployed) return "unknown";
    if (currentCommit === "unknown" || deployed.commit === "unknown")
      return "unknown";
    return deployed.version === currentVersion &&
      deployed.commit === currentCommit
      ? "latest"
      : "updateAvailable";
  } catch {
    // The current app remains usable while the browser is offline or update lookup fails.
    return "unknown";
  }
}

async function waitForInstallingWorker(
  registration: ServiceWorkerRegistration,
  installing: ServiceWorker,
  timeoutMs: number,
): Promise<ServiceWorker | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (
      installing.state === "installed" &&
      registration.waiting === installing
    ) {
      return installing;
    }
    if (installing.state === "redundant") return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

export async function installPwaUpdate(timeoutMs = 10_000): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const serviceWorkers = navigator.serviceWorker;
    const registration = await serviceWorkers.getRegistration();
    if (!registration) return false;
    await registration.update();
    const installing = registration.installing;
    const waiting = installing
      ? await waitForInstallingWorker(registration, installing, timeoutMs)
      : (registration.waiting ?? undefined);
    if (!waiting) return false;

    const controllerChanged = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      serviceWorkers.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });
    waiting.postMessage({ type: "SKIP_WAITING" });
    return await controllerChanged;
  } catch {
    return false;
  }
}

export function subscribeToPwaUpdateChecks(
  checkForUpdate: () => void,
): () => void {
  document.addEventListener("visibilitychange", checkForUpdate);
  window.addEventListener("online", checkForUpdate);
  return () => {
    document.removeEventListener("visibilitychange", checkForUpdate);
    window.removeEventListener("online", checkForUpdate);
  };
}
