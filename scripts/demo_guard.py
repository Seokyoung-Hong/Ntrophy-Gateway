"""데모 가드: 키 보관 구조 등을 바꾼 뒤에도 데모 화면·API 사용성이 유지되는지 확인한다.
사전: Mock·게이트웨이 기동(PUBLIC_MODE 끔, ADMIN_KEY=admin). vllm 모드는 Mock에도 VLLM_BASE_URL을 주고
게이트웨이와 Mock이 같은 DB_PATH 폴더를 쓰게 한다(live_key.json 공유).
  기준선 저장: python scripts/demo_guard.py --gw http://127.0.0.1:8000 --mock http://127.0.0.1:9000 --mode mock --capture
  비교 실행  : python scripts/demo_guard.py --gw http://127.0.0.1:8000 --mock http://127.0.0.1:9000 --mode mock
판정: 기준선에서 키가 사라지거나 타입이 바뀌면 FAIL, 키가 늘면 WARN, 나머지 PASS. FAIL이 있으면 종료 코드 1."""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx

sys.stdout.reconfigure(encoding="utf-8")
BASE = Path(__file__).with_name("demo_guard_baseline.json")
ADM = {"X-Admin-Key": "admin"}
BODY = {"model": "mock", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}
UI_PAGES = ["/", "/ui/", "/ui/index.html", "/ui/live.html", "/ui/employee.html", "/ui/css/app.css", "/test", "/test/auto"]
UI_JS = ["api.js", "console.js", "employee.js", "live.js", "sim.js", "ui.js"]  # 기준선 시점 목록(app/static/ui/js). 새 파일은 무시
SK_RE = re.compile(r"sk-[A-Za-z0-9_-]{8,}")  # 마스킹 값(sk-...abcd)은 걸리지 않는다

res = []  # (PASS|WARN|FAIL, 이름, 설명)
samples = {}  # "METHOD path" -> {"status": 코드, "shape": 구조}


def rec(level, name, info=""):
    res.append((level, name, info))
    print(f"[{level}] {name} {info}".rstrip())


def check(name, ok, info=""):
    rec("PASS" if ok else "FAIL", name, info)
    return ok


# ---------- 구조 추출·병합·비교 (값은 저장하지 않는다) ----------
def shape(v):
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "str"
    if v is None:
        return "null"
    if isinstance(v, dict):
        return {k: shape(x) for k, x in v.items()}
    out = None  # 리스트: 원소 구조의 합집합(첫 원소만 보면 이벤트처럼 필드가 다른 목록에서 흔들린다)
    for x in v:
        out = merge(out, shape(x))
    return {"__list__": out}


def merge(a, b):
    """None=아직 없음, "null"=값이 null. null은 다른 타입에 흡수된다."""
    if a is None or a == "null":
        return b if b is not None else a
    if b is None or b == "null":
        return a
    if isinstance(a, dict) and isinstance(b, dict):
        return {**a, **{k: merge(a.get(k), v) if k in a else v for k, v in b.items()}}
    return a  # 타입이 다르면 먼저 본 쪽 유지(기준선과 비교할 때 걸린다)


def diff(base, new, path=""):
    """(사라지거나 바뀐 것, 늘어난 것). null·빈 목록은 어느 쪽이든 와일드카드."""
    gone, added = [], []
    if base is None or new is None or base == "null" or new == "null":
        return gone, added
    if isinstance(base, dict) and isinstance(new, dict):
        if ("__list__" in base) != ("__list__" in new):
            return [f"{path or '.'}: 목록<->객체 변경"], added
        for k in base:
            if k not in new:
                gone.append(f"{path}.{k} 사라짐")
            else:
                g, a = diff(base[k], new[k], f"{path}.{k}")
                gone += g; added += a
        added += [f"{path}.{k}" for k in new if k not in base]
    elif base != new:
        gone.append(f"{path or '.'}: {base} -> {new if isinstance(new, str) else '구조'} 타입 변경")
    return gone, added


def sample(name, r):
    try:
        data = r.json()
    except ValueError:
        data = None
    s = samples.setdefault(name, {"status": r.status_code, "shape": None})
    s["shape"] = merge(s["shape"], shape(data))
    s["status"] = r.status_code
    return data


