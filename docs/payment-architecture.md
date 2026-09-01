# 결제 구조 결정

기준일은 2026-09-01입니다. 이 문서는 Lightning Split의 일반 공동비용 정산 경로와 자동 확인의 신뢰 경계를 정의합니다.

결제 확인 규격의 전체 등급과 적용 경계는 [자동 결제 확인 표준 조사](./payment-verification-standards.md)에 기록합니다.

## 최종 구조

1. 정산자가 자신의 Lightning Address를 입력합니다.
2. Worker는 LUD-16/LUD-06 discovery를 한 번 수행합니다.
3. 참가자별 고정 금액 invoice callback을 최대 3개씩 병렬 호출합니다.
4. 반환된 BOLT11의 network, signature, amount, expiry와 payment hash를 검증합니다.
5. 참가자에게는 해당 BOLT11 하나만 QR로 표시합니다. QR 데이터는 BOLT11 권고에 따라 uppercase로 인코딩하고, 복사 문자열은 canonical lowercase를 유지합니다.
6. 최종 invoice에서 실제로 확인된 자동 확인·송신자 메모·수신자 메모 증거를 제품 capability registry에 넣어 여섯 단계 중 가장 높은 단계를 선택합니다.
7. callback이 실제 LUD-21 `verify` URL을 반환하면 그 invoice에 한해서 자동 확인합니다. `pr`와 payment preimage/payment-hash 일치를 모두 검증합니다.
8. LUD-21이 없으면 자동 완료로 보고하지 않습니다. 정산자가 받는 지갑을 직접 확인한 뒤 수동 완료로 표시합니다.

## 제품 capability 체

| 우선순위 | 필요한 기능                                 |
| -------- | ------------------------------------------- |
| 1        | QR + 자동 확인 + 송신자 메모 + 수신자 메모  |
| 2        | QR + 자동 확인 + 송신자·수신자 중 한쪽 메모 |
| 3        | QR + 자동 확인                              |
| 4        | QR + 송신자 메모 + 수신자 메모              |
| 5        | QR + 송신자·수신자 중 한쪽 메모             |
| 6        | QR만 제공하고 수동 확인                     |

송신자 메모와 수신자 메모 사이에는 별도 우선순위를 두지 않습니다. 자동 확인 여부를 가장 먼저 비교하고, 같은 자동 확인 수준 안에서 완전하게 전달된 메모 수만 비교합니다. `partial`은 사용자에게 사실대로 표시하고 저장하지만 완전한 메모로 세지 않습니다.

이 체는 주소나 지갑 이름으로 경로를 정하지 않습니다. invoice 발급이 끝난 뒤 실제 응답과 검증된 BOLT11에 남은 증거만으로 단계가 결정됩니다. 현재 주소 발급 흐름의 자동 확인 adapter는 LUD-21 하나이며, 새로운 공개 규격을 추가할 때에는 같은 증거 형식으로 변환하는 독립 adapter를 추가합니다.

## 검토한 대안

