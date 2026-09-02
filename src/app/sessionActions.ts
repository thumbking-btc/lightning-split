import type { ClientSlot } from "./types";

export const NEW_SETTLEMENT_PENDING_MESSAGE =
  "아직 정산이 진행 중입니다. 만료된 결제 요청은 새로 만들어 다시 공유하고, 모든 참여자의 결제를 확인한 뒤 새 정산을 시작하십시오.";

export const ABANDON_PENDING_SETTLEMENT_CONFIRMATION =
  "이 정산을 중단하고 기기에서 삭제하시겠습니까? 아직 결제 가능한 Lightning invoice가 있으면 이후 실제 입금이 발생해도 이 앱에서 더 이상 자동 추적할 수 없습니다.";

export const DELETE_SETTLEMENT_RECORD_CONFIRMATION =
  "이 기기에 저장된 현재 정산을 삭제하시겠습니까? 이미 생성된 Lightning 결제 요청이나 완료된 결제 자체는 취소되지 않습니다.";

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
