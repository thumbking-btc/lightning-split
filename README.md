# Lightning Split

Lightning Split은 공동 비용을 Lightning invoice로 나누어 정산하기 위한 독립 PWA입니다. KRW를 기본 입력으로 사용하며, 익명 정산 슬롯마다 일반 Lightning Wallet이 바로 읽을 수 있는 BOLT11 QR을 생성합니다.

현재 MVP는 BTC/KRW 가격 조회, Lightning Address batch invoice 생성, LUD-21 자동 확인, IndexedDB 복구를 Cloudflare Worker 경계와 함께 제공합니다. 계정, 수탁, 서버 영구 DB는 사용하지 않습니다. `prototype.html`은 과거 Corn Wallet 제안용 참고 자료이며 실제 앱 코드와 분리하여 보존합니다.

## 개발 환경

- Node.js 22 LTS
- npm

```bash
npm install
npm run verify
```

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
