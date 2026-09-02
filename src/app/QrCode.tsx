import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { prepareInvoiceShareFile } from "./invoiceShare";
import { buildQrPayload } from "./qr";

const MAX_QR_CACHE_ENTRIES = 24;
const qrDataUrlCache = new Map<string, Promise<string>>();

function qrDataUrl(invoice: string): Promise<string> {
  const cached = qrDataUrlCache.get(invoice);
  if (cached !== undefined) {
    qrDataUrlCache.delete(invoice);
    qrDataUrlCache.set(invoice, cached);
    return cached;
  }
  const generated = Promise.resolve()
    .then(() => buildQrPayload(invoice))
    .then((payload) =>
      QRCode.toDataURL(payload, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 360,
        color: { dark: "#171612", light: "#ffffff" },
      }),
    )
    .catch((cause: unknown) => {
      qrDataUrlCache.delete(invoice);
      throw cause;
    });
  qrDataUrlCache.set(invoice, generated);
  while (qrDataUrlCache.size > MAX_QR_CACHE_ENTRIES) {
    const oldest = qrDataUrlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    qrDataUrlCache.delete(oldest);
  }
  return generated;
}

export function QrCode({ invoice }: { readonly invoice: string }) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void prepareInvoiceShareFile(invoice);
    qrDataUrl(invoice)
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setError("QR을 만들지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [invoice]);

  if (error) return <p className="inline-error">{error}</p>;
  if (!dataUrl)
    return <div className="qr-placeholder" aria-label="QR 생성 중" />;
  return <img className="qr-image" src={dataUrl} alt="라이트닝 결제용 QR" />;
}
