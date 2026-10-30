# 계약 (고정). 상수·스키마는 `app/contract.py`, `app/db.py`가 원본.

실행: Mock `uvicorn app.mock_provider.main:app --port 9000` / 게이트웨이 `uvicorn app.main:app --port 8000` (프로젝트 루트, `.venv`).
관리자 API(`/admin/*`)는 항상 헤더 `X-Admin-Key` 필요(값 = 환경변수 `ADMIN_KEY`, 기본 `admin`). `/demo/*`·`/idp/token`은 `PUBLIC_MODE=1`일 때만 필요(K절). `/v1/*`·`/live*`·`/test`는 관리자 키 불필요. 모두 JSON, CORS 전체 허용(게이트웨이·Mock 모두).
시간은 응답에서 ISO8601(UTC) 문자열, DB는 epoch 초(float). 예외: `/live/stats.updated_at`은 epoch 초 정수, `/admin/usage/timeseries`의 `t`는 서버 로컬 시간 문자열.
관리자 키 오류 응답: `/admin/credentials|settings|cidrs|services|tokens|honeykeys|access-denied|usage/*|trusted-identities|wif/*|{provider}/provision`와 공개 모드 가드는 401 `{"detail":"invalid_admin_key"}`, `/admin/dashboard|timeseries|incidents|events`는 401 `{"detail":"bad admin key"}`(문구만 다름, 둘 다 401).

## A. Mock Provider (port 9000)
- 키 규칙: `Authorization: Bearer <key>`. 폐기되지 않은 키는 처음 보는 값이어도 **유효**(자동 등록). 소유자(owner)=키 문자열(STS 토큰이면 `wif:<audience>`).
- `POST /v1/chat/completions` body `{model, messages, max_tokens?(기본 300), stream?}` → OpenAI 형식 응답(`choices[0].message.content`="mock response"). `usage = {prompt_tokens:0, completion_tokens:max_tokens, total_tokens:max_tokens}`.
  비용은 `contract.cost_krw(total_tokens)`(토큰당 0.4원)로 owner에 누적. stream=true면 SSE 청크, **마지막 청크에 `usage`** 포함 후 `data: [DONE]`.
  폐기된 owner/만료 토큰은 401 `{"error":"revoked"}`.
- `GET /usage?owner=<ref>` → `{"owner","cost_krw","tokens","requests"}`. **`MOCK_USAGE_LAG_S`(2)초보다 최근 요청은 제외**한 값(집계 지연).
- `POST /revoke` `{"owner": "<ref>"}` → `{"ok":true}`. 이후 그 owner의 키/토큰 모두 401.
- `POST /sts/token` `{"audience","identity"}` → `{"token":"wif-...","expires_in":900,"owner":"wif:<audience>"}`. 토큰은 Bearer로 쓸 수 있고 owner=`wif:<audience>`로 집계. 만료(`WIF_TOKEN_TTL_S`=900초) 후 401. 폐기된 owner면 401 `revoked`.
- `POST /demo/reset` → Mock 상태 전부 초기화 `{"ok":true}`(공개 모드면 관리자 키 필요).
- 실제 AI 패스스루·청중 라이브(`/live*`)는 E·F절.

## B. 게이트웨이 중계 (port 8000)
- `POST /v1/chat/completions` (OpenAI 호환, 스트리밍 포함). 헤더 `Authorization: Bearer <게이트웨이 토큰 nvm-... 또는 OIDC JWT>`.
- 검사 순서(`app/gateway/router.py chat_completions`):
  ① 허니키 일치 → 401 `{"error":"invalid_token"}`(E절, `access_denied_log`에는 안 남고 `honeykey_event`로 기록)
  ③ allowed_cidr가 1개 이상(`*` 없음)이고 출발 IP ∉ allowed_cidr → 403 `{"error":"ip_not_allowed"}` (허용 대역이 0개거나 `*`가 있으면 모두 허용)
  ④ 토큰이 게이트웨이 토큰이 아니고 점 3조각·`nvm-` 아님 → JWT 경로(J절), 실패 시 401 `{"error":"wif_*"}`
  ⑤ 토큰 해시 불일치 또는 REVOKED → 401 `{"error":"invalid_token"}`
  ⑥ service가 ACTIVE 아님 → 403 `{"error":"service_suspended"}`
  ⑦ `role='PRIMARY' AND status='ACTIVE'` credential 없음 → 503 `{"error":"no_active_credential"}`(로그 안 남김)
  ②~⑥ 거부는 `access_denied_log` + `event(ACCESS_DENIED)` 기록.
- 출발 IP 결정은 K절(`app/clientip.py client_ip`): 기본 `request.client.host`, 신뢰 프록시면 `X-Forwarded-For`, `DEMO_MODE`면 `X-Demo-Source-IP`(공개 모드에선 관리자 키 동반 시만).
- 통과 시 PRIMARY·ACTIVE credential 중 id가 가장 작은 것을 골라(provider 필터 없음, I절 어댑터로 분기) 키 확보
  (API_KEY: `vault.decrypt(secret_enc)`, WIF: Mock `/sts/token` 토큰을 audience별로 캐시, 만료 60초 전 갱신) → 어댑터 `chat_url`로 중계(`prepare(body)`로 본문 보정).
- 업스트림 응답이 200이고 `usage`가 있으면 `usage_log` 1행(`cost_krw = 어댑터.call_cost_usd(usage) × USD_TO_KRW`, Mock은 결과적으로 `total_tokens × 0.4원`, `credential_id`=사용한 것). 스트리밍은 마지막 청크의 usage 사용, 클라이언트에는 그대로 흘려보낸다. `/demo/reset` 이전에 시작된 중계는 기록하지 않는다(`reset_gen`).
- 업스트림 401/네트워크 오류는 502 `{"error":"upstream_error"}`로 변환, usage_log 기록 안 함. 그 외 업스트림 상태 코드(400·429 등)는 본문과 함께 그대로 전달(기록 안 함).

## C. 관리자 CRUD (`app/gateway/router.py`, prefix `/admin`)
- `GET /admin/credentials` → `[{id,provider,auth_mode,role,status,masked,audience,provider_ref_masked,replaced_by_id,created_at}]` (원문·secret_enc 절대 노출 금지)
- `POST /admin/credentials` `{provider:"mock", auth_mode:"API_KEY"|"WIF", role:"PRIMARY"|"STANDBY", secret?, audience?}` → 위 항목 1개. 같은 provider에 ACTIVE PRIMARY가 이미 있으면 400. `provider`가 mock이 아니면 400(`POST /admin/{provider}/provision` 사용, G·I절). `provider_ref`: API_KEY=secret, WIF=`wif:<audience>`(masked도 `wif:<audience>`).
- `DELETE /admin/credentials/{id}` → `{"ok":true}` (status=REVOKED로만 표시, 공급자 폐기는 안 함)
- `GET /admin/settings` → `{"unauthorized_call_limit": 100, "loss_limit_krw": 100000}`.
  `PUT /admin/settings` 본문에 **보낸 키만** 갱신(둘 다 양의 정수, 아니면 400), 응답은 갱신 후 GET과 같은 형태. 변경은 다음 워커 틱(≤`POLL_INTERVAL_S`=1초, 공급자별 `min_poll_s`)부터 판정에 반영.
  `unauthorized_call_limit` = 허용하는 '설명되지 않는 호출 수'(**판정 기준**). `loss_limit_krw` = 참고 표시용 금액 한도(판정에 안 씀).
