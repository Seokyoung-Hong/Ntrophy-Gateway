# NovemberAiGateway 기능 명세 (PoC)

전제(초기 계획): LiteLLM 포크, Mock Provider 사용, 마감 04:00. **실제 구현은 LiteLLM 없이 FastAPI 자체 구현**(`requirements.txt`: fastapi·uvicorn·httpx·cryptography). 현재 동작의 원본은 `contract.md`이며, 본문과 다르면 문서 끝 "구현 반영 사항"과 `contract.md`가 우선. 시나리오는 `demo-scenario.md`, 데이터는 `erd.md` 참조.
미확정 항목(문서 6절)은 **권장안으로 가정**했고 `[가정]`으로 표시한다.

우선순위: **P0** = 데모 필수 / **P1** = 있으면 좋음 / **P2** = 시간 남으면.

## 1. 기능 목록

| ID | 기능 | 우선순위 | 시나리오 장면 |
|---|---|---|---|
| F1 | 공급자 크레덴셜 등록(API Key / WIF / 예비키) | P0 | 1 |
| F2 | 무단 사용 한도 설정(허용 무단 호출 수) | P0 | 1 |
| F3 | 허용 IP 대역(CIDR) 관리 | P0 | 1 |
| F4 | 사용자 게이트웨이 토큰 발급·폐기 | P0 | 1 |
| F5 | 요청 중계 + 접근 통제(IP+토큰) | P0 | 2 |
| F6 | 게이트웨이 사용량 기록(원화 비용) | P0 | 2 |
| F7 | 공급자 사용량 수집(1초 주기) | P0 | 2, 4 |
| F8 | 사용량 대조·위험도 판정 | P0 | 4, 5 |
| F9 | 자동 대응(폐기→예비키 승격→통보) | P0 | 5, 6 |
| F10 | 사고 기록·타임라인 | P0 | 5, 6 |
| F11 | 대시보드 조회 API | P0 | 전체 |
| F12 | 공격 시뮬레이터(데모 전용) | P0 | 4 |
| F13 | Mock Provider | P0 | 전체 |
| F14 | 데모 리셋·시드 | P1 | 준비 |
| F15 | 허니키 탐지 | P2 | 2 말미 |

## 2. 기능별 명세

### F1 크레덴셜 등록
- 입력: `provider`, `auth_mode`(`API_KEY`|`WIF`), `role`(`PRIMARY`|`STANDBY`), API Key 원문(API_KEY일 때) 또는 `audience`(WIF일 때). (`trusted_identity`는 공급자 크레덴셜이 아니라 사용자 측 WIF 신뢰 규칙, contract J절)
- API Key는 **암호화 저장**(PoC: Fernet 대칭키, 키는 환경변수). 응답·로그에는 마스킹(`sk-...a9f2`)만.
- WIF: 장기 키를 저장하지 않는다. 호출 시 Mock STS에서 **15분 단기 토큰**을 발급·캐시하고 만료 전 갱신.
- 프로바이더당 PRIMARY는 최대 1개(ACTIVE).
- 수용 기준: 등록 후 목록에서 원문이 어디에도 보이지 않는다.

### F2 한도 설정
- 판정 기준 값 `unauthorized_call_limit`(허용하는 '설명되지 않는 호출 수', 기본 100). 대표가 수정 가능. 변경은 다음 워커 틱(≤1초)부터 판정에 반영.
- `loss_limit_krw`(기본 100,000)는 참고 표시용으로만 남는다(판정에 안 씀).
- 경고/차단 비율은 상수(`WARN=0.5`, `BLOCK=0.7`, `SUSPECT=0.1`, Mock 기준). 실제 공급자(OpenRouter·OpenAI)는 0.2/0.35/0.05(`contract.RATIOS`).
- 허용 오차 `TOLERANCE_CALLS=3`건(진행 중 요청·집계 지연 흡수).

