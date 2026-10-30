# 프론트·디자인 인계 (2026-10-31, 코드 기준)

> **주소 변경**: 서비스 주소는 `https://sio2.kr`이다. 이전 주소 `https://hack.sio2.kr`는 301로 `sio2.kr`에 리다이렉트된다. 브라우저의 교차 출처 `fetch`(특히 POST·프리플라이트)는 리다이렉트를 따라가지 못할 수 있으므로 **API 기본 주소(`?server=` 값, `api.js` 설정)는 반드시 `https://sio2.kr`로 바꿔야 한다.**


API 원본은 `docs/contract.md`(절 A~K). 이 문서는 화면을 만들 때 필요한 것만 추렸다. 값·필드는 모두 코드와 로컬 실측(Mock 모드)으로 확인했다.

## 1. 한눈에
**만들 것**
| 화면 | 사용자 | 서버 | 근거 |
|---|---|---|---|
| 대표 대시보드 | 발표자(대표 역) | 게이트웨이 `/admin/*`·`/demo/*` | `demo-scenario.md` 장면 1~7 |
| 페이지 A: 청중 채팅 (필수) | 청중(유출 키 사용자 역) | Mock `/live/*` | `demo-page-spec.md` 2절 |
| 페이지 B: 사용자 채팅 (선택) | 사용자 A·B 역 | 게이트웨이 `/v1/chat/completions` | `demo-page-spec.md` 3절 |

**이미 있는 것(디자인 없음, 참고·대체 대상)**
- `GET /test` (게이트웨이, `app/static/test.html`): 모든 API를 버튼으로 호출하는 기능 테스트 페이지. 대시보드 1초·live stats 2초 폴링 예시 코드가 들어 있다.
- `GET /live` (Mock, `app/mock_provider/live.html`): 청중 채팅 최소 버전. 스타일 훅 `.live-*`, `body[data-state=active|busy|revoked|limited]`. `/live/stats` 폴링은 **없다**(정식 페이지에서 구현 필요).

## 2. 접속 정보
- **테스트 서버**: `https://sio2.kr` (게이트웨이, 공개 모드). 청중 페이지 `https://sio2.kr/live`(NPM이 `/live*`만 Mock으로 보냄).
  - 공개 모드라 `/admin/*`·`/demo/*`·`/idp/token`은 헤더 `X-Admin-Key` 필수. 관리자 키는 `admin`(데모 서버 고정값, 공개 서버에서는 추측 가능하므로 접근 제한 필요). **키를 청중 페이지에 넣지 말 것.**
  - **경고: `admin`은 누구나 추측할 수 있는 약한 키다. 공개 서버에서는 NPM 접근 제한(IP·인증) 없이 열어 두지 말 것.**
  - 키 없이 쓰는 것: `/v1/chat/completions`(사용자 토큰), `/live`, `/live/config`, `/live/chat`, `/live/stats`, `/test`(페이지 자체).
  - 실제 AI 키 없이 실행된다 → 답은 항상 `"mock response"`, OpenRouter/OpenAI 모드 불가.
  - `/docs`(Swagger)는 꺼져 있다. 스키마는 `contract.md`를 본다.
- **로컬 실행**: README "실행" 절(`scripts/dev.ps1` → 게이트웨이 `http://127.0.0.1:8000`, Mock `http://127.0.0.1:9000`). 로컬 관리자 키 기본값 `admin`, `/demo/*`는 키 불필요. 로컬에서는 `/live`가 9000 포트(다른 origin)다.
- **CORS**: 게이트웨이·Mock 모두 전체 허용(`allow_origins/methods/headers=*`). 401에도 CORS 헤더가 붙는다. 쿠키·인증정보는 쓰지 않는다.
- **폴링 권장 주기**: 대시보드 `GET /admin/dashboard` 1초, `GET /live/stats` 2초, `GET /admin/events?since_id=` 1~2초, `GET /admin/timeseries` 2초(버킷이 2초). 서버 워커는 1초마다 판정한다(OpenRouter 3초·OpenAI 15초마다 조회).
- **허용 IP(테스트 서버 포함)**: 기본은 **모두 허용**(리셋 직후 `GET /admin/cidrs` = `[]`, 대시보드 `ip_policy:"open"`). 관리자가 `POST /admin/cidrs {"cidr":"10.0.0.0/16","label":"INTERNAL"}`처럼 대역을 하나라도 등록하면 그 대역만 허용되고 나머지는 **403 `ip_not_allowed`**. `*`를 등록하면 전체 허용.

