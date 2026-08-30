import { MAX_BOLT11_LENGTH } from "../lightning/bolt11";

export function buildQrPayload(invoice: string): string {
  if (
    invoice.length < 1 ||
    invoice.length > MAX_BOLT11_LENGTH ||
    !/^lnbc[0123456789acdefghjklmnpqrstuvwxyz]+$/u.test(invoice)
  ) {
    throw new Error("검증된 Lightning invoice만 QR로 만들 수 있습니다.");
  }
  // BOLT11 recommends uppercase for QR because alphanumeric mode is denser.
  return invoice.toUpperCase();
}
