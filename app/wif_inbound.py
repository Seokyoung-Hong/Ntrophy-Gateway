"""사용자 측 WIF(OIDC JWT) 인바운드 인증 + 신뢰 규칙 관리 + 데모용 로컬 IdP. 계약: docs/contract.md J."""
import base64
import json
import os
import time
from fnmatch import fnmatch
from typing import Optional

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.contract import DEMO_MODE
from app.db import get_conn
from app.gateway.router import _admin, now_iso

router = APIRouter()
LEEWAY_S = 30
JWKS_TTL_S = 300
DEFAULT_AUDIENCE = "november-gateway"
IDP_ISSUER = os.getenv("IDP_ISSUER", "http://localhost:8000/idp")
_jwks_cache: dict[str, tuple[dict, float]] = {}  # jwks_uri -> ({kid: key}, 만료 epoch)


class WifError(Exception):
    def __init__(self, reason: str, sub: str = ""):
        super().__init__(reason)
        self.reason, self.sub = reason, sub


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _int_b64(n: int) -> str:
    return _b64e(n.to_bytes((n.bit_length() + 7) // 8, "big"))


def _jwk_to_key(k: dict):
    return rsa.RSAPublicNumbers(int.from_bytes(_b64d(k["e"]), "big"), int.from_bytes(_b64d(k["n"]), "big")).public_key()


# ---------------- 데모 로컬 IdP (키는 메모리, 재시작 시 새로 생성) ----------------
_idp_key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if DEMO_MODE else None
IDP_KID = "local-1"


def _idp_jwks() -> dict:
    pub = _idp_key.public_key().public_numbers()
    return {"keys": [{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": IDP_KID, "n": _int_b64(pub.n), "e": _int_b64(pub.e)}]}


def idp_sign(sub: str, audience: str, ttl_s: int = 600) -> str:
    now = int(time.time())
    h = _b64e(json.dumps({"alg": "RS256", "typ": "JWT", "kid": IDP_KID}).encode())
    p = _b64e(json.dumps({"iss": IDP_ISSUER, "sub": sub, "aud": audience, "iat": now, "nbf": now, "exp": now + ttl_s}).encode())
    sig = _idp_key.sign(f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{h}.{p}.{_b64e(sig)}"


def _keys_for(issuer: str, jwks_uri: Optional[str]) -> dict:
    if DEMO_MODE and issuer == IDP_ISSUER:
        return {k["kid"]: k for k in _idp_jwks()["keys"]}
    if not jwks_uri:
        return {}
    keys, exp = _jwks_cache.get(jwks_uri, ({}, 0.0))
    if time.time() > exp:
        # ponytail: 동기 httpx(요청 경로 최대 5초 블록), 5분 캐시라 드묾. 부하 커지면 async로
        try:
            keys = {k.get("kid"): k for k in httpx.get(jwks_uri, timeout=5).raise_for_status().json().get("keys", [])}
        except (httpx.HTTPError, ValueError):
            return keys  # 조회 실패 시 이전 캐시(없으면 빈 값 → 서명 실패)
        _jwks_cache[jwks_uri] = (keys, time.time() + JWKS_TTL_S)
    return keys


def _default_audience() -> str:
    with get_conn() as c:
        r = c.execute("SELECT value FROM setting WHERE key='wif_audience'").fetchone()
    return r["value"] if r else DEFAULT_AUDIENCE


def verify_jwt(token: str, source_ip: str = "") -> int:
    """RS256 JWT 검증 → 신뢰 규칙의 service_id. 실패 시 WifError(reason, sub). source_ip는 호출자가 이미 검사."""
    try:
        h64, p64, s64 = token.split(".")
        header, claims, sig = json.loads(_b64d(h64)), json.loads(_b64d(p64)), _b64d(s64)
        if not isinstance(header, dict) or not isinstance(claims, dict):
            raise ValueError
    except (ValueError, TypeError):
        raise WifError("wif_malformed")
    sub = str(claims.get("sub") or "")
    if header.get("alg") != "RS256":  # none·HS256 등 거부(alg 혼동 공격 방지)
        raise WifError("wif_invalid_signature", sub)
    with get_conn() as c:
        rules = c.execute("SELECT * FROM trusted_identity WHERE issuer=?", (str(claims.get("iss")),)).fetchall()
    if not rules:
        raise WifError("wif_untrusted_identity", sub)
    jwk = _keys_for(rules[0]["issuer"], next((r["jwks_uri"] for r in rules if r["jwks_uri"]), None)).get(header.get("kid"))
    try:
        if not jwk:
            raise InvalidSignature
        _jwk_to_key(jwk).verify(sig, f"{h64}.{p64}".encode(), padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError, KeyError, TypeError):
        raise WifError("wif_invalid_signature", sub)
    now = time.time()
    exp, nbf = claims.get("exp"), claims.get("nbf", 0)
    if not isinstance(exp, (int, float)) or not isinstance(nbf, (int, float)):
        raise WifError("wif_malformed", sub)
    if now > exp + LEEWAY_S or now < nbf - LEEWAY_S:
        raise WifError("wif_expired", sub)
    aud = claims.get("aud")
    auds = set(aud) if isinstance(aud, list) else {aud}
    default_aud = _default_audience()
    rules = [r for r in rules if (r["audience"] or default_aud) in auds]
    if not rules:
        raise WifError("wif_audience_mismatch", sub)
    for r in rules:
        if sub and fnmatch(sub, r["subject_pattern"]):
            return r["service_id"]
    raise WifError("wif_untrusted_identity", sub)


# ---------------- 관리자 API ----------------
admin = APIRouter(prefix="/admin", dependencies=[Depends(_admin)])


class RuleIn(BaseModel):
    issuer: str
    subject_pattern: str
    audience: Optional[str] = None
    service_id: Optional[int] = None
    service_name: Optional[str] = None
    jwks_uri: Optional[str] = None


@admin.get("/trusted-identities")
def list_rules():
    with get_conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM trusted_identity ORDER BY id")]


@admin.post("/trusted-identities")
def add_rule(b: RuleIn):
    if not b.issuer.strip() or not b.subject_pattern.strip():
        raise HTTPException(400, "issuer, subject_pattern required")
    with get_conn() as c:
        s = (c.execute("SELECT id FROM service WHERE id=?", (b.service_id,)).fetchone() if b.service_id is not None
             else c.execute("SELECT id FROM service WHERE name=?", (b.service_name,)).fetchone())
        if not s:
            raise HTTPException(404, "service not found")
        rid = c.execute("INSERT INTO trusted_identity(issuer,subject_pattern,audience,service_id,jwks_uri,created_at)"
                        " VALUES(?,?,?,?,?,?)", (b.issuer, b.subject_pattern, b.audience, s["id"], b.jwks_uri, now_iso())).lastrowid
        return dict(c.execute("SELECT * FROM trusted_identity WHERE id=?", (rid,)).fetchone())


@admin.delete("/trusted-identities/{rid}")
def delete_rule(rid: int):
    with get_conn() as c:
        if not c.execute("DELETE FROM trusted_identity WHERE id=?", (rid,)).rowcount:
            raise HTTPException(404, "rule not found")
    return {"ok": True}


class WifSettingsIn(BaseModel):
    wif_audience: str


@admin.get("/wif/settings")
def get_wif_settings():
    return {"wif_audience": _default_audience()}


@admin.put("/wif/settings")
def put_wif_settings(b: WifSettingsIn):
    if not b.wif_audience.strip():
        raise HTTPException(400, "wif_audience required")
    with get_conn() as c:
        c.execute("INSERT OR REPLACE INTO setting(key,value) VALUES('wif_audience',?)", (b.wif_audience,))
    return get_wif_settings()


router.include_router(admin)

# ---------------- 데모 (DEMO_MODE 전용) ----------------
demo = APIRouter()
DEMO_SUB = "repo:november/app:ref:refs/heads/main"


class IdpTokenIn(BaseModel):
    sub: str
    audience: Optional[str] = None
    ttl_s: int = 600


@demo.get("/idp/.well-known/jwks.json")
def idp_jwks():
    return _idp_jwks()


@demo.post("/idp/token")
def idp_token(b: IdpTokenIn):
    ttl = max(1, min(b.ttl_s, 3600))
    return {"token": idp_sign(b.sub, b.audience or _default_audience(), ttl), "expires_in": ttl}


@demo.post("/demo/wif/seed")
def demo_wif_seed():
    with get_conn() as c:
        s = c.execute("SELECT id FROM service WHERE name='userA'").fetchone()
        if not s:
            raise HTTPException(404, "서비스 userA 없음. 먼저 /demo/reset")
        r = c.execute("SELECT id FROM trusted_identity WHERE issuer=? AND subject_pattern='repo:november/*'",
                      (IDP_ISSUER,)).fetchone()
        if r:  # 멱등: 리셋으로 서비스 id가 바뀌었을 수 있어 갱신만
            c.execute("UPDATE trusted_identity SET service_id=? WHERE id=?", (s["id"], r["id"]))
            rid = r["id"]
        else:
            rid = c.execute("INSERT INTO trusted_identity(issuer,subject_pattern,audience,service_id,jwks_uri,created_at)"
                            " VALUES(?,'repo:november/*',NULL,?,NULL,?)", (IDP_ISSUER, s["id"], now_iso())).lastrowid
        return dict(c.execute("SELECT * FROM trusted_identity WHERE id=?", (rid,)).fetchone())


class DemoTokenIn(BaseModel):
    sub: Optional[str] = None


@demo.post("/demo/wif/token")
def demo_wif_token(b: Optional[DemoTokenIn] = None):
    return idp_token(IdpTokenIn(sub=(b and b.sub) or DEMO_SUB))


if DEMO_MODE:
    router.include_router(demo)