- `GET /admin/cidrs` → `[{id,cidr,label}]`, `POST /admin/cidrs` `{cidr,label?(기본 INTERNAL)}` → `{id,cidr,label}`(cidr는 정규화, `*`는 그대로 저장, `*`·`0.0.0.0/0`·`::/0`는 전체 허용, 잘못되면 400). 빈 배열 = 모두 허용(기본값), `DELETE /admin/cidrs/{id}` → `{"ok":true}`
- `GET /admin/services` → `[{id,name,status,tokens:[{id,token_masked,status,created_at}]}]` (토큰 목록 전용 GET은 없음)
- `POST /admin/tokens` `{"service_name"}` → `{"id","service_id","token":"nvm-...(원문 1회)","token_masked"}` (service 없으면 생성)
- `DELETE /admin/tokens/{id}` → `{"ok":true}`(REVOKED)
- `GET /admin/access-denied?limit=20` → `[{id,at,source_ip,reason,token_masked}]` 최신순
- 서비스 정지·허니키 목록은 E절, 공급자 키 프로비저닝은 G·I절.

## D. 탐지·대시보드·데모 (`app/detector/router.py`)
### `GET /admin/dashboard`
워커 마지막 틱 계산값을 돌려준다(요청마다 공급자를 조회하지 않음). 실측 응답 예는 `docs/frontend-handoff.md` 7절.

최상위 필드:
| 필드 | 형 | 의미 |
|---|---|---|
| `status` | `NORMAL\|SUSPECT\|WARNING\|BLOCKED\|RECOVERED` | 아래 '상태 계산' |
| `limit_calls` | int | 설정 `unauthorized_call_limit`(판정 기준) |
| `warn_at_calls`, `block_at_calls` | float | `limit_calls` × 현재 PRIMARY 공급자의 WARN/BLOCK 비율(Mock 0.5/0.7, 실제 공급자 0.2/0.35). 실수일 수 있음(예 30×0.7=21.0) |
| `diff_calls` | int | 크레덴셜별 `diff_calls` 합(REVOKED 포함) |
| `certain_diff_calls` | int | 크레덴셜별 `certain_diff_calls` 합 |
| `gateway_calls`, `provider_calls` | int | 크레덴셜별 값 합 |
| `limit_krw`, `warn_at_krw`, `block_at_krw` | float | 참고 금액 한도·눈금(`loss_limit_krw` × 같은 비율) |
| `diff_krw` | float | 크레덴셜별 `diff_krw` 합(참고) |
| `diff_usd` | float | max(0, 공급자 − 게이트웨이 비용 합) / `USD_TO_KRW`(허용오차 없음, 참고) |
| `gateway_cost_krw`, `provider_cost_krw` | float | 게이트웨이 `usage_log` 비용 합 / 공급자 최신 스냅샷 비용 합(참고) |
| `active_credential` | `{id,provider,auth_mode,masked}` \| null | 현재 PRIMARY·ACTIVE |
| `credentials` | 배열 | 아래 표 |
| `attack_running` | bool | 공격 시뮬레이터 실행 중 |
| `incident_id` | int \| null | `status`가 BLOCKED/RECOVERED일 때 해당 사고 id |
| `updated_at` | ISO | 워커 마지막 틱 시각 |
| `honeykey_hits` | `[{at,honeykey_masked,planted_at,source_ip}]` | 최근 5건(최신순) |
| `blocked_ips` | `[{source_ip,until}]` | 허니키로 차단 중인 IP |
| `ip_policy` | `"open"\|"restricted"` | 허용 CIDR이 0개거나 `*`가 있으면 `open`(모두 허용), 아니면 `restricted` |

`credentials[]` 필드: `id, provider, auth_mode, role, status, masked, gateway_cost_krw, provider_cost_krw, diff_krw, diff_usd, gateway_calls, provider_calls, diff_calls, certain_diff_calls, calls_estimated`. 호출 수 값은 워커가 마지막으로 그 크레덴셜을 판정한 값(REVOKED 이후에는 마지막 값에 고정, 리셋 직후·첫 틱 전에는 0). `calls_estimated`는 비용으로 호출 수를 추정한 경우 true(OpenRouter).

- **판정 기준(호출 수)**: `gateway_calls` = 게이트웨이가 중계·기록한 호출 수(`usage_log` 행 수, 단 공급자 지연에 맞춰 `지금 − lag_s`까지만 셈. 그래서 실시간 값보다 조금 작다), `provider_calls` = 공급자가 보고한 누적 호출 수(Mock `requests`, 2초 집계 지연),
  `diff_calls` = `effective_calls_diff(provider_calls, gateway_calls)` = max(0, 공급자 − 게이트웨이 − `TOLERANCE_CALLS`(3)) = **게이트웨이가 모르는 호출 수**(누군가 키를 직접 썼다는 증거). 공급자별 정렬 방식·`certain_diff_calls`는 I절.
- 금액 필드(`*_krw`, `*_cost_krw`, `*_usd`)는 **참고 표시용**. 판정·차단에 쓰지 않는다. `diff_krw`는 `TOLERANCE_KRW`(5,000원) 차감 후 값.
- 합계 필드는 모든 credential(REVOKED 포함) 합이다. 그래서 복구 후 `status`가 NORMAL이어도 최상위 `diff_calls`는 폐기된 키의 마지막 값이 남는다(리셋 전까지).
- **상태 계산**: ① 최신 비허니키 incident가 RESOLVED가 아니면(OPEN·ROTATED) `BLOCKED` ② RESOLVED 후 `RECOVERED_HOLD_S`(10초) 동안 `RECOVERED` ③ 그 외에는 ACTIVE 크레덴셜 판정 중 최악값(워커 판정 `BREACH`는 `WARNING`으로 표시, 곧 BLOCKED가 된다). 판정 하강은 히스테리시스 10초(I절). 예비 키가 없거나 VERIFIED가 실패하면 incident가 RESOLVED가 되지 않아 리셋 전까지 BLOCKED 유지.

### 그 외 조회
- `GET /admin/timeseries?range=300` → `{points:[{t, gateway_calls, provider_calls, gateway_krw, provider_krw}]}` 최근 `range`초, 2초 버킷, 전 크레덴셜 누적값(호출 수 두 선이 판정용, 금액은 참고). 이 `gateway_calls`는 지연 정렬 없이 그 시각까지의 전체 `usage_log` 행 수, `provider_calls`는 크레덴셜별 최신 스냅샷 `requests` 합.
- `GET /admin/incidents` → 목록(최신순, 허니키 사고 포함), `GET /admin/incidents/{id}`(없으면 404) →
  `{id,trigger_type,status,credential_id,calls_estimated,credential_masked,detected_at,blocked_at,resolved_at,duration_s,loss_calls,limit_calls,loss_krw,limit_krw,new_credential_id,new_credential_masked,timeline:[{at,step,detail,ok}]}`
  - `status`: `OPEN`(탐지·폐기) → `ROTATED`(예비 키 승격 기록) → `RESOLVED`(승격 키 호출 확인). `duration_s` = blocked_at − detected_at(탐지→폐기 완료, 보통 1초 미만).
  - `loss_calls` = 설명되지 않는 호출 수. 차단 시점 판정값으로 기록 후, 폐기 `revoke_lag_s + lag_s`초 후(Mock 0.5+2=2.5초) 공급자 최종값으로 재계산(`max(정렬 차이, 확실 유출)`, 오차 미차감). `limit_calls` = 차단 당시 한도. `loss_krw`/`limit_krw`는 같은 규칙의 참고 금액. 허니키 사고는 네 값 모두 null.
  - timeline step(순서): `DETECTED`(즉시) → `REVOKE_PROVIDER_KEY`(즉시) → `PROMOTE_STANDBY`(+1초) → `NOTIFY_ADMIN`(+1초, 이때 `BLOCKED` 이벤트) → `VERIFIED`(+1초, 성공 시 `RECOVERED` 이벤트). `PROMOTE_STANDBY` 이후 간격(`STEP_DELAY_S`=1초)은 **연출용 표시 시각**이며 실제 승격은 폐기 직후 DB에 즉시 반영된다. 예비 키가 없으면 `PROMOTE_STANDBY` ok=false, `NOTIFY_ADMIN`까지만 기록.
  - 허니키 사고 timeline: `DETECTED`, `NOTIFY_ADMIN` 두 단계, status는 `OPEN` 유지.
