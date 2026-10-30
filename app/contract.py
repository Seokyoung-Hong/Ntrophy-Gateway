"""공용 계약: 모든 트랙이 여기서 import한다. 수정 금지(오케스트레이터만)."""
import hashlib
import os
from pathlib import Path

# .env 직접 파싱(이미 설정된 환경변수 우선). 게이트웨이·Mock 둘 다 이 모듈을 import하므로 여기서 한 번.
_env = Path(__file__).resolve().parents[1] / ".env"
if _env.exists():
    for _l in _env.read_text(encoding="utf-8").splitlines():
        _k, _, _v = _l.strip().partition("=")
        if _k and not _k.startswith("#") and _v:
            os.environ.setdefault(_k.strip(), _v.strip().strip("\"'"))

GATEWAY_PORT = 8000
MOCK_PORT = 9000
MOCK_BASE_URL = os.getenv("MOCK_BASE_URL", "http://127.0.0.1:9000")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_BASE_URL = "https://api.openai.com/v1"
# M. vLLM(자체 GPU): 앞단 게이트웨이가 키별 계량·폐기 제공(docs/vllm-gateway-spec.md)
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://127.0.0.1:8100").rstrip("/")
VLLM_ADMIN_KEY = os.getenv("VLLM_ADMIN_KEY", "")
VLLM_MODEL = os.getenv("VLLM_MODEL", "google/gemma-4-E2B-it-qat-w4a16-ct")
PROVIDERS = {"mock": MOCK_BASE_URL, "openrouter": OPENROUTER_BASE_URL, "openai": OPENAI_BASE_URL,
             "vllm": VLLM_BASE_URL}  # 공급자 이름 -> base_url
ADMIN_KEY = os.getenv("ADMIN_KEY", "admin")  # X-Admin-Key (/admin/*, 공개 모드면 /demo/*·/idp/token도)
PUBLIC_MODE = os.getenv("PUBLIC_MODE", "0") == "1"  # 인터넷 공개용(K절)
TRUSTED_PROXIES = {p.strip() for p in os.getenv("TRUSTED_PROXIES", "").split(",") if p.strip()}  # XFF를 믿을 직접 접속 IP
DB_PATH = os.getenv("DB_PATH", "data/gateway.db")
DEMO_MODE = os.getenv("DEMO_MODE", "1") == "1"

COST_PER_TOKEN_KRW = 0.4  # 게이트웨이·Mock 동일 공식
DEFAULT_LIMIT_KRW = 100_000  # 참고 표시용(금액은 더 이상 판정 기준 아님)
DEFAULT_LIMIT_CALLS = 100  # 판정 기준: 허용하는 '설명되지 않는 호출 수'(사장이 설정)
DEFAULT_TOLERANCE_CALLS = int(os.getenv("TOLERANCE_CALLS", "0"))  # 허용 오차 기본값. 실제 값은 setting.tolerance_calls(관리자 설정)
SUSPECT_RATIO, WARN_RATIO, BLOCK_RATIO = 0.1, 0.5, 0.7
TOLERANCE_KRW = 5_000
POLL_INTERVAL_S = float(os.getenv("POLL_INTERVAL_S", "1"))  # 탐지 워커 주기. 공급자별 하한은 어댑터 min_poll_s
MOCK_USAGE_LAG_S = 2  # Mock 집계 지연
LEAKED_KEY = os.getenv("LEAKED_KEY", "sk-mock-K1-leaked-demo")  # 시드 K1의 키 값(청중에게 '유출'로 공개되는 값)
ATTACK_RPS = 5
ATTACK_MAX_TOKENS = 2000  # 건당 800원
ATTACK_MAX_TOKENS_VLLM = 30  # GPU 부하를 줄이기 위해 작게
WIF_TOKEN_TTL_S = 900