# ---------- 시나리오 ----------
def run(gw, mock):
    c = httpx.Client(timeout=30)
    G = lambda p, **k: c.get(gw + p, headers=ADM, **k)

    def call(tok, ip=None):
        h = {"Authorization": f"Bearer {tok}"} | ({"X-Demo-Source-IP": ip} if ip else {})
        return c.post(f"{gw}/v1/chat/completions", headers=h, json=BODY)

    print("== (a) UI 정적 파일")
    for p in UI_PAGES + [f"/ui/js/{j}" for j in UI_JS]:
        r = c.get(gw + p)
        check(f"GET {p} 200", r.status_code == 200, f"status={r.status_code}")

    print("== (b) 시나리오")
    rs = c.post(f"{gw}/demo/reset")
    d = sample("POST /demo/reset", rs)
    if not check("리셋 200·토큰 발급", rs.status_code == 200 and set(d["tokens"]) == {"userA", "userB"}):
        return
    toks = d["tokens"]
    cr = G("/admin/credentials")
    sample("GET /admin/credentials", cr)
    live = c.get(mock + "/live/config")
    sample("GET /live/config", live)
    leaked = live.json().get("key", "")
    check("(d) 크레덴셜 응답에 sk- 키 원문 없음", not SK_RE.search(cr.text) and (not leaked or leaked not in cr.text),
          f"status={cr.status_code}")
    r = call(toks["userA"]); sample("POST /v1/chat/completions", r)
    check("userA 호출 200", r.status_code == 200, f"status={r.status_code}")
    check("userB 호출 200", call(toks["userB"]).status_code == 200)
    r = c.post(f"{mock}/live/chat", json={"key": leaked, "message": "hi"}); sample("POST /live/chat", r)
    check("청중 /live/chat(유출 키) 200", r.status_code == 200, f"status={r.status_code}")
    sample("GET /live/stats", c.get(mock + "/live/stats"))

    cid = c.post(f"{gw}/admin/cidrs", headers=ADM, json={"cidr": "10.0.0.0/16", "label": "INTERNAL"}).json()["id"]
    try:
        sample("GET /admin/cidrs", G("/admin/cidrs"))
        check("허용 밖 IP 403", call(toks["userA"], "203.0.113.9").status_code == 403)
        sample("GET /admin/access-denied?limit=5", G("/admin/access-denied", params={"limit": 5}))
    finally:
        c.delete(f"{gw}/admin/cidrs/{cid}", headers=ADM)
    check("대역 삭제 후 200", call(toks["userA"], "203.0.113.9").status_code == 200)

    sample("POST /demo/wif/seed", c.post(f"{gw}/demo/wif/seed"))
    sample("GET /admin/trusted-identities", G("/admin/trusted-identities"))
    jwt = sample("POST /demo/wif/token", c.post(f"{gw}/demo/wif/token"))["token"]
    r = call(jwt)
    check("WIF JWT 호출 200", r.status_code == 200, f"status={r.status_code}")

    sample("GET /admin/services", G("/admin/services"))
    sample("GET /admin/settings", G("/admin/settings"))
    sample("GET /admin/usage/summary?range=day", G("/admin/usage/summary", params={"range": "day"}))
    sample("GET /admin/usage/forecast", G("/admin/usage/forecast"))
    sample("GET /admin/usage/timeseries?range=day&bucket=hour",
           G("/admin/usage/timeseries", params={"range": "day", "bucket": "hour"}))

    r = c.post(f"{gw}/demo/attack/start"); sample("POST /demo/attack/start", r)
    check("공격 시작 200", r.status_code == 200, f"status={r.status_code}")
    t0, seen, fails = time.time(), [], 0
    while time.time() - t0 < 90:
        st = sample("GET /admin/dashboard", G("/admin/dashboard"))["status"]
        if not seen or seen[-1] != st:
            seen.append(st)
        sample("GET /admin/timeseries?range=300", G("/admin/timeseries", params={"range": 300}))
        sample("GET /admin/events?since_id=0", G("/admin/events", params={"since_id": 0}))
        fails += call(toks["userA"]).status_code != 200
        if st == "RECOVERED":
            break
        time.sleep(1)
    order = [s for s in seen if s in ("SUSPECT", "WARNING", "BLOCKED", "RECOVERED")]
    check("상태 SUSPECT→WARNING→BLOCKED→RECOVERED 순서", order == ["SUSPECT", "WARNING", "BLOCKED", "RECOVERED"], "->".join(seen))
    check("공격 중 사용자 호출 실패 0건", fails == 0, f"실패 {fails}")
    r = c.post(f"{mock}/live/chat", json={"key": leaked, "message": "hi"})
    check("유출 키 청중 호출 401", r.status_code == 401, f"status={r.status_code}")
    check("차단 후 userA·userB 200", all(call(t).status_code == 200 for t in toks.values()))
    time.sleep(3)  # 최종 손실 재계산 대기
    cr = G("/admin/credentials"); sample("GET /admin/credentials", cr)
    check("(d) 교체 후 크레덴셜 응답에 sk- 키 원문 없음", not SK_RE.search(cr.text))
    inc = sample("GET /admin/incidents", G("/admin/incidents"))
    if check("사고 생성", bool(inc)):
        i = sample("GET /admin/incidents/{id}", G(f"/admin/incidents/{inc[0]['id']}"))
        check("사고 RESOLVED", i["status"] == "RESOLVED", i["status"])
        check("손실 호출 수 < 한도", 0 < i["loss_calls"] < i["limit_calls"], f"{i['loss_calls']} < {i['limit_calls']}")
    # 허니키 hit은 전체 토큰을 폐기하므로 사용자 호출 검사가 모두 끝난 뒤에 한다
    r = c.post(f"{gw}/demo/honeypot/hit"); sample("POST /demo/honeypot/hit", r)
    check("허니키 hit 응답", r.status_code == 200, f"status={r.status_code}")
    sample("GET /admin/honeykeys", G("/admin/honeykeys"))
    check("허니키 사용 후 일반 토큰 폐기(401)", call(toks["userA"]).status_code == 401)
    sample("GET /admin/events?since_id=0", G("/admin/events", params={"since_id": 0}))
    sample("GET /admin/dashboard", G("/admin/dashboard"))
    c.post(f"{gw}/demo/reset")
    tot = G("/admin/usage/summary", params={"range": "day"}).json()["total"]["calls"]
    check("리셋 후 사용량 0", tot == 0, f"calls={tot}")


