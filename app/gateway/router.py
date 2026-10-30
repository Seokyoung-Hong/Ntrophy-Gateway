"""게이트웨이 중계(/v1/chat/completions) + 관리자 CRUD(/admin/*). 계약: docs/contract.md B·C."""
import ipaddress
import json
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app import providers, vault
from app.clientip import admin_ok, client_ip
from app.contract import (DEFAULT_LIMIT_CALLS, DEFAULT_TOLERANCE_CALLS, DEFAULT_LIMIT_KRW, DETECTION_DEFAULTS, DETECTION_MODES, LIVE_KEY_PATH, PROVIDERS, USD_TO_KRW, hash_token,
                          mask_key)
from app.db import get_conn

router = APIRouter()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------- B. 중계 ----------------

def _deny(status: int, reason: str, ip: str, token: str):
    masked = mask_key(token) if token else None
    with get_conn() as c:
        c.execute("INSERT INTO access_denied_log(source_ip,reason,token_masked,at) VALUES(?,?,?,?)",
                  (ip, reason, masked, time.time()))
        c.execute("INSERT INTO event(at,kind,message,data) VALUES(?,?,?,?)",
                  (time.time(), "ACCESS_DENIED", f"접근 거부({reason}) {ip}",
                   json.dumps({"source_ip": ip, "reason": reason, "token_masked": masked})))
    return JSONResponse({"error": reason}, status_code=status)


def _ip_allowed(ip: str, cidrs) -> bool:
    """허용 대역이 0개거나 `*`가 있으면 모두 허용(관리자가 등록하기 전 기본값)."""
    if not cidrs or any(r["cidr"] == "*" for r in cidrs):
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for r in cidrs:
        try:
            if addr in ipaddress.ip_network(r["cidr"], strict=False):
                return True
        except ValueError:
            continue
    return False


_wif_cache: dict[str, tuple[str, float]] = {}  # audience -> (token, 만료 epoch)
blocked_ips: dict[str, float] = {}  # 더 이상 채우지 않음(허니키는 IP 차단 대신 전체 토큰 폐기). 대시보드 호환용 빈 dict
inflight = {}  # credential_id -> 공급자로 보낸 뒤 아직 usage_log에 안 쓴 요청 수
reset_gen = [0]  # /demo/reset마다 증가. 리셋 전에 시작한 중계는 usage_log를 쓰지 않는다(id 재사용 충돌 방지)
HONEY_DEDUP_S = 60


def _honeykey_hit(hk, ip: str, path: str):
    """허니키 사용: honeykey_event + HONEYKEY 이벤트 + 사고(60초 중복 방지) + 전체 게이트웨이 토큰 폐기 + 서비스 일시 정지."""
    now = time.time()
    msg = f"허니키 사용 탐지: {hk['masked']}({hk['planted_at']}) 출발 IP {ip}"
    with get_conn() as c:
        dup = c.execute("SELECT 1 FROM honeykey_event WHERE honeykey_id=? AND source_ip=? AND at>?",
                        (hk["id"], ip, now - HONEY_DEDUP_S)).fetchone()
        c.execute("INSERT INTO honeykey_event(honeykey_id,source_ip,path,at) VALUES(?,?,?,?)", (hk["id"], ip, path, now))
        n_tok = c.execute("UPDATE gateway_token SET status='REVOKED' WHERE status='ACTIVE'").rowcount
        n_svc = c.execute("UPDATE service SET status='SUSPENDED' WHERE status='ACTIVE'").rowcount
        iid = None
        if not dup:
            tl = [{"at": iso(now), "step": "DETECTED", "ok": True, "detail": msg},
                  {"at": iso(now), "step": "REVOKE_ALL_TOKENS", "ok": True, "detail": f"전체 API 토큰 {n_tok}개 폐기"},
                  {"at": iso(now), "step": "SUSPEND_SERVICES", "ok": True, "detail": f"서비스 {n_svc}개 일시 정지"},
                  {"at": iso(now), "step": "NOTIFY_ADMIN", "ok": True, "detail": "관리자 통보. 토큰 재발급·서비스 재개는 관리자가 수동으로"}]
            iid = c.execute("INSERT INTO incident(credential_id,trigger_type,status,detected_at,blocked_at,timeline)"
                            " VALUES(NULL,'HONEYKEY','OPEN',?,?,?)", (now, now, json.dumps(tl, ensure_ascii=False))).lastrowid
        c.execute("INSERT INTO event(at,kind,message,data) VALUES(?,?,?,?)",
                  (now, "HONEYKEY", msg, json.dumps({"honeykey_id": hk["id"], "planted_at": hk["planted_at"],
                                                      "source_ip": ip, "incident_id": iid}, ensure_ascii=False)))