## 3. 화면별 API 매핑
공통: 관리자 호출은 헤더 `X-Admin-Key`, 본문은 JSON. 시각은 ISO8601 UTC 문자열(표시할 때 로컬 시간으로 변환).

| 장면/화면 | 호출 | 쓰는 응답 필드 | 상태·에러 처리 |
|---|---|---|---|
| 장면 1 크레덴셜 카드 | `GET /admin/credentials` (또는 대시보드 `credentials[]`) | `masked, auth_mode, role, status, provider, replaced_by_id` | 원문은 절대 오지 않음. 마스킹만 표시 |
| 장면 1 크레덴셜 추가 | `POST /admin/credentials {provider:"mock",auth_mode,role,secret?|audience?}` | 생성된 항목 | 400(PRIMARY 중복, 필수값 누락, provider가 mock 아님) |
| 장면 1 한도 | `GET`/`PUT /admin/settings {unauthorized_call_limit}` | `unauthorized_call_limit`(판정), `loss_limit_krw`(참고) | 0 이하 400. 반영은 다음 틱(≤1초). 허용 오차 `tolerance_calls`(정수 0~100, 기본 0, 범위 밖·비정수 400)도 같은 API로 읽고 저장(화면은 별도) |
| 장면 1 허용 IP | `GET`/`POST /admin/cidrs {cidr,label}`, `DELETE /admin/cidrs/{id}` | `id, cidr, label(INTERNAL/VPN)` | 잘못된 cidr 400, 빈 목록 = 모두 허용, `*` = 전체 허용 |
| 장면 1 사용자 토큰 | `GET /admin/services`, `POST /admin/tokens {service_name}`, `DELETE /admin/tokens/{id}`, `POST /admin/services/{id}/suspend|resume` | `services[].tokens[].token_masked/status`, 발급 응답 `token`(원문 1회) | 원문은 발급 응답에서만 보여 주고 저장하지 않음 |
| 장면 2 상태 배지·게이지 | `GET /admin/dashboard` (1초) | `status, diff_calls, limit_calls, warn_at_calls, block_at_calls, gateway_calls, provider_calls, active_credential, updated_at` | 4절 |
| 장면 2 두 선 차트 | `GET /admin/timeseries?range=300` (2초) | `points[].t, gateway_calls, provider_calls`(판정용), `gateway_krw, provider_krw`(참고) | 누적값. 빈 구간도 점이 온다 |
| 장면 2 거부 로그 | `GET /admin/access-denied?limit=20` | `at, source_ip, reason, token_masked` | 사유 문구는 5절 |
| 장면 2 사용량 화면 | `GET /admin/usage/summary?range=day|week|month|all`, `/admin/usage/timeseries?range=&bucket=hour|day`, `/admin/usage/forecast?window_hours=1`, `GET`/`PUT /admin/usage/budget` | `total`, `services[].models[]`, `estimated`(단가표에 없는 모델), `projected`, `budget.hours_to_budget` | `cost_krw` = 기록 비용, `estimated_cost_krw` = 단가표 재계산. 둘을 구분 표시. `null` 처리(예산 없음) |
| 장면 3 유출 | (없음) 슬라이드에 유출 키 표시용 `GET /live/config` | `key` | 키는 발표용으로 공개 전제 |
| 장면 4 무단 사용 | 페이지 A + 대시보드. 백업: `POST /demo/attack/start`·`/stop` | `/live/stats.participants, calls`, 대시보드 `attack_running` | 공격은 Mock 모드 전용 |
| 장면 4 경고 토스트 | `GET /admin/events?since_id=<마지막 id>` | `events[].id, kind, message, data` | `kind`가 SUSPECT/WARNING/BLOCKED/RECOVERED/HONEYKEY/ACCESS_DENIED/ATTACK_*. `since_id`는 받은 최대 id로 갱신 |
| 장면 5 차단 | 대시보드 `status=="BLOCKED"`, `incident_id` → `GET /admin/incidents/{incident_id}` (1초, RESOLVED까지) | `timeline[]{at,step,detail,ok}`, `duration_s, loss_calls, limit_calls, credential_masked, new_credential_masked, status, calls_estimated` | `loss_calls`는 RESOLVED 뒤에도 한 번 더 바뀐다(Mock 폐기 2.5초 후, OpenRouter 28초 후 최종값) |
| 장면 5 페이지 A | `POST /live/chat` 401 또는 `/live/stats.key_status=="revoked"` | — | "차단되었습니다" 알림(8절) |
| 장면 6 복구 | 대시보드 `status=="RECOVERED"`(10초) → NORMAL, `active_credential.masked`가 S1로 바뀜 | `active_credential` | 페이지 B는 계속 200 |
| 장면 7 허니키 | `POST /demo/honeypot/hit` → 대시보드 `honeykey_hits[]`, `blocked_ips[]`, 이벤트 `HONEYKEY`, `GET /admin/honeykeys`, `GET /admin/incidents`(`trigger_type=="HONEYKEY"`) | `honeykey_masked, planted_at, source_ip, until` | 응답 HTTP는 200, 안의 `status_code`가 401. 리셋 전이면 409. 허니키 사고는 대시보드 `status`·`incident_id`에 영향 없음 |
| 장면 8 한계 | (없음, 정적 슬라이드) | — | 4절 공급자 지연 표 |
| 페이지 A 시작 | `GET /live/config` → `GET /live/stats` | `key, model`, `key_status` | 처음부터 `revoked`면 차단 상태로 시작 |
| 페이지 A 전송 | `POST /live/chat {key, message}` | 200 `reply` | 401 차단 / 429 잠시 후 / 502·네트워크 오류는 연결 실패(차단과 구분) |
| 페이지 B 전송 | `POST /v1/chat/completions` 헤더 `Authorization: Bearer <사용자 토큰>`, 본문 `{model:"mock",messages:[...],max_tokens?,stream?}` | `choices[0].message.content`, `usage` | 5절 에러표. `stream:true`면 SSE(`data: {...}` … `data: [DONE]`) |