### F3 허용 IP 대역
- CRUD: `cidr`, `label`(`INTERNAL`|`VPN`). 예: `10.0.0.0/16`, `10.8.0.0/24`, `*`.
- 대역이 0개이면 모두 허용(기본값, 리셋 직후 상태). 하나라도 등록하면 그 대역만 허용. `*`(또는 `0.0.0.0/0`·`::/0`)는 전체 허용. 대시보드 `ip_policy`(`open`|`restricted`)로 표시.

### F4 사용자 토큰
- 사용자(서비스)별 토큰 발급. 원문은 **발급 시 1회만** 노출, 저장은 해시.
- 폐기(REVOKE) 시 즉시 무효.
- 구현: LiteLLM 없이 자체 테이블 `gateway_token`(SHA-256 해시, `nvm-` 접두 토큰).

### F5 요청 중계 + 접근 통제
- 엔드포인트: `POST /v1/chat/completions`(OpenAI 호환, 스트리밍 포함).
- 검사 순서(구현): ⓪ 허니키 일치(401 위장, 전체 토큰 폐기·서비스 정지) → ① 출발 IP ∈ 허용 대역(대역 0개면 통과) → ② 토큰 유효(또는 WIF JWT) → ③ 서비스 상태 ACTIVE → 통과 시 현재 PRIMARY 크레덴셜로 공급자에 중계(없으면 503).
- 실패: `403`(IP·차단 IP·정지 서비스) / `401`(토큰·WIF) / `503`(PRIMARY 없음, 로그 없음). 거부를 `access_denied` 로그(시각, 출발 IP, 사유, 토큰 마스킹)로 기록.
- 크레덴셜 전환(F9) 중에도 사용자는 같은 토큰으로 계속 호출 가능해야 한다.

### F6 게이트웨이 사용량 기록
- 호출마다 `usage_log`: service, credential, model, input/output 토큰, **cost_krw**, status, 시각.
- 비용 = `total_tokens × 0.4원`(Mock 단가, 데모 상수). Mock Provider와 **동일 공식**이어야 대조가 맞는다. (실제 공급자는 응답 `usage.cost` 또는 토큰×단가, 판정은 호출 수라 비용 공식 차이가 판정에 영향 없음)

### F7 공급자 사용량 수집
- 1초(`POLL_INTERVAL_S`)마다 Mock Provider `GET /usage?owner=<provider_ref>`를 호출, 크레덴셜별 누적 `cost_krw`·`tokens`·`requests`를 `provider_usage`에 적재.
- Mock은 **집계 지연 2초**(`MOCK_USAGE_LAG_S`)를 흉내 낸다.

### F8 대조·판정
- 원리: 게이트웨이가 기록한 호출 수와 공급자가 보고한 호출 수를 비교한다. 게이트웨이가 모르는 호출이 있으면 그 키를 다른 누군가가 쓴 것이다.
- 크레덴셜별로 `diff_calls = provider_calls − gateway_calls − TOLERANCE_CALLS`(누적, 0 미만은 0). 금액 차액(`diff_krw`)은 참고 표시만.
- 판정표(한도 L = `unauthorized_call_limit` 호출 수):

| diff_calls | 상태 | 동작 |
|---|---|---|
| < 0.1L | NORMAL | 없음 |
| ≥ 0.1L | SUSPECT | 상태 배지 노랑 |
| ≥ 0.5L | WARNING | 경고 알림 이벤트 |
| ≥ 0.7L | BREACH | F9 자동 대응 |

- (구현) `reconciliation` 테이블·`risk_score`는 없다. 판정 변화는 `event`(SUSPECT/WARNING/BLOCKED)와 `incident`로만 남는다.
- 이미 REVOKED인 크레덴셜은 대조하지 않는다.
- 차단선 0.7L 이유: 차단 뒤에도 집계 지연(2초)+폴링(2초) 동안 들어온 호출이 뒤늦게 잡힌다(5건/초 기준 약 15~20건). L=100이면 최종 < L 유지. L이 작으면(예 30) 최종이 L을 넘을 수 있다.

