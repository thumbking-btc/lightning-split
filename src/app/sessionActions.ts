import type { ClientSlot } from "./types";

export const NEW_SETTLEMENT_PENDING_CONFIRMATION =
  "아직 결제되지 않은 항목이 있습니다. 새 정산을 시작하시겠습니까?";

export const DELETE_SETTLEMENT_RECORD_CONFIRMATION =
  "이 기기에 저장된 현재 정산 기록을 삭제합니다. 이미 생성된 Lightning 결제 요청이나 완료된 결제는 취소되지 않습니다. 삭제하시겠습니까?";

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
