import "./CreatorContact.css";

const X_URL = "https://x.com/thumbking0227";
const THREADS_URL = "https://www.threads.com/@thumb.ggul";

export function CreatorContact() {
  return (
    <section className="creator-contact-shell" aria-label="제작자와 문의">
      <details className="creator-contact">
        <summary>
          <span>
            <strong>제작자 · 문의</strong>
            <small>문의사항·개선 제안은 언제든 환영합니다</small>
          </span>
          <span className="creator-contact-chevron" aria-hidden="true">
            ＋
          </span>
        </summary>
        <div className="creator-contact-body">
          <div className="creator-contact-profile">
            <img
              className="creator-contact-logo"
              src="/lightning-split.svg"
              alt="Lightning Split"
              width="72"
              height="72"
            />
            <div>
              <span className="creator-contact-label">MADE BY</span>
              <strong>엄지왕</strong>
              <p>
                Lightning Split을 사용하면서 궁금한 점, 불편한 점, 개선 아이디어가
                있다면 알려주십시오. 실제 지갑에서 발견한 호환성 문제 제보도
                환영합니다.
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
          <p className="creator-contact-security">
            시드 문구·개인키·비밀번호 등 지갑의 비밀정보는 보내지 마십시오.
          </p>
        </div>
      </details>
    </section>
  );
}