- `GET /admin/events?since_id=0` → `{events:[{id,at,kind,message,data}]}` 오름차순(`id > since_id`).
  kind: `SUSPECT`·`WARNING`(판정이 그 값으로 바뀔 때 1회), `BLOCKED`, `RECOVERED`, `ATTACK_STARTED`, `ATTACK_STOPPED`, `ACCESS_DENIED`, `HONEYKEY`. `data`는 kind별 JSON 또는 null.

### 데모
- `POST /demo/attack/start` / `POST /demo/attack/stop` → `{attack_running}`. 공격 = 현재 PRIMARY(ACTIVE) credential 키로 **Mock `/v1/chat/completions`에 직접** `ATTACK_RPS`(5)건/초, `max_tokens=ATTACK_MAX_TOKENS`(2000, 건당 800원). 401 받으면 자동 종료+`ATTACK_STOPPED` 이벤트. Mock 모드 전용(실제 공급자 모드에서도 Mock으로 보내므로 탐지되지 않음).
- `POST /demo/reset` → 공격 중지·대응 작업 취소·허니키 IP 차단 해제 → Mock `/demo/reset` 호출 → DB 전체 초기화(`trusted_identity` 포함) 후 시드:
  설정 `unauthorized_call_limit`=100(`DEFAULT_LIMIT_CALLS`)·`loss_limit_krw`=100000, allowed_cidr는 비움(= 모두 허용, 관리자가 등록하면 그 대역만 허용),
  credential K1(API_KEY, PRIMARY, 키 값 고정 `contract.LEAKED_KEY` 기본 `sk-mock-K1-leaked-demo`, 마스킹 `sk-...demo`) → S1(API_KEY, STANDBY, `sk-mock-S1-<랜덤>`) → K2(WIF, STANDBY, audience `novem-wif`, 마스킹 `WIF:novem-wif`) 순서로 삽입(id 순서가 승격 순서),
  service `userA`,`userB` 토큰 발급, 허니키 2개(`공개 저장소 .env.example`, `사내 위키 설정 예시`).
  응답 `{"tokens":{"userA":"nvm-...","userB":"nvm-..."}, "honeykeys":{planted_at: 원문}, "note":"..."}`. `data/live_key.json`을 지워 `/live`를 `LEAKED_KEY`로 되돌린다.
  리셋마다 토큰이 새로 발급되고 WIF 신뢰 규칙이 지워진다 → WIF를 쓰려면 `POST /demo/wif/seed` 재실행(J절).
- 실제 공급자 리셋·정리(`/demo/reset-{provider}`, `/demo/cleanup-{provider}`)는 G·I절, 허니키 호출(`/demo/honeypot/hit`)은 E절.

### 워커 `worker_loop()`
`POLL_INTERVAL_S`(1초)마다(어댑터별 `min_poll_s` 이상 간격, P절) ACTIVE credential 각각 어댑터 `fetch_usage` → `provider_usage`(cost_krw, tokens, requests) 적재 → `assess`(I절)로 호출 수 비교.
`judge(max(diff_calls, certain_diff_calls), unauthorized_call_limit, 공급자 비율)` 결과(Mock 판정표: < 0.1L NORMAL, ≥0.1L SUSPECT, ≥0.5L WARNING, ≥0.7L BREACH): SUSPECT/WARNING은 상태·이벤트 기록, BREACH는 **자동 대응**:
incident 생성(credential당 1개, 이미 있으면 아무것도 안 함, timeline `DETECTED`) → 공급자 폐기(어댑터 `revoke`, Mock `POST /revoke`) → credential REVOKED + 같은 provider의 가장 id 작은 STANDBY(ACTIVE)를 PRIMARY로 승격(`replaced_by_id`, incident `blocked_at`·`new_credential_id`) → (연출 1초 간격) timeline `PROMOTE_STANDBY`·incident ROTATED → `NOTIFY_ADMIN`·이벤트 `BLOCKED` → 승격 키로 공급자에 `max_tokens=1` 호출(게이트웨이를 거치지 않음) 성공 시 `VERIFIED`·incident `RESOLVED` + 이벤트 `RECOVERED`.
STANDBY가 없으면 timeline에 실패로 기록하고 status BLOCKED 유지.

## E. 추가 엔드포인트 (구현 반영)
- 허니키: 게이트웨이에 심어 둔 가짜 토큰(`nvm-honey-...`). 중계에서 일치하면(IP 검사보다 먼저) 호출자에게는 **일반 401 `invalid_token`**, 내부적으로 `honeykey_event` + 이벤트 `HONEYKEY` + 사고(`trigger_type=HONEYKEY`, `credential_id=null`, 같은 허니키·IP는 60초 안 중복 생성 안 함) 생성, **전체 게이트웨이 토큰을 즉시 REVOKED로 폐기하고 모든 서비스를 SUSPENDED(일시 정지)로 바꾼다**(IP 차단 없음, `ip_blocked`는 더 이상 발생하지 않음). 복구는 관리자가 토큰 재발급·서비스 재개(`/demo/reset`도 가능).
- `GET /admin/honeykeys` → `[{id,masked,planted_at,created_at,hits}]`
- `POST /demo/honeypot/hit` → `{source_ip:"203.0.113.77",planted_at,status_code:401,response:{error:"invalid_token"}}` (HTTP 200, 리셋 전이면 409)
- `POST /admin/services/{id}/suspend` → `{id,status:"SUSPENDED"}`, `POST /admin/services/{id}/resume` → `{id,status:"ACTIVE"}` (없는 id는 404). 정지 서비스 토큰은 403 `service_suspended`.
- 거부 사유(`access_denied_log.reason`, `ACCESS_DENIED` 이벤트) 값: `ip_not_allowed | invalid_token | service_suspended | ip_blocked | wif_invalid_signature | wif_expired | wif_audience_mismatch | wif_untrusted_identity | wif_malformed`.
- 실제 AI: Mock Provider에 환경변수 `UPSTREAM_API_KEY`(+선택 `UPSTREAM_BASE_URL`, 기본 OpenRouter)가 있고 요청 `model`이 `mock`/`demo`로 시작하지 않으면 실제 업스트림으로 전달하고 실제 usage로 집계한다. 실패 시 가짜 응답으로 자동 대체.
- 구 스키마 DB(`incident.limit_calls` 없음)는 서버 시작 시 자동으로 재생성된다(데모 데이터 삭제됨).

