export type InfrastructureErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "STALE_DATA"
  | "PROVIDER_REJECTED"
  | "AMOUNT_OUT_OF_RANGE"
  | "PAYER_DATA_REQUIRED"
  | "COMMENT_NOT_SUPPORTED"
  | "COMMENT_TOO_LONG"
  | "INVALID_BOLT11"
  | "DUPLICATE_PAYMENT_HASH"
  | "BATCH_ABORTED"
  | "UNSUPPORTED_PAYMENT_FLOW"
  | "CONFIGURATION_ERROR";

export interface InfrastructureErrorOptions {
  readonly retryable?: boolean;
  readonly upstreamStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

export class InfrastructureError extends Error {
  readonly code: InfrastructureErrorCode;
  readonly retryable: boolean;
  readonly upstreamStatus: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: InfrastructureErrorCode,
    message: string,
    options: InfrastructureErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "InfrastructureError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
