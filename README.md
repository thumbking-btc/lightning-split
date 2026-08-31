# Lightning Split

Lightning Split은 공동 비용을 Lightning invoice로 나누어 정산하기 위한 독립 PWA입니다. KRW를 기본 입력으로 사용하며, 익명 정산 슬롯마다 일반 Lightning Wallet이 바로 읽을 수 있는 BOLT11 QR을 생성합니다.

현재 MVP는 BTC/KRW 가격 조회, Lightning Address batch invoice 생성, LUD-21 자동 확인, IndexedDB 복구를 Cloudflare Worker 경계와 함께 제공합니다. 계정이나 수탁 기능은 없습니다. 응답 유실 시 같은 provider callback을 다시 호출하지 않도록 발급 결과를 요청 ID별 Durable Object에 8일간 보관하며, 정산 메모는 서버에 저장하지 않습니다. `prototype.html`은 과거 Corn Wallet 제안용 참고 자료이며 실제 앱 코드와 분리하여 보존합니다.

참가자에게는 검증된 BOLT11 QR 하나만 표시합니다. Lightning Address provider가 실제 LUD-21 `verify` URL을 반환한 결제만 자동 확인하며, 그 외 결제는 받는 지갑에서 입금을 확인한 뒤 수동으로 완료 처리합니다. 자동 확인 방식은 지갑 이름이나 provider domain allowlist가 아니라 각 invoice가 실제로 광고한 표준 capability registry에서 우선순위대로 선택합니다. 따라서 새로운 provider가 LUD-21을 지원하면 별도 provider별 코드 없이 자동 확인 경로를 사용하고, 기존 provider가 해당 capability를 중단하면 안전하게 수동 확인으로 내려갑니다. 정산 메모는 provider가 LUD-12 comment를 지원할 때 best-effort로 전달되며 payer 앱이나 payee 거래내역 표시는 보장하지 않습니다. 자세한 설계 근거는 [결제 구조 결정 문서](./docs/payment-architecture.md)와 [자동 결제 확인 표준 조사](./docs/payment-verification-standards.md)를 참고하십시오.

## 개발 환경

- Node.js 22 LTS
- npm

```bash
npm install
npm run setup:dev-secret
npm run verify
```

`setup:dev-secret`는 로컬 개발용 `VERIFICATION_TOKEN_SECRET`을 `.dev.vars`에 생성합니다. 이 파일은 Git에 포함되지 않습니다. 운영 배포 전에는 별도의 32바이트 비밀값을 Cloudflare Worker secret으로 설정하십시오.

```bash
npx wrangler secret put VERIFICATION_TOKEN_SECRET
```

invoice 생성과 settlement 조회의 공개 API 제한값은 `wrangler.jsonc`의 rate-limit binding에서 조정합니다. 참가자 상한은 20명이며, 하나의 Lightning Address discovery를 재사용하고 provider callback은 최대 3개씩 실행합니다. 재시도 안내 시간과 이 정책은 `src/config/policies.ts`에 분리되어 있습니다.

## 휴대폰에서 실행

PC와 휴대폰을 같은 Wi-Fi에 연결한 뒤 실행하십시오.

```bash
npm run preview:mobile
```

출력되는 `http://<PC의 LAN IP>:8787` 주소를 휴대폰 브라우저에서 여십시오. Windows 방화벽이 묻는 경우 현재 개인 네트워크에서만 접근을 허용하십시오. LAN HTTP에서는 앱 흐름을 시험할 수 있지만, 설치형 PWA와 Service Worker는 보안 컨텍스트가 필요합니다.

임시 HTTPS가 필요하면 다음 명령을 실행하고 Wrangler가 출력하는 `https://...trycloudflare.com` 주소를 사용하십시오. 이 URL은 명령을 실행하는 동안만 유효합니다.

```bash
npm run preview:tunnel
```

invoice 생성은 실제 Lightning provider에 요청을 보냅니다. 본인이 통제하는 Lightning Address로만 시험하고, 결제 여부는 직접 결정하십시오.