| 구조                                    | wallet·QR                                  | payer/payee UX                                                                  | 자동 확인·메모                                                                                       | 보안·종속성·복잡도                                                                                    | 결론                  |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| 앱이 선발급한 raw BOLT11                | 일반 invoice 지원 wallet, 고정 금액 QR 1개 | payer는 스캔 후 결제, payee는 주소만 입력                                       | provider가 LUD-21을 줄 때만 자동 확인, comment와 invoice 설명 표시는 provider/wallet별 best-effort   | 앱이 invoice를 검증하며 provider callback에 의존하지만 payer 권한은 받지 않음, 가장 단순              | 채택                  |
| payer가 recipient LNURL-pay를 직접 수행 | LNURL-pay wallet, QR 1개                   | payer wallet이 금액·metadata 흐름을 맡지만 앱이 정한 고정 금액 이탈 가능성 있음 | payer 설명 전달은 유리하나 앱은 발급 invoice와 settlement를 안정적으로 연결할 수 없음                | provider 직접 통신으로 앱 책임은 작지만 wallet capability에 의존                                      | 미채택                |
| Lightning Split LNURL proxy             | LNURL-pay wallet, QR 1개                   | 중간 callback이 추가되어 실패·재사용 상태가 늘어남                              | metadata 제어는 가능하나 payee 메모·settlement 증명을 새로 만들지는 못함                             | 공개 callback, 상태 수명, SSRF·재사용 방어가 추가되고 일반 wallet 호환 이득은 불확실                  | 제거                  |
| BIP-321 wrapper + `pop`                 | BIP-321 parser·PoP 지원 wallet, QR 1개     | 동일 기기의 로컬 호출 앱으로 BOLT11 preimage를 돌려줄 수 있음                   | `req-pop`은 강한 payment proof와 실패 폐쇄를 제공하지만 다른 기기에서 QR을 보여 주는 PWA로 복귀 불가 | HTTP(S)·브라우저 callback이 금지되고 설치형 URI handler와 wallet 지원이 필요                          | 현재 흐름에서 제거    |
| BOLT12 Offer                            | BOLT12 지원 payer/payee 필요, QR 1개 가능  | 반복 수취에는 좋지만 주소만 입력하는 현재 payee 흐름으로 생성 불가              | Offer/Invoice 경로의 기능은 있으나 기존 Lightning Address provider 관측과 별개                       | 양쪽 capability와 별도 키·프로토콜 처리가 필요                                                        | 미채택                |
| receiver wallet LUD-21                  | payer QR에는 변화 없음                     | 지원 provider에서는 payee가 별도 확인할 필요가 줄어듦                           | matching invoice·preimage가 있을 때 provider settlement attestation 가능                             | provider 독립 증명이 아니며 callback이 실제 `verify`를 반환한 invoice에만 사용, 보조 기능으로 단순    | 조건부 채택           |
| receiver wallet NWC                     | payer QR은 BOLT11 1개 유지 가능            | payee가 먼저 wallet 연결·권한을 승인해야 함                                     | `make_invoice`/`lookup_invoice`, NWC-02 `payment_received`로 자동 확인 가능                          | relay, 연결 secret, 최소 권한·취소·보관 설계가 필요하고 특정 wallet capability에 의존                 | 향후 명시적 고급 기능 |
| NIP-57 Zap                              | Zap 지원 wallet/relay 의미가 추가됨        | 일반 공동비용이 Zap으로 표시되어 payer 의미가 왜곡됨                            | receipt가 있어도 provider 독립 payment proof가 아니며 일반 결제 메모 대체가 아님                     | 실제 Nostr 수취인 `p`가 필요하고 ephemeral alias는 부적합, relay·서명·provider capability 의존성이 큼 | 제거                  |

## NIP-57 제거 결정

NIP-57의 Zap request `p` 태그는 실제 Nostr 수취인 공개키입니다. Lightning Address에는 이를 얻는 표준 매핑이 없으며 provider의 `nostrPubkey`는 Zap receipt 서명키이지 수취인 키가 아닙니다. `allowsNostr`도 provider capability일 뿐 일반 결제를 Zap으로 전환하는 사용자 의사가 아닙니다.

이전 구현은 임의의 ephemeral recipient alias를 만들고 provider receipt를 정산 근거로 사용했습니다. 이는 지갑에서 Zap으로 표시되는 의미와도 일치하지 않으며, NIP-57 receipt는 독립적인 payment proof가 아닙니다. 따라서 NIP-57 코드, relay endpoint, receipt Durable Object와 선택형 Zap/BIP-321/LNURL QR을 모두 제거했습니다.

## 메모 의미

