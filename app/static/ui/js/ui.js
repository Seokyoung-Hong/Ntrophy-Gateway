/* ui.js — 세 화면이 같이 쓰는 도구: 아이콘, 포맷, 토스트, 시트, 차트 */
(function (global) {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 아이콘 (24px, 2px 선) ----------
  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5 6.5-5s5.7 1.5 6.5 5M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.2 2.2 3.5 5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    honey: '<path d="M12 2 20 6.5v9L12 20l-8-4.5v-9z"/><path d="M12 8v4M12 15h.01"/>',
    swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="16.5" cy="13.5" r="1.2"/>',
    arrow: '<path d="M9 6l6 6-6 6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5"/>',
  };
  const icon = (n, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${P[n] || ''}</svg>`;

  // ---------- 포맷 ----------
  const nf = new Intl.NumberFormat('ko-KR');
  const n = (v, d = 0) => (v == null || Number.isNaN(+v) ? '—' : nf.format(+(+v).toFixed(d)));
  const won = (v) => (v == null ? '—' : `${nf.format(Math.round(v))}원`);
  const time = (isoStr, sec = true) => {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), hour12: false });
  };
  const ago = (isoStr) => {
    const s = Math.max(0, (Date.now() - new Date(isoStr)) / 1000);
    if (s < 10) return '방금';
    if (s < 60) return `${Math.floor(s)}초 전`;
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return time(isoStr, false);
  };

  // ---------- 토스트 ----------
  function toast(msg, kind = 'info', ms = 3200) {
    let host = $('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.append(host); }
    const ic = { ok: 'check', warn: 'alert', bad: 'ban', info: 'bell' }[kind] || 'bell';
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="t-ic">${icon(ic)}</span><span>${esc(msg)}</span>`;
    host.append(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
  }

  // ---------- 시트(데스크톱 모달 · 모바일 바텀시트) ----------
  let openSheet = null;
  function sheet({ title, desc = '', body = '', wide = false, onMount, onClose }) {
    closeSheet();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grabber"></div>
      <div class="sheet-h"><div><h2>${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>
      <button class="icon-btn" data-close aria-label="닫기">${icon('x')}</button></div>
      <div class="sheet-b">${body}</div></div>`;
    document.body.append(scrim);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => scrim.classList.add('on'));
    const api = {
      el: $('.sheet', scrim),
      close() {
        if (openSheet !== api) return;
        openSheet = null;
        scrim.classList.remove('on');
        document.body.style.overflow = '';
        setTimeout(() => scrim.remove(), 260);
        onClose && onClose();
      },
    };
    scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) api.close(); });
    openSheet = api;
    onMount && onMount(api.el, api);
    const f = $('input,select,textarea', api.el);
    if (f && matchMedia('(min-width: 861px)').matches) setTimeout(() => f.focus(), 80);
    return api;
  }
  function closeSheet() { openSheet && openSheet.close(); }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  function confirmSheet({ title, desc, ok = '확인', danger = false }) {
    return new Promise((resolve) => {
      let done = false;
      sheet({
        title, desc,
        body: `<div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn ${danger ? 'danger' : ''}" data-ok>${ok}</button></div>`,
        onMount(el, s) { $('[data-ok]', el).onclick = () => { done = true; resolve(true); s.close(); }; },
        onClose() { if (!done) resolve(false); },
      });
    });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('복사했어요', 'ok', 1600); }
    catch { toast('복사하지 못했어요. 직접 선택해 주세요', 'warn'); }
  }

  // ---------- 두 선 차트 (게이트웨이 vs 공급자, 호출 수) ----------
  // 축 하나, 2px 선, 4개 이하 시리즈라 끝에 직접 라벨, 크로스헤어 툴팁
  function lineChart(host, { series, refY, refLabel, fmt = (v) => n(v), xfmt = (t) => time(t, false) }) {
    const W = host.clientWidth || 600, H = host.clientHeight || 240;
    const m = { l: 40, r: 64, t: 14, b: 26 };
    const pts = series[0].points;
    if (!pts.length) { host.innerHTML = `<div class="empty">${icon('chart')}데이터가 아직 없어요</div>`; return; }
    const xs = pts.map((p) => +new Date(p.t));
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    const maxV = Math.max(4, refY || 0, ...series.flatMap((s) => s.points.map((p) => p.v)));
    const niceMax = (() => { const p = 10 ** Math.floor(Math.log10(maxV)); return Math.ceil(maxV / p * 1.1) * p; })();
    const X = (t) => m.l + (W - m.l - m.r) * ((t - x0) / Math.max(1, x1 - x0));
    const Y = (v) => H - m.b - (H - m.t - m.b) * (v / niceMax);
    const path = (ps) => ps.map((p, i) => `${i ? 'L' : 'M'}${X(+new Date(p.t)).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => niceMax * f);
    const xt = [0, 0.5, 1].map((f) => x0 + (x1 - x0) * f);
    if (x1 - x0 < 180000) xfmt = (t) => time(t); // 3분 미만이면 초까지

    const [gw, pv] = series;
    // 두 선 사이 간격(공급자가 위) — 설명되지 않는 호출을 빨간 면으로
    const gap = pv && gw ? `M${pv.points.map((p, i) => `${X(+new Date(p.t)).toFixed(1)},${Y(Math.max(p.v, gw.points[i].v)).toFixed(1)}`).join('L')}L${[...gw.points].reverse().map((p) => `${X(+new Date(p.t)).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L')}Z` : '';
    const lastY = series.map((s) => Y(s.points[s.points.length - 1].v));
    if (lastY.length === 2 && Math.abs(lastY[0] - lastY[1]) < 14) { // 끝 라벨 겹침 방지
      const mid = (lastY[0] + lastY[1]) / 2, up = lastY[0] <= lastY[1] ? 0 : 1;
      lastY[up] = mid - 8; lastY[1 - up] = mid + 8;
    }

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="게이트웨이 기록과 공급자 보고 누적 호출 수">
      ${ticks.map((v) => `<line class="grid-l" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-t" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
      ${xt.map((t, i) => `<text class="axis-t" x="${X(t)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${xfmt(new Date(t).toISOString())}</text>`).join('')}
      ${gap ? `<path class="gap" d="${gap}"/>` : ''}
      ${refY ? `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${Y(refY)}" y2="${Y(refY)}"/><text class="ref-t" x="${W - m.r - 4}" y="${Y(refY) - 6}" text-anchor="end">${esc(refLabel || '')}</text>` : ''}
      ${series.map((s) => `<path class="ln ${s.cls}" d="${path(s.points)}"/>`).join('')}
      ${series.map((s, i) => `<text class="end-l" x="${W - m.r + 8}" y="${lastY[i] + 4}">${fmt(s.points[s.points.length - 1].v)}</text>`).join('')}
      <g class="hover" style="display:none"><line class="xh" y1="${m.t}" y2="${H - m.b}"/>${series.map((s) => `<circle class="dot ${s.cls}" r="5"/>`).join('')}</g>
    </svg><div class="tip"></div>`;

    const svg = $('svg', host), hv = $('.hover', host), tip = $('.tip', host);
    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) * (W / r.width);
      const t = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
      let i = 0, best = Infinity;
      xs.forEach((x, k) => { const d = Math.abs(x - t); if (d < best) { best = d; i = k; } });
      const cx = X(xs[i]);
      hv.style.display = '';
      $('.xh', hv).setAttribute('x1', cx); $('.xh', hv).setAttribute('x2', cx);
      $$('circle', hv).forEach((c, k) => { c.setAttribute('cx', cx); c.setAttribute('cy', Y(series[k].points[i].v)); });
      const diff = pv && gw ? Math.max(0, pv.points[i].v - gw.points[i].v) : null;
      tip.innerHTML = `<b>${time(pts[i].t)}</b>${series.map((s) => `<div><span><i class="swatch ${s.cls}"></i>${s.label}</span><span>${fmt(s.points[i].v)}</span></div>`).join('')}${diff != null ? `<div><span>차이</span><span>${fmt(diff)}</span></div>` : ''}`;
      tip.style.left = `${Math.min(Math.max(cx / W * r.width, 90), r.width - 90)}px`;
      tip.style.top = `${Math.min(...series.map((s) => Y(s.points[i].v))) / H * r.height}px`;
      tip.classList.add('on');
    };
    const leave = () => { hv.style.display = 'none'; tip.classList.remove('on'); };
    svg.addEventListener('pointermove', (e) => move(e.clientX));
    svg.addEventListener('pointerleave', leave);
    svg.addEventListener('pointerdown', (e) => move(e.clientX));
  }

  // 세로 막대 (한 시리즈). 4px 둥근 끝, 막대 사이 간격, 막대별 툴팁
  function barChart(host, { points, fmt = (v) => n(v), tip = () => '' }) {
    if (!points.length) { host.innerHTML = `<div class="empty">${icon('chart')}이 기간에는 호출이 없어요</div>`; return; }
    const W = host.clientWidth || 600, H = host.clientHeight || 200;
    const m = { l: 36, r: 8, t: 12, b: 24 };
    const maxV = Math.max(1, ...points.map((p) => p.v));
    const top = (() => { const p = 10 ** Math.floor(Math.log10(maxV)); return Math.ceil(maxV / p) * p; })();
    const slot = (W - m.l - m.r) / points.length, bw = Math.max(4, Math.min(36, slot - 6));
    const Y = (v) => H - m.b - (H - m.t - m.b) * (v / top);
    const every = Math.ceil(points.length / Math.max(1, Math.floor((W - m.l) / 46)));
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="시간대별 호출 수">
      ${[0, 0.5, 1].map((f) => `<line class="grid-l" x1="${m.l}" x2="${W - m.r}" y1="${Y(top * f)}" y2="${Y(top * f)}"/><text class="axis-t" x="${m.l - 8}" y="${Y(top * f) + 4}" text-anchor="end">${fmt(top * f)}</text>`).join('')}
      ${points.map((p, i) => { const x = m.l + slot * i + (slot - bw) / 2, y = Y(p.v), h = Math.max(0, H - m.b - y);
        return `<g class="bar" data-i="${i}"><rect x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${H - m.t - m.b}" fill="transparent"/>
        ${h >= 4 ? `<path d="M${x},${H - m.b}V${y + 4}q0,-4 4,-4h${bw - 8}q4,0 4,4V${H - m.b}Z" fill="var(--brand)" opacity="${p.dim ? 0.35 : 1}"/>` : `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="var(--brand)"/>`}
        ${i % every === 0 ? `<text class="axis-t" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>` : ''}</g>`; }).join('')}
    </svg><div class="tip"></div>`;
    const t = $('.tip', host);
    $$('.bar', host).forEach((g) => {
      const show = () => {
        const p = points[+g.dataset.i], r = host.getBoundingClientRect(), b = g.getBoundingClientRect();
        t.innerHTML = `<b>${esc(p.label)}</b><div><span>호출</span><span>${fmt(p.v)}</span></div>${tip(p)}`;
        t.style.left = `${Math.min(Math.max(b.left - r.left + b.width / 2, 90), r.width - 90)}px`;
        t.style.top = `${Y(p.v) / H * r.height}px`;
        t.classList.add('on');
      };
      g.addEventListener('pointerenter', show); g.addEventListener('pointerdown', show);
      g.addEventListener('pointerleave', () => t.classList.remove('on'));
    });
  }

  // 숫자가 부드럽게 바뀌도록
  function tween(el, to, fmt = (v) => n(v), ms = 500) {
    const from = +(el.dataset.v || 0);
    el.dataset.v = to;
    const id = (el._tween = (el._tween || 0) + 1); // 새 tween이 시작되면 이전 것은 멈춘다(단위가 바뀔 때 옛 형식으로 덮어쓰지 않게)
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      if (el._tween !== id) return;
      const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3;
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 테마 전환(시스템 → 라이트 → 다크)
  function initTheme() {
    let t = null;
    try { t = localStorage.getItem('ng.theme'); } catch { /* 무시 */ }
    if (t) document.documentElement.dataset.theme = t;
  }
  function toggleTheme() {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ng.theme', next); } catch { /* 무시 */ }
    return next;
  }
  initTheme();

  global.UI = { $, $$, esc, icon, n, won, time, ago, toast, sheet, closeSheet, confirmSheet, copy, lineChart, barChart, tween, toggleTheme };
})(window);