## F. 청중 라이브 데모 (Mock Provider, port 9000)
청중이 "유출된 키"(`LEAKED_KEY` = 시드 K1)로 게이트웨이를 거치지 않고 공급자에 직접 호출 → 탐지기가 호출 수 차이로 감지. 실행 절차는 `scripts/live.md`.
- `GET /live` → 청중용 채팅 HTML(`app/mock_provider/live.html`, 스타일 클래스 `.live-*`, 상태는 `body[data-state=active|busy|revoked|limited]`).
- `GET /live/config` → `{key, model}` (key = `data/live_key.json`의 OpenRouter 키, 없으면 `LEAKED_KEY`)
- `POST /live/chat` `{key, message}` → 200 `{reply, status:200}` / 401 `{error:"revoked"}` / 429 `{error:"rate_limited"}` / 502 `{error:"upstream_error", upstream_status?}`(OpenRouter 경로만).
  제한: 메시지 300자(초과분 잘림), max_tokens 150, 모델 고정(`LIVE_MODEL`), 출발 IP당 20초 10회(429도 누적 시도에 포함되지 않음). 출발 IP는 K절 규칙(신뢰 프록시일 때만 X-Forwarded-For).
  Mock 키 경로는 그 키의 owner가 폐기됐으면 401. `UPSTREAM_API_KEY`가 있으면 `LIVE_MODEL`(mock 아님)이라 실제 AI 답이 온다.
- `GET /live/stats` → `{participants, calls, key_status:"active"|"revoked", updated_at}` (participants = 최근 10분 안에 `/live/chat`을 보낸 IP 수, calls = 성공 호출 수, updated_at = epoch 초 정수). `key_status`는 현재 공개 키 기준. Mock `/demo/reset`으로 0·active로 돌아간다.
- 환경변수: `UPSTREAM_API_KEY`, `UPSTREAM_BASE_URL`(기본 OpenRouter), `LIVE_MODEL`(기본 `openai/gpt-4o-mini`), `LEAKED_KEY`.
- 실측(청중 40명 가정, 초당 약 6.5건): 한도 100호출에서 78건에 BLOCKED, 청중 401, 최종 손실 94건. 청중이 더 빠르면 한도를 넘길 수 있으니 한도 여유를 두거나 속도 제한을 유지할 것.

## G. OpenRouter 라이브 모드
Mock 대신 실제 OpenRouter 키로 같은 탐지·차단 흐름을 보여 준다. 게이트웨이 `.env`에 `OPENROUTER_MANAGEMENT_KEY`(관리 키) 필요(`app/contract.py`가 `.env`를 직접 읽음). 공급자 분기는 `app/providers.py`.
- 관리 키로만 키를 만들고·비활성화하고·지운다. **이름이 `november-`로 시작하는 키만** 다룬다(다른 키는 건드리지 않음).
- `POST /admin/openrouter/provision` `{role:"PRIMARY"|"STANDBY", limit_usd?:0.5, name?}` → `{id, masked, role, hash_masked, leaked_key?}`.
  `november-<role>-<랜덤>` 키 생성(한도 limit_usd), vault 암호화 저장, credential(`provider='openrouter'`, `auth_mode='API_KEY'`, `provider_ref`=OpenRouter 키 hash).
  원문은 PRIMARY일 때만 `leaked_key`로 1회 반환하고 `data/live_key.json`(gitignore)에도 저장 → Mock `/live/config`가 그 키를 쓴다. ACTIVE PRIMARY가 이미 있으면(공급자 무관) 400. `POST /admin/credentials`에 `provider:"openrouter"`는 400.
- `POST /demo/reset-openrouter` → `/demo/reset`과 같은 시드(CIDR 비움·userA/B 토큰·허니키·`loss_limit_krw`)에 기존 `november-` 키 삭제 후 K1(PRIMARY)·S1(STANDBY) 각 $0.5를 새로 만들어 넣는다(Mock 키·WIF 크레덴셜은 없음). `unauthorized_call_limit`=100(`OPENROUTER_LIMIT_CALLS`). 응답 = reset 응답 + `leaked_key`.
  `POST /demo/reset`·`/demo/reset-openai`는 `data/live_key.json`을 지워 라이브 페이지를 `LEAKED_KEY`로 되돌린다(OpenRouter 키는 지우지 않음).
- `POST /demo/cleanup-openrouter` → `{deleted:n}`. `november-` 키(비활성 포함)만 삭제.
- 중계: PRIMARY·ACTIVE 크레덴셜의 provider로 분기(provider 필터 없음). OpenRouter면 `https://openrouter.ai/api/v1/chat/completions`, `model`은 그대로(없거나 `mock`/`demo`로 시작하면 `openai/gpt-4o-mini`), 본문에 `usage:{include:true}`를 넣어 응답 `usage.cost`(USD)로 `usage_log.cost_krw = USD × USD_TO_KRW(1400)`. 스트리밍은 마지막 청크 usage, cost가 없으면 gpt-4o-mini 단가로 토큰 추정.
- 탐지: 워커가 `GET /keys/{hash}`(관리 키)의 `data.usage`(USD)×1400을 `provider_usage.cost_krw`로 적재. OpenRouter는 호출 수를 주지 않으므로(`/activity`는 당일 미지원) **호출 수는 추정**:
  `provider_calls(추정) = gateway_calls + round((공급자 비용 − 같은 시점 게이트웨이 비용) / 1건 기대 비용)`, 1건 기대 비용은 I절 '추정 보정'(최근 20건 평균을 [$0.000012, $0.0002]로 제한, 이력 없으면 `DEFAULT_CALL_COST_USD`=$0.000016). 게이트웨이 쪽은 `지금 − OPENROUTER_USAGE_LAG_S(8)`까지만 센다. `diff_calls = effective_calls_diff(...)`(오차 3건 차감)는 Mock과 같다.
  이 추정값이 `provider_usage.requests`에 저장되므로 대시보드·시계열·사고의 `provider_calls`/`loss_calls`는 추정치다. `/admin/dashboard`의 `credentials[]`와 `/admin/incidents/{id}`의 `calls_estimated`가 true(OpenRouter).
  비율은 공급자별 `RATIOS`: Mock 0.1/0.5/0.7, OpenRouter·OpenAI **0.05/0.2/0.35**(지연이 커서 낮춤). 대시보드 `warn_at_*`/`block_at_*`는 현재 PRIMARY의 provider 비율.
- 폐기: `PATCH /keys/{hash}` `{disabled:true}`. 타임라인 REVOKE_PROVIDER_KEY 상세에 "공급자 반영까지 약 20초 소요". 승격·사고·이벤트는 Mock과 같다. VERIFIED는 승격 키로 OpenRouter 실제 호출 1건(`max_tokens=1`). 최종 손실 재계산은 폐기 28초 후(`OPENROUTER_REVOKE_LAG_S` 20 + `OPENROUTER_USAGE_LAG_S` 8).
- 지연 특성(실측): 사용액 반영 약 6초, 비활성화 후 401까지 최대 약 20초(그 사이 호출은 200). 그래서 탐지까지 수십 초, 손실은 차단선을 넘을 수 있다. 금액 참고값(`diff_krw`)은 `TOLERANCE_KRW`(5,000원)보다 작아 보통 0으로 보인다.
- 라이브(Mock `/live/chat`): 키가 `sk-or-`로 시작하면 **현재 공개한 키(`/live/config`)와 같을 때만** OpenRouter에 직접 전달(다르면 401 `revoked`, `LIVE_MODEL` 기본 `openai/gpt-4o-mini`, `max_tokens` 150, 기존 속도 제한 유지). OpenRouter 401/403 → 401 `{"error":"revoked"}`, 그 외 오류 → 502 `{"error":"upstream_error","upstream_status"}`. `/live/stats`의 `key_status`는 마지막 OpenRouter 응답이 401/403이면 `revoked`. Mock 키 경로는 그대로.

