"""웹 콘솔 탭·시트 스크린샷 재현 스크립트(시드 포함).
사용: python scripts/capture_console_tabs.py --gw http://127.0.0.1:8402 --mock http://127.0.0.1:9402 --out docs/screenshots
"""
import argparse, io, os, time
import httpx
from PIL import Image
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--gw", default="http://127.0.0.1:8402")
ap.add_argument("--mock", default="http://127.0.0.1:9402")
ap.add_argument("--key", default="admin")
ap.add_argument("--out", default="docs/screenshots")
ap.add_argument("--skip-seed", action="store_true")
a = ap.parse_args()
ADM = {"X-Admin-Key": a.key}
MSGS = ["회의록 요약해 줘", "이 문장 영어로 바꿔 줘", "고객 문의 답장 초안", "코드 리뷰 부탁해", "보고서 제목 추천", "SQL 쿼리 설명해 줘"]


def seed():
    c = httpx.Client(timeout=60)
    toks = c.post(f"{a.gw}/demo/reset").json()["tokens"]

    def call(t, m):
        return c.post(f"{a.gw}/v1/chat/completions", headers={"Authorization": f"Bearer {t}"},
                      json={"model": "mock", "messages": [{"role": "user", "content": m}], "max_tokens": 50})
    for i in range(30):
        call(toks["userA" if i % 2 == 0 else "userB"], MSGS[i % len(MSGS)])
    c.post(f"{a.gw}/demo/attack/start")
    t0 = time.time()
    while time.time() - t0 < 120:
        call(toks["userA"], "hi")
        if c.get(f"{a.gw}/admin/dashboard", headers=ADM).json()["status"] == "RECOVERED":
            break
        time.sleep(1)
    time.sleep(3)
    cid = c.post(f"{a.gw}/admin/cidrs", headers=ADM, json={"cidr": "10.0.0.0/16", "label": "INTERNAL"}).json()["id"]
    c.post(f"{a.gw}/admin/cidrs", headers=ADM, json={"cidr": "192.168.10.0/24", "label": "VPN"})
    c2 = c.post(f"{a.gw}/admin/cidrs", headers=ADM, json={"cidr": "172.16.0.0/12", "label": "INTERNAL"}).json()["id"]
    c.delete(f"{a.gw}/admin/cidrs/{c2}", headers=ADM)


def shrink(path, limit=600_000):
    im = Image.open(path)
    im.save(path, optimize=True)
    if os.path.getsize(path) > limit:
        im.convert("RGB").quantize(256, dither=Image.FLOYDCMYK if False else Image.NONE).save(path, optimize=True)


def main():
    os.makedirs(a.out, exist_ok=True)
    if not a.skip_seed:
        seed()
    url = f"{a.gw}/ui/index.html?mode=live&api={a.gw}&mock={a.mock}&key={a.key}"
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2).new_page()

        def go(tab):
            pg.goto(f"{url}#{tab}"); pg.reload(); pg.wait_for_timeout(3500)

        def shot(name, full=False):
            f = os.path.join(a.out, name + ("-full" if full else "") + ".png")
            pg.screenshot(path=f, full_page=full); shrink(f)

        go("usage"); shot("20-usage"); shot("20-usage", True)
        go("limits"); shot("21-limits")
        go("keys"); shot("22-keys")
        pg.click("#addCred"); pg.wait_for_timeout(800); shot("23-keys-issue-sheet")
        go("incidents")
        row = pg.locator("#view [data-inc], #view .row").first
        try: row.click(); pg.wait_for_timeout(1000)
        except Exception: pass
        shot("25-incidents")
        pg.keyboard.press("Escape")
        go("incidents"); pg.click("#demoBtn"); pg.wait_for_timeout(800); shot("26-demo-control")
        go("usage"); pg.click("#connChip"); pg.wait_for_timeout(800)
        pg.fill("#cKey", ""); shot("27-connection-sheet")
        # 접근 제어: 허니키 hit은 서비스를 정지시키므로 마지막
        c = httpx.Client(timeout=30)
        c.post(f"{a.gw}/demo/wif/seed"); c.post(f"{a.gw}/demo/honeypot/hit"); time.sleep(2)
        go("access"); shot("24-access"); shot("24-access", True)
        c.post(f"{a.gw}/demo/reset")
        b.close()


main()
