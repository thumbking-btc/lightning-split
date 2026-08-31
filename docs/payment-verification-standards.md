# 자동 결제 확인 표준 조사

기준일은 2026-08-31입니다. 이 문서는 Lightning Split이 결제 완료를 알아낼 수 있는 공개 표준과 제안을 표준 계열별로 전수 검토한 결과를 기록합니다. 지갑 이름이나 provider domain별 예외 목록은 조사·선택 기준으로 사용하지 않습니다.

## 결론

모든 Lightning 지갑을 자동 확인할 수 있는 단일 표준이나 표준 조합은 없습니다. 제3자 앱이 결제를 자동으로 알기 위해서는 다음 셋 중 적어도 하나가 필요합니다.

1. 수취 provider가 invoice 상태를 공개합니다.
2. 수취 지갑을 앱에 명시적으로 연결합니다.
3. 결제 지갑이 성공 후 preimage를 앱으로 돌려줍니다.

셋 모두 없는 raw BOLT11 결제에서는 payment hash만 아는 제3자 앱이 결제 여부를 알아낼 수 없습니다. Lightning에는 제3자가 조회할 수 있는 전역 원장이 없기 때문입니다.

현재 제품 흐름은 `Lightning Address 입력 → 앱이 invoice 발급 → 다른 기기의 일반 지갑이 raw BOLT11 QR 결제`입니다. 이 흐름을 그대로 유지하면서 적용할 수 있는 완성 표준은 LUD-21뿐입니다. 따라서 현재 production selector는 `LUD-21 → 수동 확인`이며, provider별 분기는 두지 않습니다.

## 등급 기준

| 등급 | 의미                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| A    | 현재 주소·QR 흐름을 유지하고 자동 확인할 수 있는 완성 표준                                |
| B    | 신뢰 가능한 확인이 가능하지만 지갑 연결, 동일 기기 복귀 또는 결제 방식 변경이 필요한 표준 |
| C    | 신호는 얻을 수 있으나 일반 결제 의미·증거 수준·필수 입력이 현재 제품과 맞지 않는 표준     |
| D    | 아직 병합되지 않은 제안이거나 기존 방식의 성능만 개선하는 제안                            |
| X    | 결제와 관련은 있지만 이 서비스의 invoice별 완료 확인 수단은 아닌 표준                     |

## 전수조사 결과

