/* live.js — 공격자 채팅 페이지 (docs/demo-page-spec.md 페이지 A)
 * 유출된 키로 공급자(Mock /live/chat)에 직접 호출한다. 게이트웨이를 거치지 않는다.
 * 차단 감지 두 경로: ① 전송 응답 401 ② /live/stats 의 key_status=revoked (2초 폴링)
 * 상태 훅: body[data-state=active|busy|revoked|limited] (원본 live.html과 호환) */
(function () {
  'use strict';
  const { $, esc, icon, n, toast } = UI;

  const hist = []; // 이전 대화(모델에 문맥으로 전달)
  const st = { key: '', revoked: false, shown: false, busy: false, sim: false, fakePeople: 1, audience: null };
  const msgs = $('#msgs'), input = $('#input');
  $('#send').innerHTML = icon('send');
  $('#blkIc').innerHTML = icon('ban');

  const setState = (s) => { document.body.dataset.state = s; };
  const scroll = () => scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  function add(kind, html, meta) {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.innerHTML = html + (meta ? `<span class="msg-meta">${meta}</span>` : '');
    msgs.append(el);
    scroll();
    return el;
  }

  function revoke(fromSend) {
    st.revoked = true;
    setState('revoked');
    $('#keyStatus').className = 'badge bad live-status';
    $('#keyStatus').textContent = '차단됨';
    $('#keyTag').hidden = false;
    input.disabled = true;
    input.placeholder = '이 키는 더 이상 쓸 수 없어요';
    if (fromSend) add('err', '401 · 이 키는 폐기되었습니다');
    if (!st.shown) { // 알림은 한 번만
      st.shown = true;
      $('#blocked').hidden = false;
      $('#blkAgain').hidden = !st.sim;
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
    if (st.audience) { clearInterval(st.audience); st.audience = null; }
  }

  function restore() { // /demo/reset 후 키가 다시 active 가 되면 새로고침 없이 복귀
    st.revoked = false; st.shown = false; hist.length = 0;
    setState('active');
    $('#keyStatus').className = 'badge ok live-status';
    $('#keyStatus').textContent = '사용 가능';
    $('#keyTag').hidden = true;
    $('#blocked').hidden = true;
    input.disabled = false;
    input.placeholder = '무엇이든 물어보세요';
    add('sys', '키가 다시 활성화됐어요');
    loadConfig();
  }

  async function loadConfig() {
    try {
      const c = await API.liveConfig();
      st.key = c.key;
      $('#leakedKey').textContent = c.key;
      $('#stMode').textContent = st.sim ? '시뮬레이션' : c.model;
      $('#netErr').hidden = true;
    } catch (e) {
      $('#leakedKey').textContent = '키를 불러오지 못했어요';
      $('#netErr').hidden = false;
    }
  }

  async function send(text) {
    text = text.trim().slice(0, 300);
    if (!text || st.busy || st.revoked) return;
    st.busy = true;
    setState('busy');
    add('me', esc(text));
    input.value = ''; autosize(); count();
    const typing = add('ai', '<span class="typing"><i></i><i></i><i></i></span>');
    startAudience();
    try {
      const r = await API.liveChat(st.key, text, hist.slice(-10));
      hist.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
      typing.innerHTML = esc(r.reply);
      setState('active');
    } catch (e) {
      typing.remove();
      if (e.status === 401) revoke(true);
      else if (e.status === 429) { setState('limited'); toast('잠시 후 다시 시도하세요', 'warn'); setTimeout(() => !st.revoked && setState('active'), 3000); }
      else { setState('active'); add('err', `${e.status || ''} 연결에 실패했어요`); $('#netErr').hidden = false; }
    } finally {
      st.busy = false;
      if (!st.revoked && document.body.dataset.state === 'busy') setState('active');
    }
  }

  async function poll() {
    try {
      const s = await API.liveStats();
      const people = st.sim ? st.fakePeople : s.participants;
      $('#stPeople').textContent = `접속 ${n(people)}명`;
      $('#stCalls').textContent = `호출 ${n(st.sim ? s.calls + st.fakeCalls : s.calls)}건`;
      if (s.key_status === 'revoked' && !st.revoked) revoke(false);
      else if (s.key_status === 'active' && st.revoked && !st.sim) restore();
      $('#netErr').hidden = true;
    } catch (e) { /* 다음 폴링에서 다시 */ }
  }

  // 시뮬레이션: 같은 키를 쓰는 가상 공격자. 첫 메시지 뒤 공급자를 직접 두드려 탐지기가 차단하게 만든다.
  st.fakeCalls = 0;
  function startAudience() {
    if (!st.sim || st.audience || st.revoked) return;
    const w = API.simWorld();
    add('sys', `다른 공격자들도 같은 키로 호출하기 시작했어요`);
    st.audience = setInterval(() => {
      st.fakePeople = Math.min(42, st.fakePeople + (Math.random() < 0.5 ? 1 : 0));
      if (w.provider.call(w.LEAKED_KEY, 150) === 200) st.fakeCalls++;
    }, 220);
  }

  // 입력창
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  const count = () => { $('#count').textContent = `${input.value.length} / 300`; };
  input.addEventListener('input', () => { autosize(); count(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  $('#form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  const ideas = ['오늘 점심 메뉴 추천해 줘', '시 한 편 써 줘', '파이썬으로 피보나치', '보안 점검 체크리스트'];
  $('#suggest').innerHTML = ideas.map((t) => `<button class="chip" type="button">${esc(t)}</button>`).join('');
  $('#suggest').onclick = (e) => { const b = e.target.closest('.chip'); if (b) send(b.textContent); };
  $('#blkClose').onclick = () => { $('#blocked').hidden = true; };
  $('#blkAgain').onclick = () => location.reload();
  $('#retry').onclick = () => { loadConfig(); poll(); };

  (async () => {
    st.sim = (await API.init()) === 'sim';
    if (st.sim) await API.reset('mock');
    await loadConfig();
    add('ai', '안녕하세요! 이 키로 무엇이든 물어보세요.');
    await poll();
    setInterval(poll, 2000);
  })();
})();