### F9 자동 대응
BREACH 시 아래를 **순서대로** 수행하고 각 단계를 사고 타임라인에 시각과 함께 기록.
0. (구현) 사고 `INCIDENT` 생성(`OPEN`, timeline `DETECTED`).
1. 공급자 폐기(Mock `POST /revoke {owner}`) → 크레덴셜 `REVOKED`.
2. STANDBY → PRIMARY 승격 (`replaced_by_id` 기록). STANDBY가 없으면 timeline `PROMOTE_STANDBY`를 ok=false("예비 키 없음")로 기록, 사고는 OPEN·대시보드 BLOCKED 유지(별도 `NO_STANDBY` 상태값은 없음).
3. 사고 상태 `ROTATED`(생성은 0단계, 갱신 없음).
4. 관리자 통보(이벤트 + 대시보드 배너). 외부 채널은 P2.
5. 승격 키로 호출 성공을 한 번 확인하면 `RESOLVED`(복구).
- 멱등: 같은 크레덴셜에 대해 사고는 1개만 생성.
- WIF 크레덴셜: 폐기 = Mock에서 owner `wif:<audience>` 폐기(이후 STS 발급·기존 토큰 모두 401) + 게이트웨이 STS 토큰 캐시는 다음 401 시 파기.

### F10 사고 기록
- 사고 상세: 탐지 시각, 차단 시각, 소요 초, 손실 호출 수 `loss_calls`(차단 시점 diff_calls, 폐기 후 최종값으로 재계산), 한도 `limit_calls`, 참고 금액 `loss_krw`/`limit_krw`, 폐기 키, 전환 키, 타임라인(단계, 시각, 결과).
- 상태: `OPEN → ROTATED → RESOLVED`.

### F11 대시보드 API (프론트 계약)
폴링 1~2초. JSON.

| 메서드·경로 | 용도 |
|---|---|
| `GET/POST /admin/credentials`, `DELETE /admin/credentials/{id}` | F1 |
| `GET/PUT /admin/settings` | F2 (`unauthorized_call_limit`, 참고 `loss_limit_krw`) |
| `GET/POST/DELETE /admin/cidrs` | F3 |
| `POST /admin/tokens`, `DELETE /admin/tokens/{id}`, 목록은 `GET /admin/services` | F4 |
| `GET /admin/dashboard` | 현재 상태, 차액, 한도, 크레덴셜별 gateway/provider 누적 |
| `GET /admin/timeseries?range=300` | 두 선 차트용 시계열(range 초 단위, 2초 버킷) |
| `GET /admin/access-denied?limit=20` | 최근 거부 로그 |
| `GET /admin/incidents`, `GET /admin/incidents/{id}` | F10 |
| `GET /admin/events?since_id=` | 경고·차단 알림 토스트용 |

- 대시보드 응답 핵심 필드: `status`(NORMAL/SUSPECT/WARNING/BLOCKED/RECOVERED), `diff_calls`, `limit_calls`, `warn_at_calls`, `block_at_calls`, `gateway_calls`, `provider_calls`, `active_credential`. 금액(`diff_krw`, `limit_krw`, `*_cost_krw`)은 참고. 상세는 `docs/contract.md` D절.
- 관리자 인증: 고정 `X-Admin-Key` 헤더 1개(환경변수 `ADMIN_KEY`, 기본 `admin`).

### F12 공격 시뮬레이터 (데모 전용)
- `POST /demo/attack/start`·`/stop`: 서버 내부 백그라운드 작업이 **K1으로 Mock Provider에 직접** 초당 5회 × 800원 호출(게이트웨이를 거치지 않음). `[가정: 대표 버튼 클릭 트리거]`
- 중지 조건: 사용자가 stop, 또는 호출이 401(키 폐기)을 받으면 자동 종료하고 "공격 차단됨 401" 이벤트 발생.
- (구현) `/demo/attack/*`·`/demo/reset*`는 `DEMO_MODE`와 무관하게 항상 등록된다. `DEMO_MODE`는 `X-Demo-Source-IP`와 로컬 IdP(`/idp/*`, `/demo/wif/*`)만 켠다. 공개 모드에서는 `/demo/*`에 관리자 키 필요. Mock 전용(실제 공급자 모드에서는 효과 없음).

