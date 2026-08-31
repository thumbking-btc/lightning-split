import { ApiClientError } from "./api";
import type { Language } from "./preferences";

const ERROR_MESSAGES_KO: Readonly<Record<string, string>> = Object.freeze({
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
  UNSUPPORTED_PAYMENT_FLOW:
    "이 주소는 결제 후 별도 동작이 필요하여 현재 방식으로는 사용할 수 없습니다.",
  ISSUANCE_UNKNOWN:
    "발급 결과를 확인할 수 없습니다. 받는 지갑을 확인한 뒤 새 정산을 시작하십시오.",
  CONFIGURATION_ERROR: "서비스 보안 설정이 준비되지 않았습니다.",
});

const ERROR_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  INVALID_INPUT: "Check the information you entered.",
  TIMEOUT: "The response is taking too long. Try again shortly.",
  NETWORK_ERROR: "Check your network connection and try again.",
  HTTP_ERROR: "An external service is temporarily unavailable. Try again shortly.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  PROVIDER_REJECTED: "The Lightning service rejected the request.",
  AMOUNT_OUT_OF_RANGE: "The amount is outside the range accepted by this address.",
  PAYER_DATA_REQUIRED:
    "Addresses that require additional payer information are not supported yet.",
  COMMENT_TOO_LONG:
    "The settlement note exceeds the length allowed by this address. Shorten it and try again.",
  INVALID_BOLT11: "The returned payment request could not be verified safely.",
  DUPLICATE_PAYMENT_HASH:
    "A previous payment request was reused, so the operation was stopped safely.",
  BATCH_ABORTED:
    "The remaining payment requests were stopped because a safety check failed.",
  UNSUPPORTED_PAYMENT_FLOW:
    "This address requires an additional post-payment action and is not supported by the current flow.",
  ISSUANCE_UNKNOWN:
    "The issuance result could not be confirmed. Check the receiving wallet before starting a new settlement.",
  CONFIGURATION_ERROR: "The service security configuration is not ready.",
});

export function toUserMessage(
  cause: unknown,
  fallback?: string,
  language: Language = "ko",
): string {
  const messages = language === "ko" ? ERROR_MESSAGES_KO : ERROR_MESSAGES_EN;
  const fallbackMessage =
    fallback ??
    (language === "ko"
      ? "요청을 완료하지 못했습니다."
      : "The request could not be completed.");

  if (cause instanceof ApiClientError) {
    if (cause.code === "COMMENT_TOO_LONG" && language === "ko")
      return cause.message;
    const message = messages[cause.code] ?? fallbackMessage;
    if (cause.code === "RATE_LIMITED" && cause.retryAfterSeconds) {
      return language === "ko"
        ? `${message} 약 ${cause.retryAfterSeconds}초 후 다시 시도할 수 있습니다.`
        : `${message} Try again in about ${cause.retryAfterSeconds} seconds.`;
    }
    return message;
  }
  return cause instanceof Error && cause.message ? cause.message : fallbackMessage;
}
