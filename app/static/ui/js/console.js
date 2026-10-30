/* console.js — 관리자 콘솔 (index.html)
 * 홈(실시간 탐지) · 사용량 · 키·한도 · 접근 제어 · 사고, 그리고 데모 제어판.
 * 데이터는 전부 API.*(js/api.js)에서 받는다. */
(function () {
  'use strict';
  const { $, $$, esc, icon, n, won, time, ago, toast, sheet, closeSheet, confirmSheet, copy, lineChart, tween } = UI;

  const PAGES = [
    { id: 'home', label: '홈', icon: 'home', sub: '게이트웨이 기록과 공급자 보고를 2초마다 대조해요' },
    { id: 'usage', label: '사용량', icon: 'chart', sub: '게이트웨이가 중계한 호출의 토큰과 비용' },
    { id: 'limits', label: '한도', icon: 'target', sub: '어디서부터 의심하고 언제 키를 끊을지 정해요' },
    { id: 'keys', label: '키', icon: 'key', sub: '공급자 키 발급과 전환 순서' },
    { id: 'access', label: '접근 제어', icon: 'shield', sub: '누가 어디에서 게이트웨이를 부를 수 있는지' },
    { id: 'incidents', label: '사고', icon: 'alert', sub: '자동 차단과 허니키 탐지가 남긴 기록' },
  ];

  const STATUS = {
    NORMAL: { pill: '정상', title: '지금은 안전해요', lead: '게이트웨이 기록과 공급자 보고가 일치해요.', ic: 'shield' },
    SUSPECT: { pill: '의심', title: '설명되지 않는 호출이 보여요', lead: '공급자가 게이트웨이보다 많은 호출을 보고하고 있어요. 지켜보는 중이에요.', ic: 'alert' },
    WARNING: { pill: '경고', title: '키가 유출된 것 같아요', lead: '차단선에 가까워지고 있어요. 넘으면 자동으로 차단해요.', ic: 'alert' },
    BLOCKED: { pill: '차단', title: '유출된 키를 차단했어요', lead: '공급자에서 키를 폐기하고 예비 키로 전환하고 있어요.', ic: 'ban' },
    RECOVERED: { pill: '복구', title: '예비 키로 전환을 마쳤어요', lead: '직원 호출은 같은 토큰으로 끊김 없이 계속돼요.', ic: 'check' },
  };
  const STEP = {
    DETECTED: '유출 탐지', REVOKE_PROVIDER_KEY: '공급자 키 폐기', PROMOTE_STANDBY: '예비 키 승격',
    REVOKE_ALL_TOKENS: '전체 토큰 폐기', SUSPEND_SERVICES: '서비스 일시 정지',
    NOTIFY_ADMIN: '관리자 통보', VERIFIED: '전환 키 호출 확인',
  };
  const STEP_ORDER = ['DETECTED', 'REVOKE_PROVIDER_KEY', 'PROMOTE_STANDBY', 'NOTIFY_ADMIN', 'VERIFIED'];
  const EVENT = {
    SUSPECT: ['warn', 'alert'], WARNING: ['warn', 'alert'], BLOCKED: ['bad', 'ban'], RECOVERED: ['ok', 'check'],
    ATTACK_STARTED: ['bad', 'bolt'], ATTACK_STOPPED: ['gray', 'stop'], ACCESS_DENIED: ['gray', 'lock'], HONEYKEY: ['warn', 'honey'],
  };
  const REASON = {
    ip_not_allowed: '허용 안 된 IP', invalid_token: '잘못된 토큰', service_suspended: '정지된 서비스', ip_blocked: '임시 차단 IP',
    wif_invalid_signature: 'JWT 서명 오류', wif_expired: 'JWT 만료', wif_audience_mismatch: 'audience 불일치',
    wif_untrusted_identity: '신뢰 안 된 신원', wif_malformed: 'JWT 형식 오류',
  };

  const st = {
    page: null, dash: null, range: 300, lastEvent: 0, feed: [], incident: null, popped: new Set(),
    traffic: false, trafficTimer: null, trafficN: 0, lastErr: {}, usageRange: 'day', liveSheet: null,
  };

  // 정적 아이콘 채우기
  $$('[data-ic]').forEach((el) => { el.outerHTML = icon(el.dataset.ic); });

  // ---------- 내비게이션 ----------
  function renderNav() {
    const openInc = st.dash && st.dash.status === 'BLOCKED';
    $('#nav').innerHTML = PAGES.map((p) => `<button class="nav-btn" data-go="${p.id}" ${st.page === p.id ? 'aria-current="page"' : ''}>${icon(p.icon)}${p.label}${p.id === 'incidents' && openInc ? '<span class="dot"></span>' : ''}</button>`).join('');
    $('#tabbar').innerHTML = PAGES.map((p) => `<button data-go="${p.id}" ${st.page === p.id ? 'aria-current="page"' : ''}>${icon(p.icon)}${p.label}${p.id === 'incidents' && openInc ? '<span class="dot"></span>' : ''}</button>`).join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) { location.hash = b.dataset.go; }
  });
  addEventListener('hashchange', route);

  function route() {
    const id = (location.hash.slice(1) || 'home');
    const page = PAGES.find((p) => p.id === id) || PAGES[0];
    st.page = page.id;
    $('#pageTitle').textContent = page.label;
    $('#pageSub').textContent = page.sub;
    renderNav();
    const v = $('#view');
    v.innerHTML = '';
    v.className = 'page';
    void v.offsetWidth;
    ({ home: viewHome, usage: viewUsage, limits: viewLimits, keys: viewKeys, access: viewAccess, incidents: viewIncidents })[page.id](v);
    scrollTo({ top: 0 });
  }

  // ================= 홈 =================
  function viewHome(v) {
    v.innerHTML = `
      <section class="grid g-hero">
        <div class="card hero" id="hero" data-status="NORMAL">
          <span class="status-pill"><span class="pulse"></span><span id="hPill">정상</span></span>
          <h2 id="hTitle">불러오는 중…</h2>
          <p class="lead" id="hLead">&nbsp;</p>
          <div class="big-metric"><span class="n num" id="hNum">0</span><span class="u" id="hUnit">건</span><span class="of" id="hOf"></span></div>
          <div class="metric-label" id="hLabel">설명되지 않는 호출</div>
          <div class="meter" id="meter"><div class="meter-fill"></div></div>
          <div class="meter-legend" id="meterLegend"></div>
        </div>
        <div class="card">
          <div class="card-h"><h3>지금 숫자</h3><div class="spacer"></div><span class="muted" style="font-size:12px" id="updated"></span></div>
          <div class="kpis">
            <div class="kpi"><div class="kpi-l"><i class="swatch gw"></i>게이트웨이 기록</div><div class="kpi-v num" id="kGw">0</div><div class="kpi-s">게이트웨이가 중계한 호출</div></div>
            <div class="kpi"><div class="kpi-l"><i class="swatch pv"></i>공급자 보고</div><div class="kpi-v num" id="kPv">0</div><div class="kpi-s" id="kPvS">공급자가 집계한 호출</div></div>
            <div class="kpi"><div class="kpi-l">${icon('key', 'width="14" height="14"')}사용 중인 키</div><div class="kpi-v sm mono" id="kKey">—</div><div class="kpi-s" id="kKeyS">&nbsp;</div></div>
            <div class="kpi"><div class="kpi-l">${icon('target', 'width="14" height="14"')}자동 차단선</div><div class="kpi-v num" id="kBlock">—</div><div class="kpi-s"><a href="#limits" id="kLimit">&nbsp;</a></div></div>
          </div>
          <div class="callout" id="attackNote" hidden>${icon('bolt')}<span>공격자가 유출 키로 공급자를 직접 호출하고 있어요 (게이트웨이 우회)</span></div>
        </div>
      </section>

      <section class="grid g-main" style="margin-top:var(--gap)">
        <div class="stack">
          <div class="card">
            <div class="card-h">
              <div><h2>호출 수 비교</h2><p>두 선 사이 빨간 면이 게이트웨이가 모르는 호출이에요</p></div>
              <div class="spacer"></div>
              <div class="seg" id="rangeSeg">${[[60, '1분'], [300, '5분'], [900, '15분']].map(([s, l]) => `<button data-r="${s}" aria-pressed="${st.range === s}">${l}</button>`).join('')}</div>
            </div>
            <div class="legend" style="margin-bottom:8px"><span><i style="background:var(--gw)"></i>게이트웨이 기록</span><span><i style="background:var(--pv)"></i>공급자 보고</span><span><i style="background:var(--bad);opacity:.35;height:10px"></i>설명되지 않는 호출</span></div>
            <div class="chart" id="chart"></div>
          </div>
          <div class="card">
            <div class="card-h"><div><h2>키 전환 순서</h2><p>주 키가 폐기되면 위에서부터 예비 키가 이어받아요</p></div><div class="spacer"></div><button class="btn sm soft" data-go="keys">관리</button></div>
            <div class="list" id="credList"></div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-h"><h2>실시간 알림</h2><div class="spacer"></div><span class="badge ghost" id="feedCount">0</span></div>
            <div class="feed" id="feed"></div>
          </div>
          <div class="card tight" id="howCard">
            <div class="card-h" style="margin-bottom:10px"><h3>어떻게 찾아내나요?</h3></div>
            <p class="sub" style="margin:0;font-size:14px">직원은 모두 게이트웨이를 거쳐 호출해요. 그래서 <b>공급자가 보고한 호출 수가 게이트웨이 기록보다 많으면</b>, 누군가 키를 몰래 쓰고 있다는 뜻이에요. <span id="howRule">차이가 차단선에 닿으면</span> 키를 폐기하고 예비 키로 바꿔요.</p>
          </div>
        </div>
      </section>`;
    $('#rangeSeg').onclick = (e) => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      st.range = +b.dataset.r;
      $$('#rangeSeg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      refreshChart();
    };
    renderFeed();
    if (st.dash) renderHome(st.dash);
    refreshChart();
  }

  const ratiosOf = (d) => { const w = d.warn_at_calls / d.limit_calls; return w > 0.4 ? [0.1, 0.5, 0.7] : [0.05, 0.2, 0.35]; };
  const activeDiff = (d) => d.credentials.filter((c) => c.status === 'ACTIVE').reduce((a, c) => a + Math.max(c.diff_calls, c.certain_diff_calls || 0), 0);

  // 판정 기준을 한 모양으로. 사용량 방식(%) 또는 건수 방식(건).
  // 아직 detection을 주지 않는 실서버는 '한도 L × 비율' 하나뿐이라 그걸 건수 방식으로 옮겨 그린다(legacy).
  function detOf(d) {
    if (d.detection) return d.detection;
    const [s, w, b] = ratiosOf(d), L = d.limit_calls;
    return { mode: 'calls', unit: '건', suspect: L * s, warn: L * w, block: L * b, value: activeDiff(d), diff_calls: activeDiff(d), legacy: true, limit: L };
  }
  const fmtDet = (x, v) => (x.unit === '%' ? `${n(v, 1)}%` : `${n(v, 1)}건`);
  // 막대 끝: 차단선이 70% 자리에 오도록 잡고 둥근 값으로. 예전 서버는 한도 L이 끝
  const meterMax = (x) => (x.legacy ? x.limit : x.unit === '%' ? Math.min(100, Math.ceil(x.block / 0.7 / 5) * 5) : Math.ceil(x.block / 0.7));
  const ruleText = (x) => (x.unit === '%' ? `공급자 보고 호출의 ${n(x.block, 1)}%` : x.legacy ? `한도 ${n(x.limit)}건의 ${Math.round((x.block / x.limit) * 100)}%` : `설명되지 않는 호출 ${n(x.block)}건`);

  function renderHome(d) {
    const hero = $('#hero');
    if (!hero) return;
    const s = STATUS[d.status] || STATUS.NORMAL;
    hero.dataset.status = d.status;
    $('#hPill').textContent = s.pill;
    $('#hTitle').textContent = s.title;
    $('#hLead').textContent = s.lead;
    const x = detOf(d);
    const pct = x.unit === '%';
    const blocked = d.status === 'BLOCKED' || d.status === 'RECOVERED';
    const inc = st.incident && st.incident.id === d.incident_id ? st.incident : null;
    // 차단 뒤에는 방식과 상관없이 '새어 나간 호출 수'를 보여 준다
    const showCalls = blocked || !pct;
    const val = blocked && inc ? (inc.loss_calls ?? 0) : showCalls ? x.diff_calls : x.value;
    tween($('#hNum'), val, (v) => n(v, showCalls ? 0 : 1));
    $('#hUnit').textContent = showCalls ? '건' : '%';
    const over = x.legacy && val > x.limit; // 예전 서버: 최종 손실이 한도를 넘을 수 있다(공격자가 빠르거나 공급자 지연이 클 때)
    $('#hOf').innerHTML = blocked
      ? `차단선 ${esc(fmtDet(x, x.block))}${over ? ` <span class="badge bad">한도를 ${n(val - x.limit)}건 초과</span>` : ''}`
      : pct ? `모르는 호출 ${n(x.diff_calls)}건 / 공급자 보고 ${n(x.provider_calls)}건` : `/ 차단선 ${n(x.block, 1)}건`;
    $('#hLabel').innerHTML = blocked ? `${icon('ban', 'width="16" height="16"')}차단까지 새어 나간 호출`
      : `${icon('alert', 'width="16" height="16"')}${pct ? '공급자 보고 중 게이트웨이가 모르는 호출의 비율' : '게이트웨이가 모르는 호출'}`;
    const max = meterMax(x);
    const meterVal = blocked ? (pct ? x.block : val) : x.value;
    const at = (v) => Math.min(100, (v / max) * 100);
    const meter = $('#meter');
    meter.dataset.level = d.status;
    meter.classList.toggle('over', meterVal > max);
    $('.meter-fill', meter).style.width = `${at(meterVal)}%`;
    $$('.meter-tick', meter).forEach((t) => t.remove());
    [[x.suspect, ''], [x.warn, ''], [x.block, 'block']].forEach(([v, c]) => meter.insertAdjacentHTML('beforeend', `<span class="meter-tick ${c}" style="left:${at(v)}%"></span>`));
    const lv = (v) => (pct ? `${n(v, 1)}%` : n(v, 1));
    $('#meterLegend').innerHTML = `<span style="left:${at(x.suspect)}%">의심 ${lv(x.suspect)}</span><span style="left:${at(x.warn)}%">경고 ${lv(x.warn)}</span><span style="left:${at(x.block)}%;color:var(--bad-ink)">차단 ${lv(x.block)}</span><span class="end" style="left:100%">${lv(max)}</span>`;
    $('#howRule').textContent = pct ? `모르는 호출이 공급자 보고의 ${n(x.block, 1)}%에 닿으면` : `모르는 호출이 ${n(x.block, 1)}건에 닿으면`;

    tween($('#kGw'), d.gateway_calls);
    tween($('#kPv'), d.provider_calls);
    const est = d.credentials.some((c) => c.calls_estimated && c.status === 'ACTIVE');
    $('#kPvS').textContent = est ? '비용으로 추정한 호출 수' : '공급자가 집계한 호출 (약 2초 지연)';
    const a = d.active_credential;
    $('#kKey').textContent = a ? a.masked : '없음';
    $('#kKeyS').textContent = a ? `${a.provider} · ${a.auth_mode === 'WIF' ? 'WIF 단기 토큰' : 'API 키'}` : '예비 키가 없어요';
    $('#kBlock').textContent = fmtDet(x, x.block);
    $('#kLimit').textContent = x.unit === '%' ? '사용량 방식 · 바꾸기' : x.legacy ? ruleText(x) : '건수 방식 · 바꾸기';
    $('#updated').textContent = `${time(d.updated_at)} 기준`;
    $('#attackNote').hidden = !d.attack_running;

    const rank = (c) => (c.status === 'REVOKED' ? 2 : c.role === 'PRIMARY' ? 0 : 1);
    const creds = [...d.credentials].sort((x, y) => rank(x) - rank(y) || x.id - y.id);
    $('#credList').innerHTML = creds.map((c) => credRow(c)).join('') || `<div class="empty">${icon('key')}등록된 키가 없어요</div>`;
  }

  const PROVIDERS = { mock: 'Mock', openrouter: 'OpenRouter', openai: 'OpenAI', vllm: 'vLLM' };
  const provName = (p) => PROVIDERS[p] || p;

  function credRow(c, actions = '') {
    const dead = c.status === 'REVOKED';
    const ic = dead ? 'gray' : c.role === 'PRIMARY' ? '' : 'ok';
    const badge = dead ? '<span class="badge bad">폐기됨</span>' : c.role === 'PRIMARY' ? '<span class="badge blue">사용 중</span>' : '<span class="badge ok">대기</span>';
    const mode = c.auth_mode === 'WIF' ? 'WIF 단기 토큰' : 'API 키 · Vault 암호화';
    const counts = c.gateway_calls != null ? ` · 게이트웨이 ${n(c.gateway_calls)} / 공급자 ${n(c.provider_calls)}${c.calls_estimated ? '(추정)' : ''}` : '';
    return `<div class="row ${dead ? 'dead' : ''}"><div class="row-ic ${ic}">${icon(c.auth_mode === 'WIF' ? 'id' : 'key')}</div>
      <div class="row-b"><div class="row-t"><span class="mono">${esc(c.masked)}</span>${c.name ? `<span class="muted" style="font-size:13px;font-weight:400">${esc(c.name)}</span>` : ''}</div>
      <div class="row-s">${c.role === 'PRIMARY' ? '주 키' : '예비 키'} · ${esc(provName(c.provider))} · ${mode}${counts}</div></div>
      <div class="row-e">${badge}${actions}</div></div>`;
  }

  async function refreshChart() {
    const host = $('#chart');
    if (!host) return;
    try {
      const { points } = await API.timeseries(st.range);
      if (!$('#chart')) return;
      lineChart(host, {
        series: [
          { cls: 'gw', label: '게이트웨이', points: points.map((p) => ({ t: p.t, v: p.gateway_calls })) },
          { cls: 'pv', label: '공급자', points: points.map((p) => ({ t: p.t, v: p.provider_calls })) },
        ],
      });
    } catch (e) { /* 다음 주기에 다시 */ }
  }

  function renderFeed() {
    const host = $('#feed');
    if (!host) return;
    const items = st.feed.slice(-40).reverse();
    $('#feedCount').textContent = st.feed.length;
    host.innerHTML = items.map((e) => {
      const [k, ic] = EVENT[e.kind] || ['gray', 'bell'];
      return `<div class="row"><div class="row-ic sm ${k}">${icon(ic)}</div><div class="row-b"><div class="row-t"><span>${esc(e.message)}</span></div></div><time>${ago(e.at)}</time></div>`;
    }).join('') || `<div class="empty">${icon('bell')}아직 알림이 없어요<br><span style="font-size:13px">유출 징후가 보이면 여기에 바로 알려 드려요</span></div>`;
  }

  // ================= 사용량 =================
  function viewUsage(v) {
    v.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <div class="seg" id="uSeg">${[['day', '오늘'], ['week', '7일'], ['month', '이번 달'], ['all', '전체']].map(([k, l]) => `<button data-u="${k}" aria-pressed="${st.usageRange === k}">${l}</button>`).join('')}</div>
        <span class="muted" style="font-size:13px">게이트웨이가 중계한 호출만 집계해요</span>
      </div>
      <section class="grid g-hero">
        <div class="card hero" data-status="NORMAL" style="--hero-glow:var(--brand-soft)">
          <div class="metric-label">${icon('wallet', 'width="16" height="16"')}이번 달 예상 비용</div>
          <div class="big-metric" style="margin-top:10px"><span class="n num" id="uMonth">0</span><span class="u">원</span></div>
          <p class="lead" id="uRate">&nbsp;</p>
          <div class="kpis" style="margin-top:22px">
            <div class="kpi"><div class="kpi-l">오늘 예상</div><div class="kpi-v num" id="uDay">—</div></div>
            <div class="kpi"><div class="kpi-l">시간당 호출</div><div class="kpi-v num" id="uCalls">—</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>월 예산</h3><div class="spacer"></div><button class="btn sm soft" id="budgetBtn">설정</button></div>
          <div id="budgetBox"></div>
        </div>
      </section>
      <section class="kpis k4" style="margin-top:var(--gap)" id="uKpis"></section>
      <div class="card" style="margin-top:var(--gap)">
        <div class="card-h"><div><h2 id="uTsTitle">시간대별 호출</h2><p>막대에 올리면 서비스별 호출과 비용이 보여요</p></div></div>
        <div class="chart" id="uTs" style="height:200px"></div>
      </div>
      <section class="grid g-main" style="margin-top:var(--gap)">
        <div class="card"><div class="card-h"><div><h2>서비스별 비용</h2><p>누르면 모델별 내역을 볼 수 있어요</p></div></div><div class="bars" id="uBars"></div></div>
        <div class="card"><div class="card-h"><h2>서비스별 월말 예측</h2></div><div class="list" id="uPer"></div><p class="muted" style="font-size:12px;margin:14px 0 0" id="uNote"></p></div>
      </section>`;
    $('#uSeg').onclick = (e) => {
      const b = e.target.closest('[data-u]'); if (!b) return;
      st.usageRange = b.dataset.u;
      $$('#uSeg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      loadUsage();
    };
    $('#budgetBtn').onclick = budgetSheet;
    loadUsage();
  }

  async function loadUsage() {
    try {
      const bucket = st.usageRange === 'day' ? 'hour' : 'day';
      const [sum, fc, month, ts] = await Promise.all([API.usageSummary(st.usageRange), API.usageForecast(1), API.usageSummary('month'), API.usageTimeseries(st.usageRange, bucket)]);
      if (st.page !== 'usage') return;
      renderUsageBars(ts, bucket);
      tween($('#uMonth'), fc.projected.end_of_month_cost_krw);
      $('#uDay').textContent = won(fc.projected.end_of_day_cost_krw);
      $('#uCalls').textContent = `${n(fc.rate_per_hour.calls)}건`;
      $('#uRate').textContent = `최근 ${fc.window_hours}시간 속도 ${won(fc.rate_per_hour.cost_krw)}/시간이 이어진다고 가정했어요`;
      const b = fc.budget.monthly_budget_krw;
      const spent = month.total.cost_krw;
      $('#budgetBox').innerHTML = b == null
        ? `<div class="empty" style="padding:18px 0">${icon('wallet')}예산이 없어요<br><span style="font-size:13px">예산을 정하면 도달 시점을 알려 드려요</span></div>`
        : `<div class="big-metric" style="margin:4px 0 0"><span class="n num" style="font-size:36px">${n(spent)}</span><span class="u" style="font-size:16px">원</span><span class="of">/ ${won(b)}</span></div>
           <div class="bar-track" style="margin:14px 0 10px;height:12px"><div class="bar-fill" style="width:${Math.min(100, spent / b * 100)}%;${spent / b > 0.9 ? 'background:var(--bad)' : ''}"></div></div>
           <div class="sub" style="font-size:14px">${fc.budget.hours_to_budget == null ? '지금 속도로는 예산에 닿지 않아요' : fc.budget.hours_to_budget === 0 ? '<b style="color:var(--bad-ink)">이미 예산을 넘었어요</b>' : `지금 속도면 약 <b>${n(fc.budget.hours_to_budget, 1)}시간</b> 뒤 예산에 닿아요`}</div>`;
      const t = sum.total;
      $('#uKpis').innerHTML = [
        ['호출', `${n(t.calls)}건`, '성공(200)만'], ['입력 토큰', n(t.input_tokens), ''], ['출력 토큰', n(t.output_tokens), ''],
        ['비용', won(t.cost_krw), `단가표 기준 ${won(t.estimated_cost_krw)}`],
      ].map(([l, val, s]) => `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-v num">${val}</div><div class="kpi-s">${s || '&nbsp;'}</div></div>`).join('');
      const max = Math.max(1, ...sum.services.map((s) => s.cost_krw));
      $('#uBars').innerHTML = sum.services.map((s) => `<div class="bar-row" style="cursor:pointer" data-svc="${s.service_id}">
        <div class="bl">${esc(s.name || '알 수 없음')}</div><div class="bv num">${won(s.cost_krw)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${s.cost_krw / max * 100}%"></div></div>
        <div class="bs">호출 ${n(s.calls)}건 · 토큰 ${n(s.input_tokens + s.output_tokens)} · ${s.models.map((m) => esc(m.model)).join(', ')}</div></div>`).join('')
        || `<div class="empty">${icon('chart')}이 기간에는 호출이 없어요<br><span style="font-size:13px">직원이 게이트웨이를 쓰면 여기에 집계돼요</span></div>`;
      $$('#uBars [data-svc]').forEach((el) => { el.onclick = () => modelSheet(sum.services.find((s) => s.service_id === +el.dataset.svc)); });
      $('#uPer').innerHTML = fc.per_service.map((p) => `<div class="row"><div class="row-b"><div class="row-t"><span>${esc(p.name)}</span></div><div class="row-s">${won(p.rate_cost_krw_per_hour)}/시간</div></div><div class="row-e"><b class="num">${won(p.projected_month_cost_krw)}</b></div></div>`).join('')
        || `<div class="empty" style="padding:16px">최근 1시간 호출이 없어요</div>`;
      $('#uNote').textContent = fc.note;
    } catch (e) { toast(e.message, 'bad'); }
  }

  // /admin/usage/timeseries: 서비스별 버킷을 합쳐 막대 하나로(서비스별 값은 툴팁). 호출 없는 버킷은 서버가 생략하므로 채운다
  function renderUsageBars(ts, bucket) {
    $('#uTsTitle').textContent = bucket === 'hour' ? '시간대별 호출' : '날짜별 호출';
    const by = {};
    for (const s of ts.services) for (const p of s.points) {
      const b = (by[p.t] ||= { t: p.t, v: 0, svc: [] });
      b.v += p.calls; b.svc.push({ name: s.name, calls: p.calls, cost: p.cost_krw });
    }
    if (bucket === 'hour') { // 오늘 0시~지금까지 빈 시간도 0으로
      const d = new Date(), pad = (v) => String(v).padStart(2, '0'), day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      for (let h = 0; h <= d.getHours(); h++) { const k = `${day}T${pad(h)}:00`; by[k] ||= { t: k, v: 0, svc: [] }; }
    }
    const pts = Object.keys(by).sort().map((k) => ({ ...by[k], label: bucket === 'hour' ? `${+k.slice(11, 13)}시` : k.slice(5).replace('-', '/') }));
    UI.barChart($('#uTs'), { points: pts, fmt: (v) => n(v), tip: (p) => p.svc.map((s) => `<div><span>${esc(s.name || '?')}</span><span>${n(s.calls)}건 · ${won(s.cost)}</span></div>`).join('') });
  }

  function modelSheet(s) {
    sheet({
      title: `${esc(s.name)} 모델별 내역`, desc: '단가표(USD/1M 토큰) × 환율로 게이트웨이가 다시 계산한 예상 비용도 함께 보여 드려요.',
      body: `<div class="table-wrap"><table class="table"><thead><tr><th>모델</th><th class="r">호출</th><th class="r">토큰</th><th class="r">비용</th><th class="r">예상</th></tr></thead><tbody>
        ${s.models.map((m) => `<tr><td class="mono">${esc(m.model)}${m.estimated ? ' <span class="badge" title="단가표에 없어 gpt-4o-mini 단가로 계산">추정</span>' : ''}</td><td class="r num">${n(m.calls)}</td><td class="r num">${n(m.input_tokens + m.output_tokens)}</td><td class="r num">${won(m.cost_krw)}</td><td class="r num">${won(m.estimated_cost_krw)}</td></tr>`).join('')}
      </tbody></table></div>`,
    });
  }

  function budgetSheet() {
    sheet({
      title: '월 예산 설정', desc: '이번 달 사용액과 최근 속도로 예산에 닿는 시점을 계산해요.',
      body: `<label class="field"><span>월 예산 (원)</span><input class="input num" id="bIn" inputmode="numeric" placeholder="예: 500000"></label>
        <div class="inline-form">${[100000, 300000, 1000000].map((v) => `<button class="chip" data-b="${v}">${n(v)}원</button>`).join('')}</div>
        <div class="sheet-f"><button class="btn gray" id="bClear">예산 해제</button><button class="btn" id="bSave">저장</button></div>`,
      onMount(el, s) {
        API.budget().then((r) => { if (r.monthly_budget_krw) $('#bIn', el).value = r.monthly_budget_krw; });
        $$('[data-b]', el).forEach((b) => { b.onclick = () => { $('#bIn', el).value = b.dataset.b; }; });
        const save = async (v) => { try { await API.saveBudget(v); toast(v ? '예산을 저장했어요' : '예산을 해제했어요', 'ok'); s.close(); loadUsage(); } catch (e) { toast(e.message, 'bad'); } };
        $('#bSave', el).onclick = () => { const v = parseInt($('#bIn', el).value.replace(/\D/g, ''), 10); if (!v) return toast('금액을 입력해 주세요', 'warn'); save(v); };
        $('#bClear', el).onclick = () => save(null);
      },
    });
  }

  // ================= 한도 =================
  // 판정 방식 두 가지(사용량 % / 건수). 오른쪽 표는 지금 고르고 있는 기준으로 키마다 다시 재서 보여 준다
  const MODE_INFO = {
    usage_pct: {
      unit: '%', step: 1, max: 100,
      help: '공급자가 보고한 호출 중 게이트웨이가 모르는 호출의 비율로 판정해요. 많이 쓰는 키도 적게 쓰는 키도 같은 잣대로 재요.',
      why: '기본값 5 · 10 · 20%: 정상 호출은 게이트웨이와 공급자 기록이 같아 0%에 머물러요. 진행 중 요청 3건은 이미 빼고 재기 때문에 5%면 알림만 보내고, 20%면 공급자 집계 지연(약 2초) 동안 더 새는 호출을 감안해도 피해가 작을 때 끊어요. 쓰임이 없던 키가 몰래 쓰이면 바로 100%가 돼 즉시 막혀요.',
      rows: [['의심', 'warn', 'alert', '부터 알림을 보내요'], ['경고', 'warn', 'bell', '부터 경고로 올려요'], ['자동 차단', 'bad', 'ban', '에 닿으면 키를 폐기하고 예비 키로 바꿔요']],
    },
    calls: {
      unit: '건', step: 1, max: 100000,
      help: '게이트웨이가 모르는 호출을 1건 단위로 세어 판정해요. 사용량과 상관없이 몇 건이 새었는지만 봐요.',
      why: '기본값 1 · 5 · 10건: 진행 중 요청 3건은 이미 빼고 센 값이라 1건부터 실제 무단 호출이에요. 의심은 알림만 보내니 1건, 차단은 공급자 집계 지연(약 2초) 동안 초당 5건씩 더 새는 걸 감안해 10건으로 뒀어요. OpenRouter처럼 호출 수를 비용으로 추정하는 공급자는 오차가 있어 사용량 방식이 더 안정적이에요.',
      rows: [['의심', 'warn', 'alert', '부터 알림을 보내요'], ['경고', 'warn', 'bell', '부터 경고로 올려요'], ['자동 차단', 'bad', 'ban', '에 닿으면 키를 폐기하고 예비 키로 바꿔요']],
    },
  };
  const KEYS_OF = { usage_pct: ['suspect_pct', 'warn_pct', 'block_pct'], calls: ['suspect_calls', 'warn_calls', 'block_calls'] };

  function viewLimits(v) {
    v.innerHTML = `
      <section class="grid g-main">
        <div class="card">
          <div class="card-h"><div><h2>판정 기준</h2><p>게이트웨이가 모르는 호출을 무엇으로 잴지 골라요</p></div></div>
          <div class="seg full" id="dMode"><button data-m="usage_pct" aria-pressed="true">사용량 방식 (%)</button><button data-m="calls" aria-pressed="false">건수 방식 (건)</button></div>
          <p class="sub" id="dHelp" style="font-size:14px;margin:12px 0 8px"></p>
          <div id="thRows"></div>
          <div class="callout info" id="dWhy"></div>
          <label class="field" style="margin-top:16px"><span>참고 금액 한도 (원, 판정에 쓰지 않아요)</span><input class="input num" id="lossIn" inputmode="numeric"></label>
          <button class="btn block" id="limSave">저장하기</button>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>키별 지금 값</h2><p>왼쪽 기준으로 재면 키마다 지금 어디쯤인지 보여 줘요</p></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>키</th><th class="r">공급자 보고</th><th class="r">모르는 호출</th><th class="r">판정값</th><th></th></tr></thead><tbody id="thLive"></tbody></table></div>
        </div>
      </section>`;
    let cfg = null, legacy = false;
    const form = () => {
      if (legacy) return { mode: 'calls', th: (() => { const L = +$('#th0').value || 0, r = st.dash ? ratiosOf(st.dash) : [0.1, 0.5, 0.7]; return r.map((x) => L * x); })() };
      return { mode: cfg.detection_mode, th: [0, 1, 2].map((i) => +$(`#th${i}`).value || 0) };
    };
    const renderRows = () => {
      const m = MODE_INFO[cfg.detection_mode];
      $$('#dMode button').forEach((b) => { b.setAttribute('aria-pressed', b.dataset.m === cfg.detection_mode); b.disabled = legacy && b.dataset.m === 'usage_pct'; });
      if (legacy) {
        $('#dHelp').textContent = '연결된 서버는 아직 사용량 방식을 몰라요. 허용 무단 호출 수(한도) 하나에 의심·경고·차단 비율을 곱해 판정해요.';
        $('#thRows').innerHTML = `<div class="th-row"><span class="th-l">한도</span><div class="stepper"><button data-step="-1" data-i="0" aria-label="한도 줄이기">−</button><input id="th0" class="num" inputmode="numeric" value="${cfg.unauthorized_call_limit}" aria-label="한도 (건)"><button data-step="1" data-i="0" aria-label="한도 늘리기">+</button></div><span class="th-u">건</span><span class="th-d" id="legacyTh"></span></div>`;
        $('#dWhy').innerHTML = `${icon('bell')}<span>차단선을 한도의 70%에 두는 이유: 공급자 집계 지연(2초)과 폴링(2초) 동안 들어오는 호출을 흡수해서 최종 손실이 한도 아래에 머물게 하려는 거예요.</span>`;
        return;
      }
      const vals = KEYS_OF[cfg.detection_mode].map((k) => cfg[k]);
      $('#dHelp').textContent = m.help;
      $('#thRows').innerHTML = m.rows.map(([l, k, ic, tail], i) => `<div class="th-row"><span class="th-l"><span class="badge ${k}">${icon(ic)}${l}</span></span>
        <div class="stepper"><button data-step="-1" data-i="${i}" aria-label="${l} 줄이기">−</button><input id="th${i}" class="num" inputmode="decimal" value="${vals[i]}" aria-label="${l} (${m.unit})"><button data-step="1" data-i="${i}" aria-label="${l} 늘리기">+</button></div>
        <span class="th-u">${m.unit}</span><span class="th-d">${tail}</span></div>`).join('');
      $('#dWhy').innerHTML = `${icon('bell')}<span>${m.why}</span>`;
    };
    // 기준이 바뀔 때마다 키별 값과 판정을 다시 계산(저장 전 미리 보기)
    const renderLive = () => {
      const f = form(), pct = f.mode === 'usage_pct';
      if (legacy && $('#legacyTh')) $('#legacyTh').textContent = `의심 ${n(f.th[0], 1)} · 경고 ${n(f.th[1], 1)} · 차단 ${n(f.th[2], 1)}건`;
      const rows = st.dash ? st.dash.credentials.filter((c) => c.status === 'ACTIVE') : [];
      const lvl = (x) => (x >= f.th[2] ? ['bad', '차단'] : x >= f.th[1] ? ['warn', '경고'] : x > 0 && x >= f.th[0] ? ['warn', '의심'] : ['', '정상']);
      $('#thLive').innerHTML = rows.map((c) => {
        const diff = Math.max(c.diff_calls, c.certain_diff_calls || 0), x = pct ? (c.provider_calls > 0 ? (diff / c.provider_calls) * 100 : 0) : diff;
        const [k, l] = lvl(x);
        return `<tr><td><span class="mono">${esc(c.masked)}</span><div class="muted" style="font-size:12px">${c.role === 'PRIMARY' ? '주 키' : '예비 키'} · ${esc(provName(c.provider))}</div></td>
          <td class="r num">${n(c.provider_calls)}</td><td class="r num">${n(diff)}</td><td class="r num"><b>${pct ? `${n(x, 1)}%` : `${n(x)}건`}</b></td><td class="r"><span class="badge ${k}">${l}</span></td></tr>`;
      }).join('') || `<tr><td colspan="5"><div class="empty">${icon('key')}사용 중인 키가 없어요</div></td></tr>`;
    };
    st.onDash = () => { if (cfg) renderLive(); };
    $('#dMode').onclick = (e) => {
      const b = e.target.closest('[data-m]'); if (!b || b.disabled || !cfg) return;
      KEYS_OF[cfg.detection_mode].forEach((k, i) => { cfg[k] = +$(`#th${i}`).value || cfg[k]; });
      cfg.detection_mode = b.dataset.m;
      renderRows(); renderLive();
    };
    $('#thRows').oninput = renderLive;
    $('#thRows').onclick = (e) => {
      const b = e.target.closest('[data-step]'); if (!b) return;
      const inp = $(`#th${b.dataset.i}`), max = legacy ? 100000 : MODE_INFO[cfg.detection_mode].max;
      inp.value = Math.min(max, Math.max(1, (+inp.value || 0) + +b.dataset.step));
      renderLive();
    };
    API.settings().then((s) => {
      legacy = !s.detection_mode;
      cfg = { ...s, detection_mode: s.detection_mode || 'calls' };
      $('#lossIn').value = s.loss_limit_krw;
      renderRows(); renderLive();
    }).catch((e) => toast(e.message, 'bad'));
    $('#limSave').onclick = async () => {
      const K = parseInt($('#lossIn').value.replace(/\D/g, ''), 10);
      const f = form();
      try {
        if (legacy) {
          const L = parseInt($('#th0').value, 10);
          await API.saveSettings({ unauthorized_call_limit: L, loss_limit_krw: K });
          return toast(`한도를 ${n(L)}건으로 바꿨어요. 다음 판정(2초 안)부터 적용돼요`, 'ok');
        }
        if (!(f.th[0] < f.th[1] && f.th[1] < f.th[2])) return toast('의심 < 경고 < 자동 차단 순서로 정해 주세요', 'warn');
        const body = { detection_mode: f.mode, loss_limit_krw: K };
        KEYS_OF[f.mode].forEach((k, i) => { body[k] = f.mode === 'calls' ? Math.round(f.th[i]) : f.th[i]; });
        cfg = { ...cfg, ...(await API.saveSettings(body)) };
        toast(`${f.mode === 'calls' ? '건수' : '사용량'} 방식, 자동 차단 ${f.mode === 'calls' ? `${n(f.th[2])}건` : `${n(f.th[2], 1)}%`}으로 바꿨어요. 다음 판정(2초 안)부터 적용돼요`, 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    };
  }

  // ================= 키 =================
  const PROV_INFO = {
    openrouter: { lag: '사용액 약 6초 지연 · 폐기 약 20초', limit: true },
    openai: { lag: '호출 수 약 6분 지연 · 폐기 약 3초', limit: false },
  };

  function viewKeys(v) {
    v.innerHTML = `
      <section class="grid g-main">
        <div class="card">
          <div class="card-h"><div><h2>공급자 키</h2><p id="credSum">원문은 Vault에 암호화해 저장하고 화면에는 마스킹만 보여요</p></div><div class="spacer"></div><button class="btn sm soft" id="addCred">${icon('plus')}직접 등록</button></div>
          <div class="list" id="credAll"></div>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>공급자 키 발급</h2><p>공급자 관리 API로 새 키를 만들어 바로 등록해요. 같은 공급자 키를 여러 개 둘 수 있어요</p></div></div>
          <div class="field"><span>공급자</span><div class="seg full" id="pProv">${Object.keys(PROV_INFO).map((p, i) => `<button data-p="${p}" aria-pressed="${i === 0}">${provName(p)}</button>`).join('')}</div><small id="pLag"></small></div>
          <div class="field"><span>역할</span><div class="seg full" id="pRole"><button data-r="STANDBY" aria-pressed="true">예비 키</button><button data-r="PRIMARY" aria-pressed="false">주 키</button></div></div>
          <div class="field"><span>개수</span>
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div class="stepper"><button id="pDown" aria-label="개수 줄이기">−</button><input id="pCount" class="num" inputmode="numeric" value="2" aria-label="발급할 키 개수"><button id="pUp" aria-label="개수 늘리기">+</button></div><small id="pCountNote">한 번에 10개까지</small></div></div>
          <label class="field"><span>누구의 키인가요 (선택)</span><input class="input" id="pName" placeholder="예: 직원A, 마케팅팀" maxlength="40"><small id="pNameNote">공급자에는 november-이름-번호로 붙어요</small></label>
          <label class="field" id="pLimitF"><span>키마다 지출 한도 (USD)</span><input class="input num" id="pLimit" inputmode="decimal" value="0.5"><small>탐지가 늦어지는 동안의 최대 손실을 공급자 쪽에서 한 번 더 막아요</small></label>
          <button class="btn block" id="pGo"></button>
          <p class="muted" style="font-size:12px;margin:10px 0 0">${API.mode === 'live' ? '게이트웨이 .env에 OPENROUTER_MANAGEMENT_KEY 또는 OPENAI_ADMIN_KEY가 있어야 해요.' : '시뮬레이션에서는 공급자에 연결하지 않고 같은 모양의 키를 만들어요.'}</p>
        </div>
      </section>`;
    const f = { prov: 'openrouter', role: 'STANDBY' };
    const count = () => (f.role === 'PRIMARY' ? 1 : Math.min(10, Math.max(1, parseInt($('#pCount').value, 10) || 1)));
    const sync = () => {
      $$('#pProv button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.p === f.prov));
      $$('#pRole button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.r === f.role));
      $('#pLag').textContent = PROV_INFO[f.prov].lag;
      $('#pLimitF').hidden = !PROV_INFO[f.prov].limit;
      const primary = f.role === 'PRIMARY';
      $('#pCount').disabled = primary; $('#pDown').disabled = primary; $('#pUp').disabled = primary;
      $('#pCountNote').textContent = primary ? '주 키는 한 번에 하나예요' : '한 번에 10개까지';
      const k = count();
      $('#pGo').textContent = `${provName(f.prov)} ${primary ? '주 키' : '예비 키'} ${k}개 발급`;
    };
    $('#pProv').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { f.prov = b.dataset.p; sync(); } };
    $('#pRole').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { f.role = b.dataset.r; sync(); } };
    $('#pCount').oninput = sync;
    $('#pDown').onclick = () => { $('#pCount').value = Math.max(1, count() - 1); sync(); };
    $('#pUp').onclick = () => { $('#pCount').value = Math.min(10, count() + 1); sync(); };
    $('#pGo').onclick = () => issueKeys(f.prov, f.role, count(), $('#pName').value.trim(), parseFloat($('#pLimit').value) || 0.5, $('#pGo')).then(sync);
    $('#addCred').onclick = credSheet;
    sync();
    loadCreds();
  }

  async function loadCreds() {
    try {
      const list = await API.credentials();
      const counts = Object.fromEntries((st.dash ? st.dash.credentials : []).map((c) => [c.id, c]));
      const host = $('#credAll');
      if (!host) return;
      host.innerHTML = list.map((c) => credRow({ ...c, ...(counts[c.id] ? { gateway_calls: counts[c.id].gateway_calls, provider_calls: counts[c.id].provider_calls, calls_estimated: counts[c.id].calls_estimated } : {}) },
        c.status === 'ACTIVE' ? `<button class="icon-btn" data-revoke="${c.id}" aria-label="폐기">${icon('trash')}</button>` : '')).join('')
        || `<div class="empty">${icon('key')}등록된 키가 없어요</div>`;
      const act = list.filter((c) => c.status === 'ACTIVE'), by = {};
      act.forEach((c) => { by[c.provider] = (by[c.provider] || 0) + 1; });
      if ($('#credSum')) $('#credSum').textContent = act.length ? `사용 가능 ${n(act.length)}개 · ${Object.entries(by).map(([p, k]) => `${provName(p)} ${n(k)}`).join(' · ')}` : '사용 가능한 키가 없어요';
      $$('[data-revoke]', host).forEach((b) => {
        b.onclick = async () => {
          if (!await confirmSheet({ title: '이 키를 폐기할까요?', desc: '게이트웨이에서 REVOKED로 표시만 해요. 공급자 쪽 폐기는 하지 않아요.', ok: '폐기', danger: true })) return;
          try { await API.revokeCredential(b.dataset.revoke); toast('폐기했어요', 'ok'); loadCreds(); } catch (e) { toast(e.message, 'bad'); }
        };
      });
    } catch (e) { toast(e.message, 'bad'); }
  }

  function credSheet() {
    sheet({
      title: '공급자 키 등록', desc: 'API 키는 암호화해 저장하고, WIF는 장기 키 없이 15분짜리 단기 토큰을 그때그때 받아요.',
      body: `<div class="seg full" id="cMode" style="margin-bottom:18px"><button data-m="API_KEY" aria-pressed="true">API 키</button><button data-m="WIF" aria-pressed="false">WIF (단기 토큰)</button></div>
        <label class="field" data-for="API_KEY"><span>API 키</span><input class="input mono" id="cSecret" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false"><small>저장 후에는 다시 볼 수 없어요</small></label>
        <label class="field" data-for="WIF" hidden><span>Audience</span><input class="input mono" id="cAud" placeholder="novem-wif"></label>
        <div class="field"><span>역할</span><div class="seg full" id="cRole"><button data-r="STANDBY" aria-pressed="true">예비 키</button><button data-r="PRIMARY" aria-pressed="false">주 키</button></div></div>
        <div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn" id="cSave">등록</button></div>`,
      onMount(el, s) {
        let mode = 'API_KEY', role = 'STANDBY';
        $('#cMode', el).onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; $$('#cMode button', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); $$('[data-for]', el).forEach((f) => { f.hidden = f.dataset.for !== mode; }); };
        $('#cRole', el).onclick = (e) => { const b = e.target.closest('[data-r]'); if (!b) return; role = b.dataset.r; $$('#cRole button', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); };
        $('#cSave', el).onclick = async () => {
          const body = { provider: 'mock', auth_mode: mode, role, ...(mode === 'API_KEY' ? { secret: $('#cSecret', el).value.trim() } : { audience: $('#cAud', el).value.trim() }) };
          try { await API.addCredential(body); toast('키를 등록했어요', 'ok'); s.close(); loadCreds(); } catch (e) { toast(e.message, 'bad'); }
        };
      },
    });
  }

  // 같은 공급자 키 여러 개: 실서버 API가 한 번에 하나라 차례로 부른다. 이름은 공급자 쪽에서 november-이름-번호가 된다
  async function issueKeys(provider, role, count, label, limitUsd, btn) {
    const slug = label.replace(/\s+/g, '-');
    const made = [];
    let leaked = null, err = null;
    btn.disabled = true;
    try {
      for (let i = 1; i <= count; i++) {
        btn.textContent = `${provName(provider)} 키 만드는 중… (${i}/${count})`;
        const name = slug ? (count > 1 ? `${slug}-${i}` : slug) : undefined;
        try {
          const r = await API.provision(provider, { role, limit_usd: limitUsd, ...(name ? { name } : {}) });
          made.push(r);
          if (r.leaked_key) leaked = r.leaked_key;
        } catch (e) { err = e; break; }
      }
    } finally { btn.disabled = false; }
    loadCreds();
    const what = `${provName(provider)} ${role === 'PRIMARY' ? '주 키' : '예비 키'}`;
    if (err) toast(made.length ? `${what} ${made.length}개를 만들고 멈췄어요: ${err.message}` : err.message === 'active PRIMARY already exists' ? '이미 사용 중인 주 키가 있어요. 예비 키로 만들거나 주 키를 먼저 폐기하세요' : err.message, 'bad');
    else if (leaked) secretSheet('주 키를 만들었어요', '공격자 화면에서 ‘유출된 키’로 쓰여요. 지금 한 번만 보여 드려요.', leaked);
    else toast(`${what} ${made.length}개를 만들었어요`, 'ok');
  }

  function secretSheet(title, desc, value) {
    sheet({
      title, desc,
      body: `<div class="secret-box"><span>${esc(value)}</span><button class="icon-btn" id="sCopy" aria-label="복사">${icon('copy')}</button></div>
        <div class="callout">${icon('lock')}<span>이 창을 닫으면 원문을 다시 볼 수 없어요. 서버에는 해시만 저장돼요.</span></div>
        <div class="sheet-f"><button class="btn" data-close>확인했어요</button></div>`,
      onMount(el) { $('#sCopy', el).onclick = () => copy(value); },
    });
  }

  // ================= 접근 제어 =================
  function viewAccess(v) {
    v.innerHTML = `
      <section class="grid g-2">
        <div class="card">
          <div class="card-h"><div><h2>허용 IP 대역</h2><p>여기에 없는 곳에서 온 호출은 403으로 막아요. 0개면 모두 허용해요.</p></div></div>
          <div class="list" id="cidrList"></div>
          <form class="inline-form" id="cidrForm" style="margin-top:14px">
            <input class="input mono" name="cidr" placeholder="10.20.0.0/16" required aria-label="CIDR">
            <select class="input" name="label" style="flex:0 0 120px" aria-label="구분"><option value="INTERNAL">사내</option><option value="VPN">VPN</option></select>
            <button class="btn">추가</button>
          </form>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>직원 · 서비스</h2><p>토큰 원문은 발급할 때 한 번만 보여요</p></div><div class="spacer"></div><button class="btn sm" id="issueBtn">${icon('plus')}토큰 발급</button></div>
          <div class="list" id="svcList"></div>
        </div>
      </section>
      <section class="grid g-2" style="margin-top:var(--gap)">
        <div class="card">
          <div class="card-h"><div><h2>WIF 신뢰 규칙</h2><p>IdP가 서명한 단기 JWT(OIDC)를 서비스에 연결해요</p></div><div class="spacer"></div><button class="btn sm soft" id="tiAdd">${icon('plus')}규칙</button></div>
          <div class="list" id="tiList"></div>
          <p class="muted" style="font-size:12px;margin:12px 0 0" id="wifAud"></p>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>허니키</h2><p>일부러 흘려 둔 가짜 토큰이에요. 쓰이면 전체 API 토큰을 즉시 폐기하고 서비스를 일시 정지해요.</p></div></div>
          <div class="list" id="hkList"></div>
          <div id="blockedIps"></div>
        </div>
      </section>
      <div class="card" style="margin-top:var(--gap)">
        <div class="card-h"><div><h2>최근 거부 기록</h2><p>막힌 호출의 출발 IP와 이유</p></div><div class="spacer"></div><button class="icon-btn" id="denRefresh" aria-label="새로고침">${icon('refresh')}</button></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>시각</th><th>출발 IP</th><th>이유</th><th>토큰</th><th></th></tr></thead><tbody id="denRows"></tbody></table></div>
      </div>`;
    $('#cidrForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await API.addCidr({ cidr: f.cidr.value.trim(), label: f.label.value }); f.reset(); toast('대역을 추가했어요', 'ok'); loadAccess(); } catch (err) { toast(err.message === 'invalid cidr' ? 'CIDR 형식이 올바르지 않아요' : err.message, 'bad'); }
    };
    $('#issueBtn').onclick = issueSheet;
    $('#tiAdd').onclick = trustedSheet;
    $('#denRefresh').onclick = loadAccess;
    loadAccess();
  }

  async function loadAccess() {
    try {
      const [cidrs, svcs, ti, hk, den, wif] = await Promise.all([API.cidrs(), API.services(), API.trusted(), API.honeykeys(), API.accessDenied(30), API.wifSettings().catch(() => null)]);
      if (st.page !== 'access') return;
      $('#cidrList').innerHTML = cidrs.map((c) => `<div class="row"><div class="row-ic sm ${c.label === 'VPN' ? 'ok' : ''}">${icon(c.label === 'VPN' ? 'lock' : 'globe')}</div><div class="row-b"><div class="row-t"><span class="mono">${esc(c.cidr)}</span></div><div class="row-s">${c.label === 'VPN' ? 'VPN' : '사내망'}</div></div><div class="row-e"><button class="icon-btn" data-dc="${c.id}" aria-label="삭제">${icon('trash')}</button></div></div>`).join('')
        || `<div class="callout">${icon('alert')}<span>허용 대역이 없어서 모든 IP를 허용하고 있어요.</span></div>`;
      $$('[data-dc]').forEach((b) => { b.onclick = async () => { try { await API.deleteCidr(b.dataset.dc); loadAccess(); } catch (e) { toast(e.message, 'bad'); } }; });

      $('#svcList').innerHTML = svcs.map((s) => `<div class="row" style="align-items:flex-start"><div class="row-ic ${s.status === 'ACTIVE' ? '' : 'gray'}">${icon('user')}</div>
        <div class="row-b"><div class="row-t"><span>${esc(s.name)}</span>${s.status === 'ACTIVE' ? '' : '<span class="badge warn">정지</span>'}</div>
        ${s.tokens.map((t) => `<div class="row-s" style="display:flex;align-items:center;gap:6px;margin-top:4px"><span class="mono" style="${t.status !== 'ACTIVE' ? 'text-decoration:line-through' : ''}">${esc(t.token_masked)}</span>${t.status === 'ACTIVE' ? `<button class="btn sm ghost" style="height:26px;padding:0 8px" data-rt="${t.id}">폐기</button>` : '<span class="badge">폐기됨</span>'}</div>`).join('')}</div>
        <div class="row-e"><label class="switch" title="${s.status === 'ACTIVE' ? '사용 중' : '정지됨'}"><input type="checkbox" data-sv="${s.id}" ${s.status === 'ACTIVE' ? 'checked' : ''} aria-label="${esc(s.name)} 사용"><span></span></label></div></div>`).join('')
        || `<div class="empty">${icon('users')}서비스가 없어요</div>`;
      $$('[data-sv]').forEach((x) => { x.onchange = async () => { try { await (x.checked ? API.resumeService(x.dataset.sv) : API.suspendService(x.dataset.sv)); toast(x.checked ? '서비스를 다시 열었어요' : '서비스를 정지했어요. 이 토큰은 403을 받아요', x.checked ? 'ok' : 'warn'); loadAccess(); } catch (e) { toast(e.message, 'bad'); } }; });
      $$('[data-rt]').forEach((b) => { b.onclick = async () => { if (!await confirmSheet({ title: '토큰을 폐기할까요?', desc: '이 토큰으로 오는 호출은 바로 401을 받아요.', ok: '폐기', danger: true })) return; try { await API.revokeToken(b.dataset.rt); loadAccess(); } catch (e) { toast(e.message, 'bad'); } }; });

      const svcName = (id) => (svcs.find((s) => s.id === id) || {}).name || `#${id}`;
      $('#tiList').innerHTML = ti.map((r) => `<div class="row"><div class="row-ic sm">${icon('id')}</div><div class="row-b"><div class="row-t"><span class="mono">${esc(r.subject_pattern)}</span></div><div class="row-s">${esc(r.issuer)} → ${esc(svcName(r.service_id))}</div></div><div class="row-e"><button class="icon-btn" data-dt="${r.id}" aria-label="삭제">${icon('trash')}</button></div></div>`).join('')
        || `<div class="empty" style="padding:18px">${icon('id')}규칙이 없어요<br><span style="font-size:13px">사내 ID 공급자의 신원을 서비스에 연결하면 여기에 나와요</span></div>`;
      $$('[data-dt]').forEach((b) => { b.onclick = async () => { try { await API.deleteTrusted(b.dataset.dt); loadAccess(); } catch (e) { toast(e.message, 'bad'); } }; });
      $('#wifAud').innerHTML = wif ? `기본 audience <b class="mono">${esc(wif.wif_audience)}</b> <button class="btn sm ghost" style="height:26px;padding:0 8px" id="wifEdit">바꾸기</button>` : '';
      if (wif) $('#wifEdit').onclick = () => wifAudienceSheet(wif.wif_audience);

      $('#hkList').innerHTML = hk.map((h) => `<div class="row"><div class="row-ic sm ${h.hits ? 'warn' : 'gray'}">${icon('honey')}</div><div class="row-b"><div class="row-t"><span class="mono">${esc(h.masked)}</span></div><div class="row-s">${esc(h.planted_at)}</div></div><div class="row-e">${h.hits ? `<span class="badge warn">${n(h.hits)}회 사용됨</span>` : '<span class="badge">조용함</span>'}</div></div>`).join('')
        || `<div class="empty" style="padding:18px">허니키가 아직 없어요</div>`;
      const bl = st.dash ? st.dash.blocked_ips : [];
      $('#blockedIps').innerHTML = bl.length ? `<div class="callout" style="margin-top:14px">${icon('ban')}<span>임시 차단 중: ${bl.map((b) => `<b class="mono">${esc(b.source_ip)}</b> (${time(b.until, false)}까지)`).join(', ')}</span></div>` : '';

      const allowed = (ip) => cidrs.some((c) => c.cidr === `${ip}/32` || c.cidr === `${ip}/128`);
      $('#denRows').innerHTML = den.map((d) => `<tr><td class="num">${time(d.at)}</td><td class="mono">${esc(d.source_ip)}</td><td><span class="badge ${d.reason === 'ip_blocked' || d.reason === 'ip_not_allowed' ? 'bad' : 'warn'}">${esc(REASON[d.reason] || d.reason)}</span></td><td class="mono muted">${esc(d.token_masked || '—')}</td>
        <td class="r">${d.reason === 'ip_not_allowed' && !allowed(d.source_ip) ? `<button class="btn sm soft" data-allow="${esc(d.source_ip)}">이 IP 허용</button>` : ''}</td></tr>`).join('')
        || `<tr><td colspan="5"><div class="empty">${icon('lock')}거부된 호출이 없어요</div></td></tr>`;
      $$('[data-allow]').forEach((b) => { b.onclick = () => allowIp(b.dataset.allow).then(loadAccess); });
    } catch (e) { toast(e.message, 'bad'); }
  }

  // 공개 서버에서는 발표장 공인 IP가 허용 대역 밖이라 직원 호출이 403이 된다.
  // 거부 로그에 찍힌 출발 IP를 /32로 허용한다(리셋하면 시드 대역으로 돌아가니 다시 눌러야 한다).
  async function allowIp(ip) {
    try {
      await API.addCidr({ cidr: `${ip}${ip.includes(':') ? '/128' : '/32'}`, label: 'VPN' });
      toast(`${ip}를 허용했어요. 이제 이 장소에서 호출할 수 있어요`, 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }

  function wifAudienceSheet(cur) {
    sheet({
      title: 'WIF 기본 audience', desc: '신뢰 규칙에 audience가 없을 때 JWT의 aud를 이 값과 비교해요.',
      body: `<label class="field"><span>Audience</span><input class="input mono" id="waIn" value="${esc(cur)}"></label>
        <div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn" id="waSave">저장</button></div>`,
      onMount(el, s) {
        $('#waSave', el).onclick = async () => {
          const v = $('#waIn', el).value.trim();
          if (!v) return toast('값을 입력해 주세요', 'warn');
          try { await API.saveWifSettings(v); toast('저장했어요', 'ok'); s.close(); loadAccess(); } catch (e) { toast(e.message, 'bad'); }
        };
      },
    });
  }

  function issueSheet() {
    sheet({
      title: '게이트웨이 토큰 발급', desc: '직원이나 서비스는 공급자 키 대신 이 토큰으로 게이트웨이를 불러요. 같은 이름이 없으면 서비스를 새로 만들어요.',
      body: `<label class="field"><span>서비스 이름</span><input class="input" id="tName" placeholder="예: 직원C, 사내 챗봇"></label>
        <div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn" id="tGo">발급하기</button></div>`,
      onMount(el) {
        $('#tGo', el).onclick = async () => {
          const name = $('#tName', el).value.trim();
          if (!name) return toast('이름을 입력해 주세요', 'warn');
          try { const r = await API.issueToken(name); secretSheet(`${esc(name)} 토큰이 나왔어요`, '직원에게 전달하세요. 지금 한 번만 보여 드려요.', r.token); if (st.page === 'access') loadAccess(); } catch (e) { toast(e.message, 'bad'); }
        };
      },
    });
  }

  async function trustedSheet() {
    const svcs = await API.services().catch(() => []);
    sheet({
      title: 'WIF 신뢰 규칙 추가', desc: 'issuer와 subject 패턴(* 사용 가능)이 맞는 JWT만 이 서비스로 받아들여요. 서명은 RS256만 허용해요.',
      body: `<label class="field"><span>Issuer</span><input class="input mono" id="tiIss" value="https://token.actions.githubusercontent.com"></label>
        <label class="field"><span>Subject 패턴</span><input class="input mono" id="tiSub" value="repo:november/*:ref:refs/heads/main"></label>
        <label class="field"><span>Audience (선택)</span><input class="input mono" id="tiAud" placeholder="november-gateway"></label>
        <label class="field"><span>JWKS URI (선택)</span><input class="input mono" id="tiJwks" placeholder="https://token.actions.githubusercontent.com/.well-known/jwks"></label>
        <label class="field"><span>연결할 서비스</span><select class="input" id="tiSvc">${svcs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        <div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn" id="tiSave">추가</button></div>`,
      onMount(el, s) {
        $('#tiSave', el).onclick = async () => {
          const body = { issuer: $('#tiIss', el).value.trim(), subject_pattern: $('#tiSub', el).value.trim(), service_id: +$('#tiSvc', el).value };
          if ($('#tiAud', el).value.trim()) body.audience = $('#tiAud', el).value.trim();
          if ($('#tiJwks', el).value.trim()) body.jwks_uri = $('#tiJwks', el).value.trim();
          try { await API.addTrusted(body); toast('규칙을 추가했어요', 'ok'); s.close(); loadAccess(); } catch (e) { toast(e.message, 'bad'); }
        };
      },
    });
  }

  // ================= 사고 =================
  function viewIncidents(v) {
    v.innerHTML = `<div class="card" style="max-width:880px"><div class="card-h"><h2>사고 기록</h2><div class="spacer"></div><span class="muted" id="incCount"></span></div><div class="list" id="incList"></div></div>`;
    loadIncidents();
  }

  async function loadIncidents() {
    try {
      const list = await API.incidents();
      const host = $('#incList');
      if (!host) return;
      host.innerHTML = list.map((i) => {
        const hk = i.trigger_type === 'HONEYKEY';
        const done = i.status === 'RESOLVED';
        return `<div class="row click" data-inc="${i.id}"><div class="row-ic ${hk ? 'warn' : done ? 'ok' : 'bad'}">${icon(hk ? 'honey' : done ? 'check' : 'ban')}</div>
          <div class="row-b"><div class="row-t"><span>${hk ? '허니키 사용 탐지' : `${esc(i.credential_masked)} 유출 차단`}</span><span class="badge ${done ? 'ok' : hk ? 'warn' : 'bad'}">${{ OPEN: '진행 중', ROTATED: '전환됨', RESOLVED: '복구됨' }[i.status] || i.status}</span></div>
          <div class="row-s">${time(i.detected_at)} · ${hk ? esc((i.timeline[0] || {}).detail || '') : `손실 ${n(i.loss_calls)}건${i.limit_calls ? ` / 한도 ${n(i.limit_calls)}건` : i.block_label ? ` · 차단선 ${esc(i.block_label)}` : ''}${i.new_credential_masked ? ` · ${esc(i.new_credential_masked)}로 전환` : ''}`}</div></div>
          <div class="row-e">${icon('arrow', 'width="18" height="18" style="color:var(--ink-4)"')}</div></div>`;
      }).join('') || `<div class="empty" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="flex:1;min-width:220px">아직 사고가 없어요. 자동 차단이나 허니키 탐지가 일어나면 시각, 새어 나간 호출 수, 전환한 키가 여기에 남아요.</span><button class="btn sm soft" onclick="document.getElementById('demoBtn').click()">${icon('play')}데모 제어 열기</button></div>`;
      $('#incCount').textContent = list.length ? `${n(list.length)}건` : '';
      $$('[data-inc]', host).forEach((r) => { r.onclick = () => incidentSheet(+r.dataset.inc); });
    } catch (e) { toast(e.message, 'bad'); }
  }

  function incidentBody(i) {
    const hk = i.trigger_type === 'HONEYKEY';
    const have = Object.fromEntries(i.timeline.map((t) => [t.step, t]));
    const steps = hk ? i.timeline.map((t) => t.step) : STEP_ORDER;
    const firstPending = steps.findIndex((s) => !have[s]);
    const dur = i.resolved_at ? (new Date(i.resolved_at) - new Date(i.detected_at)) / 1000 : null;
    return `
      ${hk ? '' : `<div class="kpis" style="margin-bottom:22px">
        <div class="kpi"><div class="kpi-l">새어 나간 호출${i.calls_estimated ? ' (추정)' : ''}</div><div class="kpi-v num">${i.calls_estimated ? '약 ' : ''}${n(i.loss_calls)}<span style="font-size:15px;color:var(--ink-3)">${i.limit_calls ? ` / ${n(i.limit_calls)}` : ''}건</span></div><div class="kpi-s">${!i.limit_calls ? (i.block_label ? `차단선 ${esc(i.block_label)}에서 끊었어요` : '&nbsp;') : i.loss_calls == null ? '&nbsp;' : i.loss_calls <= i.limit_calls ? '한도 안에서 막았어요' : `<span style="color:var(--bad-ink)">한도를 ${n(i.loss_calls - i.limit_calls)}건 넘었어요</span>`}</div></div>
        <div class="kpi"><div class="kpi-l">탐지 → 복구</div><div class="kpi-v num">${dur != null ? `${n(dur, 1)}초` : '진행 중'}</div><div class="kpi-s">탐지 ${time(i.detected_at)}</div></div>
      </div>
      <div class="row" style="padding:0 0 18px;border:0"><div class="row-ic bad">${icon('key')}</div><div class="row-b"><div class="row-s">폐기한 키</div><div class="row-t"><span class="mono">${esc(i.credential_masked)}</span></div></div>
        <div style="color:var(--ink-4)">${icon('arrow', 'width="20" height="20"')}</div>
        <div class="row-ic ok">${icon('key')}</div><div class="row-b"><div class="row-s">전환한 키</div><div class="row-t"><span class="mono">${esc(i.new_credential_masked || '없음')}</span></div></div></div>`}
      <ol class="steps">${steps.map((s, k) => {
        const t = have[s];
        const cls = t ? (t.ok ? 'done' : 'fail') : k === firstPending ? 'now' : '';
        return `<li class="step ${cls}"><span class="step-ic">${icon(t ? (t.ok ? 'check' : 'x') : 'refresh')}</span><div><div class="step-t">${STEP[s] || s}${t ? `<time>${time(t.at)}</time>` : ''}</div><div class="step-d">${esc(t ? t.detail : '대기 중')}</div></div></li>`;
      }).join('')}</ol>`;
  }

  async function incidentSheet(id, live = false) {
    let i;
    try { i = await API.incident(id); } catch (e) { return toast(e.message, 'bad'); }
    const hk = i.trigger_type === 'HONEYKEY';
    let timer = null;
    const s = sheet({
      title: hk ? '허니키가 사용됐어요' : live ? '유출된 키를 자동으로 차단했어요' : `${esc(i.credential_masked)} 차단 기록`,
      desc: hk ? '호출자에게는 평범한 401을 돌려주고, 안에서는 전체 API 토큰을 폐기하고 서비스를 일시 정지했어요.' : '게이트웨이가 모르는 호출이 차단선을 넘어 아래 순서로 대응했어요.',
      body: `<div id="incBody">${incidentBody(i)}</div><div class="sheet-f"><button class="btn" data-close>확인</button></div>`,
      onMount(el) {
        // loss_calls 는 RESOLVED 뒤에도 한 번 더 바뀐다(Mock 폐기 2.5초 후, OpenRouter 28초 후 최종값) → 복구 후 40초까지 갱신
        const settled = (x) => x.resolved_at && Date.now() - new Date(x.resolved_at) > 40000;
        if (!settled(i) || live) {
          timer = setInterval(async () => {
            try { const x = await API.incident(id); const b = $('#incBody', el); if (b) b.innerHTML = incidentBody(x); if (settled(x)) clearInterval(timer); } catch { /* 무시 */ }
          }, 1000);
        }
      },
      onClose() { clearInterval(timer); st.liveSheet = null; },
    });
    if (live) st.liveSheet = s;
  }

  // ================= 배너 =================
  function renderBanner(d) {
    const host = $('#banner');
    if (d.status === 'BLOCKED') {
      host.innerHTML = `<div class="banner"><div class="row-ic">${icon('ban')}</div><div><b>유출된 키를 차단하고 있어요</b><p>공급자 키 폐기 → 예비 키 승격 → 관리자 통보 → 전환 키 확인</p></div><button class="btn sm danger" data-banner>자세히</button></div>`;
    } else if (d.status === 'RECOVERED') {
      host.innerHTML = `<div class="banner ok"><div class="row-ic">${icon('check')}</div><div><b>예비 키로 전환을 마쳤어요</b><p>${esc(d.active_credential ? d.active_credential.masked : '')} 키로 직원 호출이 계속되고 있어요</p></div><button class="btn sm gray" data-banner>기록 보기</button></div>`;
    } else host.innerHTML = '';
    const b = $('[data-banner]', host);
    if (b) b.onclick = () => d.incident_id && incidentSheet(d.incident_id);
  }

  // ================= 데모 제어판 =================
  function demoSheet() {
    const live = API.mode === 'live';
    sheet({
      title: '데모 제어', desc: live ? '실서버(NovemberApiGateway)에 연결돼 있어요. 버튼은 /demo/* API를 그대로 불러요.' : '브라우저 안 시뮬레이션으로 같은 흐름을 재현해요.',
      body: `
        <div class="ctl-grid">
          <button class="ctl" id="dReset"><span class="row-ic sm">${icon('refresh')}</span><b>데모 초기화</b><span>키 3개·직원 2명·허니키를 새로 심어요</span></button>
          <button class="ctl" id="dAttack"><span class="row-ic sm bad">${icon('bolt')}</span><b id="dAttackT">공격 시작</b><span>유출 키로 공급자를 직접 초당 5회 호출</span></button>
          <button class="ctl" id="dOutside"><span class="row-ic sm gray">${icon('globe')}</span><b>외부 IP에서 호출</b><span>203.0.113.57 → 403을 받아요</span></button>
          <button class="ctl" id="dHoney"><span class="row-ic sm warn">${icon('honey')}</span><b>허니키로 침입</b><span>가짜 토큰 사용 → 전체 토큰 폐기·서비스 정지</span></button>
          <button class="ctl" id="dWif"><span class="row-ic sm">${icon('id')}</span><b>WIF로 호출</b><span>로컬 IdP JWT로 게이트웨이 인증</span></button>
          <button class="ctl" id="dSuspend"><span class="row-ic sm gray">${icon('pause')}</span><b>직원B 정지</b><span>정지된 서비스는 403</span></button>
        </div>
        <div class="ctl-row" style="margin-top:12px"><div class="row-ic">${icon('users')}</div><div class="row-b"><div class="row-t"><span>직원 정상 호출</span></div><div class="row-s" id="dTrafficS">직원A·B가 1.5초마다 게이트웨이로 호출해요</div></div><label class="switch"><input type="checkbox" id="dTraffic" ${st.traffic ? 'checked' : ''} aria-label="직원 정상 호출"><span></span></label></div>
        <div class="ctl-row"><div class="row-ic">${icon('plug')}</div><div class="row-b"><div class="row-t"><span>실제 공급자로 초기화</span></div><div class="row-s">게이트웨이 .env의 관리 키가 필요해요</div></div><div class="row-e"><button class="btn sm soft" data-rp="openrouter">OpenRouter</button><button class="btn sm soft" data-rp="openai">OpenAI</button></div></div>
        <div class="ctl-row"><div class="row-ic gray">${icon('trash')}</div><div class="row-b"><div class="row-t"><span>시연 후 실제 키 정리</span></div><div class="row-s">november- 로 시작하는 키만 지워요</div></div><div class="row-e"><button class="btn sm gray" data-cl="openrouter">OpenRouter</button><button class="btn sm gray" data-cl="openai">OpenAI</button></div></div>
        <div class="ctl-row"><div class="row-ic">${icon('external')}</div><div class="row-b"><div class="row-t"><span>발표 화면</span></div><div class="row-s">${live ? '링크에 서버 주소가 들어가요. 관리자 키는 들어가지 않아요' : '공격자는 유출 키로, 직원은 게이트웨이로 채팅해요'}</div></div><div class="row-e"><button class="btn sm" id="dQr">공격자 화면 QR</button><a class="btn sm soft" href="${esc(API.shareLink('employee.html'))}" target="_blank" rel="noopener">직원</a></div></div>`,
      onMount(el) {
        const sync = () => {
          const on = st.dash && st.dash.attack_running;
          // 공격 시뮬레이터는 Mock 전용: 실제 공급자 키로는 Mock을 두드려도 탐지되지 않는다
          const prov = st.dash && st.dash.active_credential ? st.dash.active_credential.provider : 'mock';
          const mockOnly = prov !== 'mock' && !on;
          $('#dAttack', el).classList.toggle('on', !!on);
          $('#dAttack', el).disabled = mockOnly;
          $('#dAttackT', el).textContent = on ? '공격 중지' : '공격 시작';
          $('#dAttack span:last-child', el).textContent = mockOnly ? `Mock 모드 전용이에요. ${prov}는 공격자 화면으로 시연하세요` : '유출 키로 공급자를 직접 초당 5회 호출';
        };
        sync();
        const iv = setInterval(sync, 800);
        el.closest('.scrim').addEventListener('transitionend', () => { if (!document.body.contains(el)) clearInterval(iv); });
        const run = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; poll(); } };
        $('#dReset', el).onclick = run($('#dReset', el), async () => {
          if (live && !await confirmSheet({ title: '실서버 데이터를 초기화할까요?', desc: '사용량·사고·토큰이 모두 지워지고 새로 시드돼요.', ok: '초기화', danger: true })) return;
          await API.reset('mock'); resetLocal(); toast('초기화했어요. 새 토큰이 발급됐어요', 'ok');
          if (!st.traffic) setTraffic(true);
        });
        $$('[data-rp]', el).forEach((b) => { b.onclick = run(b, async () => { if (!await confirmSheet({ title: `${b.dataset.rp}로 초기화할까요?`, desc: '기존 november- 키를 지우고 주/예비 키를 새로 만들어요.', ok: '초기화' })) return; toast('실제 키를 만드는 중이에요…'); const r = await API.reset(b.dataset.rp); resetLocal(); if (r.leaked_key) secretSheet('유출용 주 키를 만들었어요', '공격자 화면이 이 키를 써요.', r.leaked_key); }); });
        $('#dAttack', el).onclick = run($('#dAttack', el), async () => {
          if (st.dash && st.dash.attack_running) { await API.attackStop(); toast('공격을 멈췄어요'); } else { await API.attackStart(); toast('공격을 시작했어요. 공급자 선만 올라가요', 'warn'); }
        });
        $('#dOutside', el).onclick = run($('#dOutside', el), async () => {
          const tok = tokens()[0];
          if (!tok) return toast('먼저 데모 초기화를 해 주세요', 'warn');
          try { await API.chat({ token: tok[1], message: '외부에서 접속', ip: '203.0.113.57' }); toast('통과했어요 (허용 대역을 확인하세요)', 'warn'); } catch (e) { toast(`${e.status} · ${e.message}`, 'bad'); }
        });
        $('#dHoney', el).onclick = run($('#dHoney', el), async () => { const r = await API.honeypot(); toast(`${r.source_ip}에 ${r.status_code}을 돌려주고 전체 토큰을 폐기했어요`, 'warn'); });
        $('#dWif', el).onclick = run($('#dWif', el), async () => {
          await API.wifSeed();
          const { token } = await API.wifToken();
          const r = await API.chat({ token, message: 'WIF로 인증한 호출' });
          toast(`JWT 인증 통과 · 직원A로 호출 성공 (${r.usage ? r.usage.total_tokens : '?'} 토큰)`, 'ok');
        });
        $('#dSuspend', el).onclick = run($('#dSuspend', el), async () => {
          const svcs = await API.services();
          const b = svcs.find((s) => s.name === '직원B');
          if (!b) return toast('직원B가 없어요. 초기화해 주세요', 'warn');
          if (b.status === 'ACTIVE') { await API.suspendService(b.id); toast('직원B를 정지했어요. 이제 403을 받아요', 'warn'); } else { await API.resumeService(b.id); toast('직원B를 다시 열었어요', 'ok'); }
        });
        $('#dTraffic', el).onchange = (e) => setTraffic(e.target.checked);
        $$('[data-cl]', el).forEach((b) => { b.onclick = run(b, async () => {
          if (!await confirmSheet({ title: `${b.dataset.cl} 키를 정리할까요?`, desc: '이름이 november- 로 시작하는 키(비활성 포함)만 공급자에서 지워요.', ok: '정리', danger: true })) return;
          const r = await API.cleanup(b.dataset.cl); toast(`${n(r.deleted)}개를 지웠어요`, 'ok');
        }); });
        $('#dQr', el).onclick = () => qrSheet(API.shareLink('live.html'));
      },
    });
  }

  // 공격자 화면 QR: 슬라이드·프로젝터에 띄워 폰으로 바로 접속하게 한다
  let qrLib = null;
  function loadQr() {
    qrLib ||= new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      s.onload = () => ok(window.qrcode); s.onerror = fail;
      document.head.append(s);
    });
    return qrLib;
  }
  function qrSheet(url) {
    sheet({
      title: '공격자 화면 QR', desc: API.mode === 'live' ? '폰 카메라로 찍으면 유출 키 채팅 화면이 열려요.' : '지금은 시뮬레이션이라 폰마다 따로 움직여요. 실서버에 연결하면 모두 같은 유출 키를 써요.',
      body: `<div style="display:grid;place-items:center;padding:8px 0 4px"><div id="qrBox" style="background:#fff;padding:14px;border-radius:20px;width:min(300px,80vw);aspect-ratio:1;display:grid;place-items:center"><div class="skeleton" style="width:100%;height:100%"></div></div></div>
        <div class="secret-box" style="margin-top:14px"><span>${esc(url)}</span><button class="icon-btn" id="qrCopy" aria-label="링크 복사">${icon('copy')}</button></div>
        <div class="sheet-f"><a class="btn gray" href="${esc(url)}" target="_blank" rel="noopener">${icon('external')}열어 보기</a><button class="btn" data-close>닫기</button></div>`,
      onMount(el) {
        $('#qrCopy', el).onclick = () => copy(url);
        loadQr().then((qrcode) => {
          const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
          $('#qrBox', el).innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
          $('#qrBox svg', el).style.cssText = 'width:100%;height:100%';
        }).catch(() => { $('#qrBox', el).innerHTML = '<span style="color:#4e5968;font-size:13px;text-align:center">QR을 그리지 못했어요.<br>아래 링크를 쓰세요</span>'; });
      },
    });
  }

  function tokens() {
    const r = API.lastReset();
    return r && r.tokens ? Object.entries(r.tokens) : [];
  }

  function resetLocal() {
    st.feed = []; st.lastEvent = 0; st.incident = null; st.lastErr = {}; st.popped.clear();
    renderFeed();
    if (st.page !== 'home') route();
  }

  function setTraffic(on) {
    st.traffic = on;
    clearInterval(st.trafficTimer);
    const sw = $('#dTraffic'); if (sw) sw.checked = on;
    if (!on) return;
    if (!tokens().length) { toast('먼저 데모 초기화를 해 주세요', 'warn'); st.traffic = false; if (sw) sw.checked = false; return; }
    const msgs = ['회의록 요약해 줘', '이 문장 영어로 바꿔 줘', '고객 문의 답장 초안', '코드 리뷰 부탁해', '보고서 제목 추천'];
    st.trafficTimer = setInterval(async () => {
      const list = tokens();
      const [name, tok] = list[st.trafficN++ % list.length];
      try { await API.chat({ token: tok, message: msgs[st.trafficN % msgs.length] }); }
      catch (e) {
        const k = `${name}:${e.status}`;
        if (!st.lastErr[k] || Date.now() - st.lastErr[k] > 15000) { st.lastErr[k] = Date.now(); toast(`${name} 호출 ${e.status} · ${e.message}`, e.status === 503 ? 'bad' : 'warn'); }
      }
    }, 1500 / Math.max(1, tokens().length) * 2);
  }

  // ================= 연결 설정 =================
  function connSheet() {
    const c = API.config;
    sheet({
      title: '서버 연결', desc: '기본은 시뮬레이션이에요. NovemberApiGateway를 로컬에서 띄우면(게이트웨이 8000 · Mock 9000) 같은 화면이 실제 데이터로 움직여요.',
      body: `<div class="seg full" id="mSeg" style="margin-bottom:18px">${[['sim', '시뮬레이션'], ['auto', '자동'], ['live', '실서버']].map(([k, l]) => `<button data-m="${k}" aria-pressed="${c.mode === k}">${l}</button>`).join('')}</div>
        <div class="callout ${API.mode === 'live' ? 'info' : ''}">${icon(API.mode === 'live' ? 'check' : 'plug')}<span>${API.mode === 'live' ? `지금 실서버(${esc(c.api)})에 연결돼 있어요.` : '지금은 브라우저 안 시뮬레이션이에요. 백엔드 없이도 같은 흐름을 보여 줘요.'}</span></div>
        <div class="inline-form" style="margin-bottom:16px"><button class="chip" data-pre="https://hack.sio2.kr|https://hack.sio2.kr">${icon('globe', 'width="14" height="14"')}테스트 서버 hack.sio2.kr</button><button class="chip" data-pre="http://localhost:8000|http://localhost:9000">${icon('plug', 'width="14" height="14"')}내 컴퓨터 (8000 · 9000)</button></div>
        <label class="field"><span>게이트웨이 주소</span><input class="input mono" id="cApi" value="${esc(c.api)}"></label>
        <label class="field"><span>Mock Provider 주소 (공격자 화면용)</span><input class="input mono" id="cMock" value="${esc(c.mock)}"></label>
        <label class="field"><span>관리자 키 (X-Admin-Key)</span><input class="input mono" id="cKey" value="${esc(c.key)}" type="password" autocomplete="off"><small>테스트 서버 키는 담당자에게 따로 받아요. 이 브라우저에만 저장되고 공격자 링크·QR에는 들어가지 않아요.</small></label>
        <div class="sheet-f"><button class="btn gray" data-close>취소</button><button class="btn" id="cGo">저장하고 다시 연결</button></div>`,
      onMount(el) {
        let mode = c.mode;
        $('#mSeg', el).onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; $$('#mSeg button', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); };
        $$('[data-pre]', el).forEach((b) => { b.onclick = () => {
          const [a, m] = b.dataset.pre.split('|');
          $('#cApi', el).value = a; $('#cMock', el).value = m; mode = 'live';
          $$('#mSeg button', el).forEach((x) => x.setAttribute('aria-pressed', x.dataset.m === 'live'));
          if (a.startsWith('https')) { $('#cKey', el).value = ''; $('#cKey', el).focus(); }
          else $('#cKey', el).value = 'demo-admin';
        }; });
        $('#cGo', el).onclick = () => { API.saveConfig({ mode, api: $('#cApi', el).value.trim(), mock: $('#cMock', el).value.trim(), key: $('#cKey', el).value }); location.reload(); };
      },
    });
  }

  // ================= 폴링 =================
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      let [d, ev] = await Promise.all([API.dashboard(), API.events(st.lastEvent)]);
      const prev = st.dash;
      st.dash = d;
      const first = st.lastEvent === 0 && !prev;
      // fix: 다른 탭·API로 서버를 초기화해 이벤트 번호가 되감기면 처음부터 다시 받는다(안 그러면 새 이벤트·차단 팝업을 놓침)
      if (ev.last_id != null && ev.last_id < st.lastEvent) { st.lastEvent = 0; st.feed = []; st.popped.clear(); ev = await API.events(0); }
      const pop = (id) => { if (id && !st.popped.has(id)) { st.popped.add(id); incidentSheet(id, true); } }; // fix: 사고당 팝업 1번
      for (const e of ev.events) {
        st.feed.push(e);
        st.lastEvent = Math.max(st.lastEvent, e.id);
        if (first) continue;
        if (e.kind === 'SUSPECT') toast(e.message, 'warn');
        if (e.kind === 'WARNING') toast(e.message, 'warn', 4500);
        if (e.kind === 'BLOCKED') { toast('유출 키를 자동으로 차단했어요', 'bad', 5000); if (e.data) pop(e.data.incident_id); }
        if (e.kind === 'RECOVERED') toast(e.message, 'ok', 4500);
        if (e.kind === 'HONEYKEY') toast('허니키 사용을 탐지했어요', 'warn');
      }
      if (st.feed.length > 300) st.feed = st.feed.slice(-200);
      // fix: BLOCKED 이벤트를 놓쳐도 상태가 BLOCKED로 바뀌는 순간 팝업을 띄운다(첫 화면부터 BLOCKED면 띄우지 않음)
      if (prev && prev.status !== 'BLOCKED' && d.status === 'BLOCKED') pop(d.incident_id);
      // fix: 사고가 두 번 연속 없으면 기록을 비운다(초기화 후 사고 번호가 1부터 다시 시작하므로)
      if (!d.incident_id && prev && !prev.incident_id) st.popped.clear();
      if (d.incident_id && (!st.incident || st.incident.id !== d.incident_id || d.status === 'BLOCKED' || st.incident.loss_calls == null)) {
        st.incident = await API.incident(d.incident_id).catch(() => st.incident);
      }
      if (!prev || prev.status !== d.status) { renderNav(); renderBanner(d); }
      if (st.page === 'home') { renderHome(d); if (ev.events.length) renderFeed(); }
      if (st.page === 'limits' && st.onDash) st.onDash();
      setConn(true);
    } catch (e) {
      setConn(false, e);
      if (e.status === 401 && !st.keyAsked) { // 공개 서버에 처음 붙으면 관리자 키부터 묻는다
        st.keyAsked = true;
        toast('관리자 키가 필요해요', 'warn');
        connSheet();
      }
    } finally {
      polling = false;
    }
  }

  function setConn(ok, err) {
    const chip = $('#connChip');
    chip.classList.toggle('on', ok && API.mode === 'live');
    chip.classList.toggle('sim', ok && API.mode === 'sim');
    $('#connText').textContent = !ok ? (err && err.status === 401 ? '관리자 키 오류' : '연결 끊김') : API.mode === 'live' ? '실서버 연결됨' : '시뮬레이션';
  }

  // ================= 시작 =================
  const setThemeIcon = () => { const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'; $('#themeBtn').innerHTML = icon(dark ? 'sun' : 'moon'); };
  $('#themeBtn').onclick = () => { UI.toggleTheme(); setThemeIcon(); if (st.page === 'home') refreshChart(); };
  setThemeIcon();
  $('#demoBtn').onclick = demoSheet;
  $('#connChip').onclick = connSheet;

  (async () => {
    const mode = await API.init();
    if (mode === 'sim') { await API.reset('mock'); setTraffic(true); }
    route();
    await poll();
    setInterval(poll, 1200);
    setInterval(() => { if (st.page === 'home') refreshChart(); }, 2000);
    setInterval(() => { if (st.page === 'usage') loadUsage(); if (st.page === 'incidents') loadIncidents(); }, 5000);
    setInterval(() => { if (st.page === 'home') renderFeed(); }, 10000);
    if (mode === 'sim') setTimeout(() => toast('‘데모 제어’에서 공격을 시작해 보세요'), 600);
  })();
  addEventListener('resize', () => { if (st.page === 'home') refreshChart(); });
  void closeSheet;
})();
