# Lightning Split 작업 지침

이 문서는 저장소 전체에 적용됩니다.

## 프로젝트 탐색

- 이 프로젝트는 Node.js 22와 npm을 사용합니다. `src/`에는 React·TypeScript·Vite 기반 PWA와 도메인 로직이 있고, `worker/`에는 Cloudflare Worker API가 있습니다. 브라우저 상태는 IndexedDB를 사용합니다.
- GitHub 원격 저장소를 기준(source of truth)으로 삼고, 로컬 파일이나 worktree는 GitHub에서 체크아웃한 작업 사본으로만 취급하십시오. 현재 브랜치·원격 상태·`main`·열린 PR을 먼저 확인한 뒤 작업하십시오.
- Cloudflare 리소스는 현재 저장소 설정을 직접 확인해 판단하십시오. 과거에 Durable Object·KV·D1·R2를 사용했다는 이유만으로 현재도 사용한다고 가정하지 마십시오.
- 변경 전에는 `README.md`, `package.json`, 관련 소스와 인접 테스트, 해당 경로의 설정을 먼저 확인하십시오. 결제·invoice·정산 구조를 바꾸는 경우 `docs/payment-architecture.md`와 `docs/payment-verification-standards.md`도 확인하십시오.
- `prototype.html`은 실제 앱과 분리하여 보존하는 과거 참고 자료이며, `public/sw.js`는 기존 서비스 워커의 전환 경로입니다. 사용되지 않는 파일로 단정하여 삭제하거나 용도를 바꾸지 마십시오.

## 브랜치와 운영

- `main`은 production 브랜치입니다. 사용자의 명시적 승인 없이 `main`을 직접 수정하거나 `main`으로 merge하거나 `main`을 push하지 마십시오.
- 개발 작업은 최신 원격 `main`에서 별도 `feature/*` 브랜치를 만들거나, 이미 승인된 해당 feature 브랜치를 사용하여 수행하십시오.
- 사용자가 feature 개발·수정을 요청한 경우 그 feature 브랜치의 commit·push는 작업의 정상적인 일부로 간주합니다. 의미 있는 변경 단위마다 이유가 남는 commit을 만들고 GitHub에 push하여, 중요한 작업을 장시간 로컬에만 보관하지 마십시오. 같은 feature 작업에 대해 commit·push 승인을 매번 다시 요구하지 마십시오.
- 사용자의 명시적 승인이 필요한 것은 `main` 수정·merge·push와 메인 production Worker 배포입니다.
- feature 브랜치가 작업 중 최신 `main`보다 뒤처지면 Preview 또는 최종 병합 판단 전에 최신 `main`의 변경을 feature에 통합하고, 충돌 여부와 회귀를 다시 검증하십시오. 기존 `main`의 변경을 feature 전체로 덮어쓰지 마십시오.
- 휴대폰에서 확인할 수 있어야 하는 앱 변경은 가능한 경우 현재 feature 브랜치의 Cloudflare Preview URL을 사용하십시오. Preview가 기술적으로 불가능할 때만 원인을 확인한 뒤 격리된 임시 Preview 방식을 사용하십시오.
- 프리뷰 Worker 배포는 production 배포로 간주하지 않습니다. 검증을 마친 뒤 실제로 열린다는 것을 확인한 프리뷰 PWA 링크를 사용자에게 제공하십시오. 사용자가 프리뷰 배포를 하지 말라고 명시한 경우에만 생략하십시오.

## 변경 원칙

- 정상 동작하는 코드를 단순한 취향이나 “더 현대적인 구조”라는 이유로 대규모 리팩터링하지 마십시오.
- 변경은 가능한 한 작고 독립적으로 수행하고 관련 없는 정리나 개선을 섞지 마십시오.
- 기존 동작, 사용자 자산 또는 저장 데이터에 영향을 줄 수 있는 변경은 특히 보수적으로 다루십시오. 사용자에게 보이는 동작이나 API·저장 데이터·QR·결제 데이터 형식을 바꿀 때는 기존 호환성과 회귀 가능성을 검토하십시오.
- 문제 해결에 현재 프로젝트 규모상 불필요한 엔터프라이즈급 인프라나 과잉설계를 도입하지 마십시오.
- 변경과 관련 없는 기존 실패를 발견하면 임의로 함께 수정하지 말고 별도로 보고하십시오.

## 금전 및 보안 안전성

이 프로젝트는 Bitcoin·Lightning과 금전적 가치를 다룰 수 있습니다. 다음 영역의 정확성, 경계값, 실패 경로 및 기존 동작을 특히 엄격하게 확인하십시오.

- 금액 및 단위 변환
- sats·BTC·법정화폐 처리
- Lightning invoice 및 Lightning Address
- 결제 상태 판정
- 정산 계산
- QR 및 결제 데이터
- 지갑·키·복구정보 등 민감정보가 존재하거나 새로 다루게 되는 경우 그 저장·전송·표시

그 밖에 다음 안전 규칙을 지키십시오.

- 비밀키, mnemonic, seed, API secret, token 또는 실제 사용자 자격 증명을 코드, 로그, 테스트 fixture, 문서에 실제 값으로 추가하지 마십시오.
- 외부 가격 API, Lightning provider와 서비스, Cloudflare 등의 응답을 무조건 신뢰하지 마십시오. 실패, 지연, timeout, 잘못된 형식이나 값, 불일치 및 재시도에 따른 중복 가능성을 고려하십시오.
- PWA 변경 시 캐시, 서비스 워커 수명주기, 업데이트와 오프라인 동작, 기존 사용자의 오래된 클라이언트와 새 배포의 조합을 검토하십시오.
- Cloudflare Workers 또는 상태 저장 리소스를 변경할 때는 상태와 영속 데이터, migration 필요 여부 및 기존 배포와의 호환성을 확인하십시오.

## 검증

변경 범위와 위험도에 맞춰 프로젝트에 이미 정의된 명령을 우선 사용하십시오.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:worker
npm run build
```

필요한 경우 최종 통합 검증으로 `npm run verify`를 사용하십시오. 새 기능을 추가했다면 해당 기능의 정상 경로뿐 아니라 실패·만료·재시도·복구·호환 경로를 검증하는 테스트도 함께 추가하십시오. 테스트 통과만으로 변경이 옳다고 단정하지 말고 관련 실제 사용자 흐름과 회귀 가능성도 검토하십시오.

## 적대적 감사 프로토콜

향후 `docs/audit/ADVERSARIAL_AUDIT.md`가 존재하더라도 일반적인 개발 작업에는 자동으로 읽거나 전체 프로토콜을 적용하지 마십시오. 사용자가 “적대적 감사”, “전수 감사”, “가혹한 감사” 또는 이에 준하는 감사를 명시적으로 요청한 경우에만 해당 문서를 읽고 적용하십시오.
