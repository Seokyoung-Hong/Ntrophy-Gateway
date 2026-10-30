"""랜딩·공격자·직원 화면 스크린샷 재현 스크립트(서버는 미리 띄워 둔다).
사용: python scripts/capture_user_screens.py --api http://127.0.0.1:8403 --mock http://127.0.0.1:9403 --admin-key admin
"""
import argparse, io, json, time, urllib.request
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:8403")
ap.add_argument("--mock", default="http://127.0.0.1:9403")
ap.add_argument("--admin-key", default="admin")
ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "docs" / "screenshots"))
a = ap.parse_args()
OUT = Path(a.out); OUT.mkdir(parents=True, exist_ok=True)
Q = f"mode=live&api={a.api}&mock={a.mock}&key={a.admin_key}"
ATK, EMP = f"{a.api}/ui/live.html?{Q}", f"{a.api}/ui/employee.html?{Q}"


def post(path):
    r = urllib.request.Request(a.api + path, method="POST", data=b"{}", headers={"X-Admin-Key": a.admin_key, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=90))


def save(page, name, **kw):
    png = page.screenshot(**kw)
    im = Image.open(io.BytesIO(png)).convert("RGB")
    p = OUT / name
    im.save(p, optimize=True)
    if p.stat().st_size > 600_000:
        im.quantize(256).save(p, optimize=True)
    print(name, p.stat().st_size)


def ask(page, text, ai_cls=".msg.ai"):
    n = page.locator(f"#msgs {ai_cls}").count()
    page.fill("#input", text); page.click("#send")
    page.wait_for_function("n => { const l=document.querySelectorAll('#msgs .msg.ai'); return l.length>n && !l[l.length-1].querySelector('.typing') && l[l.length-1].textContent.trim().length>0 }", arg=n, timeout=90000)
    page.wait_for_timeout(1200)


reset = post("/demo/reset")
print("tokens:", list(reset.get("tokens", {})))
store = json.dumps({**reset, "at": int(time.time() * 1000), "mode": "live"})
init = f"try{{localStorage.setItem('ng.reset', {json.dumps(store)})}}catch(e){{}}"

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    dctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, locale="ko-KR")
    dctx.add_init_script(init)
    mctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, has_touch=True, is_mobile=True, locale="ko-KR")
    mctx.add_init_script(init)

    pg = dctx.new_page(); pg.goto(a.api + "/"); pg.wait_for_timeout(2500)
    save(pg, "00-landing.png", full_page=True)

    atk = dctx.new_page(); atk.goto(ATK)
    atk.wait_for_function("!document.getElementById('leakedKey').textContent.includes('불러오는')"); atk.wait_for_timeout(1000)
    save(atk, "30-attacker-ready.png")
    for q in ["점심 메뉴 추천해 줘", "이 문장을 영어로 바꿔 줘: 오늘 회의는 3시에 시작합니다.", "신입사원 환영 인사말 한 줄만 써 줘"]:
        ask(atk, q)
    atk.evaluate("scrollTo(0, document.body.scrollHeight)"); atk.wait_for_timeout(800)
    save(atk, "31-attacker-chatting.png")

    emp = dctx.new_page(); emp.goto(EMP); emp.wait_for_timeout(1500)
    if emp.locator('[data-who="userA"]').count(): emp.click('[data-who="userA"]')
    for q in ["회의록 요약할 때 좋은 형식 알려 줘", "이 문장을 영어로 바꿔 줘: 내일까지 보고서를 제출해 주세요.", "점심 메뉴 추천해 줘"]:
        ask(emp, q)
    emp.evaluate("scrollTo(0, document.body.scrollHeight)"); emp.wait_for_timeout(800)
    save(emp, "33-employee-chat.png")

    post("/demo/attack/start")
    atk.wait_for_selector("#blocked:not([hidden])", timeout=90000); atk.wait_for_timeout(1000)
    save(atk, "32-attacker-blocked.png")

    emp.bring_to_front()
    ask(emp, "차단 이후에도 되는지 확인할게요. 오늘 날씨 인사말을 써 줘")
    ask(emp, "고마워요, 퇴근 인사도 한 줄로 부탁해요")
    emp.evaluate("scrollTo(0, document.body.scrollHeight)"); emp.wait_for_timeout(800)
    save(emp, "34-employee-after-block.png")

    m = mctx.new_page(); m.goto(ATK); m.wait_for_selector("#blocked:not([hidden])", timeout=60000); m.wait_for_timeout(1000)
    save(m, "41-mobile-attacker-blocked.png")
    me = mctx.new_page(); me.goto(EMP); me.wait_for_timeout(1500)
    if me.locator('[data-who="userA"]').count(): me.click('[data-who="userA"]')
    for q in ["점심 메뉴 추천해 줘", "이 문장을 영어로 바꿔 줘: 감사합니다."]:
        ask(me, q)
    me.evaluate("scrollTo(0, document.body.scrollHeight)"); me.wait_for_timeout(800)
    save(me, "42-mobile-employee.png")
    b.close()
