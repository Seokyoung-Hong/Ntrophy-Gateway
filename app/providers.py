"""공급자 어댑터. 새 공급자 = 어댑터 클래스 하나 + ADAPTERS 등록. 계약: docs/contract.md G·I.

어댑터가 제공하는 것:
- name, lag_s(공급자 보고 지연), revoke_lag_s(폐기 후 401까지), model(기본 모델), chat_url
- fetch_usage(http, cred) -> 키별 누적값 중 '있는 것만': {cost_usd?, tokens?, requests?, buckets?}
  buckets = [(start_epoch, end_epoch, requests)] (분 단위 등). 탐지기는 채워진 필드로 판정 방식을 고른다.
- revoke(http, cred) -> bool, probe_revoked(http, cred) -> True(폐기 확인)|False(아직 유효)|None(확인 불가), prepare(body) -> 중계 본문, call_cost_usd(usage) -> 중계 1건 비용
- (실제 공급자) provision(http, role, name, limit_usd) -> (원문 키, provider_ref), cleanup(http) -> 삭제 수
"""
import asyncio
import hashlib
import os
import re
import secrets
import time
from datetime import datetime

import httpx

from app import vault
from app.contract import (COST_PER_TOKEN_KRW, MOCK_BASE_URL, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_PROJECT_ID,
                          OPENAI_REVOKE_LAG_S, OPENROUTER_BASE_URL, OPENROUTER_MODEL, OPENROUTER_REVOKE_LAG_S,
                          USAGE_LAG_S, USD_TO_KRW, VLLM_ADMIN_KEY, VLLM_BASE_URL, VLLM_MODEL, gemma_tune)

OUR_PREFIX = "november-"  # 이 접두어로 시작하는 키·서비스 계정만 만들고·고치고·지운다

# ponytail: gpt-4o-mini 단가 상수(USD/토큰). 가격표 모듈이 생기면 그쪽으로 교체.
PRICE_IN, PRICE_OUT = 0.15e-6, 0.60e-6


def _our_name(role: str, name: str | None) -> str:
    n = name or f"{role}-{secrets.token_hex(3)}"
    return n if n.startswith(OUR_PREFIX) else OUR_PREFIX + n


def key_ref(raw: str) -> str:
    """DB provider_ref에 남기는 API 키 식별자(원문 대신 해시)."""
    return "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def owner_of(cred) -> str:
    """공급자 /usage·/revoke의 owner(=키 원문). 해시 ref면 secret_enc 복호화, 구 DB 원문·wif: ref는 그대로."""
    ref = cred["provider_ref"]
    return vault.decrypt(cred["secret_enc"]) if ref.startswith("sha256:") and cred["secret_enc"] else ref


def scrub(msg: str) -> str:
    """로그용: URL의 owner= 값과 sk- 키 원문을 가린다."""
    return re.sub(r"sk-[\w-]{6,}", "sk-***", re.sub(r"owner=[^&'\"\s)]+", "owner=***", msg))


def _token_cost_usd(u: dict) -> float:
    return (u.get("prompt_tokens") or 0) * PRICE_IN + (u.get("completion_tokens") or 0) * PRICE_OUT


async def _probe(self, http, cred, on_call=None):
    """폐기 효과 확인: 그 키로 chat_url에 max_tokens=1 호출. 401/403=True, 200=False(revoke_lag_s 동안 2초 간격 재확인), 그 밖·오류=None."""
    end = time.time() + self.revoke_lag_s
    while True:
        try:
            if cred["auth_mode"] == "API_KEY":
                key = vault.decrypt(cred["secret_enc"])
            else:  # Mock WIF: 폐기된 audience는 STS가 401
                t = await http.post(f"{MOCK_BASE_URL}/sts/token", json={"audience": cred["audience"], "identity": "november-detector"})
                if t.status_code == 401:
                    return True
                key = t.json()["token"]
            r = await http.post(self.chat_url, headers={"Authorization": f"Bearer {key}"},
                                json={"model": self.model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1})
        except Exception:
            return None
        if r.status_code in (401, 403):
            return True
        if r.status_code != 200:
            return None
        if on_call:  # 200 = 공급자가 집계한 내부 호출 -> 탐지에서 설명된 호출로(계약 P절)
            on_call()
        if time.time() >= end:
            return False
        await asyncio.sleep(min(2.0, max(0.2, end - time.time())))


