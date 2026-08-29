import type { ApiRateLimitPolicy } from "../src/config/policies";
import { DEFAULT_API_RATE_LIMIT_POLICY } from "../src/config/policies";
import { InfrastructureError } from "../src/infrastructure/errors";

export type RateLimitRoute = "invoices" | "settlement";

function actorKey(request: Request): string {
  const address = request.headers.get("cf-connecting-ip")?.trim();
  return address ? `ip:${address}` : "ip:unknown";
}

export async function enforceRateLimit(
  request: Request,
  limiter: RateLimit,
  route: RateLimitRoute,
  policy: ApiRateLimitPolicy = DEFAULT_API_RATE_LIMIT_POLICY,
): Promise<void> {
  const outcome = await limiter.limit({ key: `${route}:${actorKey(request)}` });
  if (outcome.success) return;
  const retryAfterSeconds =
    route === "invoices"
      ? policy.invoiceRetryAfterSeconds
      : policy.settlementRetryAfterSeconds;
  throw new InfrastructureError(
    "RATE_LIMITED",
    "요청이 너무 많습니다. 잠시 후 다시 시도하십시오.",
    { retryable: true, retryAfterSeconds },
  );
}