- 정산 메모는 provider가 `commentAllowed`를 제공할 때 LUD-12 comment로 callback에 전달합니다.
- 이 경로는 주로 payee/provider 기록을 위한 best-effort 신호입니다.
- 제품 capability 판정에서 수신자 메모 `full`은 LUD-12 comment 전체가 실제 callback 요청에 포함된 경우를 뜻합니다. provider나 받는 지갑의 거래내역 표시를 보증한다는 뜻은 아닙니다.
- 최신 LUD-06은 callback invoice에서 요청 금액 일치를 검증하도록 요구하며 metadata hash를 강제하지 않습니다. 앱은 BOLT11 금액·서명·만료를 검증하되 유효한 inline `d`와 `h`를 모두 허용합니다.
- 제품 capability 판정에서 송신자 메모 `full`은 요청한 전체 메모와 정확히 같은 inline `d`가 최종 BOLT11에 들어간 경우만 뜻합니다. `h`나 다른 설명을 보고 송신자 메모 지원을 추정하지 않습니다.
- provider가 `h`를 사용하면 이는 원문이 아닌 hash입니다. 앱이 LNURL을 대신 수행한 뒤 raw BOLT11만 전달하므로 payer wallet은 원래 LNURL metadata의 사람이 읽는 설명을 복원할 수 없습니다.
- payer 거래내역과 payee 거래내역의 표시 여부는 wallet/provider 구현마다 다르며 제품이 보장하지 않습니다.
- 메모를 위해 추가 QR이나 결제 rail을 만들지 않습니다.

## LNURL 확장 처리

- LUD-09 `successAction`: raw invoice만 스캔한 payer가 결제 후 동작을 보존할 수 없으므로 해당 invoice를 표시하지 않고 실패 처리합니다.
- LUD-11 `disposable`: discovery 응답을 batch에서 한 번 재사용하는 판단과 invoice 재사용을 구분합니다. 참가자마다 callback을 새로 호출하고 invoice/hash 중복을 거부합니다.
- LUD-12 `commentAllowed`: 지원 범위 안에서 메모를 전달하며 provider 한도를 넘으면 Unicode code point 기준으로 잘라 부분 전달로 기록합니다.
- LUD-18 `payerData`: 필수 payer 정보가 있으면 주소만으로 충족할 수 없으므로 실패 폐쇄합니다. 선택 정보는 임의로 꾸며 보내지 않습니다.
- LUD-20 metadata: provider metadata는 discovery 검증에 사용하지만 raw invoice만 받은 payer wallet에 이미지·긴 설명을 별도 전달하지 않습니다.
- LUD-21 `verify`: HTTPS URL을 밀봉된 invoice별 token으로 보관하고, 일치하는 `pr`, `settled=true`, 32-byte preimage와 payment hash가 모두 맞을 때만 자동 완료합니다.

## 자동 확인과 증거 수준

| 화면 상태      | 근거                                                                                                 | 보장하지 않는 것              |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| 자동 결제 완료 | 해당 callback이 제공한 LUD-21 응답의 matching `pr`, `settled=true`, payment hash와 일치하는 preimage | 실제 payer의 신원             |
| 사용자 확인    | 정산자가 받는 지갑을 직접 확인하고 표시                                                              | 네트워크에서 독립 검증된 상태 |
| 결제 대기      | 아직 matching settlement evidence 없음                                                               | 미결제 확정                   |

LUD-21은 recipient provider의 settlement attestation을 조회하는 경로입니다. 앱은 공식 응답 예시처럼 일치하는 payment preimage까지 요구하여 응답과 invoice의 일관성을 확인하지만, invoice 발급 provider도 원래 preimage를 알기 때문에 이는 provider와 독립된 결제 증명은 아닙니다. 현재 UI는 출금자의 신원을 자동 추론하지 않습니다.

## 인원·부하 정책

- 제품 상한: 전체 20명
- 주소 discovery: batch당 1회
- 동일 provider callback 동시성: 최대 3
- invoice API: Cloudflare rate-limit binding 기준 IP별 30 batch/분
- settlement API: IP별 300회/분
- QR 생성: 현재 카드와 양옆 카드만 활성화
- 허용 invoice 잔여 수명: 최대 24시간; 재발급 전후 invoice 이력은 브라우저에서 7일간 보관

20명은 Lightning protocol 한계가 아니라 모바일 carousel 탐색, 최대 20개의 payable invoice 관리, callback 지연을 함께 고려한 제품 상한입니다. 상향하려면 목록 탐색/virtualization과 provider-domain별 quota를 먼저 재검증해야 합니다.

## 발급 실패와 저장 경계