async def _upstream_key(client: httpx.AsyncClient, cred) -> str:
    if cred["auth_mode"] == "API_KEY":
        return vault.decrypt(cred["secret_enc"])
    aud = cred["audience"]
    tok, exp = _wif_cache.get(aud, ("", 0.0))
    if time.time() > exp - 60:  # 만료 60초 전 갱신
        r = await client.post(f"{PROVIDERS['mock']}/sts/token", json={"audience": aud, "identity": "novem-gateway"})
        r.raise_for_status()
        d = r.json()
        tok, exp = d["token"], time.time() + d["expires_in"]
        _wif_cache[aud] = (tok, exp)
    return tok


def _log_usage(service_id, cred, model, usage: dict, status_code: int):
    with get_conn() as c:
        c.execute("INSERT INTO usage_log(service_id,credential_id,model,input_tokens,output_tokens,cost_krw,status_code,at)"
                  " VALUES(?,?,?,?,?,?,?,?)",
                  (service_id, cred["id"], model, usage.get("prompt_tokens"), usage.get("completion_tokens"),
                   providers.get(cred["provider"]).call_cost_usd(usage) * USD_TO_KRW, status_code, time.time()))


def _bad_gateway(cred):
    if cred["auth_mode"] == "WIF":
        _wif_cache.pop(cred["audience"], None)  # 폐기·만료 토큰 재사용 방지
    return JSONResponse({"error": "upstream_error"}, status_code=502)


@router.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header("")):
    ip = client_ip(request)
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""

    gen = reset_gen[0]
    with get_conn() as c:
        hk = c.execute("SELECT * FROM honeykey WHERE value_hash=?", (hash_token(token),)).fetchone() if token else None
        cidrs = c.execute("SELECT cidr FROM allowed_cidr").fetchall()
        tok = c.execute("SELECT * FROM gateway_token WHERE token_hash=?", (hash_token(token),)).fetchone() if token else None
        svc = c.execute("SELECT * FROM service WHERE id=?", (tok["service_id"],)).fetchone() if tok else None
        cred = c.execute("SELECT * FROM credential WHERE role='PRIMARY' AND status='ACTIVE'"
                         " ORDER BY id LIMIT 1").fetchone()

    if hk:  # 허니키는 IP 검사보다 먼저. 호출자에겐 일반 401로 숨긴다
        _honeykey_hit(hk, ip, request.url.path)
        return JSONResponse({"error": "invalid_token"}, status_code=401)
    if not _ip_allowed(ip, cidrs):
        return _deny(403, "ip_not_allowed", ip, token)
    if not tok and token.count(".") == 2 and not token.startswith("nvm-"):  # 사용자 측 WIF(OIDC JWT) → 서비스
        from app import wif_inbound  # 지연 import(순환 방지)
        try:
            tok = {"status": "ACTIVE", "service_id": wif_inbound.verify_jwt(token, ip)}
        except wif_inbound.WifError as e:
            return _deny(401, e.reason, ip, e.sub)  # token_masked = 마스킹한 sub(JWT 원문 미저장)
        with get_conn() as c:
            svc = c.execute("SELECT * FROM service WHERE id=?", (tok["service_id"],)).fetchone()
    if not tok or tok["status"] != "ACTIVE":
        return _deny(401, "invalid_token", ip, token)
    if not svc or svc["status"] != "ACTIVE":
        return _deny(403, "service_suspended", ip, token)
    if not cred:
        return JSONResponse({"error": "no_active_credential"}, status_code=503)

    body = await request.json()
    ad = providers.get(cred["provider"])
    body, url = ad.prepare(body), ad.chat_url
    cid, handed = cred["id"], False
    inflight[cid] = inflight.get(cid, 0) + 1  # 탐지: 공급자는 셌지만 아직 usage_log에 없는 요청(계약 P절)
    try:
        r = await _forward(svc, cred, ad, body, url, gen)
        handed = isinstance(r, StreamingResponse)
        return r
    finally:
        if not handed:
            _done(cid)


def _done(cid):
    inflight[cid] = max(0, inflight.get(cid, 0) - 1)