## H. 사용량 집계·예측
`app/usage.py`(라우터 `/admin/usage/*`, X-Admin-Key 필요), 단가표 `app/pricing.py`. `usage_log`의 `status_code=200`만 집계(게이트웨이를 거친 호출만, 공격·청중·VERIFIED 호출은 없음). 기간은 서버 로컬 시간: day=오늘 0시~, week=최근 7일, month=이번 달 1일~, all=전체. `from`/`to`는 UTC ISO.
- `cost_krw` = usage_log에 기록된 값(OpenRouter `usage.cost` 실제 비용 또는 게이트웨이 계산). `estimated_cost_krw` = 단가표(USD/1M 토큰, 입력·출력 분리) × 토큰 × `USD_TO_KRW`로 게이트웨이가 재계산한 값 → 공급자가 비용만 주거나 아무것도 안 줘도 서비스별 예상 비용 산출 가능. 모델명의 `openai/` 같은 접두는 떼고 찾으며, 표에 없는 모델(mock 등)은 gpt-4o-mini 단가로 계산하고 `models[].estimated:true`.
- `GET /admin/usage/summary?range=day|week|month|all` → `{range,from,to,total:{calls,input_tokens,output_tokens,cost_krw,estimated_cost_krw},services:[{service_id,name,...같은 합계,models:[{model,...같은 합계,estimated}]}]}`
- `GET /admin/usage/timeseries?range=...&bucket=hour|day` → `{range,bucket,from,to,services:[{service_id,name,points:[{t:"2026-10-31T01:00"|"2026-10-31",calls,tokens,cost_krw}]}]}` (t는 로컬 시간, 호출 없는 버킷은 생략)
- `GET /admin/usage/forecast?window_hours=1`(0 초과 744 이하) → `{window_hours,rate_per_hour:{calls,tokens,cost_krw},projected:{end_of_day_cost_krw,end_of_month_cost_krw},per_service:[{service_id,name,rate_cost_krw_per_hour,projected_month_cost_krw}],budget:{monthly_budget_krw|null,hours_to_budget|null},method:"linear",note}`.
  예측 = 이미 쓴 금액(오늘/이번 달) + 최근 window 시간당 속도 × 남은 시간. `hours_to_budget` = (예산 − 이번 달 사용액) / 시간당 비용(이미 초과면 0, 속도 0이거나 예산 없으면 null). 한계: 단순 선형, 시간대·요일 패턴·급증(공격) 미반영, 창이 짧으면 변동 큼, 단가표는 수동 관리(공급자 가격 변경 시 갱신 필요).
- `GET /admin/usage/budget` → `{monthly_budget_krw}`; `PUT` `{monthly_budget_krw: 양의 정수|null}`(null=해제, 0 이하 400). setting `monthly_budget_krw`에 저장. `/demo/reset`은 setting을 지우므로 예산도 해제된다.

## I. 공급자 어댑터·OpenAI
- 어댑터(`app/providers.py`, `ADAPTERS`): 공급자마다 `lag_s`(보고 지연), `revoke_lag_s`(폐기 후 401까지), `model`, `chat_url`, `fetch_usage(http, cred)`, `revoke`, `prepare(body)`, `call_cost_usd(usage)`, (실제 공급자) `provision`, `cleanup`. 새 공급자 = 어댑터 클래스 1개 + `contract.USAGE_LAG_S`/`RATIOS`/`PROVIDERS` 항목.
  `fetch_usage`는 키별 누적값 중 **있는 것만** 준다: `{cost_usd?, tokens?, requests?, buckets?}` (`buckets=[(start,end,requests)]`).
  | provider | lag_s | revoke_lag_s | 주는 값 | 폐기 | 판정 비율 |
  |---|---|---|---|---|---|
  | mock | 2 | 0.5 | requests, tokens, cost_usd | `POST /revoke` | 0.1/0.5/0.7 |
  | openrouter | 8 (실측 약 6초) | 20 | cost_usd | `PATCH /keys/{hash}` disabled (약 20초) | 0.05/0.2/0.35 |
  | openai | 420 (실측 95초·381초) | 3 | requests, tokens, 1분 buckets | 서비스 계정 삭제 (실측 2.8초) | 0.05/0.2/0.35 |
- 판정(탐지기 `assess`): 전제 = 공급자 값은 항상 게이트웨이 기록보다 늦다.
  - 정렬 비교 `diff_calls`(대시보드 표시): buckets가 있으면 반영 완료 버킷(끝 ≤ now − lag_s)의 누적 호출 수 vs 같은 경계 이전 게이트웨이 호출 수(버킷 경계 정렬, 누적 비교라 분 경계 오차가 쌓이지 않음). requests만 있으면 스냅샷 vs now − lag_s까지의 게이트웨이. cost만(또는 tokens만) 있으면 차액 ÷ 1건 기대값으로 호출 수 추정(`calls_estimated: true`).
  - 확실 유출 `certain_diff_calls`: 공급자 누적 − 게이트웨이 **현재까지 전체** 누적(오차 3건 차감). 공급자가 늦으므로 양수면 무단 사용이 확실하다(오탐 없음).
  - 판정값 = max(diff_calls, certain_diff_calls). 그래서 정렬 비교가 아직 반영 전이어도 확실 유출이 차단선을 넘으면 바로 BREACH. Mock에서는 항상 certain ≤ diff라 기존 동작과 같다.
  - 히스테리시스: 판정 상승은 즉시, 하강은 낮은 판정이 `HYSTERESIS_S`(10초) 이어질 때만.