## 4. 상태 머신과 표시 규칙
`GET /admin/dashboard.status` (계산: `app/detector/router.py dashboard`)
| 값 | 의미 | 들어가는 조건 | 나가는 조건 |
|---|---|---|---|
| `NORMAL` | 설명되지 않는 호출이 한도의 10% 미만 | 기본 | 판정 상승 시 즉시 |
| `SUSPECT` | 10% 이상(실제 공급자 5%) | 판정 상승 | 하강은 낮은 판정이 10초 유지될 때(히스테리시스) |
| `WARNING` | 50% 이상(실제 공급자 20%). 차단선 도달 직후 BLOCKED로 바뀌기 전 순간도 WARNING으로 보임 | 판정 상승 | 같음 |
| `BLOCKED` | 자동 차단 진행 중(사고 OPEN·ROTATED) | 차단선(70%, 실제 공급자 35%) 도달 | 승격 키 확인 성공 **그리고 공급자 폐기 확인**(`credentials[].revocation=="CONFIRMED"`). 폐기 미확인(`PENDING`·`FAILED`, `REVOKE_FAILED` 이벤트)이면 사용자 호출은 200이어도 BLOCKED 유지. 예비 키가 없거나 확인 실패면 리셋 전까지 유지 |
| `RECOVERED` | 예비 키로 전환 완료 | 사고 RESOLVED | **10초 후 자동으로** 판정값(보통 NORMAL) |