### F13 Mock Provider
OpenAI 호환 별도 프로세스(포트 분리).

| 경로 | 동작 |
|---|---|
| `POST /v1/chat/completions` | 키 검증 후 가짜 응답. `usage.total_tokens`와 비용 누적. 폐기 키는 401 |
| `GET /usage?owner=` | owner별 누적 비용·토큰·호출 수(집계 지연 2초 반영) |
| `POST /revoke` `{owner}` | 키 폐기 |
| `POST /sts/token` | WIF용 15분 단기 토큰 발급 |
- 요청 토큰 수는 요청 본문의 `max_tokens`(없으면 300)를 따른다 → 공격자는 2,000 토큰(=800원)으로 호출.

### F14 데모 리셋·시드 (P1)
- `POST /demo/reset`: DB 전체(WIF 신뢰 규칙 포함)·Mock 상태 초기화, K1(PRIMARY)·S1(STANDBY)·K2(WIF STANDBY)·사용자 토큰 2개·허니키 2개 시드. 리허설 반복용(contract D절).

### F15 허니키 (P2)
- 게이트웨이에 가짜 토큰/키 N개를 심어 두고, 그 값으로 접근하면 `honeykey_event` + 사고(trigger=HONEYKEY) 생성. 데모에서는 10초 장면.

## 3. 상태 머신 (대시보드 표시)

```
NORMAL → SUSPECT → WARNING → BLOCKED → RECOVERED → NORMAL
   ↑___________(diff 감소 시 10초 히스테리시스 후 하강, RECOVERED는 10초 후 NORMAL)
```
- BLOCKED는 BREACH 처리 시작~승격 확인 전(사고 OPEN·ROTATED), RECOVERED는 승격 키 호출 성공(RESOLVED) 후 10초. 예비 키가 없으면 리셋 전까지 BLOCKED.

## 4. 데이터 보강 (ERD 반영)
- `ALLOWED_CIDR(id, cidr, label)`, `SETTING(key, value)` 추가.
- `ACCESS_DENIED_LOG(id, source_ip, reason, token_masked, at)` 추가(`USAGE_LOG`와 분리).
- `INCIDENT`에 `loss_krw`, `limit_krw`, `loss_calls`, `limit_calls`, `timeline(JSON)` 추가. 이후 `PROVIDER_USAGE.requests`, `TRUSTED_IDENTITY` 추가(erd.md).

## 5. 구현 매핑 (병렬 분할 안)
| 트랙 | 범위 | 의존 |
|---|---|---|
| A Mock Provider | F13 | 없음(먼저 시작) |
| B 게이트웨이 코어 | F1, F3~F6 (계획: LiteLLM 활용 → 실제: 자체 구현) | A와 계약만 합의 |
| C 탐지·대응 워커 | F7~F10, F12 | A, B의 `usage_log` 스키마 |
| D 관리자 API | F2, F11, F14 | B, C 스키마 |
| E 프론트(담당자) | 화면 4종 | F11 계약만 있으면 Mock JSON으로 선행 가능 |

계약 먼저 고정할 것: 비용 공식(0.4원/토큰), `usage_log`·`provider_usage` 스키마, F11 응답 JSON 형태, Mock Provider 경로.

## 6. 데모 합격 체크리스트
- [ ] K1·K2·S1 등록 후 원문이 화면·로그에 없다
- [ ] 대역 0개면 모든 IP 200, 대역을 등록하면 그 밖 호출이 403이고 거부 로그에 출발 IP가 보인다
- [ ] 정상 호출 중 두 선이 겹치고 diff ≈ 0, NORMAL
- [ ] 공격 시작 후 10초 안에 SUSPECT, 약 17초에 BLOCKED
- [ ] 최종 설명되지 않는 호출 수 < 한도(100건), 공격 스크립트가 401로 종료
- [ ] 차단 직후 사용자 호출이 같은 토큰으로 성공(예비키 사용)
- [ ] 사고 상세에 탐지·차단 시각, 손실 호출 수(참고 손실액), 폐기/전환 키가 표시
- [ ] 한도를 30건으로 바꾸고 재시연하면 더 일찍 차단된다
- [ ] `/demo/reset` 후 처음부터 재실행 가능