- 추정 보정(OpenRouter): 1건 기대값 = 최근 `CALL_COST_RECENT_N`(20)건 게이트웨이 평균 비용을 [$0.000012, $0.0002]로 제한, 이력 없으면 `DEFAULT_CALL_COST_USD`=$0.000016(청중 1건 실측). tokens만이면 평균 토큰 [20, 1000], 기본 150.
- `/admin/dashboard`의 `certain_diff_calls`, `diff_usd`(= max(0, 공급자 − 게이트웨이) USD, 허용오차 없음)는 D절 표 참조. 크레덴셜 값은 워커 마지막 틱 계산값.
- `provider_usage.requests` = 공급자 누적 호출 수(OpenAI는 부분 반영 포함 총합, OpenRouter는 추정치).
- 엔드포인트(일반화): `POST /admin/{openrouter|openai}/provision` `{role, limit_usd?(OpenRouter만, 기본 0.5, 0 이하 400), name?}` → `{id, masked, role, hash_masked, leaked_key?}`(다른 provider는 404). 이름은 항상 `november-` 접두. `POST /demo/reset-{openrouter|openai}`, `POST /demo/cleanup-{openrouter|openai}` → `{deleted}`(다른 값은 404).
- OpenAI: 키 = 프로젝트(`OPENAI_PROJECT_ID`, 기본 proj_xkSCJaCHHKA3GEm5bEm02pHJ) 서비스 계정, Admin 키 `.env`의 `OPENAI_ADMIN_KEY`. `provider_ref = key_id|service_account_id|project_id`. 사용량 `GET /v1/organization/usage/completions?bucket_width=1m&group_by=api_key_id&api_key_ids=<key_id>`, 어댑터가 15초 캐시. 중계 `https://api.openai.com/v1/chat/completions`(스트림이면 `stream_options.include_usage` 추가), 모델 기본 gpt-4o-mini, 비용은 토큰 × 상수($0.15/$0.60 per 1M, 근사). `/live` 청중 페이지는 OpenAI 키를 지원하지 않는다(`data/live_key.json`은 OpenRouter PRIMARY만 기록).
- 시드 한도: reset-openrouter·reset-openai 모두 `unauthorized_call_limit`=100. 비율은 실제 공급자 0.05/0.2/0.35.
- 최종 손실 재계산: 폐기 `revoke_lag_s + lag_s` 후(OpenAI 약 7분). `loss_calls = max(정렬 차이, 확실 유출)`, 오차 미차감.

## J. 사용자 측 WIF(OIDC)
사용자/서비스가 장기 토큰 대신 IdP가 서명한 단기 JWT(OIDC ID 토큰)로 게이트웨이에 인증한다. 구현 `app/wif_inbound.py`, 테이블 `trusted_identity`.
- 중계 분기: 허니키 → IP 차단 → **IP 허용 검사** 뒤, 게이트웨이 토큰과 일치하지 않고 Bearer 값이 점으로 나뉜 3조각이며 `nvm-`로 시작하지 않으면 JWT 경로. 통과하면 매핑된 service로 기존 경로(service ACTIVE 검사·중계·usage_log·탐지) 그대로.
- 검증: `alg`는 **RS256만**(none·HS256 거부). `iss`로 신뢰 규칙 조회 → 헤더 `kid`로 JWKS 키 선택·서명 검증 → `exp`/`nbf` 30초 여유 → `aud` = 규칙 `audience`(없으면 setting `wif_audience`, 기본 `november-gateway`) → `sub`가 `subject_pattern`(fnmatch 글롭)과 일치.
  외부 JWKS는 규칙의 `jwks_uri`를 httpx로 조회해 5분 캐시. 로컬 IdP issuer는 프로세스 내 키 직접 사용.
- 거부: 401 `{"error":"wif_invalid_signature|wif_expired|wif_audience_mismatch|wif_untrusted_identity|wif_malformed"}`. `access_denied_log` + `event(ACCESS_DENIED)` 기록, `token_masked` = 마스킹한 `sub`(JWT 원문 미저장). 허용 대역이 등록돼 있으면 그 밖 IP는 JWT여도 403 `ip_not_allowed`.
- `GET /admin/trusted-identities` → `[{id,issuer,subject_pattern,audience,service_id,jwks_uri,created_at}]`
- `POST /admin/trusted-identities` `{issuer, subject_pattern, audience?, service_id | service_name, jwks_uri?}` → 위 항목 1개(서비스 없으면 404, issuer·subject_pattern 비면 400). `DELETE /admin/trusted-identities/{id}` → `{"ok":true}`(없으면 404).
- `GET /admin/wif/settings` → `{"wif_audience"}`, `PUT` 같은 형태(빈 값 400).
- 신뢰 규칙 예시(GitHub Actions): `{"issuer":"https://token.actions.githubusercontent.com","subject_pattern":"repo:november/*:ref:refs/heads/main","audience":"november-gateway","service_name":"userA","jwks_uri":"https://token.actions.githubusercontent.com/.well-known/jwks"}`
- 데모 로컬 IdP(`DEMO_MODE=1`일 때만 라우트 등록): 시작 시 RSA 키쌍을 메모리에 생성(kid `local-1`), issuer = 환경변수 `IDP_ISSUER`(기본 `http://localhost:8000/idp`, 문자열 비교용이라 실제 주소와 달라도 동작).
  `GET /idp/.well-known/jwks.json` → `{keys:[{kty,use,alg,kid,n,e}]}`, `POST /idp/token` `{sub, audience?, ttl_s?(기본 600, 1~3600으로 보정)}` → `{token, expires_in}`.
  `POST /demo/wif/seed` → 규칙(issuer=로컬 IdP, `repo:november/*` → `userA`) 1개, 멱등(재실행 시 service_id만 갱신). `userA` 없으면 404 "먼저 /demo/reset".
  `POST /demo/wif/token` `{sub?}`(본문 생략 가능, 기본 `repo:november/app:ref:refs/heads/main`) → `{token, expires_in:600}`.
- 한계: 실제 외부 IdP(Google/GitHub) 연동은 미검증(jwks_uri 조회만 구현), 키 교체 자동화 없음(새 kid는 캐시 5분 만료 후 반영), 로컬 IdP 키는 재시작 시 바뀜(기존 토큰 무효), `/demo/reset`은 `trusted_identity`도 지움(리셋 후 `/demo/wif/seed` 재실행 필요, K절), JWKS 조회는 동기(최대 5초), `jti` 재사용 방지·토큰 폐기 목록 없음(짧은 TTL로 완화), IP 거부 로그의 `token_masked`는 기존 방식(JWT 앞 3자·뒤 4자).

## K. 공개 모드
인터넷 공개(NPM → 이 PC)용. 구현 `app/clientip.py`(관리자 키 검사·출발 IP·가드, 게이트웨이와 Mock 공용).
- 환경변수: `PUBLIC_MODE=1`(기본 0 = 기존 동작), `ADMIN_KEY`(기본 `admin`), `TRUSTED_PROXIES`(쉼표 구분 IP, 기본 빈 값), `DEMO_MODE`(기본 1). 키 비교는 `hmac.compare_digest`.
- `PUBLIC_MODE=1`일 때 `X-Admin-Key` 필요: `/admin/*`(공개 모드와 무관하게 항상), `/demo/*`(게이트웨이·Mock 모두), `/idp/token`. 없거나 틀리면 401 `{"detail":"invalid_admin_key"}`(대시보드 계열은 `bad admin key`, 맨 위 참조).
  공개 유지: `/v1/*`(토큰·IP·WIF), `/live*`, `/test`(페이지 자체), `/idp/.well-known/jwks.json`. `/docs`·`/redoc`·`/openapi.json`은 비활성(404, 시작 시 결정).
  Mock의 `/v1/*`·`/usage`·`/revoke`·`/sts/token`은 인증이 없으므로 NPM은 Mock에 `/live*`만 넘길 것.
- 출발 IP(`/v1` IP 검사·허니키 차단, Mock `/live/chat` 속도 제한 공통): 직접 접속 IP(`request.client.host`)가 `TRUSTED_PROXIES`에 있으면 `X-Forwarded-For`의 가장 오른쪽 신뢰되지 않은 값(모두 신뢰 프록시면 첫 값), 아니면 XFF 무시.
  `X-Demo-Source-IP`는 `DEMO_MODE`이고 (공개 모드가 아니거나 유효한 `X-Admin-Key`가 있을 때)만 인정. `/demo/honeypot/hit`는 내부 호출에 관리자 키를 붙인다.
