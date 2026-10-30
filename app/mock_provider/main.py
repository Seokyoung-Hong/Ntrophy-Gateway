"""OpenAI 호환 Mock Provider (인메모리 상태)."""
import json
import os
import secrets
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from app.clientip import client_ip, public_guard
from app.contract import (PUBLIC_MODE, LEAKED_KEY, LIVE_KEY_PATH, MOCK_USAGE_LAG_S, OPENROUTER_BASE_URL, OPENROUTER_MODEL,
                          VLLM_BASE_URL, VLLM_MODEL, WIF_TOKEN_TTL_S, cost_krw, gemma_tune)  # contract import 시 .env 로드

app = FastAPI(**({"docs_url": None, "redoc_url": None, "openapi_url": None} if PUBLIC_MODE else {}))
app.middleware("http")(public_guard)  # 공개 모드면 Mock /demo/reset도 관리자 키 필요
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

reqs: dict[str, list[tuple[float, int]]] = {}  # owner -> [(시각, 토큰)]
revoked: set[str] = set()
sts: dict[str, tuple[str, float]] = {}  # 토큰 -> (owner, 만료 epoch)
live_hits: dict[str, list[float]] = {}  # IP -> 최근 /live/chat 시각
live_calls = 0
live_or_status = None  # OpenRouter·vLLM 모드: 마지막 공급자 응답 코드(401/403이면 key_status=revoked)
DIRECT = {"sk-or-": (f"{OPENROUTER_BASE_URL}/chat/completions", None),  # 키 접두 -> (공급자 URL, 모델 None=LIVE_MODEL)
          "sk-vllm-": (f"{VLLM_BASE_URL}/v1/chat/completions", VLLM_MODEL)}


def _reset():
    global live_calls, live_or_status
    reqs.clear(); revoked.clear(); sts.clear(); live_hits.clear(); live_calls = 0; live_or_status = None


def _owner(key: str):
    """키 -> owner. 폐기/만료/누락이면 None."""
    if key in sts:
        owner, exp = sts[key]
        if time.time() >= exp:
            return None
    else:
        owner = key
    return None if not owner or owner in revoked else owner


def _revoked():
    return JSONResponse({"error": "revoked"}, status_code=401)


@app.post("/v1/chat/completions")
async def chat(request: Request):
    owner = _owner(request.headers.get("authorization", "").removeprefix("Bearer ").strip())
    if owner is None:
        return _revoked()
    return await _complete(owner, await request.json())


async def _complete(owner: str, body: dict):
    n = int(body.get("max_tokens") or 300)
    key, model = os.getenv("UPSTREAM_API_KEY"), str(body.get("model", "mock"))
    if key and not model.startswith(("mock", "demo")):  # 실제 AI 패스스루(실패 시 가짜 응답으로 대체)
        base = os.getenv("UPSTREAM_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
        hdr = {"Authorization": f"Bearer {key}"}
        if not body.get("stream"):
            try:
                async with httpx.AsyncClient(timeout=8) as c:
                    r = await c.post(f"{base}/chat/completions", json=body, headers=hdr)
                d = r.json()
                reqs.setdefault(owner, []).append((time.time(), int(d["usage"]["total_tokens"])))
                if r.status_code == 200:
                    return d
                reqs[owner].pop()
            except Exception:
                pass
        else:
            try:  # 첫 바이트 전 오류만 대체 가능하도록 연결·헤더를 먼저 확보
                c = httpx.AsyncClient(timeout=8)
                up = await c.send(c.build_request("POST", f"{base}/chat/completions", headers=hdr, json={
                    **body, "stream_options": {"include_usage": True}}), stream=True)
                if up.status_code != 200:
                    raise RuntimeError
            except Exception:
                pass
            else:
                async def relay():
                    total = None
                    try:
                        async for line in up.aiter_lines():
                            if not line.strip():
                                continue
                            if line.startswith("data:") and "[DONE]" not in line and '"usage"' in line:
                                try:
                                    total = (json.loads(line[5:]).get("usage") or {}).get("total_tokens", total)
                                except ValueError:
                                    pass
                            if "[DONE]" not in line:
                                yield line + "\n\n"
                    except Exception:
                        pass
                    finally:
                        await up.aclose(); await c.aclose()
                        reqs.setdefault(owner, []).append((time.time(), int(total if total is not None else n)))
                    yield "data: [DONE]\n\n"
                return StreamingResponse(relay(), media_type="text/event-stream")
    reqs.setdefault(owner, []).append((time.time(), n))
    model, cid, now = body.get("model", "mock"), "chatcmpl-" + secrets.token_hex(8), int(time.time())
    usage = {"prompt_tokens": 0, "completion_tokens": n, "total_tokens": n}
    if not body.get("stream"):
        return {"id": cid, "object": "chat.completion", "created": now, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "mock response"},
                             "finish_reason": "stop"}], "usage": usage}

    def gen():
        def chunk(delta, finish=None, **extra):
            c = {"id": cid, "object": "chat.completion.chunk", "created": now, "model": model,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}
            return f"data: {json.dumps(c)}\n\n"
        yield chunk({"role": "assistant", "content": "mock "})
        yield chunk({"content": "response"})
        yield chunk({}, "stop", usage=usage)
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/usage")
def usage(owner: str):
    cutoff = time.time() - MOCK_USAGE_LAG_S
    rows = [r for r in reqs.get(owner, []) if r[0] <= cutoff]
    t = sum(r[1] for r in rows)
    return {"owner": owner, "cost_krw": cost_krw(t), "tokens": t, "requests": len(rows)}


