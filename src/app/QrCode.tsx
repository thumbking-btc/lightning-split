import QRCode from "qrcode";
import { useEffect, useState } from "react";

import {
  prepareInvoiceShareFile,
  shareBareInvoicePaymentRequest,
} from "./invoiceShare";
import { initialLanguage, subscribeLanguage, type Language } from "./preferences";
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

function shareFeedback(
  result: Awaited<ReturnType<typeof shareBareInvoicePaymentRequest>>,
  language: Language,
): string | undefined {
  if (result === "sharedWithQr") {
    return language === "ko"
      ? "QR 이미지와 결제 요청을 공유했습니다."
      : "Shared the QR image and payment request.";
  }
  if (result === "sharedText") {
    return language === "ko"
      ? "이미지 공유를 사용할 수 없어 결제 요청 텍스트를 공유했습니다."
      : "Image sharing was unavailable, so the payment request text was shared.";
  }
  if (result === "copied") {
    return language === "ko"
      ? "공유 기능을 사용할 수 없어 결제 요청을 복사했습니다."
      : "Sharing was unavailable, so the payment request was copied.";
  }
  if (result === "failed") {
    return language === "ko"
      ? "공유하거나 복사하지 못했습니다. 아래 결제 요청 복사를 사용하십시오."
      : "Could not share or copy. Use the payment request copy button below.";
  }
  return undefined;
}

export function QrCode({ invoice }: { readonly invoice: string }) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [feedback, setFeedback] = useState<string>();

  useEffect(() => subscribeLanguage(setLanguage), []);

  useEffect(() => {
    let active = true;
    void prepareInvoiceShareFile(invoice);
    qrDataUrl(invoice)
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active)
          setError(language === "ko" ? "QR을 만들지 못했습니다." : "Could not create QR.");
      });
    return () => {
      active = false;
    };
  }, [invoice, language]);

  if (error) return <p className="inline-error">{error}</p>;
  if (!dataUrl)
    return (
      <div
        className="qr-placeholder"
        aria-label={language === "ko" ? "QR 생성 중" : "Creating QR"}
      />
    );

  return (
    <div className="qr-share-block">
      <img
        className="qr-image"
        src={dataUrl}
        alt={language === "ko" ? "라이트닝 결제용 QR" : "Lightning payment QR"}
      />
      <button
        className="secondary-button full qr-share-button"
        type="button"
        onClick={() =>
          void shareBareInvoicePaymentRequest(invoice, language).then((result) =>
            setFeedback(shareFeedback(result, language)),
          )
        }
      >
        {language === "ko" ? "QR · 결제 요청 공유" : "Share QR · payment request"}
      </button>
      <div className="copy-feedback" aria-live="polite">
        {feedback}
      </div>
    </div>
  );
}