- `/demo/reset`은 `trusted_identity`도 지운다. WIF를 쓰려면 리셋 후 `POST /demo/wif/seed` 재실행. 응답에 `note` 필드로 안내.
- 테스트 서버: `scripts/run_test_server.ps1`(origin/main → `C:\Users\tjrdu\novemberdeploy\src`, Gateway 8800·Mock 9800, Tailscale IP(또는 `BIND_IP`)에만 바인드, `.env` 미복사이고 `UPSTREAM_API_KEY`·`OPENROUTER_MANAGEMENT_KEY`·`OPENAI_ADMIN_KEY`를 지운 채 실행 → Mock 가짜 응답만, 실제 공급자 모드 불가, 관리자 키 `admin` 고정(`novemberdeploydmin_key.txt`에도 기록), `TRUSTED_PROXIES=100.69.18.101`(NPM)), 종료 `scripts/stop_test_server.ps1`.

## L. OpenAI 실제 판별 검증 결과 (2026-10-31)
- 실제 OpenAI로 end-to-end 확인: 사용자 5건 + 청중 직접 10건 → 반영은 **95초**에 15건이 한꺼번에 보임(이전 단독 측정은 381초). 키 ID 필터 조회와 프로젝트 전체 `group_by=api_key_id` 조회가 같은 값이고, 호출은 K1 한 키에만 집계됨.
- 탐지: 95초에 SUSPECT(확실 유출 7건 = 공급자 15 − 게이트웨이 5 − 오차 3, 한도 100 대비 7%). 420초 경과로 버킷이 확정되자 대시보드가 공급자 15 / 게이트웨이 5 / 차이 7을 표시. 한도를 20으로 낮추면 1초 만에 BREACH → 서비스 계정 삭제(약 3초) → 예비키 승격 → RECOVERED.
- 한도 100에서는 청중 10건으로 SUSPECT까지만 간다. WARNING/BREACH 확인은 한도를 낮춘 상태에서만 했다.
- 반영 지연은 편차가 크다(95초·381초). `lag_s=420`은 유지해도 오탐은 없고 탐지가 늦어질 수 있을 뿐이다.

## M. vLLM 공급자 (자체 GPU)

> 해커톤 데모 전용 구성이다. 실제 시스템 아키텍처 그림에는 포함하지 않는다.
공급자가 구현할 인터페이스는 `docs/vllm-gateway-spec.md`(정답). vLLM 앞단 게이트웨이가 키 인증(처음 보는 키도 유효, 폐기 키만 401)·키별 계량·폐기를 맡는다. 어댑터 `Vllm`(`app/providers.py`)은 Mock과 같은 모양.

- 환경변수: `VLLM_BASE_URL`(코드 기본 `http://127.0.0.1:8100`은 로컬 개발용, 배포 서버는 `https://vllm.dorm.sio2.kr`), `VLLM_ADMIN_KEY`(설정 시 관리 경로에 `X-Admin-Key`로 보냄, 공급자의 `GPU_ADMIN_KEY`와 같은 값), `VLLM_MODEL`(기본 `google/gemma-4-E2B-it-qat-w4a16-ct`), `USAGE_LAG_S_VLLM`(기본 0).
- 공급자 쪽 호출: 중계·공격 `POST {VLLM_BASE_URL}/v1/chat/completions`, 사용량 `GET /usage?owner=<키>` → `{requests, tokens, cost_krw}`(탐지기는 `requests`로 판정, 비율 Mock과 동일 0.1/0.5/0.7), 폐기 `POST /revoke {"owner"}`, 초기화 `POST /demo/reset`(실패·404 무시).
- 중계 `prepare`: model이 비었거나 `mock`/`demo`로 시작하면 `VLLM_MODEL`로 치환, `stream:true`면 `stream_options.include_usage=true`. 중계 1건 비용은 Mock과 같은 토큰×0.4원.
- 크레덴셜: `POST /admin/credentials {provider:"vllm", auth_mode:"API_KEY", role, secret}`(secret 필수, `provider_ref`=secret. WIF는 400). 또는 `POST /demo/reset-vllm`: `/demo/reset`과 같이 DB 초기화 후 K1(PRIMARY) `sk-vllm-K1-<랜덤8>`·S1(STANDBY) `sk-vllm-S1-<랜덤8>` 시드, 허용 CIDR 없음(모두 허용), userA·userB 토큰, 허니키, 한도 100, 응답에 `leaked_key`. PRIMARY 키는 `data/live_key.json`에 저장되어 `/live/config`가 이 키를 공개한다. `/demo/cleanup-vllm`은 없음(404, 폐기할 외부 키 없음).
- 공격 시뮬레이터 대상 규칙(`POST /demo/attack/start`): PRIMARY ACTIVE 크레덴셜의 공급자로 고른다. `mock` → Mock(model `mock`, max_tokens 2000), `vllm` → `VLLM_BASE_URL`(model `VLLM_MODEL`, max_tokens `ATTACK_MAX_TOKENS_VLLM`=30), 둘 다 초당 5건·401 받으면 자동 종료. `openrouter`/`openai`는 실제 과금이라 **409** `{"detail":"이 공급자는 공격 시뮬레이터 대상 아님. /live 청중 호출로 시연하세요"}`. 시작 이벤트 문구는 "유출 키로 <Mock|vLLM> 직접 호출 시작 (5건/초)".
- 청중 라이브: `/live/chat`의 키가 `sk-vllm-`로 시작하면 `{VLLM_BASE_URL}/v1/chat/completions`로 직접 전달(model `VLLM_MODEL`, max_tokens 150, 같은 속도 제한, 현재 공개 키만 허용). 401이면 `{"error":"revoked"}`, `/live/stats`의 `key_status`는 마지막 응답이 401/403이면 `revoked`.

## N. 폐기 실패 처리 (2026-10-31)
공급자 폐기가 실패하거나 효과가 없는데 화면이 "차단·복구됨"으로 넘어가지 않게 한다. 구현 `app/detector/router.py`(`respond`·`revoke_guard`·`watch_revoked`·`maybe_resolve`), 어댑터 `probe_revoked`.
- **두 가지 차단 경로를 구분한다.**
  - 청중 경로(Mock `/live/chat`): BREACH 즉시, 공급자 폐기 결과와 무관하게 게이트웨이가 키 원문을 Mock 폐기 목록에 올린다(`POST {MOCK}/revoke {"owner": 키 원문}`, 최선 시도). `/live/chat`은 어떤 키(`sk-vllm-`·`sk-or-`·mock)든 공급자로 전달하기 전에 이 목록을 검사해 401 `{"error":"revoked"}`, `/live/stats`의 `key_status`도 `revoked`. `/demo/reset*`(Mock `/demo/reset`)로 비워진다.
  - 공급자 직접 호출: 공격자가 게이트웨이·청중 경로를 거치지 않고 공급자에 직접 부르면 **공급자 폐기가 확인될 때까지 막을 수 없다**. 그래서 아래 재시도·확인·감시와 BLOCKED 유지가 필요하다.