- 판정 기준은 **호출 수**(`diff_calls`). 금액(`*_krw`, `*_usd`)은 참고 표시. 금액·`diff_usd`는 반올림되지 않은 float(예 `7859.999999999998`)라 표시할 때 포맷 필요.
- **게이지**: 최대 `limit_calls`, 눈금 `warn_at_calls`(경고선)·`block_at_calls`(차단선). 두 값은 현재 PRIMARY 공급자 비율로 계산되어 공급자 모드에 따라 바뀌며 실수일 수 있다(한도 30 → 21.0). `diff_calls`는 한도를 넘을 수 있다(최종 손실 > 한도 가능) → 게이지 넘침 표시 필요.
- 최상위 `diff_calls`·`gateway_calls`·`provider_calls`는 **폐기된 키까지 합한 값**이다. 복구 후 status가 NORMAL이어도 `diff_calls`가 84 같은 값으로 남는다(리셋 전까지). 크레덴셜별 값은 `credentials[]`.
- `certain_diff_calls`: 오탐 없는 "확실 유출" 수. 판정은 `max(diff_calls, certain_diff_calls)`.
- `calls_estimated: true`(OpenRouter): 호출 수가 비용으로 추정한 값 → "약", "추정" 같은 표시가 필요하다. 대시보드 `credentials[]`, 사고 상세에 있다(최상위에는 없음 → 활성 크레덴셜 행 기준으로 판단).
- **타임라인**: `DETECTED` → `REVOKE_PROVIDER_KEY` → `PROMOTE_STANDBY` → `NOTIFY_ADMIN` → `VERIFIED`. 앞 두 단계는 즉시(사고 `duration_s` 실측 0.009초), 뒤 세 단계의 **1초 간격은 연출용 표시**다(실제 승격은 폐기 직후 반영). `ok:false`면 실패 단계(예: 예비 키 없음). 허니키 사고는 `DETECTED`, `NOTIFY_ADMIN` 두 단계.
- **Mock 실측 진행**(한도 100, 공격 초당 5건): 약 6초 SUSPECT → 14초 WARNING → 18초 BLOCKED → 21초 RECOVERED → 31초 NORMAL. 사고 최종 `loss_calls` 87 / 한도 100.
- **공급자별 지연이 화면에 주는 영향**
  | 공급자 | 대시보드 반영 | 폐기 후 청중 401까지 | 화면 영향 |
  |---|---|---|---|
  | Mock (테스트 서버 기본) | 2초 | 즉시 | 위 실측대로 빠르게 전이 |
  | OpenRouter | 사용액 약 6초(+8초 정렬) | 최대 약 20초 | BLOCKED 이후에도 청중 화면은 최대 20초간 200이 올 수 있다 → 페이지 A는 BLOCKED가 아니라 401/`key_status`에 맞춰 알림. 호출 수는 추정치 |
  | OpenAI | 95~381초(실측 편차) | 약 3초 | 라이브 시연용 아님. `/live` 미지원 |
  | vLLM(자체 GPU, 해커톤 데모 전용) | 0~2초 | 즉시 | Mock과 같은 속도로 전이(스텁 실측 약 18초에 RECOVERED). `/live` 지원(`sk-vllm-` 키) |

## 5. 에러 코드표
| HTTP | 본문 | 발생 | 화면 처리 제안(의미) |
|---|---|---|---|
| 401 | `{"detail":"invalid_admin_key"}` | 관리자 키 없음·틀림(`/admin/*` 대부분, 공개 모드 `/demo/*`·`/idp/token`) | 관리자 키 재입력 |
| 401 | `{"detail":"bad admin key"}` | 같은 원인, `/admin/dashboard|timeseries|incidents|events`만 문구가 다름 | 위와 동일하게 처리(상태 코드로 판단) |
| 401 | `{"error":"invalid_token"}` | `/v1` 사용자 토큰 없음·틀림·폐기, 또는 허니키 | 토큰 확인 |
| 401 | `{"error":"wif_invalid_signature"}` `wif_expired` `wif_audience_mismatch` `wif_untrusted_identity` `wif_malformed` | `/v1` JWT(사용자 측 WIF) 검증 실패 | JWT 재발급(`/demo/wif/token`)·신뢰 규칙(`/demo/wif/seed`) 확인 |
| 401 | `{"error":"revoked"}` | `/live/chat`: 유출 키가 폐기됨 | **"차단되었습니다"** |
| 403 | `{"error":"ip_not_allowed"}` | `/v1` 출발 IP가 등록된 허용 대역 밖 | 허용 IP 추가 또는 대역 삭제(2절) |
| 403 | `{"error":"service_suspended"}` | 정지된 서비스의 토큰 | 서비스 정지됨 |
| 404 | `{"detail":"not found"}` 등 | 없는 사고 id·리소스, `DEMO_MODE=0`이면 `/idp/*`·`/demo/wif/*` | — |
| 409 | `{"detail":"honeykey 없음. /demo/reset 먼저"}` | 리셋 전 `/demo/honeypot/hit` | 리셋 먼저 |
| 409 | `{"detail":"이 공급자는 공격 시뮬레이터 대상 아님. /live 청중 호출로 시연하세요"}` | PRIMARY가 OpenRouter·OpenAI일 때 `/demo/attack/start` | 공격 버튼 비활성, 청중 호출 안내 |
| 429 | `{"error":"rate_limited"}` | `/live/chat` 출발 IP당 20초 10회 초과 | "잠시 후 다시 시도하세요"(차단과 구분) |
| 502 | `{"error":"upstream_error"}` (+`upstream_status`) | `/v1` 공급자 401·네트워크 오류, `/live/chat` OpenRouter·vLLM 오류 | 연결 실패, 재시도 |
| 503 | `{"error":"no_active_credential"}` | `/v1` 활성 PRIMARY 키 없음 | 서비스 불가 |
| 400 | `{"detail":"..."}` | 관리자 입력 검증 실패 | 메시지 표시 |

