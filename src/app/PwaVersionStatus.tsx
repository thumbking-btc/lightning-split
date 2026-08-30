import { useCallback, useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

import {
  checkForPwaUpdate,
  installPwaUpdate,
  type PwaDeploymentState,
  subscribeToPwaUpdateChecks,
} from "./pwaUpdate";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

export function PwaVersionStatus() {
  const [updating, setUpdating] = useState(false);
  const [deploymentState, setDeploymentState] =
    useState<PwaDeploymentState>("unknown");
  const checkSequenceRef = useRef(0);
  const refreshDeploymentState = useCallback(async () => {
    const sequence = ++checkSequenceRef.current;
    const next = await checkForPwaUpdate(__APP_VERSION__, __GIT_COMMIT__);
    if (sequence === checkSequenceRef.current) setDeploymentState(next);
    return next;
  }, []);
  const {
    needRefresh: [needRefresh],
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW: () => {
      void refreshDeploymentState();
    },
  });

  useEffect(() => {
    const checkForUpdate = () => {
      if (document.visibilityState !== "visible") return;
      void refreshDeploymentState();
    };
    checkForUpdate();
    return subscribeToPwaUpdateChecks(checkForUpdate);
  }, [refreshDeploymentState]);

  const installUpdate = async () => {
    setUpdating(true);
    try {
      await refreshDeploymentState();
      if (await installPwaUpdate()) window.location.reload();
    } finally {
      setUpdating(false);
    }
  };

  const updateAvailable = needRefresh || deploymentState === "updateAvailable";

  return (
    <div className="app-version" role="status" aria-live="polite">
      {__APP_VERSION__} · {__GIT_COMMIT__} ·{" "}
      {updateAvailable
        ? "새 버전 사용 가능"
        : deploymentState === "latest"
          ? "최신"
          : "확인 중"}
      {updateAvailable && (
        <button type="button" disabled={updating} onClick={installUpdate}>
          {updating ? "업데이트 중…" : "업데이트"}
        </button>
      )}
    </div>
  );
}
