import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

import {
  checkForPwaUpdate,
  subscribeToPwaUpdateChecks,
  updatePwaRegistration,
} from "./pwaUpdate";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

export function PwaVersionStatus() {
  const [updating, setUpdating] = useState(false);
  const [checked, setChecked] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW: (_scriptUrl, registration) => {
      void updatePwaRegistration(registration).then((succeeded) => {
        setChecked(succeeded);
      });
    },
  });

  useEffect(() => {
    const checkForUpdate = () => {
      if (document.visibilityState !== "visible") return;
      void checkForPwaUpdate().then((succeeded) => {
        setChecked(succeeded);
      });
    };
    return subscribeToPwaUpdateChecks(checkForUpdate);
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
      {needRefresh ? "새 버전 사용 가능" : checked ? "최신" : "확인 중"}
      {needRefresh && (
        <button type="button" disabled={updating} onClick={installUpdate}>
          {updating ? "업데이트 중…" : "업데이트"}
        </button>
      )}
    </div>
  );
}
