import { ApiClientError } from "./api";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INVALID_INPUT: "입력 내용을 다시 확인하십시오.",
  TIMEOUT: "응답이 늦어지고 있습니다. 잠시 후 다시 시도하십시오.",
  NETWORK_ERROR: "네트워크 연결을 확인하고 다시 시도하십시오.",
  HTTP_ERROR:
    "외부 서비스에 일시적인 문제가 있습니다. 잠시 후 다시 시도하십시오.",
  RATE_LIMITED: "요청이 많습니다. 잠시 후 다시 시도하십시오.",
  PROVIDER_REJECTED: "Lightning 서비스가 요청을 거절했습니다.",
  AMOUNT_OUT_OF_RANGE: "이 주소에서 받을 수 있는 금액 범위를 벗어났습니다.",
  PAYER_DATA_REQUIRED:
    "추가 송금자 정보를 요구하는 주소는 현재 지원하지 않습니다.",
  COMMENT_TOO_LONG:
    "입력한 정산 메모가 이 주소의 허용 길이를 초과합니다. 메모를 줄여 다시 시도하십시오.",
  INVALID_BOLT11: "안전하게 확인할 수 없는 결제 요청이 반환되었습니다.",
  DUPLICATE_PAYMENT_HASH: "이전 결제 요청이 재사용되어 안전하게 중단했습니다.",
  BATCH_ABORTED: "안전 확인 문제로 남은 결제 요청 생성을 중단했습니다.",
  CONFIGURATION_ERROR: "서비스 보안 설정이 준비되지 않았습니다.",
});

export function toUserMessage(
  cause: unknown,
  fallback = "요청을 완료하지 못했습니다.",
): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === "COMMENT_TOO_LONG") return cause.message;
    const message = ERROR_MESSAGES[cause.code] ?? fallback;
    return cause.code === "RATE_LIMITED" && cause.retryAfterSeconds
      ? `${message} 약 ${cause.retryAfterSeconds}초 후 다시 시도할 수 있습니다.`
      : message;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
