import type { ClientSlot } from "./types";

export const NEW_SETTLEMENT_PENDING_BLOCKED =
  "아직 정산되지 않은 항목이 있습니다. 현재 정산에서 만료된 결제 요청은 새 invoice로 재발급하고, 모든 참여자의 정산이 끝난 뒤 새 정산을 시작하십시오.";

/**
 * Backward-compatible name retained for the legacy App module and its tests.
 * The active settlement-history application uses NEW_SETTLEMENT_PENDING_BLOCKED
 * and blocks the transition instead of offering an override confirmation.
 */
export const NEW_SETTLEMENT_PENDING_CONFIRMATION =
  NEW_SETTLEMENT_PENDING_BLOCKED;

export const DELETE_PENDING_SETTLEMENT_BLOCKED =
  "아직 정산되지 않은 항목이 있어 현재 정산을 삭제할 수 없습니다. 미정산 항목을 먼저 처리하십시오.";

export const DELETE_SETTLEMENT_RECORD_CONFIRMATION =
  "기기에 저장된 완료된 현재 정산 기록을 삭제합니다. 이미 완료된 Lightning 결제는 취소되지 않습니다. 삭제하시겠습니까?";

export function hasPendingSettlement(
  session: {
    readonly slots: readonly Pick<ClientSlot, "status">[];
  } | null,
): boolean {
  return Boolean(
    session?.slots.some(
      (slot) =>
        slot.status !== "settled" && slot.status !== "manuallyConfirmed",
    ),
  );
}
