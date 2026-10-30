# vLLM 게이트웨이 계량 인터페이스 명세 (자체 GPU 공급자 연동)

> **해커톤 데모 전용 구성이다. 실제 시스템 아키텍처 그림에는 포함하지 않는다.**

vLLM은 키별 사용량을 알려 주지 않는다. 그래서 vLLM 앞단 게이트웨이(`gpu_lb`)가 **공급자 역할**(키 인증, 키별 계량, 키 폐기)을 하도록 아래 인터페이스를 구현한다. 이 규약을 그대로 따르면 NovemberAiGateway의 탐지기가 `vllm` 공급자로 바로 사용한다(기존 Mock Provider와 같은 모양, `docs/contract.md` A절 참조).

## 0. 서비스 주소
- vLLM 게이트웨이는 숙소 쪽 NPM이 TLS를 종료하는 **`https://vllm.dorm.sio2.kr`**로 서비스한다(`*.dorm.sio2.kr` 인증서는 숙소 NPM 담당). NovemberAiGateway(Proxmox CT)는 이 주소를 `VLLM_BASE_URL`로 호출한다. 관리 경로(`/usage`, `/revoke`, `/demo/reset`)는 공개 인터넷을 지나므로 **`GPU_ADMIN_KEY`를 반드시 설정**하고 우리 쪽 `VLLM_ADMIN_KEY`를 같은 값으로 맞춘다.

## 1. 인증
- 요청 헤더 `Authorization: Bearer <키>`.
- **키는 처음 보는 값이어도 유효**(자동 등록)이고, **폐기된 키만 401** `{"error":"revoked"}`. (기존 단일 `GPU_API_KEY`는 "서비스 계정 키"로 계속 허용해도 되지만 아래 계량·폐기 대상이 아님.)
- 계량 단위(owner) = 키 문자열 그대로. (저장은 해시를 권장하나 `/usage`·`/revoke`의 `owner` 값은 키 원문으로 받는다.)

## 2. 추론 엔드포인트
- `POST /v1/chat/completions` (OpenAI 호환, `stream` 지원)을 vLLM 백엔드로 중계한다(기존 로드밸런싱 유지).
- 응답의 `usage`(`prompt_tokens`, `completion_tokens`, `total_tokens`)로 해당 키의 사용량을 계량한다. 스트리밍은 `stream_options: {"include_usage": true}`를 강제로 넣어 마지막 청크의 usage를 읽는다. 클라이언트에는 그대로 흘려보낸다.
- **계량 시점**: 응답이 정상 완료(HTTP 200)된 호출을 1건으로 센다. 업스트림 실패·클라이언트 중단은 세지 않는다.

## 3. 계량·폐기 API (관리용)
관리 헤더: `X-Admin-Key: <GPU_ADMIN_KEY>`(환경변수 `GPU_ADMIN_KEY`가 설정되면 필수, 없으면 열림 — **공개 노출 시 반드시 설정**).

| 경로 | 동작 |
|---|---|
| `GET /usage?owner=<키>` | `{"owner": str, "requests": int, "tokens": int, "cost_krw": float}` — 해당 키의 **누적** 값. 아직 쓴 적 없으면 0들. `cost_krw = tokens × 0.4`(프로젝트 공통 단가, `app/contract.py`의 `COST_PER_TOKEN_KRW`와 동일하게). 선택 필드: `prompt_tokens`, `completion_tokens` |
| `POST /revoke` | body `{"owner": "<키>"}` → `{"ok": true}`. 이후 그 키의 `/v1/chat/completions`는 401 `{"error":"revoked"}` |
| `POST /demo/reset` | (선택, 권장) 모든 계량값과 폐기 목록 초기화 → `{"ok": true}` |

- `requests`는 **실시간(지연 0)** 으로 반영해도 되고, 일부러 `LAG_S`(예: 2초) 지연을 주고 싶으면 "LAG_S초보다 최근 호출은 제외한 값"을 돌려준다(기존 Mock은 2초). 지연이 있으면 응답에 `"lag_s": 2`를 넣어 달라.
- 계량값은 메모리 보관으로 충분(프로세스 재시작 시 초기화 허용).

## 4. NovemberAiGateway 쪽 설정 (우리 구현)
- 환경변수: `VLLM_BASE_URL`(코드 기본 `http://127.0.0.1:8100`은 로컬 개발용, 배포 서버는 `https://vllm.dorm.sio2.kr`), `VLLM_ADMIN_KEY`(위 `GPU_ADMIN_KEY`와 같은 값), `VLLM_MODEL`(코드 기본 `google/gemma-4-E2B-it-qat-w4a16-ct`, vLLM이 서빙하는 모델과 같아야 함), `USAGE_LAG_S_VLLM`(기본 0).
- 공급자 이름 `vllm`. 크레덴셜 등록: `POST /admin/credentials {provider:"vllm", auth_mode:"API_KEY", role, secret}` 또는 `POST /demo/reset-vllm`(K1·S1 시드, 유출 키 반환).
- 탐지기: `GET {VLLM_BASE_URL}/usage?owner=<키>`를 1초(`POLL_INTERVAL_S`)마다 조회 → 호출 수(`requests`) 기준으로 판정(Mock과 동일 비율 0.1/0.5/0.7). 폐기: `POST {VLLM_BASE_URL}/revoke`.
- 공격 시뮬레이터: PRIMARY 크레덴셜이 `vllm`이면 `VLLM_BASE_URL`로 `VLLM_MODEL`, 작은 `max_tokens`(기본 30)로 호출한다(GPU 부하를 줄이기 위해 초당 5건).

## 5. 구현 체크리스트 (vLLM 게이트웨이 담당)
- [ ] 키 자동 등록 + 폐기 시 401
- [ ] 응답 usage 기반 키별 `requests`·`tokens` 누적(스트리밍 포함)
- [ ] `GET /usage?owner=` , `POST /revoke`, (선택) `POST /demo/reset`
- [ ] `GPU_ADMIN_KEY`로 위 관리 경로 보호
- [ ] `curl`로 확인: 키 A로 3회 호출 → `/usage?owner=A`의 `requests: 3` → `/revoke` → 키 A 호출 401, 키 B는 200