# G. OpenRouter 라이브 모드
USD_TO_KRW = 1400
OPENROUTER_USAGE_LAG_S = 8  # 관리 키 GET /keys/{hash} usage 반영 지연(실측 약 6초) + 여유
OPENROUTER_REVOKE_LAG_S = 20  # disabled:true 후 실제 401까지(실측 약 20초)
OPENROUTER_MODEL = "openai/gpt-4o-mini"
OPENROUTER_LIMIT_CALLS = 100  # reset-openrouter/openai 시드 한도(호출 수, 추정치 기준). 실측: 500은 청중 80건에도 미차단
# 비용 -> 호출 수 추정: 최근 게이트웨이 호출 평균 비용을 [MIN, MAX]로 보정. 사용자의 짧은 호출만 있으면 평균이 작아 추정이 부풀기 때문.
DEFAULT_CALL_COST_USD = 0.000016  # 이력이 없을 때(청중 1건 실측 약 $0.000016, gpt-4o-mini)
CALL_COST_MIN_USD, CALL_COST_MAX_USD = 0.000012, 0.0002
CALL_COST_RECENT_N = 20
HYSTERESIS_S = 10  # 판정 상승은 즉시, 하강은 낮은 판정이 이 시간 유지될 때만
# OpenAI: Usage API num_model_requests 반영 실측 약 381초 -> 420. 서비스 계정 삭제 후 401까지 실측 2.8초.
OPENAI_USAGE_LAG_S = 420
OPENAI_REVOKE_LAG_S = 3
OPENAI_MODEL = "gpt-4o-mini"
OPENAI_PROJECT_ID = os.getenv("OPENAI_PROJECT_ID", "proj_xkSCJaCHHKA3GEm5bEm02pHJ")
USAGE_LAG_S = {"mock": MOCK_USAGE_LAG_S, "openrouter": OPENROUTER_USAGE_LAG_S, "openai": OPENAI_USAGE_LAG_S,
               "vllm": float(os.getenv("USAGE_LAG_S_VLLM", "0"))}
RATIOS = {"mock": (SUSPECT_RATIO, WARN_RATIO, BLOCK_RATIO), "vllm": (SUSPECT_RATIO, WARN_RATIO, BLOCK_RATIO),  # 실제 공급자는 지연이 커서 낮춤
          "openrouter": (0.05, 0.2, 0.35), "openai": (0.05, 0.2, 0.35)}
LIVE_KEY_PATH = os.path.join(os.path.dirname(DB_PATH) or ".", "live_key.json")  # 프로비저닝한 유출 키(OpenRouter 모드)


def cost_krw(tokens: int) -> float:
    return tokens * COST_PER_TOKEN_KRW


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def mask_key(key: str) -> str:
    return f"{key[:3]}...{key[-4:]}" if len(key) > 8 else "***"


def effective_diff(provider_krw: float, gateway_krw: float) -> float:
    """허용 오차 차감 후 설명되지 않는 사용액. 음수는 0."""
    return max(0.0, provider_krw - gateway_krw - TOLERANCE_KRW)


def effective_calls_diff(provider_calls: int, gateway_calls: int, tol: int = DEFAULT_TOLERANCE_CALLS) -> int:
    """공급자가 보고했지만 게이트웨이(+내부 호출)가 모르는 호출 수(허용 오차 tol 차감 후). 판정 기준."""
    return max(0, provider_calls - gateway_calls - tol)


def judge(diff: float, limit: float, ratios=RATIOS["mock"]) -> str:
    """effective_calls_diff(호출 수)와 한도(호출 수)로 판정: NORMAL | SUSPECT | WARNING | BREACH.
    ratios = (SUSPECT, WARN, BLOCK) 비율, 공급자별(RATIOS)."""
    r = diff / limit
    suspect, warn, block = ratios
    if r >= block:
        return "BREACH"
    if r >= warn:
        return "WARNING"
    if r >= suspect:
        return "SUSPECT"
    return "NORMAL"