- **재시도**: 폐기 요청(어댑터 `revoke`)이 예외·비200이면 0.5초, 1초 후 다시(최대 3회). timeline `REVOKE_PROVIDER_KEY`(ok = 요청 성공 여부).
- **확인**: 어댑터 `probe_revoked(http, cred) -> True|False|None` = 그 키로 `chat_url`에 `max_tokens=1` 호출. 401/403이면 True, 200이면 `revoke_lag_s` 동안 2초 간격으로 다시 보고 끝까지 200이면 False, 그 밖의 응답·오류는 None(확인 불가). True일 때만 "폐기 확인됨". timeline `REVOKE_VERIFIED`(첫 결과, 그리고 확인 성공 시 ok=true).
- **revoke_guard**: 확인 전에는 3초에서 시작해 2배씩(상한 30초) 재요청·재확인을 반복. 실패가 이어지면 이벤트 `REVOKE_FAILED`(메시지에 마스킹 키·누적 시도 횟수, `data={credential_id, incident_id, attempts}`)를 첫 회와 이후 10회마다. 실패 뒤 확인되면 이벤트 `REVOKE_CONFIRMED`. `/demo/reset*` 시 다른 대응 작업과 함께 취소되고 `reset_gen`이 바뀌면 스스로 멈춘다.
- **재활성 감시**: 폐기 확인 후 30분 동안 워커가 그 크레덴셜을 10초에 1번 `fetch_usage`. 기준값 = 확인 시각 + `lag_s` 이후 첫 조회값(`requests`, 없으면 비용). 이후 값이 기준보다 크면 이벤트 `REVOKE_NOT_EFFECTIVE`, timeline `REVOKE_VERIFIED` ok=false, 사고를 `ROTATED`(resolved_at 비움)로 되돌리고 `revoke_guard` 재시작. 감시 상태는 메모리(`state["revoke"]`)라 서버 재시작·리셋 시 사라진다.
- **상태 규칙**: DB 폐기(REVOKED)·예비 키 승격·사용자 호출 복구는 폐기 확인을 기다리지 않고 즉시. 사고 `RESOLVED`와 이벤트 `RECOVERED`는 (예비 키 `VERIFIED` 성공) **그리고** (폐기 확인) 둘 다일 때만. 그 전까지 대시보드 `status`는 `BLOCKED`.
- **대시보드**: `credentials[].revocation` = `"PENDING"`(확인 중) | `"FAILED"`(확인 실패, 재시도 중) | `"CONFIRMED"` | null(폐기 대상 아님·리셋 후·서버 재시작 후). 기존 필드는 그대로.
- 새 이벤트 kind: `REVOKE_FAILED`, `REVOKE_CONFIRMED`, `REVOKE_NOT_EFFECTIVE`. 새 timeline step: `REVOKE_VERIFIED`(여러 번 나올 수 있음, `REVOKE_PROVIDER_KEY`도 재폐기 시 다시 나옴).
- 청중 페이지(`live.html`): `/live/stats`를 3초마다 보고 `key_status=="revoked"`이면(또는 `/live/chat` 401) 입력·전송을 잠그고 "🚫 차단되었습니다"를 표시. 잠금 중에는 전송 경로가 모두 막히며, `key_status`가 `active`로 돌아오면(리셋) `/live/config`를 다시 읽어 잠금을 푼다. 이전 답변 문구는 지우지 않는다.

## O. 판정 방식(사용량 % / 건수) (2026-10-31)
- 설정: `GET/PUT /admin/settings`(setting 테이블, 스키마 변경 없음). 필드 `detection_mode`(`usage_pct`|`calls`), `suspect_pct`·`warn_pct`·`block_pct`(기본 5·10·20, 0 초과 100 이하), `suspect_calls`·`warn_calls`·`block_calls`(기본 1·5·10, 양의 정수). 일부만 보내도 되고 저장값·기본값과 합쳐 두 방식 모두 의심 < 경고 < 차단을 검사한다. 잘못된 방식·0 이하·100 초과·순서 위반은 400, 소수 건수는 422.
- 레거시 호환: `detection_mode`를 한 번도 저장하지 않았으면 GET 응답에 이 필드가 없고(프론트는 이것으로 레거시 서버로 판단), 판정은 기존 `unauthorized_call_limit` × 공급자별 RATIOS(`judge()`) 그대로. `/demo/reset*`는 setting을 지우므로 레거시로 돌아간다. 레거시로 되돌리는 PUT 값은 없다(리셋 사용).
- 판정: 판정값 = `max(diff_calls, certain_diff_calls)`(허용 오차 3건 차감 후). `usage_pct`는 이를 공급자 보고 누적 호출 수로 나눈 %(0건이면 0%), `calls`는 건수 그대로. `judge_th`로 임계와 비교(0은 항상 NORMAL). 새 방식에서는 공급자별 비율을 쓰지 않는다. BREACH 대응(폐기·승격·사고·청중 차단·폐기 확인)은 동일.
- 대시보드: 기존 필드 유지 + `detection` = {`mode`, `unit`(`%`|`건`), `suspect`, `warn`, `block`, `value`, `diff_calls`, `provider_calls`, `tolerance_calls`, `legacy`(+레거시면 `limit`)}. 활성 키 중 판정값이 가장 큰 키 기준(모두 0이면 주 키). `credentials[].value` = 키별 판정값.
- 사고: `block_label`(예 `공급자 보고의 20%`, `10건`, 레거시 `70건`) 추가. 새 방식 사고는 `limit_calls`가 null(한도 대신 차단선), 레거시는 기존처럼 한도.
- 키 발급 `POST /admin/{openrouter|openai|vllm}/provision` {role, name?, limit_usd?}: 이름은 `november-<name>`(프론트가 `이름-번호`를 보냄). mock은 발급 없음(404). 이름은 공급자 쪽에만 붙고 DB에는 저장하지 않는다.

## P. 허용 오차 설정·1초 폴링 (2026-10-31)
- `GET`/`PUT /admin/settings`에 `tolerance_calls`(정수 0~100, 기본 0). GET은 항상 돌려준다. 음수·101 이상·비정수는 400. 저장 위치 `setting.tolerance_calls`(`/demo/reset` 후 기본값으로 복귀).
- 설명되지 않는 호출 = `공급자 − (게이트웨이 + 내부 호출) − tolerance_calls`(음수는 0). 레거시·사용량%·건수 방식, `certain_diff_calls`, 대시보드 `detection.tolerance_calls` 모두 이 설정값을 쓴다.
- 내부 호출: 게이트웨이를 거치지 않는 우리 쪽 호출(승격 키 검증 max_tokens=1, 폐기 확인 probe가 200을 받은 호출). 크레덴셜별 메모리 카운터에 더해 설명된 호출로 친다. 게이트웨이가 공급자로 보냈지만 아직 usage_log에 쓰지 않은 진행 중 요청도 더한다. 공격 시뮬레이터 호출은 더하지 않는다(유출 호출이 맞다). 리셋 시 초기화.
- 집계 시각: 어댑터 `lag_s == 0`(vLLM)이면 조회가 끝난 뒤 현재 시각까지의 게이트웨이 기록과 비교한다. Mock은 lag 2초 유지.
- 환경변수: `TOLERANCE_CALLS`(설정이 없을 때 기본, 기본 0), `POLL_INTERVAL_S`(워커 주기, 기본 1), `USAGE_LAG_S_VLLM`(기본 0, 이전 2).
- 어댑터 `min_poll_s`: 그 공급자의 사용량 조회 최소 간격(Mock 0, vLLM 0, OpenRouter 3, OpenAI 15). 워커는 크레덴셜별 마지막 조회 시각을 기억해 건너뛴다.
