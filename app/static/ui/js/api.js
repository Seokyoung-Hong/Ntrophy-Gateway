/* api.js — 화면이 서버와 이야기하는 유일한 창구
 *
 *  sim  : 브라우저 안 시뮬레이션(js/sim.js). 응답 모양은 실서버와 같다. (기본값: 서버 없이 디자인·흐름 확인)
 *  live : 실제 NovemberApiGateway (게이트웨이 :8000, Mock Provider :9000)를 로컬에서 띄웠을 때
 *  auto : 게이트웨이에 접속되면 live, 안 되면 sim
 *
 *  주소창으로 바꾸기
 *    공개 서버 하나(게이트웨이·/live 같은 주소): ?server=https://hack.sio2.kr
 *    로컬 두 포트: ?mode=live&api=http://localhost:8000&mock=http://localhost:9000
 *  관리자 키는 주소창에 넣지 않는다. 화면의 "연결" 버튼에서 입력하면 이 브라우저에만 저장된다.
 */
(function (global) {
  'use strict';

  const STORE = 'ng.cfg', RESET_STORE = 'ng.reset';
  const DEFAULTS = { mode: 'sim', api: 'http://localhost:8000', mock: 'http://localhost:9000', key: 'demo-admin' };

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가(사생활 모드)면 무시 */ } };

  const qs = new URLSearchParams(location.search);
  const cfg = { ...DEFAULTS, ...(read(STORE) || {}) };
  for (const k of Object.keys(DEFAULTS)) if (qs.get(k)) cfg[k] = qs.get(k);
  if (qs.get('server')) { // 공개 모드 서버는 게이트웨이와 /live 가 한 주소에 있다
    const s = qs.get('server').replace(/\/$/, '');
    Object.assign(cfg, { mode: 'live', api: s, mock: s });
  }

  let active = null; // 'live' | 'sim'
  let world = null;
  let resetMem = null;

  class ApiError extends Error {
    constructor(status, body) {
      super(ApiError.describe(status, body));
      this.status = status; this.body = body;
    }
    static describe(status, body) {
      const code = body && (body.error || body.detail);
      const known = {
        ip_not_allowed: '허용되지 않은 IP예요', invalid_token: '유효하지 않은 토큰이에요', service_suspended: '정지된 서비스예요',
        ip_blocked: '임시 차단된 IP예요', no_active_credential: '사용 가능한 키가 없어요', upstream_error: '공급자 연결에 실패했어요',
        revoked: '폐기된 키예요', rate_limited: '잠시 후 다시 시도해 주세요', invalid_admin_key: '관리자 키가 올바르지 않아요',
        'bad admin key': '관리자 키가 올바르지 않아요',
        wif_invalid_signature: 'JWT 서명이 올바르지 않아요', wif_expired: 'JWT가 만료됐어요', wif_untrusted_identity: '신뢰 규칙에 없는 신원이에요',
        wif_audience_mismatch: 'JWT audience가 달라요', wif_malformed: 'JWT 형식이 올바르지 않아요',
      };
      // 서버가 예외로 죽으면(500) CORS 헤더가 없어 브라우저에는 연결 실패처럼 보인다
      if (status === 0) return '서버에 연결할 수 없거나 서버 내부 오류예요';
      return known[code] || (typeof code === 'string' ? code : `요청 실패 (${status})`);
    }
  }

  function sim() {
    if (!world) world = new global.SimWorld();
    return world;
  }

  async function liveFetch(base, method, path, body, headers, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    // 관리자 키는 관리·데모 경로에만. 공격자 경로(/live/*)로는 보내지 않는다
    const admin = /^\/(admin|demo|idp|v1)\//.test(path) ? { 'X-Admin-Key': cfg.key } : {};
    let res;
    try {
      res = await fetch(base.replace(/\/$/, '') + path, {
        method, signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...admin, ...headers },
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, { error: 'network' });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  async function request(method, path, body, opts = {}) {
    if (!active) await init();
    const headers = opts.headers || {};
    if (active === 'sim') {
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 90)); // 네트워크 느낌
      try {
        return sim().request(method, path, body, headers);
      } catch (e) {
        if (e instanceof global.SimHttpError) throw new ApiError(e.status, e.body);
        throw e;
      }
    }
    const base = opts.target === 'mock' ? cfg.mock : cfg.api;
    return liveFetch(base, method, path, body, headers, opts.timeout);
  }

  let initP = null;
  function init() {
    if (initP) return initP;
    initP = (async () => {
      if (cfg.mode !== 'auto') { active = cfg.mode; return active; }
      try { // 서버가 답하기만 하면(관리자 키가 틀려 401이어도) 실서버
        await liveFetch(cfg.mock, 'GET', '/live/stats', null, {}, 1800);
        active = 'live';
      } catch (e) {
        active = e.status ? 'live' : 'sim';
      }
      return active;
    })();
    return initP;
  }

  const get = (p, o) => request('GET', p, null, o);
  const post = (p, b, o) => request('POST', p, b || {}, o);
  const put = (p, b) => request('PUT', p, b);
  const del = (p) => request('DELETE', p);

  const API = {
    init,
    get mode() { return active; },
    get config() { return { ...cfg }; },
    saveConfig(next) { Object.assign(cfg, next); write(STORE, cfg); },
    Error: ApiError,

    // 대시보드·탐지 (D절)
    dashboard: () => get('/admin/dashboard'),
    timeseries: (range = 300) => get(`/admin/timeseries?range=${range}`),
    incidents: () => get('/admin/incidents'),
    incident: (id) => get(`/admin/incidents/${id}`),
    events: (since = 0) => get(`/admin/events?since_id=${since}`),
    accessDenied: (limit = 20) => get(`/admin/access-denied?limit=${limit}`),

    // 관리 (C·E·J절)
    credentials: () => get('/admin/credentials'),
    addCredential: (b) => post('/admin/credentials', b),
    revokeCredential: (id) => del(`/admin/credentials/${id}`),
    provision: (provider, b) => post(`/admin/${provider}/provision`, b),
    settings: () => get('/admin/settings'),
    saveSettings: (b) => put('/admin/settings', b),
    cidrs: () => get('/admin/cidrs'),
    addCidr: (b) => post('/admin/cidrs', b),
    deleteCidr: (id) => del(`/admin/cidrs/${id}`),
    services: () => get('/admin/services'),
    suspendService: (id) => post(`/admin/services/${id}/suspend`),
    resumeService: (id) => post(`/admin/services/${id}/resume`),
    issueToken: (service_name) => post('/admin/tokens', { service_name }),
    revokeToken: (id) => del(`/admin/tokens/${id}`),
    honeykeys: () => get('/admin/honeykeys'),
    trusted: () => get('/admin/trusted-identities'),
    addTrusted: (b) => post('/admin/trusted-identities', b),
    deleteTrusted: (id) => del(`/admin/trusted-identities/${id}`),
    wifSettings: () => get('/admin/wif/settings'),
    saveWifSettings: (wif_audience) => put('/admin/wif/settings', { wif_audience }),

    // 사용량 (H절)
    usageSummary: (range = 'day') => get(`/admin/usage/summary?range=${range}`),
    usageTimeseries: (range = 'day', bucket = 'hour') => get(`/admin/usage/timeseries?range=${range}&bucket=${bucket}`),
    usageForecast: (h = 1) => get(`/admin/usage/forecast?window_hours=${h}`),
    budget: () => get('/admin/usage/budget'),
    saveBudget: (v) => put('/admin/usage/budget', { monthly_budget_krw: v }),

    // 데모 제어
    async reset(provider) {
      const r = await post(provider && provider !== 'mock' ? `/demo/reset-${provider}` : '/demo/reset', {}, { timeout: 60000 });
      // 시뮬레이션 세계는 탭마다 따로라 토큰도 탭 안에만 둔다. 실서버 토큰은 다른 화면(직원 채팅)과 나눠 쓴다.
      resetMem = { ...r, at: Date.now(), mode: active };
      if (active === 'live') write(RESET_STORE, resetMem);
      return r;
    },
    cleanup: (provider) => post(`/demo/cleanup-${provider}`, {}, { timeout: 60000 }),
    // 공격자·직원에게 줄 주소. 관리자 키는 절대 넣지 않는다
    shareLink(page) {
      const u = new URL(page, location.href);
      if (active === 'live') {
        if (cfg.api === cfg.mock) u.searchParams.set('server', cfg.api);
        else { u.searchParams.set('mode', 'live'); u.searchParams.set('api', cfg.api); u.searchParams.set('mock', cfg.mock); }
      }
      return u.toString();
    },
    attackStart: () => post('/demo/attack/start'),
    attackStop: () => post('/demo/attack/stop'),
    honeypot: () => post('/demo/honeypot/hit'),
    wifSeed: () => post('/demo/wif/seed'),
    wifToken: (sub) => post('/demo/wif/token', sub ? { sub } : {}),
    lastReset() {
      if (active === 'sim') return resetMem;
      const r = read(RESET_STORE);
      return r && r.mode === 'live' ? r : null;
    },

    // 직원 호출: 게이트웨이 /v1/chat/completions (토큰 또는 WIF JWT)
    chat: ({ token, message, history = [], ip, model = 'mock', max_tokens = 300 }) => post('/v1/chat/completions',
      { model, max_tokens, messages: [...history, { role: 'user', content: message }] },
      { headers: { Authorization: `Bearer ${token}`, ...(ip ? { 'X-Demo-Source-IP': ip } : {}) } }),

    // 공격자 라이브 (F절, Mock Provider)
    liveConfig: () => get('/live/config', { target: 'mock' }),
    liveChat: (key, message, history = []) => post('/live/chat', { key, message, history }, { target: 'mock', timeout: 30000 }),
    liveStats: () => get('/live/stats', { target: 'mock' }),
    simWorld: () => (active === 'sim' ? sim() : null),
  };

  global.API = API;
})(window);
