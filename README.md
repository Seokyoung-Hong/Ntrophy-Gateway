# NTrophy Gateway — AI API 키 유출 탐지·자동 대응 게이트웨이

> **TEAM N · 해커톤 출품 PoC**
> NTrophy는 기업의 AI API 인증정보를 게이트웨이 한 곳에 모아 보호하고, **게이트웨이 기록과 공급자 집계의 차이로 게이트웨이 밖에서 일어난 무단 사용을 탐지**해, 해당 키를 자동으로 폐기하고 예비 키로 전환하는 보안 게이트웨이다.

<p align="center"><img src="docs/screenshots/00-landing.png" alt="랜딩 페이지" width="720"></p>

- 라이브 데모: **https://sio2.kr** (실제 AI 키 없이 Mock 공급자로 동작)
- 코드·문서 경로에는 개발 당시 이름(`november`)이 남아 있다. 서비스 이름은 NTrophy다.

## 목차
1. [문제: 키 유출과 게이트웨이 밖 사각지대](#1-문제-키-유출과-게이트웨이-밖-사각지대)
2. [해결: Protect · Detect · Respond](#2-해결-protect--detect--respond)
3. [핵심 탐지 원리: G vs P](#3-핵심-탐지-원리-g-vs-p)
4. [3중 방어](#4-3중-방어)
5. [기존 서비스와 비교](#5-기존-서비스와-비교)
6. [시장성과 비즈니스 모델](#6-시장성과-비즈니스-모델)
7. [구현 아키텍처](#7-구현-아키텍처)
8. [데모: 정상 → 유출 → 차단 → 복구](#8-데모-정상--유출--차단--복구)
9. [실행 방법](#9-실행-방법)
10. [문서 안내](#10-문서-안내)
11. [한계와 로드맵](#11-한계와-로드맵)

---

## 1. 문제: 키 유출과 게이트웨이 밖 사각지대

OpenAI·Claude·Gemini 같은 AI API는 호출량·토큰 사용량만큼 과금되고, 유출된 장기 키는 권한 범위 안에서 누구나 호출할 수 있다. 유출 → 비인가 호출 → 비용 증가 → 뒤늦은 발견이 반복된다.

| 문제 | 내용 |
|---|---|
| 키 분산 | 키가 개발자 PC, 서버, `.env`·설정 파일, 저장소에 흩어져 한 곳만 새도 유출된다 |
| 사각지대 | 탈취된 키로 **공급자 API를 직접** 부르면 회사 게이트웨이 로그에는 아무것도 남지 않는다 |
| 늦은 발견 | 공급자 대시보드·청구서로 알게 되는 시점은 이미 늦다 |
| 대응 부작용 | 키를 급히 폐기하면 그 키를 쓰던 정상 서비스까지 멈춘다 |
| 공급자별 차이 | 공급자마다 키 발급·인증·유출 대응·사용량 조회 방식이 달라 통합 관리가 어렵다 |

공급자별 보안 기능 (발표자료 기준 팀 조사)

| | OpenAI | Claude | Gemini(Vertex AI) |
|---|---|---|---|
| 키 부여 | 프로젝트별 키 | Console 수동 발급 | 서비스 계정 · IAM |
| 인증 | API Key · WIF | API Key · WIF | OAuth · WIF |
| 유출 대응 | 자동 비활성화 | 키 상태 변경 | IAM 권한 회수 |

## 2. 해결: Protect · Detect · Respond

모든 AI API 호출을 NTrophy 게이트웨이 하나로 모으고 세 단계로 지킨다.

| 단계 | 하는 일 | 이 PoC에서 구현된 것 |
|---|---|---|
| **Protect** | 실제 공급자 키를 게이트웨이에만 두고, 직원·서비스에는 게이트웨이 토큰(또는 WIF JWT)만 준다 | 공급자 키 **AWS KMS 봉투 암호화** 보관, 게이트웨이 토큰(SHA-256 해시만 저장), 워크로드 WIF(RS256 JWT 검증), 허용 IP 대역 |
| **Detect** | 게이트웨이 기록 사용량(G)과 공급자 집계 사용량(P)을 비교해 게이트웨이 밖 사용을 찾는다 | 1초 주기 탐지 워커, 판정 방식 3가지, 허니키 |
| **Respond** | 위험도에 따라 키를 폐기하고 예비 키로 전환한 뒤 기록·통보한다 | 공급자 키 폐기(재시도) → 예비 키 승격 → 사고 기록·콘솔 알림 → 폐기 확인 |

**1인 1키 권장**: 여러 명이 한 키를 같이 쓰면 사용량이 섞여 이상 사용이 묻힌다. 사람(또는 서비스)마다 키를 나누면 키별 사용 패턴이 생겨 차이가 바로 드러난다. 과금도 이 키 수 기준이다([6절](#6-시장성과-비즈니스-모델)).

## 3. 핵심 탐지 원리: G vs P

다른 AI 게이트웨이는 **자기를 거친 호출만** 본다. NTrophy는 공급자가 집계한 실제 사용량을 함께 본다.

```
G = 게이트웨이가 중계·기록한 사용량 (키별 누적)
P = 같은 키·같은 구간에 공급자가 집계한 사용량 (공급자 Usage API 조회)

판정값 = P − (G + 내부 호출) − 허용 오차        (음수는 0)
판정값이 기준을 넘으면 → 게이트웨이 밖에서 그 키가 쓰였다
```

- 정상 호출은 게이트웨이에 먼저 기록되고 공급자 보고는 늘 늦다. 그래서 **P > G**인 부분은 게이트웨이를 거치지 않은 호출이다.
- 예: 게이트웨이 1만 건, 공급자 1만 2천 건이면 2천 건이 외부 사용이다(가상 예시).
- 구현은 **호출 수**를 비교한다. 비용만 주는 공급자(OpenRouter)는 평균 호출 비용으로 호출 수를 추정하고 화면에 "추정"으로 표시한다.
- 정상 원인 흡수: 승격 키 검증·폐기 확인 같은 내부 호출과 진행 중 요청은 "설명된 호출"로 치고, 관리자 허용 오차(`tolerance_calls`)를 뺀다. 판정 상승은 즉시, 하강은 낮은 판정이 10초 유지될 때만.

**판정 방식** (`docs/contract.md` O절)

| 방식 | 기준 | 기본 임계 (의심 / 경고 / 차단) |
|---|---|---|
| 레거시 한도(기본) | 허용 무단 호출 수 한도(기본 100) × 비율 | Mock 10% / 50% / 70%, OpenRouter·OpenAI 5% / 20% / 35% |
| 사용량 % (`usage_pct`) | 공급자 보고 중 게이트웨이가 모르는 호출 비율 | 5% / 10% / 20% |
| 건수 (`calls`) | 설명되지 않는 호출 건수 | 1 / 5 / 10건 |

차단선을 100%보다 낮게 두는 이유는 집계 지연과 폴링 사이에 늘어나는 호출을 흡수해 최종 손실이 한도 아래에 머물게 하려는 것이다.

**자동 대응 순서** (`docs/contract.md` D·N절)
1. 탐지(DETECTED) → 사고 생성
2. 공급자에서 키 폐기(실패 시 최대 3회 재시도)
3. 예비 키를 주 키로 승격 — 사용자는 **같은 게이트웨이 토큰으로** 계속 200을 받는다
4. 사고 기록·관리자 콘솔 알림
5. 폐기 확인 — 유출 키로 1토큰 호출해 401인지 확인. 확인 전까지 BLOCKED 유지·재폐기, 확인 후 30분 안에 사용량이 다시 늘면 `REVOKE_NOT_EFFECTIVE`로 재폐기

사고는 예비 키 검증 성공 **그리고** 폐기 확인이 모두 될 때만 RESOLVED가 된다.

## 4. 3중 방어

| 단계 | 방어선 | 구현 상태 |
|---|---|---|
| 1. 키 중앙화 (예방) | 실제 키는 게이트웨이만 가진다. 직원 PC가 털려도 공급자 키는 나가지 않는다 | **적용**: AWS KMS 봉투 암호화(크레덴셜마다 DEK, AES-256-GCM, KEK는 KMS 밖으로 나가지 않음, `app/kms.py`·`app/vault.py`). 로컬 개발은 Fernet 백엔드. 워크로드 WIF(RS256 JWT)는 로컬 데모 IdP로 구현. **HashiCorp Vault는 향후** |
| 2. IP 접근 제한 (차단) | 게이트웨이 토큰이 탈취돼도 허용 IP·VPN 밖에서는 못 쓴다 | **적용**: 관리자가 허용 CIDR을 등록하면 그 대역만 통과(403). 등록 전 기본값은 모두 허용 |
| 3. 사용량 대조 감시 (탐지·대응) | 앞 두 단계가 뚫려도 G vs P 차이로 잡고 키를 폐기·전환 | **적용**: [3절](#3-핵심-탐지-원리-g-vs-p) |

추가로 **허니키**: 심어 둔 가짜 토큰이 쓰이면 겉으로는 평범한 401을 주고, 내부에서는 전체 토큰 폐기·서비스 일시 정지를 한다.

## 5. 기존 서비스와 비교

세 서비스 모두 키 숨기기·한도·사용량 기록은 제공하지만, 게이트웨이를 통과한 요청만 감시하고 실제 공급자 키 교체는 수동이다.

| 기능 | NTrophy | Cloudflare AI Gateway | OpenRouter | Azure APIM |
|---|:-:|:-:|:-:|:-:|
| WIF(신원 기반 인증) 적용 | ○ | × | × | ○ (관리 ID) |
| 게이트웨이 밖 사용 탐지 | ○ | × | × | × |
| 실제 공급자 키 자동 교체 | ○ | × | × | × |

○ 지원 · × 미지원. **공개 문서 기준 팀 조사**(발표자료 9쪽). NTrophy의 ○는 이 PoC 기준으로 다음 범위다: WIF는 게이트웨이로 들어오는 워크로드 JWT 검증(공급자 측 WIF는 Mock STS), 키 교체는 공급자 키 관리 API가 지원하는 범위(OpenRouter·OpenAI 폐기, 미리 등록한 예비 키 승격).

NTrophy는 기존 게이트웨이를 대체하지 않고 그 위에 붙이는 보안 계층을 목표로 한다.

## 6. 시장성과 비즈니스 모델

**시장 규모** (발표자료 기준 추정, 환율 1달러 1,400원 가정)

| 구분 | 값 | 산식 |
|---|---|---|
| TAM | 약 1.9조 원 | 전 세계 기업용 AI 게이트웨이 시장 2026년 13.3억 달러(SNS Insider 보고서) |
| SAM | 약 449억 원 | 국내 SW사업자 신고 기업 67,222개 × 생성형 AI 활용 비율 55.7% × 연 120만 원 |
| SOM | 약 4억 원 | 출시 후 3년 안에 SAM 기업의 1%(약 330개) |

SW사업자 수는 AI API 사용 기업 수와 같지 않고 55.7%는 설문 기반이라 추정치다. 시장 근거로 발표자료는 Palo Alto Networks의 AI 게이트웨이 기업 Portkey 인수(1억 1,700만 달러)를 든다.

**비즈니스 모델**: B2B 보안 SaaS. 고객은 AI API를 쓰는 기업(특히 중소·중견 SW 기업의 IT·보안팀).
- 월 구독료 = **기본 10만 원 + 관리 API 키 1개당 1만 원** (예: 키 20개 → 월 30만 원)
- AI 사용료는 고객이 공급자에 직접 낸다. NTrophy는 사용료를 재판매하지 않고 보안 가치에만 과금한다.
- 1인 1키를 쓸수록 탐지가 정확해지고 과금도 함께 늘어나는 구조다.

## 7. 구현 아키텍처

| 컴포넌트 구성 | 탐지·대응 시퀀스 |
|---|---|
| <img src="docs/screenshots/60-arch-components.png" alt="컴포넌트 아키텍처" width="420"> | <img src="docs/screenshots/61-arch-detection-sequence.png" alt="탐지와 자동 대응 시퀀스" width="420"> |
| **개인 사용자 WIF (목표 구성)** | **공급자 키 보관 (봉투 암호화)** |
| <img src="docs/screenshots/62-arch-personal-wif.png" alt="개인 사용자 WIF 흐름" width="420"> | <img src="docs/screenshots/63-arch-key-storage.png" alt="공급자 키 보관 구조" width="420"> |

**구성 요약** (상세 `docs/architecture.md`)
- 사용자: Web UI, OpenAI SDK, curl → HTTPS 요청.
- 진입점: Nginx Proxy Manager가 Let's Encrypt로 TLS를 종료하고 Proxmox VE의 LXC(Ubuntu) 컨테이너로 프록시.
- 게이트웨이 앱(Python, FastAPI, Uvicorn, systemd, 한 프로세스): OpenAI 호환 중계(`/v1/chat/completions`, 스트리밍), 접근 통제(허니키 → 허용 IP → 토큰/WIF → 서비스 상태), 관리자 API, 탐지·대응 워커, 사용량 집계·예측.
- 공급자 어댑터(`app/providers.py`): Mock, OpenRouter, OpenAI. 사용량 조회와 키 폐기를 공급자별로 감싼다.
- 저장소: SQLite(운영 전환 시 PostgreSQL). 평문 공급자 키는 DB에 없다(KMS 봉투 암호문만).

**보안 프로토콜 요지** (`docs/architecture.md` 5-1절)
- 인터넷 구간은 HTTPS. `X-Forwarded-For`는 신뢰 프록시에서 온 것만 인정.
- 사용자 인증: Bearer 게이트웨이 토큰(서버는 SHA-256 해시만 보관) 또는 RS256 JWT(서명·`exp`·`aud`·`iss` 검증).
- 게이트웨이 → AWS KMS: HTTPS + SigV4, `GenerateDataKey`·`Decrypt`만 허용된 최소 권한 IAM, 암호화 컨텍스트 바인딩. KMS 사용은 CloudTrail에 기록.

**공급자별 지연 (실측, `docs/contract.md`·`docs/architecture.md`)**

| 공급자 | 사용량 반영 지연 | 키 폐기 반영 |
|---|---|---|
| Mock | 2초 | 즉시 |
| OpenRouter | 사용액 약 6초(호출 수는 비용으로 추정) | 비활성화 후 최대 약 20초 |
| OpenAI | 95~381초(실측 2회, 편차 큼) | 서비스 계정 삭제 후 약 3초 |

탐지는 공급자 지연만큼 늦어지고, 그 사이 손실은 "호출 속도 × 지연"이다.

**기술 스택**

| 계층 | 기술 |
|---|---|
| 언어·웹 | Python 3, FastAPI, Uvicorn, httpx, asyncio |
| 암호·토큰 | cryptography(AES-256-GCM, Fernet, RS256), JWT, OIDC |
| 키 관리 | AWS KMS, boto3, AWS IAM, AWS CloudTrail (향후 HashiCorp Vault) |
| 저장소 | SQLite(PoC) → PostgreSQL(운영) |
| 인프라 | Nginx Proxy Manager, Let's Encrypt, Proxmox VE, LXC(Ubuntu 24.04), systemd |
| AI 공급자 | OpenAI API, OpenRouter API, Mock Provider(자체) |

## 8. 데모: 정상 → 유출 → 차단 → 복구

시나리오(상세 `docs/demo-scenario.md`): 주 키 K1·예비 키 S1 등록 → 정상 호출(차이 ≈ 0) → K1 유출 → 청중이 유출 키로 공급자에 직접 호출(또는 공격 시뮬레이터 초당 5건) → 자동 차단 → 사용자는 같은 토큰으로 계속 사용.

Mock 공격(초당 5건, 한도 100) 실측: 약 6초 SUSPECT → 14초 WARNING → 18초 BLOCKED → 21초 RECOVERED, 최종 손실 87건 / 한도 100 (`docs/frontend-handoff.md`, `docs/demo-scenario.md`).

### 상태 흐름
| NORMAL | SUSPECT | WARNING |
|---|---|---|
| <img src="docs/screenshots/10-console-home-normal.png" alt="콘솔 홈 정상 상태" width="300"> | <img src="docs/screenshots/11-console-home-suspect.png" alt="콘솔 홈 의심 상태" width="300"> | <img src="docs/screenshots/12-console-home-warning.png" alt="콘솔 홈 경고 상태" width="300"> |
| G와 P가 겹친다. 차이 ≈ 0 | P만 올라가며 "게이트웨이가 모르는 호출"이 생긴다 | 차이가 경고선을 넘어 경고 알림 |

| BLOCKED (자동 차단 팝업) | RECOVERED | 사고 타임라인 |
|---|---|---|
| <img src="docs/screenshots/13-console-home-blocked-popup.png" alt="자동 차단 팝업" width="300"> | <img src="docs/screenshots/14-console-home-recovered.png" alt="예비 키로 복구된 상태" width="300"> | <img src="docs/screenshots/15-console-incident-timeline.png" alt="사고 타임라인" width="300"> |
| 차단선 도달: 폐기 → 예비 키 승격 → 통보 → 검증 | 예비 키로 전환, 사용자 호출은 끊기지 않음 | 단계별 시각과 손실 호출 수 |

### 공격자(청중) 화면과 직원 화면
| 공격자: 준비 | 공격자: 채팅 중 | 공격자: 차단됨 | 직원: 채팅 | 직원: 차단 이후 |
|---|---|---|---|---|
| <img src="docs/screenshots/30-attacker-ready.png" alt="공격자 화면 준비" width="170"> | <img src="docs/screenshots/31-attacker-chatting.png" alt="공격자 채팅 중" width="170"> | <img src="docs/screenshots/32-attacker-blocked.png" alt="공격자 차단됨" width="170"> | <img src="docs/screenshots/33-employee-chat.png" alt="직원 채팅" width="170"> | <img src="docs/screenshots/34-employee-after-block.png" alt="차단 이후에도 이어지는 직원 채팅" width="170"> |

유출 키는 401로 막히고, 직원은 같은 게이트웨이 토큰으로 예비 키를 통해 계속 대화한다.

### 관리자 콘솔
| | | |
|---|---|---|
| <img src="docs/screenshots/20-usage.png" alt="사용량 화면" width="260"><br>사용량·월말 예측 | <img src="docs/screenshots/21-limits.png" alt="한도 설정 화면" width="260"><br>판정 방식·한도·허용 오차 | <img src="docs/screenshots/22-keys.png" alt="키 관리 화면" width="260"><br>공급자 키(마스킹) |
| <img src="docs/screenshots/23-keys-issue-sheet.png" alt="공급자 키 등록 시트" width="260"><br>공급자 키 등록 | <img src="docs/screenshots/24-access.png" alt="접근 제어 화면" width="260"><br>허용 IP·토큰·허니키 | <img src="docs/screenshots/25-incidents.png" alt="사고 목록" width="260"><br>사고 목록 |
| <img src="docs/screenshots/26-demo-control.png" alt="데모 제어 패널" width="260"><br>데모 제어(공격 시작·리셋) | <img src="docs/screenshots/27-connection-sheet.png" alt="서버 연결 설정" width="260"><br>서버 연결 설정 | <img src="docs/screenshots/16-console-home-dark.png" alt="콘솔 홈 다크 모드" width="260"><br>다크 모드 |

### 모바일과 테스트 페이지
| 모바일 홈 | 모바일 공격자 차단 | 모바일 직원 | 테스트 콘솔 `/test` | 자동 테스트 `/test/auto` |
|---|---|---|---|---|
| <img src="docs/screenshots/40-mobile-home.png" alt="모바일 콘솔 홈" width="150"> | <img src="docs/screenshots/41-mobile-attacker-blocked.png" alt="모바일 공격자 차단" width="150"> | <img src="docs/screenshots/42-mobile-employee.png" alt="모바일 직원 채팅" width="150"> | <img src="docs/screenshots/50-test-console.png" alt="기능 테스트 페이지" width="220"> | <img src="docs/screenshots/51-test-auto-pass.png" alt="자동 테스트 통과" width="220"> |

### 라이브 데모 경로 (https://sio2.kr)
| 화면 | 경로 |
|---|---|
| 랜딩 | `/` |
| 관리자 콘솔 | `/ui/index.html?server=https://sio2.kr` |
| 공격자(청중) 채팅 — 유출 키로 공급자 직접 호출 | `/ui/live.html` |
| 직원 채팅 — 게이트웨이 토큰으로 호출 | `/ui/employee.html` |
| 기능 테스트 / 자동 테스트 | `/test`, `/test/auto` |

관리자 화면에는 `X-Admin-Key`가 필요하다. 데모 서버는 **데모용 약한 관리자 키**를 쓰며 운영 전 반드시 교체해야 한다. 해커톤 시연에는 자체 GPU의 vLLM 공급자(`gpu-serving/`, `docs/vllm-gateway-spec.md`)도 썼지만 데모 전용이라 아키텍처에서는 뺐다.

## 9. 실행 방법

### 로컬 실행 (Windows)
```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\scripts\dev.ps1          # Mock Provider(9000) + Gateway(8000) 기동
```
- 콘솔: `http://127.0.0.1:8000/ui/index.html?server=http://127.0.0.1:8000`
- 테스트 페이지: `http://127.0.0.1:8000/test`, 청중 페이지(Mock): `http://127.0.0.1:9000/live`
- 데모 초기화: `POST /demo/reset` (WIF를 쓰려면 이어서 `POST /demo/wif/seed`)
- 공격 시작/중지: `POST /demo/attack/start`, `POST /demo/attack/stop`

### 점검 스크립트 (서버 기동 후)
```powershell
.\.venv\Scripts\python scripts\rehearse.py      # 리셋 → 정상 호출 → 공격 → 차단·복구 자동 점검, PASS/FAIL
.\.venv\Scripts\python scripts\demo_guard.py --gw http://127.0.0.1:8000 --mock http://127.0.0.1:9000 --mode mock
                                                # 기준선 대비 API 응답 형태 비교(처음엔 --capture로 기준선 저장)
```

### 주요 환경변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| `PUBLIC_MODE` | `0` | `1`이면 공개 모드: `/demo/*`·`/idp/token`도 관리자 키 필요, `/docs` 비활성 |
| `ADMIN_KEY` | 약한 고정 문자열 | `X-Admin-Key` 값. **공개 서버에서는 반드시 교체** |
| `TRUSTED_PROXIES` | (빈 값) | `X-Forwarded-For`를 믿을 직접 접속 IP |
| `KEY_BACKEND` | `fernet` | `kms`(AWS KMS 봉투 암호화, 서버) 또는 `fernet`(로컬) |
| `KMS_KEY_ID` / `AWS_REGION` | `alias/november-gateway-kek` / `ap-northeast-2` | KMS KEK와 리전 |
| `VAULT_KEY` | (없음) | fernet 키. 로컬은 없으면 `data/.vault_key` 자동 생성 |
| `DB_PATH` | `data/gateway.db` | SQLite 경로 |
| `TOLERANCE_CALLS` / `POLL_INTERVAL_S` | `0` / `1` | 허용 오차 기본값 / 탐지 워커 주기(초) |
| `OPENROUTER_MANAGEMENT_KEY` | (없음) | OpenRouter 라이브 모드(키 발급·사용량·폐기) |
| `OPENAI_ADMIN_KEY` / `OPENAI_PROJECT_ID` | (없음) | OpenAI 어댑터 |

전체 목록은 `app/contract.py`. `.env`는 `app/contract.py`가 직접 읽으며(이미 설정된 환경변수 우선) 저장소에 올리지 않는다.

### 실제 공급자 모드 (선택)
- OpenRouter: `POST /demo/reset-openrouter` → 정리 `POST /demo/cleanup-openrouter`
- OpenAI: `POST /demo/reset-openai` → 정리 `POST /demo/cleanup-openai`

### 서버 배포
```bash
bash scripts/deploy_test_server.sh <VMID>   # origin/main을 Proxmox LXC에 배포(멱등, 미커밋 변경 제외)
```
서버는 공개 모드 + KMS 백엔드로 systemd에서 실행되며, 데모 서버에는 실제 AI 키를 넣지 않는다. KMS 설정은 `docs/kms-setup.md`.

### 주요 API
| 구분 | 엔드포인트 | 인증 |
|---|---|---|
| 사용자 중계 | `POST /v1/chat/completions` (OpenAI 호환, 스트리밍) | `Bearer <게이트웨이 토큰 또는 JWT>` |
| 관리자 | `/admin/dashboard`, `/admin/settings`, `/admin/credentials`, `/admin/cidrs`, `/admin/tokens`, `/admin/honeykeys`, `/admin/incidents`, `/admin/usage/*` 등 | `X-Admin-Key` |
| 데모 | `/demo/reset`, `/demo/attack/start`·`stop`, `/demo/wif/seed` 등 | 공개 모드에서 `X-Admin-Key` |

스키마·에러 코드의 원본은 [`docs/contract.md`](docs/contract.md).

## 10. 문서 안내

| 문서 | 내용 |
|---|---|
| [`docs/contract.md`](docs/contract.md) | API 계약 원본(중계·관리자·탐지·판정 방식·허용 오차·공급자별 지연) |
| [`docs/architecture.md`](docs/architecture.md) | 컴포넌트·시퀀스·신뢰 경계·통신 구간별 보안·배포 구조 |
| [`docs/key-security-design.md`](docs/key-security-design.md) | 공급자 키 보관 설계(위협 모델, KMS 봉투 암호화, 격차·로드맵) |
| [`docs/kms-setup.md`](docs/kms-setup.md) | AWS KMS 설정 절차와 운영 반영 기록 |
| [`docs/multi-key-management-design.md`](docs/multi-key-management-design.md) | 다중 키·테넌트별 KEK 설계(미구현) |
| [`docs/feature-spec.md`](docs/feature-spec.md) | 기능 명세(F1~F15)와 상태 머신 |
| [`docs/demo-scenario.md`](docs/demo-scenario.md) | 발표 데모 시나리오와 준비 체크리스트 |
| [`docs/demo-page-spec.md`](docs/demo-page-spec.md) | 청중·직원 채팅 페이지 명세 |
| [`docs/frontend-handoff.md`](docs/frontend-handoff.md) | 화면별 API 매핑, 에러 코드, 샘플 JSON |
| [`docs/erd.md`](docs/erd.md) | 데이터 모델(ERD) |
| [`docs/vllm-gateway-spec.md`](docs/vllm-gateway-spec.md) | vLLM 계량·폐기 인터페이스(데모 전용) |
| [`docs/tech-stack-logos.md`](docs/tech-stack-logos.md) | 기술 스택 로고 출처와 사용 조건 |
| [`app/static/ui/README.md`](app/static/ui/README.md) | 웹 화면(콘솔·청중·직원) 안내 |

## 11. 한계와 로드맵

**알려진 한계**
- 공격자가 공급자에 **직접** 부르는 호출은 공급자 폐기가 확인되기 전까지 막을 수 없다. 자동 대응은 피해를 줄이는 도구이지 완전한 예방이 아니다.
- 탐지는 공급자 사용량 반영 지연만큼 늦다(OpenAI는 수 분).
- 개인 사용자 SSO·Device Code·사람 단위 예산은 설계만 있다. 외부 IdP 연동과 공급자 측 실제 WIF 연동은 하지 않았다(Mock STS로 대체).
- 관리자 통보는 콘솔 알림과 사고 기록뿐이다(이메일·메신저 채널 없음).
- 서버가 AWS 밖에 있어 KMS 인증에 장기 IAM 액세스 키를 쓴다(운영은 IAM Roles Anywhere 등으로 교체).
- 관리자 인증은 고정 관리자 키 하나다. 단일 프로세스·SQLite PoC다.
- 탐지 정확도·오탐률 같은 지표는 아직 체계적으로 측정하지 않았다. 위 수치는 문서에 기록된 시연 실측뿐이다.

**로드맵**
- 여러 공급자 간 사용량 비교 정확도 향상(Claude·Gemini 어댑터, 토큰 단위 비교)
- SIEM 등 보안 관제 시스템 연동, 외부 알림 채널
- HashiCorp Vault·동적(JIT) 키, 테넌트별 KEK, 정기 키 교체 자동화
- 개인 사용자 WIF(SSO), 관리자 역할 기반 접근, PostgreSQL 전환

**라이선스·로고 표기**: 별도 라이선스 파일이 없는 해커톤 출품용 PoC다. 아키텍처 그림의 기술 로고는 비상업 해커톤 발표용으로만 쓰며 각 로고는 해당 소유자의 상표다(`docs/tech-stack-logos.md`).
