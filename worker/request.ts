import { InfrastructureError } from "../src/infrastructure/errors";

const MAX_API_BODY_BYTES = 32_768;

export async function readBoundedRequestJson(
  request: Request,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "Content-Type must be application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_BYTES) {
    throw new InfrastructureError(
      "RESPONSE_TOO_LARGE",
      "The API request body is too large.",
    );
  }
  if (!request.body)
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The API request body is empty.",
    );

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_API_BODY_BYTES) {
        await reader.cancel();
        throw new InfrastructureError(
          "RESPONSE_TOO_LARGE",
          "The API request body is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch (cause) {
    throw new InfrastructureError(
      "INVALID_INPUT",
      "The API request body is invalid JSON.",
      { cause },
    );
  }
}