# O. 판정 방식. detection_mode 미설정 = 레거시(한도 하나 × RATIOS). 설정 시 사용자가 정한 임계를 쓴다.
DETECTION_MODES = {"usage_pct": ("suspect_pct", "warn_pct", "block_pct"), "calls": ("suspect_calls", "warn_calls", "block_calls")}
DETECTION_DEFAULTS = {"suspect_pct": 5, "warn_pct": 10, "block_pct": 20, "suspect_calls": 1, "warn_calls": 5, "block_calls": 10}


def measure(mode: str, diff: int, provider_calls: int) -> float:
    """usage_pct: 공급자 보고 중 게이트웨이가 모르는 호출 비율(%), calls: 오차 차감 후 건수."""
    if mode == "calls":
        return diff
    return diff / provider_calls * 100 if provider_calls > 0 else 0.0


def judge_th(value: float, th) -> str:
    """임계 (의심, 경고, 차단)과 비교. 0은 항상 NORMAL."""
    if value >= th[2]:
        return "BREACH"
    if value >= th[1]:
        return "WARNING"
    if value > 0 and value >= th[0]:
        return "SUSPECT"
    return "NORMAL"


if __name__ == "__main__":  # 최소 자체 검증
    assert [judge_th(measure("usage_pct", d, 100), (5, 10, 20)) for d in (0, 5, 10, 20)] == ["NORMAL", "SUSPECT", "WARNING", "BREACH"]
    assert [judge_th(measure("calls", d, 0), (1, 5, 10)) for d in (0, 1, 5, 10)] == ["NORMAL", "SUSPECT", "WARNING", "BREACH"]
    assert measure("usage_pct", 3, 0) == 0
    assert cost_krw(2000) == 800
    assert effective_diff(4000, 0) == 0 and effective_diff(30_000, 5_000) == 20_000
    assert [judge(d, 100) for d in (0, 10, 50, 70)] == ["NORMAL", "SUSPECT", "WARNING", "BREACH"]
    assert [judge(d, 100, RATIOS["openrouter"]) for d in (4, 5, 20, 35)] == ["NORMAL", "SUSPECT", "WARNING", "BREACH"]
    assert effective_calls_diff(20, 10, 3) == 7 and effective_calls_diff(11, 10, 0) == 1 and effective_calls_diff(5, 10) == 0
    print("contract ok")


# Gemma 4 권장 설정(Google): temperature 1.0, top_p 0.95, top_k 64. 시스템 역할 지원, 빠른 채팅이라 생각(thinking) 끔.
GEMMA_SYSTEM_PROMPT = (
    "당신은 Ntrophy Gateway 체험 화면의 AI 어시스턴트입니다. "
    "사용자가 쓴 언어로 답하고, 한국어 질문에는 자연스러운 한국어 존댓말로 답하세요. "
    "핵심부터 간결하게 3~5문장 안으로 말하고, 불필요한 서론과 반복은 피하세요. "
    "답하기 전에 짧게 단계별로 따져 보되(계산·논리 문제만), 풀이 과정은 한두 문장으로 줄여 최종 답과 함께 보여 주세요. "
    "모르는 내용은 지어내지 말고 모른다고 말하세요. "
    "목록이나 짧은 코드 블록이 도움이 될 때만 사용하세요."
)


def gemma_tune(body: dict) -> dict:
    """vLLM(Gemma 4) 요청에 시스템 프롬프트와 권장 샘플링을 기본값으로 채운다. 호출자가 준 값은 덮어쓰지 않는다."""
    msgs = list(body.get("messages") or [])
    if not any(m.get("role") == "system" for m in msgs):
        msgs.insert(0, {"role": "system", "content": GEMMA_SYSTEM_PROMPT})
    return {"temperature": 1.0, "top_p": 0.95, "top_k": 64, "chat_template_kwargs": {"enable_thinking": False},
            **body, "messages": msgs}
