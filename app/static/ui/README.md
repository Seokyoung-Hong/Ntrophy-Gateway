# Ntrophy Gateway — 웹 화면

[NovemberApiGateway](https://github.com/Seokyoung-Hong/NovemberApiGateway)(AI API 키 유출을 사용량 대조로 탐지하고 자동 차단하는 게이트웨이)의 기능을 모두 버튼과 화면으로 옮긴 프론트엔드입니다.
설치 없이 `index.html`을 브라우저로 열면 **브라우저 안 시뮬레이션**으로 전체 흐름이 그대로 움직입니다.

## 화면

| 파일 | 대상 | 내용 |
|---|---|---|
| `index.html` | 대표(관리자) | 홈(실시간 탐지) · 사용량 · 키·한도 · 접근 제어 · 사고, 우상단 **데모 제어** |
| `live.html` | 발표 청중 | 유출된 키로 공급자에 직접 채팅 → 키가 폐기되면 전체 화면 **“차단되었습니다”** |
| `employee.html` | 직원 | 게이트웨이 토큰으로 채팅 → 유출 키가 차단돼도 예비 키로 **끊김 없이** 계속 |

### 데모 순서 (약 1분)
1. `index.html` → **데모 제어** → **공격 시작**
2. 공급자 선만 올라가고 “게이트웨이가 모르는 호출”이 늘어남: 의심 → 경고
3. 한도의 70%에서 자동 차단: 키 폐기 → 예비 키 승격 → 통보 → 검증 (팝업 타임라인)
4. **사고** 탭에서 손실 호출 수 < 한도 확인

## 원본 기능 ↔ 화면

| 원본 (docs/contract.md) | 화면 위치 |
|---|---|
| D. `/admin/dashboard`, `/timeseries`, `/events` | 홈: 상태 카드, 한도 막대, 호출 수 비교 차트, 실시간 알림 |
| D. `/admin/incidents` | 사고 탭, 차단 순간 자동 팝업 |
| C. `/admin/settings` | 키·한도 → 허용 무단 호출 수 |
| C. `/admin/credentials`, I. `/{provider}/provision` | 키·한도 → 공급자 크레덴셜, 실제 공급자 키 만들기 |
| C. `/admin/cidrs`, `/services`, `/tokens`, `/access-denied` | 접근 제어 |
| E. 허니키, 서비스 정지/재개 | 접근 제어, 데모 제어 |
| H. `/admin/usage/*` | 사용량 탭 (집계·월말 예측·예산) |
| J. WIF 신뢰 규칙, `/demo/wif/*` | 접근 제어 → WIF 신뢰 규칙, 데모 제어 → WIF로 호출 |
| F. `/live/*` | `live.html` |
| B. `/v1/chat/completions` | `employee.html`, 데모 제어 → 직원 정상 호출 |

## 실서버로 라이브 시연

같은 화면이 원본 백엔드의 실제 데이터로 움직입니다.

**테스트 서버(hack.sio2.kr, 공개 모드)**: 권장
1. 콘솔을 `index.html?server=https://hack.sio2.kr`로 엽니다. 관리자 키 입력 창이 뜨면 담당자에게 받은 키를 넣습니다. 키는 이 브라우저에만 저장되고 링크·QR에는 들어가지 않습니다.
2. **데모 제어 → 데모 초기화**를 누릅니다. 직원 토큰이 새로 나오고, 같은 브라우저의 직원 화면에 자동으로 채워집니다.
3. 직원 화면이나 우리 앱이 `403 ip_not_allowed`를 받으면 **이 장소 IP 허용하기**(직원 화면) 또는 **접근 제어 → 최근 거부 기록 → 이 IP 허용**을 누릅니다. 리셋할 때마다 다시 눌러야 합니다.
4. **데모 제어 → 청중 QR**을 프로젝터에 띄웁니다. 청중 링크는 `live.html?server=https://hack.sio2.kr`입니다.

**내 컴퓨터에서 백엔드 실행**: 화면도 로컬에서 열어야 합니다. GitHub Pages(https)에서 localhost로 보내는 요청은 브라우저가 막습니다.
```
index.html?mode=live&api=http://localhost:8000&mock=http://localhost:9000
```

**우리 앱을 게이트웨이에 붙이기**: OpenAI 호환이라 SDK의 주소와 키만 바꿉니다. 콘솔이 호출을 그대로 집계합니다.
```python
from openai import OpenAI
client = OpenAI(base_url="https://hack.sio2.kr/v1", api_key="nvm-...")  # 콘솔에서 발급한 직원 토큰
client.chat.completions.create(model="mock", messages=[{"role": "user", "content": "안녕"}])
```

## 파일

| 파일 | 역할 |
|---|---|
| `css/app.css` | 디자인 토큰(라이트·다크)과 모든 컴포넌트 |
| `js/api.js` | 화면이 서버와 이야기하는 유일한 창구. `sim` / `live` / `auto` |
| `js/sim.js` | 원본 판정 규칙(호출 수 차이, 10/50/70%, 2초 지연, 히스테리시스)을 그대로 옮긴 시뮬레이터. 응답 모양이 실서버와 같음 |
| `js/ui.js` | 아이콘, 토스트, 바텀시트, 차트 |
| `js/console.js` · `js/live.js` · `js/employee.js` | 각 화면 |

디자인 규칙
- 파랑 = 게이트웨이 기록, 주황 = 공급자 보고. 다른 의미로 쓰지 않습니다.
- 상태색(초록·노랑·빨강)은 상태에만 쓰고 항상 글자·아이콘과 함께 씁니다.
- 화면에서 가장 큰 것은 “게이트웨이가 모르는 호출” 숫자 하나입니다.
- 현재 이 웹 디자인은 테스트 버전입니다.
