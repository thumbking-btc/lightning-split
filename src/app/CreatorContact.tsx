import { useState } from "react";

import { copyTextToClipboard } from "./clipboard";
import "./CreatorContact.css";

const X_URL = "https://x.com/thumbking0227";
const THREADS_URL = "https://www.threads.com/@thumb.ggul";
const LIGHTNING_ADDRESS = "thumbking@oksu.su";

function SupportAddressCopy() {
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);

  const copyAddress = async () => {
    const copied = await copyTextToClipboard(LIGHTNING_ADDRESS);
    setCopyFailed(!copied);
    setCopyStatus(
      copied
        ? "주소를 복사했습니다."
        : "복사하지 못했습니다. 주소를 길게 눌러 복사하십시오.",
    );
  };

  return (
    <figcaption className="creator-support-address">
      <span>라이트닝 주소</span>
      <code>{LIGHTNING_ADDRESS}</code>
      <button
        type="button"
        aria-label="라이트닝 주소 복사"
        onClick={() => void copyAddress()}
      >
        복사
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
  return (
    <section className="creator-contact-shell" aria-label="제작자와 문의">
      <details className="creator-contact">
        <summary>
          <span>
            <strong>제작자 · 문의</strong>
            <small>제작자 정보 · 문의 · 라이트닝 후원</small>
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
              alt="엄지왕 로고"
              width="1000"
              height="1000"
            />
            <div>
              <span className="creator-contact-label">MADE BY</span>
              <strong>엄지왕</strong>
              <p>
                Lightning Split을 사용하면서 궁금한 점, 불편한 점, 개선
                아이디어가 있다면 알려주십시오. 실제 지갑에서 발견한 호환성 문제
                제보도 환영합니다.
              </p>
            </div>
          </div>
          <nav className="creator-contact-links" aria-label="제작자 문의 채널">
            <a href={X_URL} target="_blank" rel="me noopener noreferrer">
              <span>X</span>
              <strong>@thumbking0227</strong>
              <small>문의하기 ↗</small>
            </a>
            <a href={THREADS_URL} target="_blank" rel="me noopener noreferrer">
              <span>Threads</span>
              <strong>@thumb.ggul</strong>
              <small>문의하기 ↗</small>
            </a>
          </nav>

          <article
            className="creator-support"
            aria-labelledby="creator-support-title"
          >
            <div className="creator-support-copy">
              <span className="creator-contact-label">SUPPORT</span>
              <h3 id="creator-support-title">라이트닝으로 후원하기</h3>
              <p>
                Lightning Split이 도움이 되었다면 지속적인 검증과 다음 버전
                제작을 후원해 주십시오.
              </p>
              <p className="creator-support-note">
                후원하기 전, 라이트닝 지갑에 표시된 수신 주소가 아래 주소와
                같은지 확인해 주십시오.
              </p>
            </div>
            <figure className="creator-support-figure">
              <img
                className="creator-support-qr"
                src="/lightning-support-qr.png"
                alt="엄지왕 라이트닝 후원 QR"
                width="445"
                height="445"
              />
              <SupportAddressCopy />
            </figure>
          </article>

          <p className="creator-contact-security">
            문의할 때 시드 문구·개인키·비밀번호 등 지갑의 비밀정보는 보내지
            마십시오.
          </p>
        </div>
      </details>
    </section>
  );
}
