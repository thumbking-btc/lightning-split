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

export async function checkForPwaUpdate(): Promise<boolean> {
  if (
    typeof document === "undefined" ||
    document.visibilityState !== "visible" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return await updatePwaRegistration(registration);
  } catch {
    // The current app remains usable while the browser is offline or SW lookup fails.
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