async def _forward(svc, cred, ad, body, url, gen):
    client = httpx.AsyncClient(timeout=60)
    try:
        key = await _upstream_key(client, cred)
        req = client.build_request("POST", url, json=body,
                                   headers={"Authorization": f"Bearer {key}"})
        resp = await client.send(req, stream=bool(body.get("stream")))
    except httpx.HTTPError:
        await client.aclose()
        return _bad_gateway(cred)

    if resp.status_code == 401:
        await resp.aclose()
        await client.aclose()
        return _bad_gateway(cred)

    if not body.get("stream"):
        await client.aclose()
        data = resp.json()
        if resp.status_code == 200 and data.get("usage") and gen == reset_gen[0]:
            _log_usage(svc["id"], cred, data.get("model", body.get("model")), data["usage"], resp.status_code)
        return JSONResponse(data, status_code=resp.status_code)

    async def relay():
        usage = None
        try:
            async for line in resp.aiter_lines():
                if line.startswith("data: ") and line[6:].strip() != "[DONE]":
                    try:
                        usage = json.loads(line[6:]).get("usage") or usage
                    except ValueError:
                        pass
                yield line + "\n"
        finally:
            await resp.aclose()
            await client.aclose()
            if usage and resp.status_code == 200 and gen == reset_gen[0]:
                _log_usage(svc["id"], cred, body.get("model"), usage, resp.status_code)
            _done(cred["id"])

    return StreamingResponse(relay(), status_code=resp.status_code, media_type="text/event-stream")


# ---------------- C. 관리자 CRUD ----------------

def _admin(x_admin_key: str = Header("")):
    if not admin_ok(x_admin_key):
        raise HTTPException(401, "invalid_admin_key")


admin = APIRouter(prefix="/admin", dependencies=[Depends(_admin)])


def _cred_out(r) -> dict:  # 원문·secret_enc 비노출
    return {"id": r["id"], "provider": r["provider"], "auth_mode": r["auth_mode"], "role": r["role"],
            "status": r["status"], "masked": r["masked"], "audience": r["audience"],
            "provider_ref_masked": mask_key(r["provider_ref"]), "replaced_by_id": r["replaced_by_id"],
            "created_at": r["created_at"]}


class CredIn(BaseModel):
    provider: str = "mock"
    auth_mode: str
    role: str
    secret: Optional[str] = None
    audience: Optional[str] = None


@admin.get("/credentials")
def list_credentials():
    with get_conn() as c:
        return [_cred_out(r) for r in c.execute("SELECT * FROM credential ORDER BY id")]


@admin.post("/credentials")
def create_credential(b: CredIn):
    if b.provider not in PROVIDERS or b.role not in ("PRIMARY", "STANDBY"):
        raise HTTPException(400, "invalid provider/role")
    if b.provider not in ("mock", "vllm"):
        raise HTTPException(400, f"{b.provider}는 POST /admin/{b.provider}/provision 사용")
    if b.provider == "vllm" and not (b.auth_mode == "API_KEY" and b.secret):
        raise HTTPException(400, "vllm은 API_KEY + secret 필요")
    if b.auth_mode == "API_KEY" and b.secret:
        enc, masked, ref = vault.encrypt(b.secret), mask_key(b.secret), providers.key_ref(b.secret)
    elif b.auth_mode == "WIF" and b.audience:
        enc, masked, ref = None, f"wif:{b.audience}", f"wif:{b.audience}"
    else:
        raise HTTPException(400, "API_KEY needs secret, WIF needs audience")
    with get_conn() as c:
        if b.role == "PRIMARY" and c.execute(
                "SELECT 1 FROM credential WHERE provider=? AND role='PRIMARY' AND status='ACTIVE'", (b.provider,)).fetchone():
            raise HTTPException(400, "active PRIMARY already exists")
        cur = c.execute("INSERT INTO credential(provider,auth_mode,role,secret_enc,masked,audience,provider_ref,created_at)"
                        " VALUES(?,?,?,?,?,?,?,?)",
                        (b.provider, b.auth_mode, b.role, enc, masked, b.audience, ref, now_iso()))
        return _cred_out(c.execute("SELECT * FROM credential WHERE id=?", (cur.lastrowid,)).fetchone())


@admin.delete("/credentials/{cid}")
def delete_credential(cid: int):
    with get_conn() as c:
        c.execute("UPDATE credential SET status='REVOKED' WHERE id=?", (cid,))
    return {"ok": True}


