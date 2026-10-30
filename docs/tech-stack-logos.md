# 기술 스택 로고 출처 및 사용 조건

조사일: 2026-10-31. 이미지는 저장소에 넣지 않았고 출처 URL만 적었다. "확인함" = 해당 URL을 실제로 열어 내용을 확인함(요약 도구 경유). "부분" = 페이지는 열었으나 다운로드 링크나 조건 일부를 못 봄. "확인 불가" = 못 열었거나 근거 없음.

## 0. 사용 범위 결정 (프로젝트 담당자 확인)
- 이 프로젝트는 **비상업 해커톤 발표용**이므로 표의 로고를 **모두 사용해도 된다**고 결정했다(담당자 확인, 2026-10-31). 비상업 조건을 요구하는 로고(Let's Encrypt의 CC BY-NC 등)와 상업·광고 사용에 허락이 필요한 로고(WireGuard)도 이 용도에서는 사용한다.
- **비상업이어도 지켜야 할 것**: 출처·저작자 표기(CC BY-NC는 표기 필수), 로고 **변형 금지**(비율·색·요소 배치), 후원·제휴·인증으로 **오인되게 쓰지 않기**, Proxmox 등은 자사 브랜딩보다 눈에 띄지 않게 쓰기.
- **재검토 조건**: 상업 서비스·제품 소개·판매 자료로 전환하거나 자료를 외부에 배포할 때는 각 로고의 조건과 허락 여부를 다시 확인한다.

## 1. 사용 원칙
1. 공식 브랜드/프레스 페이지나 공식 저장소에서 받는다. Simple Icons 등 모음은 보조로만 쓴다.
2. 로고를 변형하지 않는다(비율·색·요소 배치 변경, 회전, 효과 금지). 제공된 흑백·반전 변형만 쓴다.
3. 로고는 상표다. 후원·제휴·인증으로 오인되게 쓰지 않고, 자사 로고처럼 쓰지 않는다. 그림에는 기술 이름을 옆에 적는다.
4. 라이선스(CC BY, NC 등)와 상업 사용 제한을 확인하고, 필요하면 출처를 표기한다.
5. 로고가 없는 개념(OAuth, PKCE 등)은 로고를 만들지 말고 텍스트 박스로 그린다.

## 2. 로고 출처 표

| 컴포넌트 | 기술 | 로고 출처 URL | 형식 | 사용 조건(한 줄) | 확인 여부 |
|---|---|---|---|---|---|
| 게이트웨이 앱 | Python | https://www.python.org/community/logos/ (정책: https://www.python.org/psf/trademarks/) | SVG, PNG, PSD | 원본 그대로, TM 표기 유지, 파생은 허락 필요, 상업 굿즈는 PSF 허가 | 확인함 |
| 게이트웨이 앱 | FastAPI | https://github.com/fastapi/fastapi/tree/master/docs/en/docs/img (icon-white.svg, logo-teal.svg 등) | SVG | 라이선스·사용 조건 확인 불가(저장소 LICENSE 미열람) | 부분(파일 목록만) |
| 게이트웨이 앱 | Uvicorn | https://www.uvicorn.org/ | - | 사이트 접속 실패 | 확인 불가 |
| 게이트웨이 앱 | httpx | https://www.python-httpx.org/ | - | 로고·라이선스 정보를 페이지에서 못 찾음 | 확인 불가 |
| 사용량 DB | SQLite | https://www.sqlite.org/images/ (404) | - | 공식 로고 정책 확인 불가 | 확인 불가 |
| 암호화 | cryptography(Fernet) | - | - | 공식 로고 확인 불가 → 텍스트 박스 권장 | 확인 불가 |
| 서버 프로세스 | systemd | - | - | 조사 안 함 → 텍스트 박스 권장 | 확인 불가 |
| 서버 호스트 | Proxmox VE (LXC) | https://www.proxmox.com/en/about/company-details/media-kit | 로고 팩(형식 미확인) | 링크·기사·자사보다 덜 눈에 띄게만 허용. 자사 아이콘화, 변형, 요소 재배치 금지 | 확인함 |
| 서버 OS | Ubuntu | https://canonical.com/legal/trademarks (정책 안내만. 다운로드는 design.ubuntu.com/brand/ 로 안내됨) | 확인 불가 | Canonical 등록상표, 사용 허가 여부는 브랜드 가이드 확인 필요 | 부분(brand.ubuntu.com 접속 실패) |
| 중계 | Nginx (nginx.org) | https://nginx.org/img/nginx_logo.svg, nginx_logo_dark.svg (홈페이지에서 참조되는 경로) | SVG | 별도 브랜드 가이드 페이지 없음. F5 상표이므로 필요 시 F5에 문의 | 부분 |
| 중계 NPM | Nginx Proxy Manager | https://nginxproxymanager.com/ , 저장소 https://github.com/NginxProxyManager/nginx-proxy-manager | PNG(github.png 참조) | 소프트웨어는 MIT. 로고 별도 조건은 확인 불가 | 부분 |
| TLS 인증서 | Let's Encrypt | https://www.abetterinternet.org/trademarks/ | EPS, SVG, PNG | 무변형, 다른 내용과 분리, 가장 눈에 띄는 요소 금지(개인·비상업 예외). 디자인은 CC BY-NC 4.0 + 상표정책 | 확인함 |
| VPN | WireGuard | https://www.wireguard.com/ (정책 https://www.wireguard.com/trademark-policy/) | SVG(사이트 로고) | 무변형, 상업·광고·굿즈 사용은 소유자 허락(이메일 요청으로 허락 가능) | 확인함(다운로드 링크는 못 봄) |
| VPN(참고) | Tailscale | https://tailscale.com/brand , https://tailscale.com/press | - | brand 404. press 페이지에 미디어킷 있다고만 확인 | 확인 불가 |
| 인증 | OpenID Connect | https://openid.net/certification/mark/ (인증 마크 안내), https://openid.net/intellectual-property/policies/ | 확인 불가 | OpenID 로고·인증 마크는 정책 확인 필요. 인증 오인 주의 | 부분 |
| 인증 | JWT (jwt.io) | https://jwt.io/introduction | 확인 불가 | 페이지에 로고 우클릭 메뉴가 있다고만 확인. 공식 사용 조건 확인 불가 | 부분 |
| 인증 | OAuth 2.0, PKCE, Device Authorization Grant | - | - | 공식 로고 없음(조사 안 함) → 텍스트 박스 | 확인 불가 |
| 키 보관(목표) | AWS KMS | https://aws.amazon.com/architecture/icons/ (상표: https://aws.amazon.com/trademark-guidelines/) | PPT, 아이콘 패키지(SVG/PNG 추정, 미확인) | 아이콘 변형 금지, AWS 후원·승인 암시 금지, 자사 이름·브랜드와 결합 금지 | 확인함(KMS 아이콘 존재는 미확인) |
| 키 보관(목표) | HashiCorp Vault | https://www.hashicorp.com/brand | 확인 불가 | 가이드라인 준수 시 별도 계약 없이 사용, HashiCorp가 언제든 변경·취소 가능. 가이드 외 용도는 목업 보내 문의 | 확인함(다운로드 형식은 못 봄) |
| 키 보관(목표) | Google Cloud KMS | https://cloud.google.com/icons | 확인 불가 | 내용 미완 수신. 조건 확인 불가 | 확인 불가 |
| IdP | Google Workspace | https://developers.google.com/workspace/brand-guidelines (404), https://partnermarketinghub.withgoogle.com/brands/google/overview/ (리다이렉트 안내만, 미열람) | - | 확인 불가 | 확인 불가 |
| IdP | Microsoft Entra ID | https://learn.microsoft.com/en-us/entra/architecture/architecture-icons (약관 동의 후 ZIP 다운로드) | ZIP(아이콘 팩) | 아키텍처 그림·교육·문서에만 허용. 자르기·뒤집기·회전·왜곡 금지, 자사 제품 대표 금지, 제품명을 아이콘 근처에 표기 권장 | 확인함 |
| IdP | GitHub(Actions) | https://brand.github.com/foundations/logo (ZIP: https://brand.github.com/GitHub_Logos.zip) | ZIP(형식 미확인) | 흰·검정·회색·초록만, 효과·왜곡·재배치 금지, 제휴 암시 금지. Actions 전용 로고는 확인 불가 | 확인함 |
| AI 공급자 | OpenAI | https://openai.com/brand/ | - | 403으로 열람 실패 | 확인 불가 |
| AI 공급자 | OpenRouter | https://openrouter.ai/brand | SVG, PNG(2x), ZIP | 늘리기·재색·리믹스 금지. 4색(Grape/Volt/Ink/Cloud) 중 배경에 맞게 선택 | 확인함 |
| AI 공급자 | vLLM | https://github.com/vllm-project/media-kit | SVG, PNG | 여백 확보, 왜곡 금지, 배경에 맞는 라이트/다크 선택. 라이선스 문구는 확인 불가 | 확인함 |
| AI 모델(참고) | Google Gemma | - | - | 조사 안 함 | 확인 불가 |
| 문서 | Mermaid | https://mermaid.js.org/ | - | 홈페이지에서 로고 자료 페이지 못 찾음 | 확인 불가 |
| 문서 | Git | https://git-scm.com/community/logos | PNG, EPS, SVG | CC BY 3.0, 상업 사용 가능, 제작자(Jason Long) 표기 필요 | 확인함 |
| 문서 | Markdown | https://github.com/dcurtis/markdown-mark | SVG, PNG, PSD, AI 등 | 퍼블릭 도메인. 가급적 비율·단색 유지 권장 | 확인함 |
| 문서 | GitHub (저장소) | 위 GitHub 행과 동일 | | 위와 동일 | 확인함 |
| 보조 | Simple Icons | https://github.com/simple-icons/simple-icons (https://simpleicons.org/) | SVG | 아이콘 모음은 CC0이나 각 브랜드 상표는 별개. 법적 고지 확인 필요. 공식 출처가 없을 때만 보조로 사용 | 확인함 |

## 3. 아키텍처 컴포넌트와 기술 대응

| 아키텍처 박스 | 기술(로고 후보) |
|---|---|
| 게이트웨이 앱 | Python + FastAPI + Uvicorn (+ httpx 클라이언트) |
| 서버 | Proxmox VE의 LXC 컨테이너, OS는 Ubuntu, 프로세스 관리는 systemd |
| 중계 NPM | Nginx Proxy Manager (내부는 Nginx) |
| 인증서 | Let's Encrypt |
| 사설망(필요 시) | WireGuard, Tailscale(참고) |
| 사용량 DB | SQLite |
| 암호화 | cryptography / Fernet |
| 키 보관(목표) | AWS KMS, HashiCorp Vault, Google Cloud KMS 중 선택 |
| 로그인 프로토콜 | OpenID Connect, OAuth 2.0, PKCE, Device Authorization Grant, JWT |
| IdP | Google Workspace, Microsoft Entra ID, GitHub(Actions) |
| 공급자 | OpenAI, OpenRouter, vLLM (참고: Gemma) |
| 문서·도구 | Mermaid, Git/GitHub, Markdown |

## 4. 로고가 없거나 쓰기 어려운 항목과 대안

- 로고 없음 또는 확인 불가: OAuth 2.0, PKCE, Device Authorization Grant, systemd, cryptography/Fernet, SQLite(공식 정책 확인 불가), Uvicorn, httpx. 대안은 텍스트 박스(이름만)나 범용 아이콘(자물쇠, DB 원통, 서버).
- 조건이 까다로움: Proxmox(자사 아이콘화·변형 금지, 덜 눈에 띄게), WireGuard(상업 사용은 허락 필요), Let's Encrypt(CC BY-NC, 가장 눈에 띄는 요소 금지), Python(파생 허락 필요, TM 표기), HashiCorp(사용 허가가 언제든 취소될 수 있음). 이런 로고는 작게 넣고 제품명을 함께 적는다.
- 접속 실패로 직접 확인 필요: OpenAI(403), Tailscale(brand 404), Google Workspace·Cloud KMS·Gemma, Ubuntu(brand.ubuntu.com), Uvicorn, SQLite. 디자이너가 브라우저로 직접 열어 약관을 확인하고, 안 되면 텍스트 박스로 대체한다.
- 공개 아이콘 모음(Simple Icons)은 최후 수단이며 보조 출처로만 표기한다.
