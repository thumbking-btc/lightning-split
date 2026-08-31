from pathlib import Path
import re

batch = Path("src/lightning/batch.ts")
text = batch.read_text(encoding="utf-8")
old_function = re.compile(
    r"""function failureSlot\(\n  slot: InvoiceSlotRequest,\n  error: unknown,\n\): FailedInvoiceSlot \{.*?\n\}\n\nfunction validateBatchInput""",
    re.S,
)
new_function = '''function failureSlot(
  slot: InvoiceSlotRequest,
  error: unknown,
): FailedInvoiceSlot {
  const known = error instanceof InfrastructureError;
  const issuanceResultUnknown =
    known &&
    new Set([
      "TIMEOUT",
      "NETWORK_ERROR",
      "HTTP_ERROR",
      "RESPONSE_TOO_LARGE",
      "INVALID_RESPONSE",
    ]).has(error.code);
  if (issuanceResultUnknown) {
    return {
      ...slot,
      status: "failed",
      failure: {
        code: "ISSUANCE_UNKNOWN",
        message:
          "The provider callback result is unknown. Check the receiving wallet before creating another payment request.",
        retryable: false,
      },
    };
  }
  const canRetryWithFreshProviderState =
    known &&
    new Set([
      "PROVIDER_REJECTED",
      "INVALID_BOLT11",
      "DUPLICATE_PAYMENT_HASH",
      "BATCH_ABORTED",
    ]).has(error.code);
  return {
    ...slot,
    status: "failed",
    failure: {
      code: known
        ? error.code
        : error instanceof Bolt11InvoiceError
          ? error.code
          : "UNKNOWN",
      message:
        error instanceof Error ? error.message : "Invoice generation failed.",
      retryable:
        error instanceof Bolt11InvoiceError
          ? true
          : known
            ? error.retryable || canRetryWithFreshProviderState
            : false,
    },
  };
}

function validateBatchInput'''
text, count = old_function.subn(new_function, text, count=1)
if count != 1:
    raise SystemExit(f"failureSlot replacement count: {count}")
batch.write_text(text, encoding="utf-8")

tests = Path("src/lightning/batch.integration.test.ts")
text = tests.read_text(encoding="utf-8")
import_anchor = 'import { DEFAULT_LIGHTNING_POLICY } from "../config/policies";\n'
if import_anchor not in text:
    raise SystemExit("batch test import anchor missing")
text = text.replace(
    import_anchor,
    import_anchor + 'import { InfrastructureError } from "../infrastructure/errors";\n',
    1,
)
anchor = '  it("discovers once, caps callbacks at three, and preserves request order", async () => {'
if anchor not in text:
    raise SystemExit("batch test insertion anchor missing")
test = '''  it.each([
    "TIMEOUT",
    "NETWORK_ERROR",
    "HTTP_ERROR",
    "RESPONSE_TOO_LARGE",
    "INVALID_RESPONSE",
  ] as const)(
    "fails closed when a provider callback result is ambiguous: %s",
    async (code) => {
      const mock = clientWith(() =>
        Promise.reject(
          new InfrastructureError(code, "ambiguous callback", {
            retryable: true,
          }),
        ),
      );

      const result = await generateInvoiceBatch(
        { address: ADDRESS, slots: slots(1) },
        { client: mock.client, now: () => NOW_SECONDS * 1_000 },
      );

      expect(result.slots[0]).toMatchObject({
        status: "failed",
        failure: { code: "ISSUANCE_UNKNOWN", retryable: false },
      });
      expect(mock.callback).toHaveBeenCalledOnce();
    },
  );

'''
text = text.replace(anchor, test + anchor, 1)
tests.write_text(text, encoding="utf-8")