def insert_provider_cred(c, provider: str, role: str, raw: str, ref: str) -> dict:
    """프로비저닝한 실제 공급자 키를 vault에 암호화 저장. provider_ref = 공급자 식별자(OpenRouter hash,
    OpenAI 'key_id|sa_id|project_id'). OpenRouter PRIMARY면 라이브 페이지용 파일에도 저장."""
    cid = c.execute("INSERT INTO credential(provider,auth_mode,role,secret_enc,masked,provider_ref,created_at)"
                    " VALUES(?,'API_KEY',?,?,?,?,?)",
                    (provider, role, vault.encrypt(raw), mask_key(raw), ref, now_iso())).lastrowid
    if role == "PRIMARY" and provider in ("openrouter", "vllm"):  # 라이브 페이지(/live)가 이 키를 공개
        with open(LIVE_KEY_PATH, "w", encoding="utf-8") as f:  # data/ 는 gitignore
            json.dump({"key": raw}, f)
    return {"id": cid, "masked": mask_key(raw), "role": role, "hash_masked": mask_key(ref.split("|")[0])}


class ProvisionIn(BaseModel):
    role: str
    limit_usd: float = 0.5  # OpenRouter 키 한도(OpenAI는 무시)
    name: Optional[str] = None  # 'november-' 접두는 강제


@admin.post("/{provider}/provision")
async def provision(provider: str, b: ProvisionIn):
    """provider = openrouter | openai | vllm. 원문 키는 PRIMARY일 때만 leaked_key로 1회 반환."""
    if provider not in ("openrouter", "openai", "vllm"):
        raise HTTPException(404, "unknown provider")
    if b.role not in ("PRIMARY", "STANDBY") or b.limit_usd <= 0:
        raise HTTPException(400, "invalid role/limit_usd")
    with get_conn() as c:
        if b.role == "PRIMARY" and c.execute("SELECT 1 FROM credential WHERE role='PRIMARY' AND status='ACTIVE'").fetchone():
            raise HTTPException(400, "active PRIMARY already exists")
    async with httpx.AsyncClient(timeout=20) as http:
        raw, ref = await providers.get(provider).provision(http, b.role, b.name, b.limit_usd)
    with get_conn() as c:
        out = insert_provider_cred(c, provider, b.role, raw, ref)
    return out | ({"leaked_key": raw} if b.role == "PRIMARY" else {})


SETTING_DEFAULTS = {"unauthorized_call_limit": DEFAULT_LIMIT_CALLS, "loss_limit_krw": DEFAULT_LIMIT_KRW}


@admin.get("/settings")
def get_settings():
    """detection_mode가 없으면 레거시(한도 하나). 프론트는 detection_mode 유무로 서버 지원을 감지한다."""
    with get_conn() as c:
        rows = dict(c.execute("SELECT key,value FROM setting").fetchall())
    out = {k: int(rows.get(k, d)) for k, d in SETTING_DEFAULTS.items()}
    out["tolerance_calls"] = int(rows.get("tolerance_calls", DEFAULT_TOLERANCE_CALLS))
    if rows.get("detection_mode") in DETECTION_MODES:
        num = lambda k: int(float(rows.get(k, DETECTION_DEFAULTS[k]))) if k.endswith("_calls") else float(rows.get(k, DETECTION_DEFAULTS[k]))
        out |= {"detection_mode": rows["detection_mode"]} | {k: num(k) for k in DETECTION_DEFAULTS}
    return out


class SettingsIn(BaseModel):
    unauthorized_call_limit: Optional[int] = None
    loss_limit_krw: Optional[int] = None
    detection_mode: Optional[str] = None  # usage_pct | calls
    suspect_pct: Optional[float] = None
    warn_pct: Optional[float] = None
    block_pct: Optional[float] = None
    suspect_calls: Optional[int] = None
    warn_calls: Optional[int] = None
    block_calls: Optional[int] = None
    tolerance_calls: Any = None  # 허용 오차(건) 0~100 정수, 기본 0. 비정수는 422가 아니라 400(put_settings에서 검사)