| 등급 | 표준·방식                                                                                                | 상태                                      | 필요한 조건                                                                             | 확인 신호                             | 현재 결정                                        |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| A    | [LUD-21 `verify`](https://github.com/lnurl/luds/blob/luds/21.md)                                         | LNURL 병합 규격, optional                 | callback이 invoice별 `verify`를 광고                                                    | `settled`, 동일 `pr`, preimage        | production 자동 확인                             |
| B    | [NIP-47 NWC](https://github.com/nostr-protocol/nips/blob/master/47.md) `make_invoice` + `lookup_invoice` | draft, optional                           | 정산자가 수취 지갑을 먼저 연결하고 해당 method 권한을 부여                              | 인증된 지갑의 상태·preimage           | 별도 연결형 기능 후보                            |
| B    | [NWC-02 `payment_received`](https://github.com/nostr-wallet-connect/nwc/blob/main/02.md)                 | draft, optional                           | NWC 연결과 notification capability                                                      | 암호화된 invoice별 수신 알림·preimage | NWC 조회의 push 보조 후보                        |
| B    | [BIP-321 `pop`/`req-pop`](https://github.com/bitcoin/bips/blob/master/bip-0321.mediawiki)                | Complete                                  | 결제 앱과 호출 앱이 같은 기기에 있고, 호출 앱이 로컬 URI handler이며, 지갑이 PoP를 지원 | BOLT11 payment preimage 반환          | 현재 교차 기기 PWA에는 부적합                    |
| B    | [WebLN `sendPayment`](https://www.webln.dev/client/send-payment)                                         | WebLN v0.3.2 API                          | payer 지갑이 현재 브라우저에 연결되고 PWA가 직접 결제를 시작                            | Promise로 preimage 반환               | QR 정산과 다른 결제 모드 후보                    |
| B    | [BOLT12 payer proof](https://github.com/lightning/bolts/blob/master/12-offer-encoding.md#payer-proofs)   | BOLT 규격                                 | BOLT12 offer/invoice와 payer proof 전달 경로                                            | preimage와 payer 서명을 포함한 proof  | Lightning Address/BOLT11 기본 흐름에는 부적합    |
| C    | [NIP-57 Zap receipt](https://github.com/nostr-protocol/nips/blob/master/57.md)                           | draft, optional                           | 실제 Nostr 수취인 `p`, Zap으로 전환한다는 명시적 사용자 선택, receipt relay             | provider 서명 receipt                 | 일반 결제의 자동 확인 fallback으로 사용하지 않음 |
| C    | BOLT11 preimage 직접 제출                                                                                | BOLT11의 암호학적 근거이나 전달 표준 없음 | payer가 preimage를 확인하고 별도 전달                                                   | `SHA256(preimage) = payment_hash`     | 자동 확인이 아니며 일반 지갑 UX가 없어 미채택    |
| D    | [LNURL 제3자 webhook PR #147](https://github.com/lnurl/luds/pull/147)                                    | draft PR, 미병합                          | payer wallet과 LNURL service가 제안을 구현                                              | 제3자 webhook                         | 표준이 될 때까지 관찰                            |
| D    | [LUD-21 long-poll PR #281](https://github.com/lnurl/luds/pull/281)                                       | open PR                                   | 기존 LUD-21 지원                                                                        | 장기 polling 응답                     | LUD-21의 지갑 범위를 늘리지 않음                 |
| D    | [LUD-21 `verifyBatch`/SSE PR #299](https://github.com/lnurl/luds/pull/299)                               | open PR                                   | 기존 LUD-21 지원                                                                        | batch 조회 또는 SSE                   | LUD-21의 지갑 범위를 늘리지 않음                 |
| D    | [BOLT12 Payment Notification 논의](https://github.com/lightning/bolts/issues/1171)                       | 논의, 규격 없음                           | 향후 규격과 구현 필요                                                                   | invoice + preimage notification 제안  | 구현하지 않음                                    |
| X    | [LUD-09/10 successAction](https://github.com/lnurl/luds/blob/luds/09.md)                                 | LNURL 병합 규격                           | payer wallet이 LNURL-pay 전체 흐름을 수행                                               | payer 화면의 message/URL/AES 결과     | 제3자 PWA로 결과를 반환하지 않음                 |
| X    | [LSPS5 webhook](https://github.com/lightning/blips/blob/master/blip-0055.md)                             | bLIP Active                               | 자체 Lightning client와 LSP 관계                                                        | 상세 없는 `payment_incoming` wake-up  | 임의 Lightning Address invoice 조회가 아님       |

LND, Core Lightning, LNbits 등 개별 node·wallet API는 앱이 해당 node나 계정에 연결되면 강력한 조회 수단이지만, 서로 호환되는 공개 확인 표준이 아닙니다. provider별 API adapter 목록을 만드는 것은 이 설계에서 제외합니다.

## 중요한 판정 근거

### BIP-321 PoP

BIP-321은 이번 조사에서 기존 문서가 놓친 실제 결제 확인 표준입니다. `bitcoin:?lightning=...&req-pop=...`를 받은 호환 지갑은 결제 후 BOLT11 preimage를 호출 앱에 반환합니다. `req-pop`을 처리할 수 없으면 결제를 시작해서는 안 되므로 실패 폐쇄도 가능합니다.

그러나 PoP URI는 로컬 설치 앱으로만 돌아가야 하며 HTTP, HTTPS 또는 웹 브라우저를 여는 scheme은 금지됩니다. 현재 Lightning Split은 정산자의 기기에서 QR을 보여 주고 다른 참가자의 기기가 스캔하는 PWA입니다. 반환값은 QR을 보여 준 정산자 기기가 아니라 payer 기기로 돌아가므로 현재 자동 확인 경로로 사용할 수 없습니다. PWA protocol handler도 브라우저 지원이 제한적이고 BIP-321의 비브라우저 요구를 보편적으로 충족하지 않습니다.

### NIP-57

`allowsNostr`와 `nostrPubkey`는 provider가 Zap invoice와 receipt를 처리할 수 있다는 capability입니다. 여기서 `nostrPubkey`는 receipt 서명키이며 Zap 수취인의 `p`가 아닙니다. NIP-57은 receipt 자체가 payment proof가 아니라고 명시합니다.

임의의 session key를 `p`에 넣으면 일반 공동비용 결제를 공개 프로토콜상 Zap으로 바꾸게 됩니다. 실제 Nostr 수취인 키와 명시적 Zap 선택이 있는 별도 모드라면 구현할 수 있지만, 주소만 입력한 일반 결제의 자동 fallback으로 조용히 적용해서는 안 됩니다.

### NWC

NWC는 provider 도메인을 분기하지 않고 wallet service가 광고한 `make_invoice`, `lookup_invoice`, notification capability를 선택할 수 있습니다. 확인 품질은 좋지만 사용자가 connection URI와 권한을 먼저 제공해야 합니다. 이는 Lightning Address만 입력하는 현재 흐름의 fallback이 아니라 별도 수취 지갑 연결 기능입니다.

## 코드 선택 규칙

1. 사용자에게 보이는 결제 흐름별로 registry를 분리합니다. 서로 다른 사전 조건을 하나의 fallback 사슬에 섞지 않습니다.
2. 각 registry 안에서는 표준 capability만 우선순위대로 평가하고 첫 번째 적격 표준에서 종료합니다.
3. provider 이름, domain, 지갑 allowlist는 selector 입력에 포함하지 않습니다.
4. 규격이 선택되면 해당 규격 전용 verifier가 invoice, payment hash, preimage 또는 서명을 검증합니다.
5. 어떤 규격도 적격하지 않거나 검증이 실패하면 자동 완료하지 않고 수동 확인으로 내려갑니다.
6. draft·미병합 제안은 문서에서 추적하되 production registry에 넣지 않습니다.

현재 주소 발급형 registry에는 LUD-21 하나만 있습니다. 목록이 짧아서가 아니라, 위 조건을 모두 통과한 production 표준만 등록하기 때문입니다. 향후 표준이 추가되면 provider 분기가 아니라 독립 adapter 하나와 capability contract test를 추가합니다.

## 조사 범위

- LNURL 병합 규격 LUD-01부터 LUD-21 및 현재 LUD-23
- Lightning BOLT11·BOLT12와 BOLT 저장소의 payment proof·notification 항목
- Bitcoin BIP-321 proof-of-payment
- Nostr NIP-47·NIP-57 및 NWC optional specification 전체
- Lightning bLIP의 payment/webhook 항목
- WebLN 결제 API
- LNURL 및 BOLT 저장소의 공개 미병합 payment notification·verification 제안

새 규격을 검토할 때는 이 문서의 기준일과 조사 범위를 갱신하고, 병합 상태와 실제 capability discovery를 다시 확인합니다.