class Mock:
    name, model, revoke_lag_s = "mock", "mock", 0.5
    min_poll_s = 0  # 사용량 조회 최소 간격(속도 제한 공급자만 > 0)
    lag_s = USAGE_LAG_S["mock"]
    chat_url = f"{MOCK_BASE_URL}/v1/chat/completions"

    async def fetch_usage(self, http, cred):
        u = (await http.get(f"{MOCK_BASE_URL}/usage", params={"owner": owner_of(cred)})).json()
        return {"requests": u.get("requests", 0), "tokens": u["tokens"], "cost_usd": u["cost_krw"] / USD_TO_KRW}

    probe_revoked = _probe

    async def revoke(self, http, cred):
        return (await http.post(f"{MOCK_BASE_URL}/revoke", json={"owner": owner_of(cred)})).status_code == 200

    def prepare(self, body):
        return body

    def call_cost_usd(self, u):
        return u.get("total_tokens", 0) * COST_PER_TOKEN_KRW / USD_TO_KRW


class OpenRouter:
    """키별 누적 사용액(USD)만 준다(호출 수 없음, /activity는 당일 미지원) -> 탐지기가 호출 수 추정."""
    name, model, revoke_lag_s = "openrouter", OPENROUTER_MODEL, OPENROUTER_REVOKE_LAG_S
    min_poll_s = 3
    lag_s = USAGE_LAG_S["openrouter"]
    chat_url = f"{OPENROUTER_BASE_URL}/chat/completions"

    def _h(self):
        return {"Authorization": f"Bearer {os.getenv('OPENROUTER_MANAGEMENT_KEY', '')}"}

    async def fetch_usage(self, http, cred):
        r = await http.get(f"{OPENROUTER_BASE_URL}/keys/{cred['provider_ref']}", headers=self._h())
        r.raise_for_status()
        return {"cost_usd": float(r.json()["data"]["usage"] or 0)}

    probe_revoked = _probe

    async def revoke(self, http, cred):
        r = await http.patch(f"{OPENROUTER_BASE_URL}/keys/{cred['provider_ref']}", headers=self._h(),
                             json={"disabled": True})
        return r.status_code == 200

    def prepare(self, body):  # usage.cost(USD)를 응답으로 받는다
        m = str(body.get("model") or "")
        return {**body, "model": m if m and not m.startswith(("mock", "demo")) else self.model,
                "usage": {"include": True}}

    def call_cost_usd(self, u):
        # cost 누락(스트림 중단 등) 시 gpt-4o-mini 단가로 추정
        return float(u["cost"]) if u.get("cost") is not None else _token_cost_usd(u)

    async def provision(self, http, role, name=None, limit_usd=0.5):
        r = await http.post(f"{OPENROUTER_BASE_URL}/keys", headers=self._h(),
                            json={"name": _our_name(role, name), "limit": limit_usd})
        r.raise_for_status()
        d = r.json()
        return d["key"], d["data"]["hash"]

    async def cleanup(self, http):
        r = await http.get(f"{OPENROUTER_BASE_URL}/keys", headers=self._h(), params={"include_disabled": "true"})
        r.raise_for_status()
        n = 0
        for k in r.json()["data"]:
            if str(k.get("name") or "").startswith(OUR_PREFIX):
                (await http.delete(f"{OPENROUTER_BASE_URL}/keys/{k['hash']}", headers=self._h())).raise_for_status()
                n += 1
        return n


