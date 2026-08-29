export const LIGHTNING_INVOICE_INPUT_MESSAGE =
  "라이트닝 인보이스가 입력되었습니다. 여러 결제 요청을 만들려면 Lightning Address를 입력하십시오. 예: thumbking@oksu.su";

export function isLightningInvoiceInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("lnbc") || normalized.startsWith("lightning:lnbc")
  );
}
