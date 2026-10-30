"""관리자 키 검사·출발 IP 결정·공개 모드 가드. 게이트웨이와 Mock이 함께 쓴다(gateway 모듈 import 금지). 계약 K절."""
import hmac

from fastapi.responses import JSONResponse

from app.contract import ADMIN_KEY, DEMO_MODE, PUBLIC_MODE, TRUSTED_PROXIES

PROTECTED = ("/demo/", "/idp/token")  # PUBLIC_MODE에서 X-Admin-Key 필요(/admin/*은 라우터가 항상 검사)


def admin_ok(key) -> bool:
    return hmac.compare_digest((key or "").encode(), ADMIN_KEY.encode())


def client_ip(request) -> str:
    """직접 접속이 신뢰 프록시면 XFF의 가장 오른쪽 비신뢰 값(없으면 첫 값). X-Demo-Source-IP는 DEMO_MODE이고
    (공개 모드가 아니거나 유효한 관리자 키가 있을 때)만."""
    ip = request.client.host if request.client else ""
    if ip in TRUSTED_PROXIES:
        hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
        ip = next((h for h in reversed(hops) if h not in TRUSTED_PROXIES), hops[0] if hops else ip)
    demo = request.headers.get("x-demo-source-ip")
    if demo and DEMO_MODE and (not PUBLIC_MODE or admin_ok(request.headers.get("x-admin-key"))):
        ip = demo
    return ip


async def public_guard(request, call_next):
    """app.middleware("http")용. PUBLIC_MODE에서 PROTECTED 경로는 관리자 키 필요."""
    if PUBLIC_MODE and request.url.path.startswith(PROTECTED) and not admin_ok(request.headers.get("x-admin-key")):
        return JSONResponse({"detail": "invalid_admin_key"}, status_code=401)
    return await call_next(request)


if __name__ == "__main__":  # 최소 자체 검증(기본 환경: PUBLIC_MODE 꺼짐)
    from types import SimpleNamespace as N
    TRUSTED_PROXIES.add("10.0.0.1")
    req = lambda host, **h: N(client=N(host=host), headers={k.replace("_", "-"): v for k, v in h.items()})
    assert client_ip(req("10.0.0.1", x_forwarded_for="1.1.1.1, 2.2.2.2, 10.0.0.1")) == "2.2.2.2"
    assert client_ip(req("10.0.0.1", x_forwarded_for="10.0.0.1")) == "10.0.0.1"
    assert client_ip(req("9.9.9.9", x_forwarded_for="1.1.1.1")) == "9.9.9.9"
    assert admin_ok(ADMIN_KEY) and not admin_ok(None)
    print("clientip ok")