class OpenAI:
    """Usage API가 키별 '분 버킷' 호출 수를 준다(반영 실측 약 381초). 키 = 프로젝트 서비스 계정.
    provider_ref = 'key_id|service_account_id|project_id'."""
    name, model, revoke_lag_s = "openai", OPENAI_MODEL, OPENAI_REVOKE_LAG_S
    min_poll_s = 15
    lag_s = USAGE_LAG_S["openai"]
    chat_url = f"{OPENAI_BASE_URL}/chat/completions"
    poll_s = 15  # Usage API 호출 간격(워커 2초마다 부르면 과함). 사이에는 직전 값을 돌려준다
    _cache: dict = {}

    def _h(self):
        return {"Authorization": f"Bearer {os.getenv('OPENAI_ADMIN_KEY', '')}"}

    async def fetch_usage(self, http, cred):
        key_id = cred["provider_ref"].split("|")[0]
        now = datetime.now().timestamp()
        hit = self._cache.get(key_id)
        if hit and now - hit[0] < self.poll_s:
            return hit[1]
        start = int(datetime.fromisoformat(cred["created_at"]).timestamp()) // 60 * 60 - 60
        r = await http.get(f"{OPENAI_BASE_URL}/organization/usage/completions", headers=self._h(), params={
            "start_time": start, "bucket_width": "1m", "group_by": "api_key_id", "api_key_ids": key_id, "limit": 1440})
        r.raise_for_status()
        buckets, tokens = [], 0
        for b in r.json().get("data", []):
            res = [x for x in b.get("results", []) if x.get("api_key_id") in (None, key_id)]
            buckets.append((b["start_time"], b["end_time"], sum(x.get("num_model_requests", 0) for x in res)))
            tokens += sum((x.get("input_tokens") or 0) + (x.get("output_tokens") or 0) for x in res)
        out = {"requests": sum(b[2] for b in buckets), "tokens": tokens, "buckets": buckets}
        self._cache[key_id] = (now, out)
        return out

    probe_revoked = _probe

    async def revoke(self, http, cred):  # 서비스 계정 삭제(실측 2.8초 후 401)
        _, sa_id, pid = cred["provider_ref"].split("|")
        r = await http.delete(f"{OPENAI_BASE_URL}/organization/projects/{pid}/service_accounts/{sa_id}", headers=self._h())
        return r.status_code == 200

    def prepare(self, body):
        m = str(body.get("model") or "")
        out = {**body, "model": m if m and not m.startswith(("mock", "demo")) else self.model}
        return out | ({"stream_options": {"include_usage": True}} if body.get("stream") else {})  # 마지막 청크에 usage

    def call_cost_usd(self, u):  # 근사(단가 상수)
        return _token_cost_usd(u)

    async def provision(self, http, role, name=None, limit_usd=None):  # OpenAI 서비스 계정에는 금액 한도 없음
        pid = OPENAI_PROJECT_ID
        r = await http.post(f"{OPENAI_BASE_URL}/organization/projects/{pid}/service_accounts", headers=self._h(),
                            json={"name": _our_name(role, name)})
        r.raise_for_status()
        d = r.json()
        return d["api_key"]["value"], f"{d['api_key']['id']}|{d['id']}|{pid}"

    async def cleanup(self, http):
        pid, after, n = OPENAI_PROJECT_ID, None, 0
        url = f"{OPENAI_BASE_URL}/organization/projects/{pid}/service_accounts"
        ours = []
        while True:
            r = await http.get(url, headers=self._h(), params={"limit": 100} | ({"after": after} if after else {}))
            r.raise_for_status()
            d = r.json()
            ours += [a["id"] for a in d.get("data", []) if str(a.get("name") or "").startswith(OUR_PREFIX)]
            if not d.get("has_more") or not d.get("data"):
                break
            after = d["data"][-1]["id"]
        for sa_id in ours:
            (await http.delete(f"{url}/{sa_id}", headers=self._h())).raise_for_status()
            n += 1
        return n


class Vllm(Mock):
    """자체 GPU. 앞단 게이트웨이가 Mock과 같은 /usage·/revoke·/demo/reset 제공(docs/vllm-gateway-spec.md).
    키는 처음 보는 값도 유효하므로 provision = 로컬 생성. call_cost_usd는 Mock 공식 상속."""
    name, model, revoke_lag_s = "vllm", VLLM_MODEL, 0.5
    lag_s = USAGE_LAG_S["vllm"]
    chat_url = f"{VLLM_BASE_URL}/v1/chat/completions"

    def _h(self):
        return {"X-Admin-Key": VLLM_ADMIN_KEY} if VLLM_ADMIN_KEY else {}

    async def fetch_usage(self, http, cred):
        r = await http.get(f"{VLLM_BASE_URL}/usage", params={"owner": owner_of(cred)}, headers=self._h())
        r.raise_for_status()
        u = r.json()
        return {"requests": u.get("requests", 0), "tokens": u.get("tokens", 0),
                "cost_usd": float(u.get("cost_krw") or 0) / USD_TO_KRW}

    async def revoke(self, http, cred):
        r = await http.post(f"{VLLM_BASE_URL}/revoke", json={"owner": owner_of(cred)}, headers=self._h())
        return r.status_code == 200

    def prepare(self, body):
        m = str(body.get("model") or "")
        out = gemma_tune({**body, "model": m if m and not m.startswith(("mock", "demo")) else self.model})
        return out | ({"stream_options": {"include_usage": True}} if body.get("stream") else {})

    async def provision(self, http, role, name=None, limit_usd=None):
        raw = f"sk-vllm-{'K1' if role == 'PRIMARY' else 'S1'}-{secrets.token_hex(4)}"
        return raw, key_ref(raw)

    async def cleanup(self, http):  # 폐기할 외부 키 없음. 공급자 계량·폐기 목록 초기화(404·연결 실패 무시)
        try:
            await http.post(f"{VLLM_BASE_URL}/demo/reset", headers=self._h())
        except httpx.HTTPError:
            pass
        return 0


ADAPTERS = {a.name: a for a in (Mock(), OpenRouter(), OpenAI(), Vllm())}


def get(provider: str):
    return ADAPTERS[provider]