@app.post("/revoke")
async def revoke(request: Request):
    revoked.add((await request.json())["owner"])
    return {"ok": True}


@app.post("/sts/token")
async def sts_token(request: Request):
    aud = (await request.json())["audience"]
    owner = f"wif:{aud}"
    if owner in revoked:
        return _revoked()
    tok = "wif-" + secrets.token_urlsafe(24)
    sts[tok] = (owner, time.time() + WIF_TOKEN_TTL_S)
    return {"token": tok, "expires_in": WIF_TOKEN_TTL_S, "owner": owner}


LIVE_MODEL = os.getenv("LIVE_MODEL", OPENROUTER_MODEL)
LIVE_HTML = Path(__file__).with_name("live.html")


@app.get("/live")
def live_page():
    return FileResponse(LIVE_HTML)


def _live_key() -> str:
    """OpenRouter 모드면 게이트웨이가 프로비저닝한 PRIMARY 키(data/live_key.json), 아니면 LEAKED_KEY."""
    try:
        return json.loads(Path(LIVE_KEY_PATH).read_text(encoding="utf-8"))["key"]
    except (OSError, ValueError, KeyError):
        return LEAKED_KEY


@app.get("/live/config")
def live_config():
    key = _live_key()
    return {"key": key, "model": next((m for p, (_, m) in DIRECT.items() if key.startswith(p) and m), LIVE_MODEL)}  # 직접 호출 모델과 표시를 일치


async def _live_direct(key: str, msgs: list, url: str, model: str):
    """청중 호출을 공급자(OpenRouter·vLLM)에 직접 전달(게이트웨이를 거치지 않음 = 유출 키 직접 사용)."""
    global live_calls, live_or_status
    if key != _live_key() or key in revoked:  # 열린 프록시 방지 + 게이트웨이가 올린 폐기 목록(공급자 폐기 확인 전에도 청중 경로 즉시 차단)
        return _revoked()
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(url, headers={"Authorization": f"Bearer {key}"},
                             json=(gemma_tune if model == VLLM_MODEL else dict)({"model": model, "max_tokens": 300, "messages": msgs}))
    except httpx.HTTPError:
        return JSONResponse({"error": "upstream_error"}, status_code=502)
    live_or_status = r.status_code
    if r.status_code in (401, 403):
        return _revoked()
    if r.status_code != 200:
        return JSONResponse({"error": "upstream_error", "upstream_status": r.status_code}, status_code=502)
    live_calls += 1
    return {"reply": r.json()["choices"][0]["message"]["content"], "status": 200}


@app.post("/live/chat")
async def live_chat(request: Request):
    global live_calls
    ip = client_ip(request)
    now = time.time()
    hits = live_hits.setdefault(ip, [])
    hits[:] = [t for t in hits if t > now - 600]  # 10분 창(참여자 집계 겸용)
    if sum(t > now - 20 for t in hits) >= 10:
        return JSONResponse({"error": "rate_limited"}, status_code=429)
    hits.append(now)
    body = await request.json()
    key, msg = str(body.get("key", "")).strip(), str(body.get("message", ""))[:300]
    hist = [{"role": m["role"], "content": str(m.get("content", ""))[:600]} for m in (body.get("history") or [])[-10:]  # 이전 대화(최근 10개)
            if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    msgs = hist + [{"role": "user", "content": msg}]
    for prefix, (url, model) in DIRECT.items():
        if key.startswith(prefix):
            return await _live_direct(key, msgs, url, model or LIVE_MODEL)
    owner = _owner(key)
    if owner is None:
        return _revoked()
    d = await _complete(owner, {"model": LIVE_MODEL, "max_tokens": 150,
                                "messages": msgs})
    live_calls += 1
    return {"reply": d["choices"][0]["message"]["content"], "status": 200}


def _live_revoked() -> bool:
    key = _live_key()
    return key in revoked or (key.startswith(tuple(DIRECT)) and live_or_status in (401, 403))


@app.get("/live/stats")
def live_stats():
    now = time.time()
    return {"participants": sum(any(t > now - 600 for t in h) for h in live_hits.values()),
            "calls": live_calls, "key_status": "revoked" if _live_revoked() else "active",
            "updated_at": int(now)}


@app.post("/demo/reset")
def demo_reset():
    _reset()
    return {"ok": True}
