export function buildQrPayload(canonicalInvoice: string): string {
  if (
    !canonicalInvoice.startsWith("lnbc") ||
    canonicalInvoice !== canonicalInvoice.toLowerCase()
  ) {
    throw new Error("검증된 canonical BOLT11만 QR로 만들 수 있습니다.");
  }
  return canonicalInvoice;
}
