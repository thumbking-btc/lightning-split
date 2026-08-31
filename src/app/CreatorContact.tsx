import { useState } from "react";

import { copyTextToClipboard } from "./clipboard";
import type { Language } from "./preferences";
import { useLanguagePreference } from "./useLanguagePreference";
import "./CreatorContact.css";

const X_URL = "https://x.com/thumbking0227";
const THREADS_URL = "https://www.threads.com/@thumb.ggul";
const LIGHTNING_ADDRESS = "thumbking@oksu.su";

function SupportAddressCopy({ language }: { readonly language: Language }) {
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const korean = language === "ko";

  const copyAddress = async () => {
    const copied = await copyTextToClipboard(LIGHTNING_ADDRESS);
    setCopyFailed(!copied);
    setCopyStatus(
      copied
        ? korean
          ? "주소를 복사했습니다."
          : "Address copied."
        : korean
          ? "복사하지 못했습니다. 주소를 길게 눌러 복사하십시오."
          : "Could not copy automatically. Press and hold the address to copy it.",
    );
  };

  return (
    <figcaption className="creator-support-address">
      <span>{korean ? "라이트닝 주소" : "Lightning Address"}</span>
      <code>{LIGHTNING_ADDRESS}</code>
      <button
        type="button"
        aria-label={korean ? "라이트닝 주소 복사" : "Copy Lightning Address"}
        onClick={() => void copyAddress()}
      >
        {korean ? "복사" : "Copy"}
      </button>
      <p
        className={`creator-support-status${copyFailed ? " is-error" : ""}`}
        aria-live="polite"
        role={copyFailed ? "alert" : undefined}
      >
        {copyStatus}
      </p>
    </figcaption>
  );
}

export function CreatorContact() {
  const language = useLanguagePreference();
  const korean = language === "ko";

  return (
    <section
      className="creator-contact-shell"
      aria-label={korean ? "제작자와 문의" : "Creator and contact"}
    >
      <details className="creator-contact">
        <summary>
          <span>
            <strong>{korean ? "제작자 · 문의" : "Creator · Contact"}</strong>
            <small>
              {korean
                ? "제작자 정보 · 문의 · 라이트닝 후원"
                : "Creator info · Contact · Lightning support"}
            </small>
          </span>
          <span className="creator-contact-chevron" aria-hidden="true">
            ＋
          </span>
        </summary>
        <div className="creator-contact-body">
          <div className="creator-contact-profile">
            <img
              className="creator-contact-logo"
              src="/creator-logo.jpg"
              alt={korean ? "엄지왕 로고" : "Thumbking logo"}
              width="1000"
              height="1000"
            />
            <div>
              <span className="creator-contact-label">MADE BY</span>
              <strong>{korean ? "엄지왕" : "Thumbking"}</strong>
              <p>
                {korean
                  ? "Lightning Split을 사용하면서 궁금한 점, 불편한 점, 개선 아이디어가 있다면 알려주십시오. 실제 지갑에서 발견한 호환성 문제 제보도 환영합니다."
                  : "Questions, problems, improvement ideas, and wallet compatibility reports are welcome while using Lightning Split."}
              </p>
            </div>
          </div>
          <nav
            className="creator-contact-links"
            aria-label={
              korean ? "제작자 문의 채널" : "Creator contact channels"
            }
          >
            <a href={X_URL} target="_blank" rel="me noopener noreferrer">
              <span>X</span>
              <strong>@thumbking0227</strong>
              <small>{korean ? "문의하기 ↗" : "Contact ↗"}</small>
            </a>
            <a href={THREADS_URL} target="_blank" rel="me noopener noreferrer">
              <span>Threads</span>
              <strong>@thumb.ggul</strong>
              <small>{korean ? "문의하기 ↗" : "Contact ↗"}</small>
            </a>
          </nav>

          <article
            className="creator-support"
            aria-labelledby="creator-support-title"
          >
            <div className="creator-support-copy">
              <span className="creator-contact-label">SUPPORT</span>
              <h3 id="creator-support-title">
                {korean ? "라이트닝으로 후원하기" : "Support with Lightning"}
              </h3>
              <p>
                {korean
                  ? "Lightning Split이 도움이 되었다면 지속적인 검증과 다음 버전 제작을 후원해 주십시오."
                  : "If Lightning Split is useful to you, you can support continued verification and future versions."}
              </p>
              <p className="creator-support-note">
                {korean
                  ? "후원하기 전, 라이트닝 지갑에 표시된 수신 주소가 아래 주소와 같은지 확인해 주십시오."
                  : "Before paying, verify that your Lightning wallet shows the same receiving address as the one below."}
              </p>
            </div>
            <figure className="creator-support-figure">
              <img
                className="creator-support-qr"
                src="/lightning-support-qr.png"
                alt={
                  korean
                    ? "엄지왕 라이트닝 후원 QR"
                    : "Thumbking Lightning support QR"
                }
                width="445"
                height="445"
              />
              <SupportAddressCopy language={language} />
            </figure>
          </article>

          <p className="creator-contact-security">
            {korean
              ? "문의할 때 시드 문구·개인키·비밀번호 등 지갑의 비밀정보는 보내지 마십시오."
              : "Never send wallet secrets such as seed phrases, private keys, or passwords when contacting the creator."}
          </p>
        </div>
      </details>
    </section>
  );
}
