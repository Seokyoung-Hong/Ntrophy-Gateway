"""콘솔 홈 단계별 스크린샷. 사용: python scripts/capture_console_home.py --gw http://127.0.0.1:8401 --mock http://127.0.0.1:9401 --out docs/screenshots
서버(게이트웨이+Mock)는 미리 띄워 둔다. 시스템 Chrome 사용."""
import argparse, io, threading, time, os
import httpx
from PIL import Image
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--gw", default="http://127.0.0.1:8401")
ap.add_argument("--mock", default="http://127.0.0.1:9401")
ap.add_argument("--key", default="admin")
ap.add_argument("--out", default="docs/screenshots")
ap.add_argument("--normal-secs", type=int, default=40)
a = ap.parse_args()
H = {"X-Admin-Key": a.key}
URL = f"{a.gw}/ui/index.html?mode=live&api={a.gw}&mock={a.mock}&key={a.key}#home"
BODY = {"model": "mock", "messages": [{"role": "user", "content": "안녕하세요, 한 줄로 답해 주세요."}], "max_tokens": 16}
c = httpx.Client(timeout=30)
saved = []


def save(png, name):
    p = os.path.join(a.out, name)
    im = Image.open(io.BytesIO(png)).convert("RGB")
    im.save(p, optimize=True)
    if os.path.getsize(p) > 600_000:
        im.quantize(256).save(p, optimize=True)
    saved.append((name, os.path.getsize(p)))


def status():
    return c.get(f"{a.gw}/admin/dashboard", headers=H).json()["status"]


def traffic(toks, stop):
    i = 0
    while not stop.is_set():
        try:
            c.post(f"{a.gw}/v1/chat/completions", headers={"Authorization": f"Bearer {toks[('userA','userB')[i%2]]}"}, json=BODY)
        except Exception:
            pass
        i += 1
        stop.wait(0.6)


def wait_status(want, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if status() in want:
            return status()
        time.sleep(0.25)


def run(ctx_kw, reset=True):
    toks = c.post(f"{a.gw}/demo/reset").json()["tokens"] if reset else None
    return toks


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    pg = ctx.new_page()
    toks = c.post(f"{a.gw}/demo/reset").json()["tokens"]
    pg.goto(URL); pg.wait_for_timeout(1500)
    stop = threading.Event(); th = threading.Thread(target=traffic, args=(toks, stop), daemon=True); th.start()
    pg.wait_for_timeout(a.normal_secs * 1000)
    save(pg.screenshot(), "10-console-home-normal.png"); print("10", status())
    c.post(f"{a.gw}/demo/attack/start")
    for want, name in (("SUSPECT", "11-console-home-suspect.png"), ("WARNING", "12-console-home-warning.png")):
        s = wait_status({want}); pg.wait_for_timeout(1000)
        save(pg.screenshot(), name); print(name, s, "->", status())
    s = wait_status({"BLOCKED"}); pg.wait_for_timeout(1800)
    save(pg.screenshot(), "13-console-home-blocked-popup.png"); print("13", s, "->", status())
    pg.wait_for_timeout(5000)  # 타임라인 단계가 채워질 때까지
    sh = pg.locator("#incBody")
    if sh.count():
        sh.evaluate("e=>{const t=e.querySelector('.timeline,[class*=timeline],ol,ul');(t||e).scrollIntoView({block:'center'})}")
        pg.wait_for_timeout(500)
    save(pg.screenshot(), "15-console-incident-timeline.png"); print("15", status())
    btn = pg.locator("[data-close]").last
    if btn.count(): btn.click()
    pg.wait_for_timeout(500)
    s = wait_status({"RECOVERED"}, 60); pg.wait_for_timeout(1500)
    save(pg.screenshot(), "14-console-home-recovered.png"); print("14", s, "->", status())
    pg.evaluate("localStorage.setItem('ng.theme','dark')"); pg.reload(); pg.wait_for_timeout(2500)
    save(pg.screenshot(), "16-console-home-dark.png"); print("16", status())
    stop.set(); th.join()
    ctx.close()
    # 모바일: 초기화 후 정상 호출 15초
    toks = c.post(f"{a.gw}/demo/reset").json()["tokens"]
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); pg.goto(URL); pg.wait_for_timeout(1000)
    stop = threading.Event(); th = threading.Thread(target=traffic, args=(toks, stop), daemon=True); th.start()
    pg.wait_for_timeout(20000)
    save(pg.screenshot(), "40-mobile-home.png")
    stop.set(); th.join(); b.close()
for n, s in saved:
    print(n, s // 1024, "KB")
