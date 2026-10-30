"""기능 테스트 페이지 스크린샷 2장 + 문서 Mermaid PNG 4장.
사용: python scripts/capture_arch_and_tests.py [--gw http://127.0.0.1:8404] [--mock http://127.0.0.1:9404] [--skip-tests] [--skip-arch]
테스트 페이지는 게이트웨이/Mock 서버를 미리 띄워 둔다. 시스템 Chrome 사용."""
import argparse, io, os, re, time
from PIL import Image
from playwright.sync_api import sync_playwright

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(R, "docs", "screenshots")
ap = argparse.ArgumentParser()
ap.add_argument("--gw", default="http://127.0.0.1:8404")
ap.add_argument("--mock", default="http://127.0.0.1:9404")
ap.add_argument("--skip-tests", action="store_true")
ap.add_argument("--skip-arch", action="store_true")
a = ap.parse_args()
os.makedirs(OUT, exist_ok=True)


def save(png, name, maxw=2400, limit=800_000):
    p = os.path.join(OUT, name)
    im = Image.open(io.BytesIO(png)).convert("RGB")
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(p, optimize=True)
    if os.path.getsize(p) > limit:
        im.quantize(256).save(p, optimize=True)
    print(name, im.size, os.path.getsize(p))


MASK = r"""()=>{const re=[[/(nvm-(?:honey-)?)[A-Za-z0-9_-]{6,}/g,"$1****"],[/eyJ[A-Za-z0-9_.-]{10,}/g,"eyJ****"]];const f=t=>re.reduce((a,[r,x])=>a.replace(r,x),t);const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())n.nodeValue=f(n.nodeValue);document.querySelectorAll("input,textarea").forEach(e=>e.value=f(e.value));document.querySelectorAll("option").forEach(e=>e.textContent=f(e.textContent))}"""  # 토큰·JWT 원문 가림


def tests(b):
    pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    pg.goto(f"{a.gw}/test"); pg.fill("#akey", "admin")
    for t in ("연결 확인", "/demo/reset", "/demo/wif/seed"):
        pg.get_by_role("button", name=t, exact=False).first.click(); pg.wait_for_timeout(1500)
    pg.get_by_role("button", name="전송", exact=True).first.click(); pg.wait_for_timeout(3000)  # 사용자 채팅(토큰)
    pg.fill("#w_sub", "repo:november/app:ref:refs/heads/main")  # seed 규칙(repo:november/*)과 맞는 sub
    pg.get_by_role("button", name="JWT 받기").click(); pg.wait_for_timeout(1500)
    pg.get_by_role("button", name="이 JWT로 사용자 채팅 전송").click(); pg.wait_for_timeout(2500)
    pg.fill("#akey", "")  # 키 가림
    pg.evaluate(MASK); pg.evaluate("window.scrollTo(0,0)")
    save(pg.screenshot(full_page=True), "50-test-console.png")
    pg.goto(f"{a.gw}/test/auto")
    pg.fill("#akey", "admin"); pg.fill("#lbase", a.mock)
    pg.click("#runall")
    pg.wait_for_function("document.body.innerText.includes('SKIP') && !document.body.innerText.includes('RUN	')", timeout=180000)
    pg.wait_for_timeout(2000)
    pg.fill("#akey", "")
    pg.evaluate(MASK); pg.evaluate("window.scrollTo(0,0)")
    save(pg.screenshot(full_page=True), "51-test-auto-pass.png")


def arch(b):
    def blocks(f):
        return re.findall(r"```mermaid\n(.*?)```", open(os.path.join(R, "docs", f), encoding="utf-8").read(), re.S)
    ab, kb = blocks("architecture.md"), blocks("key-security-design.md")
    jobs = [("60-arch-components.png", ab[0]), ("61-arch-detection-sequence.png", ab[1]),
            ("62-arch-personal-wif.png", ab[2]), ("63-arch-key-storage.png", kb[0])]
    pg = b.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
    pg.set_content('<body style="margin:0;background:#fff"><div id="w" style="display:inline-block;padding:24px;background:#fff;font-family:\'Malgun Gothic\',sans-serif"></div></body>')
    pg.add_script_tag(url="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js")
    pg.evaluate("mermaid.initialize({startOnLoad:false,theme:'default',themeVariables:{fontFamily:'Malgun Gothic, sans-serif'}})")
    for i, (name, src) in enumerate(jobs):
        try:
            svg = pg.evaluate("async ([id,s])=>(await mermaid.render(id,s)).svg", [f"d{i}", src])
        except Exception as e:
            print("FAIL", name, str(e)[:300]); continue
        pg.evaluate("s=>{const w=document.getElementById('w');w.innerHTML=s;const v=w.querySelector('svg');const vb=v.viewBox.baseVal;v.style.maxWidth='none';v.style.width=vb.width+'px';v.style.height=vb.height+'px'}", svg)
        save(pg.locator("#w").screenshot(), name)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    if not a.skip_arch: arch(b)
    if not a.skip_tests: tests(b)
    b.close()