거부 로그(`/admin/access-denied`)·`ACCESS_DENIED` 이벤트의 `reason` 값: `ip_not_allowed, invalid_token, service_suspended, ip_blocked, wif_*`. 허니키 호출은 거부 로그가 아니라 `HONEYKEY` 이벤트로 남는다.

## 6. 데모 운영 절차
1. **리셋**: `POST /demo/reset` → 응답 `tokens.userA/userB`(사용자 토큰 원문), `honeykeys`. 리셋마다 **토큰이 새로 발급**되므로 페이지 B에 새 토큰을 넣는다. 설정·예산도 시드값으로, 허용 IP는 빈 목록(모두 허용)으로 돌아간다.
2. (WIF 시연 시) `POST /demo/wif/seed` — 리셋이 신뢰 규칙을 지우므로 **리셋 후 매번 재실행**. 이후 `POST /demo/wif/token` → `{token}`을 페이지 B의 Bearer로 사용 가능.
3. (선택) 허용 IP 제한 시연 시 `POST /admin/cidrs`로 대역 등록, 끝나면 `DELETE`로 지워 모두 허용으로 되돌린다(2절).
4. **시연**: 청중이 `/live`로 채팅(또는 백업 `POST /demo/attack/start`) → 대시보드 SUSPECT→WARNING→BLOCKED→RECOVERED. 공격은 키가 폐기되면 스스로 멈춘다(`ATTACK_STOPPED` 이벤트). 수동 중지 `POST /demo/attack/stop`.
5. **허니키(선택)**: `POST /demo/honeypot/hit`.
6. **정리/반복**: 다시 `POST /demo/reset`(Mock `/live/stats`도 0·active로 복귀 → 페이지 A는 새로고침 없이 정상 복귀해야 함). 실제 공급자 모드를 썼다면 `POST /demo/cleanup-openrouter`(로컬, `.env` 필요).
- 주의: 공개 모드에서는 위 `/demo/*` 모두 `X-Admin-Key` 필요. 청중 페이지(A)에서 `/demo/*`를 부르지 말 것. 리셋 중에는 진행 중인 공격·차단 연출이 취소된다.

## 7. 샘플 JSON (로컬 Mock 모드 실측, 2026-10-31. 토큰 값은 생략)
**`GET /admin/dashboard`** (WARNING 시점, `credentials`는 3개 중 2개만 표시)
```json
{"status":"WARNING","limit_krw":100000.0,"warn_at_krw":50000.0,"block_at_krw":70000.0,
 "diff_krw":39860.0,"diff_usd":32.042857142857144,"gateway_cost_krw":80.0,"provider_cost_krw":44940.0,
 "limit_calls":100,"warn_at_calls":50.0,"block_at_calls":70.0,
 "diff_calls":54,"certain_diff_calls":54,"gateway_calls":4,"provider_calls":61,
 "active_credential":{"id":1,"provider":"mock","auth_mode":"API_KEY","masked":"sk-...demo"},
 "credentials":[
  {"id":1,"provider":"mock","auth_mode":"API_KEY","role":"PRIMARY","status":"ACTIVE","masked":"sk-...demo",
   "gateway_cost_krw":80.0,"provider_cost_krw":44940.0,"diff_krw":39860.0,"diff_usd":32.042857142857144,
   "gateway_calls":4,"provider_calls":61,"diff_calls":54,"certain_diff_calls":54,"calls_estimated":false},
  {"id":2,"provider":"mock","auth_mode":"API_KEY","role":"STANDBY","status":"ACTIVE","masked":"sk-...aba7",
   "gateway_cost_krw":0,"provider_cost_krw":0.0,"diff_krw":0.0,"diff_usd":0.0,
   "gateway_calls":0,"provider_calls":0,"diff_calls":0,"certain_diff_calls":0,"calls_estimated":false}],
 "attack_running":true,"incident_id":null,"updated_at":"2026-10-30T17:57:06.889292+00:00",
 "honeykey_hits":[],"blocked_ips":[],"ip_policy":"open"}
```
허니키 후에는 `"honeykey_hits":[{"at":"...","honeykey_masked":"nvm...jYbj","planted_at":"공개 저장소 .env.example","source_ip":"203.0.113.77"}]`, `"blocked_ips":[{"source_ip":"203.0.113.77","until":"..."}]`.

