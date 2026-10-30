"""모델별 단가표로 게이트웨이가 직접 계산하는 예상 비용. 계약: docs/contract.md H."""
try:
    from app.contract import USD_TO_KRW
except ImportError:
    USD_TO_KRW = 1400

# USD / 1M 토큰 (입력, 출력). 공급자 가격표는 변경될 수 있음 — 주기적으로 확인해 갱신할 것.
PRICES = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "claude-3.5-haiku": (0.80, 4.00),
    "claude-sonnet-4": (3.00, 15.00),
}
DEFAULT_PRICE = PRICES["gpt-4o-mini"]  # 알 수 없는 모델(mock 등)


def price_of(model) -> tuple[tuple[float, float], bool]:
    """((입력, 출력) USD/1M, estimated). 'openai/gpt-4o' 같은 공급자 접두는 떼고 찾는다."""
    p = PRICES.get((model or "").split("/")[-1])
    return (p, False) if p else (DEFAULT_PRICE, True)


def estimate_cost_usd(model, input_tokens, output_tokens) -> float:
    (pi, po), _ = price_of(model)
    return ((input_tokens or 0) * pi + (output_tokens or 0) * po) / 1e6


def estimate_cost_krw(model, input_tokens, output_tokens) -> float:
    return estimate_cost_usd(model, input_tokens, output_tokens) * USD_TO_KRW


if __name__ == "__main__":
    assert abs(estimate_cost_usd("openai/gpt-4o-mini", 1_000_000, 1_000_000) - 0.75) < 1e-9
    assert price_of("mock-x")[1] is True and price_of("gpt-4o")[1] is False
    print("ok")
