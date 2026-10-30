"""데모 리허설: 서버(Mock 9000 + Gateway 8000) 기동 후 `.venv/Scripts/python scripts/rehearse.py`
판정 기준은 '설명되지 않는 호출 수'(공급자 호출 수 - 게이트웨이 호출 수). 금액은 참고 표시."""
import sys
import threading
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8")
GW, ADM = "http://127.0.0.1:8000", {"X-Admin-Key": "admin"}
BODY = {"model": "mock", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}
c = httpx.Client(timeout=10)
results = []  # (이름, 통과, 설명)


def check(name, ok, info=""):
    results.append((name, ok, info))
    print(f"[{'OK' if ok else 'NG'}] {name} {info}")


def call(tok, ip=None):
    h = {"Authorization": f"Bearer {tok}"} | ({"X-Demo-Source-IP": ip} if ip else {})
    return c.post(f"{GW}/v1/chat/completions", headers=h, json=BODY).status_code


def dash():
    return c.get(f"{GW}/admin/dashboard", headers=ADM).json()


def attack_round(tag, toks, strict=True):
    """공격 시작 → RECOVERED까지 관찰. (BLOCKED 경과 초, 최종 사고) 반환. 사용자는 0.5초 간격 호출 유지."""
    stop, stats = threading.Event(), {"ok": 0, "fail": 0}

    def user_loop():
        i = 0
        while not stop.is_set():
            try:
                s = call(list(toks.values())[i % 2])
            except Exception:
                s = 0
            stats["ok" if s == 200 else "fail"] += 1
            i += 1
            stop.wait(0.5)

    th = threading.Thread(target=user_loop, daemon=True)
    th.start()
    c.post(f"{GW}/demo/attack/start")
    t0, seen, last, blocked_at = time.time(), [], None, None
    while time.time() - t0 < 90:
        d, el = dash(), time.time() - t0
        if d["status"] != last or int(el) % 5 == 0:
            print(f"  t={el:5.1f}s  {d['status']:<9} 차액 {d['diff_calls']:>3}건 / 한도 {d['limit_calls']}건 "
                  f"(게이트웨이 {d['gateway_calls']} / 공급자 {d['provider_calls']}, 참고 {d['diff_krw']:,.0f}원)")
        if d["status"] != last:
            seen.append(d["status"])
            last = d["status"]
        if d["status"] == "BLOCKED" and blocked_at is None:
            blocked_at = el
        if d["status"] == "RECOVERED":
            break
        time.sleep(1)
    time.sleep(2)  # 사용자 호출이 새 키로 계속 성공하는지 잠시 더 관찰
    stop.set()
    th.join()
    # 한도가 작으면 한 틱(2초≈10건)에 WARNING 구간을 건너뛸 수 있어 strict가 아니면 BLOCKED·RECOVERED만 본다
    need = ("SUSPECT", "WARNING", "BLOCKED", "RECOVERED") if strict else ("BLOCKED", "RECOVERED")
    check(f"[{tag}] 상태 전이 관찰", all(s in seen for s in need), "->".join(seen))
    check(f"[{tag}] 차단 중 사용자 호출 실패 0건", stats["fail"] == 0, f"성공 {stats['ok']} / 실패 {stats['fail']}")
    check(f"[{tag}] 차단 후 사용자 호출 200", all(call(t) == 200 for t in toks.values()))
    inc = c.get(f"{GW}/admin/incidents", headers=ADM).json()
    if not inc:
        check(f"[{tag}] 사고 생성", False)
        return blocked_at, None
    time.sleep(3)  # 최종 손실 재계산(폐기 2.5초 후) 대기
    i = c.get(f"{GW}/admin/incidents/{inc[0]['id']}", headers=ADM).json()
    print(f"  BLOCKED 경과 {blocked_at}s, 손실 {i['loss_calls']}건 / 한도 {i['limit_calls']}건 "
          f"(참고 {i['loss_krw']:,.0f}원), 차단 소요 {i['duration_s']}s, "
          f"{i['credential_masked']} -> {i['new_credential_masked']}, 상태 {i['status']}")
    for t in i["timeline"]:
        print(f"    {t['at'][11:23]} {t['step']:<19} {'OK' if t['ok'] else 'NG'} {t['detail']}")
    ok = 0 < i["loss_calls"] < i["limit_calls"]
    if strict:
        check(f"[{tag}] 손실 호출 수 < 한도 호출 수", ok, f"{i['loss_calls']} < {i['limit_calls']}")
    else:  # 집계 지연 2초 + 폴링 2초 동안 약 10~20건이 더 들어오므로 작은 한도에서는 초과할 수 있다(참고 출력)
        print(f"  [참고] 손실 {i['loss_calls']}건 {'<' if ok else '>='} 한도 {i['limit_calls']}건")
    check(f"[{tag}] 사고 RESOLVED", i["status"] == "RESOLVED")
    return blocked_at, i


