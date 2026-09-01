# Lightning Split

Lightning Split은 공동 비용을 Lightning invoice로 나누어 정산하기 위한 독립 PWA입니다. KRW를 기본 입력으로 사용하며, 익명 정산 슬롯마다 일반 Lightning Wallet이 바로 읽을 수 있는 BOLT11 QR을 생성합니다.

현재 MVP는 BTC/KRW 가격 조회, Lightning Address batch invoice 생성, LUD-21 자동 확인, IndexedDB 복구를 Cloudflare Worker 경계와 함께 제공합니다. 계정이나 수탁 기능은 없습니다. invoice 발급은 stateless Worker에서 처리하며, 브라우저가 발급 응답을 받지 못한 경우 같은 요청을 자동 재전송하지 않습니다. Worker는 호환되는 발급 프로토콜을 명시한 클라이언트만 provider callback 전에 허용하므로, 업데이트하지 않은 PWA가 예전 재시도 방식으로 새 invoice를 만들지 못합니다. 이미 발급된 invoice의 settlement 조회는 이 발급 프로토콜 제한과 무관하게 계속 사용할 수 있습니다. 활성 정산과 발급된 invoice는 브라우저 IndexedDB에 저장하고, 정산 메모를 별도 서버 상태로 보관하지 않습니다. `prototype.html`은 과거 Corn Wallet 제안용 참고 자료이며 실제 앱 코드와 분리하여 보존합니다.

참가자에게는 검증된 BOLT11 QR 하나만 표시합니다. Lightning Address provider가 실제 LUD-21 `verify` URL을 반환한 결제만 자동 확인하며, 그 외 결제는 받는 지갑에서 입금을 확인한 뒤 수동으로 완료 처리합니다. 지갑 이름이나 provider domain은 선택 입력으로 사용하지 않습니다. 대신 각 invoice에서 실제로 확인된 자동 확인·송신자 메모·수신자 메모 증거를 `자동 확인 + 양쪽 메모 → 자동 확인 + 한쪽 메모 → 자동 확인 → 양쪽 메모 → 한쪽 메모 → QR만` 순서의 제품 capability registry에 넣어 가장 높은 단계를 선택합니다. 송신자 메모는 최종 BOLT11의 inline description에 전체 메모가 들어간 경우에만, 수신자 메모는 LUD-12 comment 전체가 callback으로 전달된 경우에만 완전 지원으로 판정합니다. 일부만 전달된 메모는 기록하되 상위 단계로 올리지 않으며, payer 앱이나 payee 거래내역의 실제 표시 여부는 보장하지 않습니다. 자세한 설계 근거는 [결제 구조 결정 문서](./docs/payment-architecture.md)와 [자동 결제 확인 표준 조사](./docs/payment-verification-standards.md)를 참고하십시오.

## 시장 정보

- BTC/KRW와 BTC/USD 가격은 화면이 보이고 온라인인 동안 공개 WebSocket으로 실시간 수신합니다. KRW 스트림은 로컬 미리보기와 운영에서 같은 동작을 보장하기 위해 동일 출처 Worker 경로를 거칩니다.
- 최초 진입, 원화·달러 화면 선택, 화면 복귀와 온라인 복구 시 해당 프리미엄을 포함한 REST 조회를 즉시 한 번 실행합니다.
- 이후 KRW·USD 프리미엄 REST 조회는 WebSocket 연결 상태와 무관하게 5분 간격으로 실행합니다. 실시간 WebSocket 가격은 프리미엄 REST 스냅샷을 임의로 다시 계산하지 않습니다. 정산 금액을 고정할 때는 최신 스냅샷을 얻기 위해 추가 조회할 수 있습니다.
- 코인베이스 프리미엄의 국제 BTC-USDT 기준가격은 Binance 공개 API를 우선 사용하고, Cloudflare 실행 위치에서 지역 제한 응답을 받으면 OKX 공개 API로 전환합니다.
- WebSocket 연결 실패 후에는 15초, 30초, 60초 간격으로 재연결하고, 60초를 상한으로 유지합니다. 정상 시세를 받으면 다음 실패의 재연결 대기를 15초부터 다시 시작합니다.
- 화면이 백그라운드로 이동하거나 기기가 오프라인이면 WebSocket과 예약된 갱신을 중지합니다.

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
