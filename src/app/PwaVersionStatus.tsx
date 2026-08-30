import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

export function PwaVersionStatus() {
  const [updating, setUpdating] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW: (_scriptUrl, registration) => {
      void registration?.update();
    },
  });

  useEffect(() => {
    const checkForUpdate = () => {
      if (
        document.visibilityState !== "visible" ||
        !("serviceWorker" in navigator)
      )
        return;
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => registration?.update());
    };
    document.addEventListener("visibilitychange", checkForUpdate);
    return () =>
      document.removeEventListener("visibilitychange", checkForUpdate);
  }, []);

  const installUpdate = async () => {
    setUpdating(true);
    try {
      await updateServiceWorker(true);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="app-version" role="status" aria-live="polite">
      {__APP_VERSION__} · {__GIT_COMMIT__} ·{" "}
      {needRefresh ? "새 버전 사용 가능" : "최신"}
      {needRefresh && (
        <button type="button" disabled={updating} onClick={installUpdate}>
          {updating ? "업데이트 중…" : "업데이트"}
        </button>
      )}
    </div>
  );
}