**`GET /admin/incidents/1`**
```json
{"id":1,"trigger_type":"RECONCILIATION","status":"RESOLVED","credential_id":1,"calls_estimated":false,
 "credential_masked":"sk-...demo","detected_at":"2026-10-30T17:57:10.943674+00:00",
 "blocked_at":"2026-10-30T17:57:10.952328+00:00","resolved_at":"2026-10-30T17:57:14.006775+00:00",
 "duration_s":0.009,"loss_krw":68860.0,"limit_krw":100000.0,"loss_calls":87,"limit_calls":100,
 "new_credential_id":2,"new_credential_masked":"sk-...aba7",
 "timeline":[
  {"at":"2026-10-30T17:57:10.943657+00:00","step":"DETECTED","ok":true,"detail":"설명되지 않는 호출 74건 ≥ 차단선 70건 (참고 55,860원)"},
  {"at":"2026-10-30T17:57:10.946322+00:00","step":"REVOKE_PROVIDER_KEY","detail":"sk-...demo 공급자 폐기","ok":true},
  {"at":"2026-10-30T17:57:11.960268+00:00","step":"PROMOTE_STANDBY","detail":"sk-...aba7(API_KEY) PRIMARY 승격","ok":true},
  {"at":"2026-10-30T17:57:12.977685+00:00","step":"NOTIFY_ADMIN","detail":"관리자 통보(BLOCKED 이벤트)","ok":true},
  {"at":"2026-10-30T17:57:14.006764+00:00","step":"VERIFIED","detail":"sk-...aba7 호출 성공","ok":true}]}
```

**`GET /admin/usage/summary?range=day`** (userB는 생략, 형태 동일)
```json
{"range":"day","from":"2026-10-30T15:00:00+00:00","to":"2026-10-30T17:57:27.509933+00:00",
 "total":{"calls":5,"input_tokens":0,"output_tokens":250,"cost_krw":100.0,"estimated_cost_krw":0.21},
 "services":[{"service_id":1,"name":"userA","calls":4,"input_tokens":0,"output_tokens":200,"cost_krw":80.0,
   "estimated_cost_krw":0.168,"models":[{"model":"mock","calls":4,"input_tokens":0,"output_tokens":200,
   "cost_krw":80.0,"estimated_cost_krw":0.168,"estimated":true}]}]}
```

**`GET /live/stats`** (차단 후. `updated_at`은 epoch 초 정수)
```json
{"participants":1,"calls":1,"key_status":"revoked","updated_at":1793383047}
```

**`POST /v1/chat/completions`** (사용자 채팅 200 응답, 테스트 서버는 항상 이 형태)
```json
{"id":"chatcmpl-05b76f10340afff6","object":"chat.completion","created":1793383008,"model":"mock",
 "choices":[{"index":0,"message":{"role":"assistant","content":"mock response"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":0,"completion_tokens":50,"total_tokens":50}}
```