@admin.put("/settings")
def put_settings(b: SettingsIn):
    sent = b.model_dump(exclude_none=True)
    tol = sent.pop("tolerance_calls", None)
    if tol is not None and (type(tol) is not int or not 0 <= tol <= 100):
        raise HTTPException(400, "tolerance_calls must be 0..100")
    mode = sent.pop("detection_mode", None)
    if mode is not None and mode not in DETECTION_MODES:
        raise HTTPException(400, "detection_mode must be usage_pct or calls")
    for k, v in sent.items():
        if v <= 0:
            raise HTTPException(400, f"{k} must be > 0")
        if k.endswith("_pct") and v > 100:
            raise HTTPException(400, f"{k} must be <= 100")
    with get_conn() as c:
        rows = dict(c.execute("SELECT key,value FROM setting").fetchall())
        merged = {k: float(sent.get(k, rows.get(k, d))) for k, d in DETECTION_DEFAULTS.items()}
        for keys in DETECTION_MODES.values():
            if not merged[keys[0]] < merged[keys[1]] < merged[keys[2]]:
                raise HTTPException(400, f"의심 < 경고 < 차단 순서여야 해요 ({', '.join(keys)})")
        if mode:
            sent["detection_mode"] = mode
        if tol is not None:
            sent["tolerance_calls"] = tol
        c.executemany("INSERT OR REPLACE INTO setting(key,value) VALUES(?,?)", [(k, str(v)) for k, v in sent.items()])
    return get_settings()


class CidrIn(BaseModel):
    cidr: str
    label: str = "INTERNAL"


@admin.get("/cidrs")
def list_cidrs():
    with get_conn() as c:
        return [dict(r) for r in c.execute("SELECT id,cidr,label FROM allowed_cidr ORDER BY id")]


@admin.post("/cidrs")
def add_cidr(b: CidrIn):
    try:
        cidr = "*" if b.cidr.strip() == "*" else str(ipaddress.ip_network(b.cidr.strip(), strict=False))
    except ValueError:
        raise HTTPException(400, "invalid cidr")
    with get_conn() as c:
        cur = c.execute("INSERT INTO allowed_cidr(cidr,label) VALUES(?,?)", (cidr, b.label))
    return {"id": cur.lastrowid, "cidr": cidr, "label": b.label}


@admin.delete("/cidrs/{cid}")
def delete_cidr(cid: int):
    with get_conn() as c:
        c.execute("DELETE FROM allowed_cidr WHERE id=?", (cid,))
    return {"ok": True}


@admin.get("/services")
def list_services():
    with get_conn() as c:
        return [{**dict(s), "tokens": [dict(t) for t in c.execute(
            "SELECT id,token_masked,status,created_at FROM gateway_token WHERE service_id=? ORDER BY id", (s["id"],))]}
            for s in c.execute("SELECT id,name,status FROM service ORDER BY id").fetchall()]


def _set_service_status(sid: int, status: str):
    with get_conn() as c:
        if not c.execute("UPDATE service SET status=? WHERE id=?", (status, sid)).rowcount:
            raise HTTPException(404, "service not found")
    return {"id": sid, "status": status}


@admin.post("/services/{sid}/suspend")
def suspend_service(sid: int):
    return _set_service_status(sid, "SUSPENDED")


@admin.post("/services/{sid}/resume")
def resume_service(sid: int):
    return _set_service_status(sid, "ACTIVE")


@admin.get("/honeykeys")
def list_honeykeys():
    with get_conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT h.id,h.masked,h.planted_at,h.created_at,COUNT(e.id) AS hits FROM honeykey h "
            "LEFT JOIN honeykey_event e ON e.honeykey_id=h.id GROUP BY h.id ORDER BY h.id")]


class TokenIn(BaseModel):
    service_name: str


@admin.post("/tokens")
def issue_token(b: TokenIn):
    token = "nvm-" + secrets.token_urlsafe(24)
    with get_conn() as c:
        s = c.execute("SELECT id FROM service WHERE name=?", (b.service_name,)).fetchone()
        sid = s["id"] if s else c.execute("INSERT INTO service(name) VALUES(?)", (b.service_name,)).lastrowid
        cur = c.execute("INSERT INTO gateway_token(service_id,token_hash,token_masked,created_at) VALUES(?,?,?,?)",
                        (sid, hash_token(token), mask_key(token), now_iso()))
    return {"id": cur.lastrowid, "service_id": sid, "token": token, "token_masked": mask_key(token)}


@admin.delete("/tokens/{tid}")
def revoke_token(tid: int):
    with get_conn() as c:
        c.execute("UPDATE gateway_token SET status='REVOKED' WHERE id=?", (tid,))
    return {"ok": True}


@admin.get("/access-denied")
def access_denied(limit: int = 20):
    with get_conn() as c:
        rows = c.execute("SELECT * FROM access_denied_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(r), "at": iso(r["at"])} for r in rows]


router.include_router(admin)