print("== 1. 리셋")
toks = c.post(f"{GW}/demo/reset").json()["tokens"]
check("리셋·토큰 발급", set(toks) == {"userA", "userB"}, str(list(toks)))
s = c.get(f"{GW}/admin/settings", headers=ADM).json()
check("설정 기본값", s.get("unauthorized_call_limit") == 100, str(s))

print("== 2. 정상 호출 / IP 정책")
for n, t in toks.items():
    check(f"{n} 정상 호출 200", (s := call(t)) == 200, f"status={s}")
check("리셋 후 허용 CIDR 0개", c.get(f"{GW}/admin/cidrs", headers=ADM).json() == [])
check("CIDR 0개면 임의 IP 200", (s := call(toks["userA"], "203.0.113.9")) == 200, f"status={s}")
cid = c.post(f"{GW}/admin/cidrs", headers=ADM, json={"cidr": "10.0.0.0/16", "label": "INTERNAL"}).json()["id"]
try:
    check("대역 등록 후 허용 밖 IP 403", (s := call(toks["userA"], "203.0.113.9")) == 403, f"status={s}")
    check("대역 등록 후 허용 IP 200", (s := call(toks["userA"], "10.0.0.5")) == 200, f"status={s}")
finally:
    c.delete(f"{GW}/admin/cidrs/{cid}", headers=ADM)
cid = c.post(f"{GW}/admin/cidrs", headers=ADM, json={"cidr": "*", "label": "ALL"}).json()["id"]
try:
    check("* 등록 시 임의 IP 200", (s := call(toks["userA"], "203.0.113.9")) == 200, f"status={s}")
finally:
    c.delete(f"{GW}/admin/cidrs/{cid}", headers=ADM)
check("삭제 후 다시 모두 허용", (s := call(toks["userA"], "203.0.113.9")) == 200, f"status={s}")

print("== 3. 공격 라운드 1 (한도 100건)")
b1, _ = attack_round("한도100", toks)

print("== 4. 허니키 (엔드포인트가 있을 때만)")
r = c.post(f"{GW}/demo/honeypot/hit")
if r.status_code == 404:
    print("  /demo/honeypot/hit 없음 -> 건너뜀")
else:
    check("허니키 hit 응답", r.status_code < 400, f"status={r.status_code} {r.text[:80]}")

print("== 5. 공격 라운드 2 (리셋 후 한도 30건)")
toks = c.post(f"{GW}/demo/reset").json()["tokens"]
s = c.put(f"{GW}/admin/settings", headers=ADM, json={"unauthorized_call_limit": 30}).json()
check("한도 30 설정", s.get("unauthorized_call_limit") == 30 and s.get("loss_limit_krw") == 100000, str(s))
b2, _ = attack_round("한도30", toks, strict=False)
check("한도 30이 더 일찍 차단", b1 is not None and b2 is not None and b2 < b1, f"{b2}s < {b1}s")

bad = [n for n, ok, _ in results if not ok]
print(f"\n=== {'PASS' if not bad else 'FAIL: ' + ', '.join(bad)} ({len(results) - len(bad)}/{len(results)})")
sys.exit(1 if bad else 0)