**`GET /admin/events`** 일부: `{"events":[{"id":5,"at":"...","kind":"WARNING","message":"sk-...demo 설명되지 않는 호출 54건 (54%, 참고 39,860원)","data":{"credential_id":1,"diff_calls":54,"certain_diff_calls":54,"diff_krw":39860.0}}, {"id":7,"kind":"BLOCKED","message":"sk-...demo 자동 차단. 설명되지 않는 호출 74건 / 한도 100건","data":{"incident_id":1,"credential_id":1,"new_credential_id":2}}, {"id":8,"kind":"RECOVERED","message":"sk-...aba7로 전환 완료, 서비스 정상","data":{"incident_id":1}}]}`

## 8. 확정 사항(디자인과 무관)과 미정 사항
**확정**
- 페이지 A 차단 알림 문구: 제목 **"차단되었습니다"**, 부제 "유출된 키가 감지되어 자동으로 폐기되었습니다." 한 번만 띄우고, 닫아도 입력은 계속 막힘. 새로고침해도 `key_status=="revoked"`면 차단 상태로 시작.
- 차단 감지 두 경로: 전송 응답 401 즉시 + `/live/stats` 2초 폴링(보내지 않는 청중도 같은 순간 차단을 봄). 폐기 후 5초 이내 표시가 수용 기준.
- 429·네트워크 오류·502는 차단과 다른 표시. 리셋 후 `active`로 돌아오면 새로고침 없이 정상 복귀.
- 모바일 우선(페이지 A는 폰 QR 접속), 한국어 UI, 프로젝터에서 알림 글자가 멀리서도 읽힐 것.
- 유출 키는 페이지 A에 전체 노출(발표 연출). 메시지 300자 제한 표시.
- 기존 스타일 훅 `.live-*`, `body[data-state=...]` 호환 유지(`demo-page-spec.md` 2절).
- 대시보드는 대표(발표자) 화면, 페이지 A·B와 분리.

**미정(결정 필요)**
- 대시보드 레이아웃·색·아이콘(이 문서는 의미만 정함).
- 복구 후 게이지 값: 최상위 합계(폐기 키 값 포함)를 계속 보여 줄지, 활성 크레덴셜 행 값으로 바꿀지.
- 페이지 B를 만들지, 같은 화면에 A·B를 나란히 둘지, 사용자 토큰 주입 방법(입력창/URL 파라미터 등).
- 관리자 키를 대시보드에 어떻게 입력·보관할지(공개 모드).
- 정식 페이지의 배포 위치(현재 `/live`는 Mock 서버의 정적 파일, `/test`는 게이트웨이).

## 9. 알려진 한계
- 테스트 서버는 Mock만(실제 GPT 답 없음, OpenRouter·OpenAI 모드 불가).
- 허니키 차단 IP 목록·공격 상태·판정 상태는 메모리라 서버 재시작 시 사라진다. 로컬 IdP 키도 재시작 시 바뀌어 기존 JWT가 무효.
- 공격 시뮬레이터는 Mock 모드 전용(실제 공급자 모드에서 눌러도 탐지되지 않음).
- OpenRouter 호출 수는 비용 기반 추정, 폐기 반영 최대 20초 → 손실이 차단선을 넘을 수 있다. OpenAI는 탐지 약 7분 지연.
- 청중이 빠르면 최종 손실이 한도를 넘을 수 있다(차단선 70%는 이를 흡수하려는 여유).
- 대시보드 대부분 값은 워커 1초 틱 기준이라 실시간보다 최대 1초(+공급자 지연) 늦다.
- 관리자 키 오류 문구가 엔드포인트에 따라 두 가지(`invalid_admin_key`/`bad admin key`). 상태 코드 401로 처리할 것.
- 관리자 인증은 고정 키 1개(SSO·역할 없음).
- 판정 방식(사용량 %/건수): `/admin/settings`의 `detection_mode`가 없으면 레거시 서버로 그리면 된다. 저장 후에는 대시보드 `detection`, 사고 `block_label`을 쓴다(contract.md O절).

## 부록. 기능 테스트 페이지
- `/test` — 수동 조작 콘솔(모든 API를 눌러 보고 상태 확인). `/test/auto` — 버튼 하나로 전체 기능을 점검하고 PASS/FAIL/SKIP 표를 보여 주는 자동 점검 페이지. 두 페이지 모두 디자인이 없는 QA용이며 Admin Key를 입력해야 한다(두 페이지가 같은 localStorage 키를 공유).
- 공개 서버: `https://sio2.kr/test`, `https://sio2.kr/test/auto`
