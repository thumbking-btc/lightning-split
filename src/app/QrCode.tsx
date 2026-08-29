import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { buildQrPayload } from "./qr";

export function QrCode({ invoice }: { readonly invoice: string }) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(buildQrPayload(invoice), {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360,
      color: { dark: "#171612", light: "#ffffff" },
    })
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