## 7. 리스크
- (해소: LiteLLM 미사용) LiteLLM 환경(Python 3.14, Postgres/Prisma 의존성)이 첫 병목일 수 있다. **첫 30분에 기동 확인**하고 막히면 LiteLLM은 중계·키 관리만 쓰고 사용량 대조·대응은 별도 워커로 분리한다.
- 비용 공식이 Gateway와 Mock에서 1원이라도 다르면 항상 SUSPECT가 뜬다. 공식은 한 곳에서 import.

## 구현 반영 사항 (PoC 구현 기준, 위 본문과 다른 점)
- 탐지 워커 폴링 주기 `POLL_INTERVAL_S`=1초(공급자별 `min_poll_s`), Mock 집계 지연 `MOCK_USAGE_LAG_S`=2초.
- 대시보드 `status`는 ACTIVE 크레덴셜 중 최악 판정. 열린 incident가 있으면 BLOCKED, RESOLVED 후 10초간 RECOVERED, 이후 NORMAL.
- 타임라인: DETECTED·REVOKE는 즉시, PROMOTE_STANDBY·NOTIFY_ADMIN·VERIFIED는 연출용 1초 간격(표시 시각일 뿐 실제 승격은 폐기 직후 DB에 즉시 반영).
- 폐기 즉시 STANDBY 승격(사용자 호출 503 방지). 검증은 승격 키로 Mock에 `max_tokens=1` 호출.
- 손실 호출 수(`loss_calls`)는 탐지 시점 판정값으로 먼저 기록하고, 폐기 2.5초 후(Mock, 공급자별 `revoke_lag_s + lag_s`) 공급자 최종 호출 수로 재계산(`max(공급자 - 게이트웨이, 확실 유출)`, 오차 미차감). 금액 `loss_krw`도 같은 시점 재계산(참고).
- 대조는 별도 테이블 없이 워커가 매 틱 `usage_log` 행 수 vs `provider_usage.requests`로 계산. PROVIDER 테이블도 없고 `credential.provider` 문자열.
- 판정은 호출 수 기준: 허용 오차 3건 차감 후 한도(기본 100건) 대비 10%/50%/70%에서 SUSPECT/WARNING/차단. 통화(원, 토큰당 0.4원)는 참고 표시.
- 리허설: `scripts/rehearse.py`가 위 흐름을 자동 점검(PASS/FAIL).


## 구현 반영 사항 (2차)
- **판정 기준 변경**: 금액이 아니라 **설명되지 않는 호출 수**로 판정한다(F2, F8). 한도 기본 100호출, 허용 오차 3호출. 금액은 참고 표시. 시나리오는 `demo-scenario.md` 참조.
- **공급자별 지연 보정**: 공급자 보고는 게이트웨이 기록보다 늦으므로, 게이트웨이 기록은 공급자 스냅샷 시각에서 공급자 지연만큼 뺀 시점까지로 맞춰 비교한다. `공급자 값 > 게이트웨이 전체 기록`이면 확실한 유출.
- **비용만 주는 공급자**(OpenRouter)는 비용 차이로 비교하고 호출 수를 평균 호출 비용으로 추정한다(`calls_estimated`).
- **청중 라이브 모드**와 **OpenRouter 라이브 모드**, **허니키**, **서비스 정지/재개**, **사용량 집계·단가표·예측**(`/admin/usage/*`)을 추가했다. 엔드포인트는 `contract.md` E~H절.
- **구현 완료(3차)**: 사용자 측 WIF(OIDC, contract J절), OpenAI 어댑터(I절), 공개 모드(K절), 기능 테스트 페이지 `/test`. 실제 공급자 WIF 연동은 컷. 대표 대시보드·정식 청중 페이지 디자인은 프론트 담당(`frontend-handoff.md`).