def compare(mode):
    print(f"== (c) 기준선 구조 비교 ({mode})")
    allb = json.loads(BASE.read_text(encoding="utf-8")) if BASE.exists() else {}
    if mode not in allb:
        return check("기준선 존재", False, f"{BASE.name}에 {mode} 없음. --capture 먼저")
    base = allb[mode]
    for name, b in base.items():
        n = samples.get(name)
        if not n:
            rec("FAIL", name, "이번 실행에서 호출되지 않음")
        elif n["status"] != b["status"]:
            rec("FAIL", name, f"상태 코드 {b['status']} -> {n['status']}")
        else:
            gone, added = diff(b["shape"], n["shape"])
            if gone:
                rec("FAIL", name, "; ".join(gone[:5]))
            elif added:
                rec("WARN", name, "새 필드: " + ", ".join(added[:5]))
            else:
                rec("PASS", name, f"status={n['status']}")
    for name in samples.keys() - base.keys():
        rec("WARN", name, "기준선에 없는 엔드포인트")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", default="http://127.0.0.1:8000")
    ap.add_argument("--mock", default="http://127.0.0.1:9000")
    ap.add_argument("--mode", choices=["mock", "vllm"], default="mock")
    ap.add_argument("--capture", action="store_true", help="비교 대신 기준선 저장")
    a = ap.parse_args()
    try:
        run(a.gw.rstrip("/"), a.mock.rstrip("/"))
    except Exception as e:  # 시나리오 중단도 FAIL로 센다
        rec("FAIL", "시나리오 실행 중 예외", repr(e)[:200])
    if a.capture:
        if any(r[0] == "FAIL" for r in res):
            print("FAIL이 있어 기준선을 저장하지 않는다.")
        else:
            allb = json.loads(BASE.read_text(encoding="utf-8")) if BASE.exists() else {}
            allb[a.mode] = samples
            BASE.write_text(json.dumps(allb, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
            print(f"기준선 저장: {BASE} [{a.mode}] 엔드포인트 {len(samples)}개")
    else:
        compare(a.mode)
    cnt = {k: sum(r[0] == k for r in res) for k in ("PASS", "WARN", "FAIL")}
    print(f"\n=== 요약: PASS {cnt['PASS']} / WARN {cnt['WARN']} / FAIL {cnt['FAIL']}")
    sys.exit(1 if cnt["FAIL"] else 0)


if __name__ == "__main__":
    main()