invoice 발급 API는 서버에 replay 상태를 저장하지 않는 stateless 경로입니다. `requestId`는 이전 클라이언트와의 요청 형식 호환을 위해 남겨 두지만 Worker가 같은 ID의 과거 응답을 보관하거나 재생하지 않습니다.

클라이언트는 invoice 발급 요청에 현재 발급 프로토콜 번호를 함께 보냅니다. Worker는 번호가 없거나 지원하지 않는 요청을 provider discovery와 callback 전에 `CLIENT_UPGRADE_REQUIRED`로 거절합니다. 이 제한은 새 payable invoice 생성에만 적용하며, 이미 발급된 invoice의 settlement 조회는 구버전 클라이언트에서도 계속 허용합니다. 운영 PWA는 새 배포를 자동 감지하되 사용자가 업데이트 버튼을 눌러 안전한 시점에 새 Service Worker를 활성화합니다.

브라우저가 `/api/invoices`의 응답을 받지 못한 네트워크 수준 실패는 발급 결과가 불명확하므로 자동 재전송하지 않습니다. 클라이언트는 이를 `ISSUANCE_UNKNOWN`으로 처리하고, 정산자가 받는 지갑의 상태를 확인한 뒤 새 정산을 시작하도록 안내합니다. 반대로 Worker가 provider discovery 또는 callback의 명시적 실패 응답을 정상적으로 돌려준 경우에는 해당 실패 원인과 retryable 여부를 화면에 반영합니다.

정상적으로 받은 BOLT11은 즉시 QR로 노출하지 않습니다. 먼저 브라우저 IndexedDB에 저장할 때까지 `awaitingPersistence` 상태로 유지하고, 저장이 성공한 invoice만 결제 QR로 표시합니다. 저장에 실패하면 해당 invoice는 화면에 표시하지 않고 실패 상태로 전환합니다.

활성 정산 UI 상태, 참여자 이름, 발급된 invoice와 payment hash, 재발급 이력은 브라우저 IndexedDB에 저장합니다. IndexedDB v2는 revision compare-and-swap으로 저장과 삭제를 보호하며, 오래 열린 탭이 다른 탭의 최신 정산을 덮어쓰거나 삭제하려 하면 최신 상태를 다시 불러옵니다. 재발급 전후 invoice의 자동·수동 완료 근거는 7일간 이력에 남겨 지연 결제가 겹치면 이중 입금 가능성을 경고합니다.

이 구조는 provider callback 자체의 exactly-once 발급을 보장하지 않습니다. 응답 유실이나 provider 내부 동작 때문에 화면에 노출되지 않은 미결제 invoice가 남을 수 있으므로, 자동 재전송보다 명시적인 실패 폐쇄를 선택합니다. Lightning Split은 해당 invoice를 자동 결제하지 않으며 사용자가 확인하지 못한 invoice를 QR로 노출하지 않습니다.

## 규격 근거

- BOLT11: <https://github.com/lightning/bolts/blob/master/11-payment-encoding.md>
- BOLT12: <https://github.com/lightning/bolts/blob/master/12-offer-encoding.md>
- LUD-06/09/11/12/16/18/20/21: <https://github.com/lnurl/luds/tree/luds>
- BIP-321: <https://github.com/bitcoin/bips/blob/master/bip-0321.mediawiki>
- NIP-47/NWC: <https://github.com/nostr-protocol/nips/blob/master/47.md>
- NWC-02 notifications: <https://github.com/nostr-wallet-connect/nwc/blob/main/02.md>
- NIP-57: <https://github.com/nostr-protocol/nips/blob/master/57.md>

## 실결제가 필요한 검증

코드와 무자금 invoice 발급으로는 BOLT11 검증, callback 접근, LUD-21 capability와 초기 `settled=false`까지만 확인할 수 있습니다. 다음은 실제 최소 금액 결제가 있어야 확인할 수 있습니다.

- payer wallet의 QR 인식과 결제 성공
- 결제 후 LUD-21 `settled=false → true` 전환과 실제 지연
- payer/payee 거래내역의 메모 표시
- 만료·재발급 경계의 late payment
- 여러 참가자의 실제 동시 결제
