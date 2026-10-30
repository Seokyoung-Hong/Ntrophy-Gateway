/* sim.js — 브라우저 안에서 도는 NovemberApiGateway 축소판
 *
 * 백엔드(github.com/Seokyoung-Hong/NovemberApiGateway)가 없을 때 화면을 같은 모양의 데이터로 움직이기 위한 것.
 * 규칙은 원본 app/contract.py · detector/router.py와 같다:
 *   - 판정 = 설명되지 않는 호출 수 = max(0, 공급자 − 게이트웨이(지연 정렬) − 3)
 *   - 한도 L의 10% SUSPECT / 50% WARNING / 70% BREACH → 폐기 → 예비키 승격 → 통보 → 검증
 *   - 공급자 집계 지연 2초, 워커 2초 주기, 하강 히스테리시스 10초, 복구 표시 10초
 * 응답 JSON 모양은 실서버와 같다(docs/contract.md C·D·E·H·J절).
 */
(function (global) {
  'use strict';

  const LAG_S = 2, POLL_S = 2, TOL = 3, HYST_S = 10, RECOVERED_HOLD_S = 10;
  const RATIOS = [0.1, 0.5, 0.7];
  const COST_PER_TOKEN = 0.4;
  const ATTACK_RPS = 5, ATTACK_TOKENS = 2000;
  const LEAKED_KEY = 'sk-mock-K1-leaked-demo';
  const ORDER = ['NORMAL', 'SUSPECT', 'WARNING', 'BREACH'];
  const PRICE = { in: 0.15, out: 0.6 }; // gpt-4o-mini USD / 1M 토큰
  const USD_TO_KRW = 1400;

  const now = () => Date.now() / 1000;
  const iso = (t) => (t == null ? null : new Date(t * 1000).toISOString());
  const mask = (k) => (k.length > 8 ? `${k.slice(0, 3)}...${k.slice(-4)}` : '***');
  const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  class HttpError extends Error {
    constructor(status, body) { super(`${status}`); this.status = status; this.body = body; }
  }

  // 판정 기준 두 가지
  //   usage_pct: 공급자가 보고한 호출 중 게이트웨이가 모르는 호출의 비율(%). 정상 사용량이 많든 적든 같은 잣대.
  //              쓰임이 없던 키가 몰래 쓰이면 바로 100%가 된다.
  //   calls:     게이트웨이가 모르는 호출 수(건). 허용 오차 TOL을 이미 뺀 값이라 1건부터 실제 무단 호출이다.
  const DETECTION_DEFAULTS = {
    detection_mode: 'usage_pct', suspect_pct: 5, warn_pct: 10, block_pct: 20, suspect_calls: 1, warn_calls: 5, block_calls: 10,
  };
  const thresholds = (s) => (s.detection_mode === 'calls' ? [s.suspect_calls, s.warn_calls, s.block_calls] : [s.suspect_pct, s.warn_pct, s.block_pct]);
  const measure = (s, diff, providerCalls) => (s.detection_mode === 'calls' ? diff : providerCalls > 0 ? (diff / providerCalls) * 100 : 0);
  const fmtMeasure = (s, v) => (s.detection_mode === 'calls' ? `${v}건` : `${Math.round(v * 10) / 10}%`);

  function judge(value, th) {
    if (value >= th[2]) return 'BREACH';
    if (value >= th[1]) return 'WARNING';
    if (value > 0 && value >= th[0]) return 'SUSPECT';
    return 'NORMAL';
  }

  function ipIn(ip, cidr) {
    if (cidr.includes(':') || ip.includes(':')) return cidr === `${ip}/128`;
    const [net, bits] = cidr.split('/');
    const toN = (s) => s.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
    const m = +bits === 0 ? 0 : (~0 << (32 - +bits)) >>> 0;
    return (toN(ip) & m) === (toN(net) & m);
  }

  function World() {
    let S;
    let seq;
    const timers = new Set();
    const later = (ms, fn) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };

    // ---------- 공급자(Mock) ----------
    const provider = {
      revoked: new Set(),
      reqs: {}, // owner -> [[at, tokens]]
      call(owner, tokens) {
        if (this.revoked.has(owner)) return 401;
        (this.reqs[owner] ||= []).push([now(), tokens]);
        return 200;
      },
      usage(owner, t) {
        const rs = (this.reqs[owner] || []).filter((r) => r[0] <= t - LAG_S);
        const tokens = rs.reduce((a, r) => a + r[1], 0);
        return { requests: rs.length, tokens, cost_krw: tokens * COST_PER_TOKEN };
      },
    };

    function event(kind, message, data) {
      S.events.push({ id: ++seq.event, at: iso(now()), kind, message, data: data || null });
    }

    function reset() {
      timers.forEach(clearTimeout); timers.clear();
      provider.revoked.clear(); provider.reqs = {};
      seq = { cred: 0, svc: 0, tok: 0, cidr: 0, event: 0, inc: 0, hk: 0, ti: 0, denied: 0 };
      const t = iso(now());
      S = {
        settings: { ...DETECTION_DEFAULTS, unauthorized_call_limit: 100, loss_limit_krw: 100000 },
        budget: null, wifAudience: 'november-gateway',
        creds: [], services: [], tokens: [], cidrs: [], usage: [], snaps: [], denied: [], incidents: [], events: [],
        honeykeys: [], hkEvents: [], blockedIps: {}, trusted: [], jwts: {},
        judged: {}, view: {}, attack: false, updatedAt: now(), t0: now(),
      };
      [['127.0.0.1/32', 'INTERNAL'], ['::1/128', 'INTERNAL'], ['10.0.0.0/16', 'INTERNAL'], ['10.8.0.0/24', 'VPN']]
        .forEach(([cidr, label]) => S.cidrs.push({ id: ++seq.cidr, cidr, label }));
      const addCred = (auth_mode, role, key, audience) => S.creds.push({
        id: ++seq.cred, provider: 'mock', auth_mode, role, status: 'ACTIVE', key,
        masked: auth_mode === 'WIF' ? `WIF:${audience}` : mask(key), audience: audience || null,
        ref: auth_mode === 'WIF' ? `wif:${audience}` : key, replaced_by_id: null, created_at: t,
      });
      addCred('API_KEY', 'PRIMARY', LEAKED_KEY);
      addCred('API_KEY', 'STANDBY', `sk-mock-S1-${rnd(8)}`);
      addCred('WIF', 'STANDBY', null, 'novem-wif');
      const tokens = {};
      for (const name of ['직원A', '직원B']) {
        const sid = ++seq.svc;
        S.services.push({ id: sid, name, status: 'ACTIVE' });
        tokens[name] = issue(sid).token;
      }
      seedHistory();
      const honeykeys = {};
      for (const planted of ['공개 저장소 .env.example', '사내 위키 설정 예시']) {
        const v = `nvm-honey-${rnd(24)}`;
        S.honeykeys.push({ id: ++seq.hk, value: v, masked: mask(v), planted_at: planted, created_at: t });
        honeykeys[planted] = v;
      }
      return { tokens, honeykeys, note: 'trusted_identity(WIF 신뢰 규칙)도 삭제됨. WIF는 POST /demo/wif/seed 재실행' };
    }

    // 오늘 앞 시간대의 정상 사용 이력(최대 9시간). 게이트웨이·공급자 양쪽에 똑같이 남겨 차이는 0으로 시작한다.
    // 사용량 화면의 시간대 차트와 예측이 빈 화면이 아니게 하려는 것.
    function seedHistory() {
      const t = now(), start = Math.max(rangeStart('day'), t - 9 * 3600), k1 = S.creds[0];
      const models = ['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini', 'claude-3-haiku'];
      for (let h = start; h < t - 600; h += 3600) {
        for (const svc of S.services) {
          const n = 4 + Math.floor(Math.random() * (svc.id === 1 ? 14 : 9));
          for (let i = 0; i < n; i++) {
            const at = Math.min(t - 600, h + Math.random() * 3600), out = 120 + Math.floor(Math.random() * 380), inp = 30 + Math.floor(Math.random() * 200);
            S.usage.push({ service_id: svc.id, credential_id: k1.id, model: models[Math.floor(Math.random() * models.length)], input_tokens: inp, output_tokens: out, cost_krw: (inp + out) * COST_PER_TOKEN, at });
            (provider.reqs[k1.ref] ||= []).push([at, inp + out]);
          }
        }
      }
      S.usage.sort((a, b) => a.at - b.at);
      provider.reqs[k1.ref] && provider.reqs[k1.ref].sort((a, b) => a[0] - b[0]);
    }

    function issue(sid) {
      const token = `nvm-${rnd(32)}`;
      const row = { id: ++seq.tok, service_id: sid, token, token_masked: mask(token), status: 'ACTIVE', created_at: iso(now()) };
      S.tokens.push(row);
      return row;
    }

    const primary = () => S.creds.filter((c) => c.role === 'PRIMARY' && c.status === 'ACTIVE').sort((a, b) => a.id - b.id)[0];

    // ---------- 게이트웨이 중계 ----------
    function deny(status, reason, ip, token) {
      const masked = token ? mask(token) : null;
      S.denied.push({ id: ++seq.denied, at: now(), source_ip: ip, reason, token_masked: masked });
      event('ACCESS_DENIED', `접근 거부(${reason}) ${ip}`, { source_ip: ip, reason, token_masked: masked });
      throw new HttpError(status, { error: reason });
    }

    function gatewayCall({ token = '', ip = '127.0.0.1', model = 'mock', message = '', max_tokens = 300 }) {
      const hk = S.honeykeys.find((h) => h.value === token);
      if (hk) { honeyHit(hk, ip); throw new HttpError(401, { error: 'invalid_token' }); }
      if (!S.cidrs.some((c) => ipIn(ip, c.cidr))) deny(403, 'ip_not_allowed', ip, token);
      let tok = S.tokens.find((x) => x.token === token);
      if (!tok && token.split('.').length === 3 && !token.startsWith('nvm-')) {
        const j = S.jwts[token];
        if (!j) deny(401, 'wif_invalid_signature', ip, 'sub');
        if (j.exp < now()) deny(401, 'wif_expired', ip, j.sub);
        const rule = S.trusted.find((r) => new RegExp('^' + r.subject_pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(j.sub));
        if (!rule) deny(401, 'wif_untrusted_identity', ip, j.sub);
        tok = { status: 'ACTIVE', service_id: rule.service_id };
      }
      if (!tok || tok.status !== 'ACTIVE') deny(401, 'invalid_token', ip, token);
      const svc = S.services.find((s) => s.id === tok.service_id);
      if (!svc || svc.status !== 'ACTIVE') deny(403, 'service_suspended', ip, token);
      const cred = primary();
      if (!cred) throw new HttpError(503, { error: 'no_active_credential' });
      if (provider.call(cred.ref, max_tokens) === 401) throw new HttpError(502, { error: 'upstream_error' });
      const inp = Math.max(8, Math.round(message.length * 0.7));
      S.usage.push({ service_id: svc.id, credential_id: cred.id, model, input_tokens: inp, output_tokens: max_tokens - Math.min(inp, max_tokens - 1), cost_krw: max_tokens * COST_PER_TOKEN, at: now() });
      return {
        id: `chatcmpl-${rnd(10)}`, object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply(message) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: inp, completion_tokens: max_tokens - inp, total_tokens: max_tokens },
      };
    }

    function honeyHit(hk, ip) {
      const t = now();
      const nTok = S.tokens.filter((x) => x.status === 'ACTIVE').length, nSvc = S.services.filter((x) => x.status === 'ACTIVE').length;
      S.tokens.forEach((x) => { x.status = 'REVOKED'; });
      S.services.forEach((x) => { x.status = 'SUSPENDED'; });
      const msg = `허니키 사용 탐지: ${hk.masked}(${hk.planted_at}) 출발 IP ${ip}`;
      const dup = S.hkEvents.some((e) => e.honeykey_id === hk.id && e.source_ip === ip && e.at > t - 60);
      S.hkEvents.push({ honeykey_id: hk.id, source_ip: ip, at: t });
      let iid = null;
      if (!dup) {
        iid = ++seq.inc;
        S.incidents.push({
          id: iid, trigger_type: 'HONEYKEY', status: 'OPEN', credential_id: null, detected_at: t, blocked_at: t, resolved_at: null,
          loss_calls: null, limit_calls: null, loss_krw: null, limit_krw: null, new_credential_id: null,
          timeline: [{ at: iso(t), step: 'DETECTED', ok: true, detail: msg }, { at: iso(t), step: 'REVOKE_ALL_TOKENS', ok: true, detail: `전체 API 토큰 ${nTok}개 폐기` }, { at: iso(t), step: 'SUSPEND_SERVICES', ok: true, detail: `서비스 ${nSvc}개 일시 정지` }, { at: iso(t), step: 'NOTIFY_ADMIN', ok: true, detail: '관리자 통보. 토큰 재발급·서비스 재개는 관리자가 수동으로' }],
        });
      }
      event('HONEYKEY', msg, { honeykey_id: hk.id, planted_at: hk.planted_at, source_ip: ip, incident_id: iid });
    }

    // ---------- 탐지 워커 ----------
    function gwCount(cid, until) {
      return S.usage.filter((u) => u.credential_id === cid && (until == null || u.at <= until)).length;
    }
    function gwCost(cid) { return S.usage.filter((u) => u.credential_id === cid).reduce((a, u) => a + u.cost_krw, 0); }

    function tick() {
      const t = now();
      S.updatedAt = t;
      const s = S.settings, th = thresholds(s);
      for (const cred of S.creds.filter((c) => c.status === 'ACTIVE')) {
        const u = provider.usage(cred.ref, t);
        S.snaps.push({ credential_id: cred.id, at: t, requests: u.requests, cost_krw: u.cost_krw });
        const gc = gwCount(cred.id, t - LAG_S);
        const diff = Math.max(0, u.requests - gc - TOL);
        const certain = Math.max(0, u.requests - gwCount(cred.id) - TOL);
        const d = Math.max(diff, certain);
        const value = measure(s, d, u.requests);
        S.view[cred.id] = { gateway_calls: gc, provider_calls: u.requests, diff_calls: diff, certain_diff_calls: certain, calls_estimated: false, value };
        const level = judge(value, th);
        const j = (S.judged[cred.id] ||= { level: 'NORMAL', low: null });
        if (ORDER.indexOf(level) > ORDER.indexOf(j.level)) { // 상승은 즉시
          j.level = level; j.low = null;
          const what = s.detection_mode === 'calls' ? `${d}건` : `${d}건 (공급자 보고의 ${fmtMeasure(s, value)})`;
          if (level === 'SUSPECT') event('SUSPECT', `${cred.masked} 설명되지 않는 호출 ${what}`, { credential_id: cred.id, diff_calls: d });
          if (level === 'WARNING') event('WARNING', `${cred.masked} 경고: 설명되지 않는 호출 ${what}`, { credential_id: cred.id, diff_calls: d });
          if (level === 'BREACH') respond(cred, d, value);
        } else if (level !== j.level) { // 하강은 HYST_S 동안 유지될 때만
          j.low ??= t;
          if (t - j.low >= HYST_S) { j.level = level; j.low = null; }
        } else {
          j.low = null;
        }
      }
    }

    function respond(cred, diff, value) {
      const t = now();
      provider.revoked.add(cred.ref);
      cred.status = 'REVOKED';
      const sb = S.creds.filter((c) => c.role === 'STANDBY' && c.status === 'ACTIVE').sort((a, b) => a.id - b.id)[0];
      if (sb) { sb.role = 'PRIMARY'; cred.replaced_by_id = sb.id; }
      const iid = ++seq.inc;
      const s = S.settings, block = thresholds(s)[2], limKrw = s.loss_limit_krw;
      const blockLabel = s.detection_mode === 'calls' ? `${block}건` : `공급자 보고의 ${block}%`;
      const inc = {
        id: iid, trigger_type: 'RECONCILIATION', status: 'OPEN', credential_id: cred.id, detected_at: t, blocked_at: t, resolved_at: null,
        loss_calls: diff, limit_calls: null, block_label: blockLabel, loss_krw: Math.max(0, provider.usage(cred.ref, t).cost_krw - gwCost(cred.id)), limit_krw: limKrw,
        new_credential_id: sb ? sb.id : null,
        timeline: [
          { at: iso(t), step: 'DETECTED', ok: true, detail: s.detection_mode === 'calls' ? `설명되지 않는 호출 ${diff}건 ≥ 차단선 ${blockLabel}` : `설명되지 않는 호출 ${diff}건, 공급자 보고의 ${fmtMeasure(s, value)} ≥ 차단선 ${block}%` },
          { at: iso(t), step: 'REVOKE_PROVIDER_KEY', ok: true, detail: `${cred.masked} 공급자에서 폐기` },
        ],
      };
      S.incidents.push(inc);
      event('BLOCKED', `${cred.masked} 자동 차단: 설명되지 않는 호출 ${diff}건`, { incident_id: iid, credential_id: cred.id });
      const add = (step, ok, detail) => inc.timeline.push({ at: iso(now()), step, ok, detail });
      later(1000, () => {
        if (!sb) { add('PROMOTE_STANDBY', false, '예비 키 없음 — 서비스 중단'); return; }
        inc.status = 'ROTATED';
        add('PROMOTE_STANDBY', true, `${sb.masked} 주 키로 승격`);
      });
      later(2000, () => sb && add('NOTIFY_ADMIN', true, '관리자 대시보드 통보'));
      later(2500, () => { // 폐기 후 공급자 최종 호출 수로 손실 재계산
        const u = provider.usage(cred.ref, now() + LAG_S);
        inc.loss_calls = Math.max(0, u.requests - gwCount(cred.id));
        inc.loss_krw = Math.max(0, u.cost_krw - gwCost(cred.id));
      });
      later(3000, () => {
        if (!sb) return;
        const ok = provider.call(sb.ref, 1) === 200;
        add('VERIFIED', ok, ok ? '승격 키로 호출 성공 확인' : '승격 키 호출 실패');
        if (ok) { inc.status = 'RESOLVED'; inc.resolved_at = now(); event('RECOVERED', `${sb.masked}로 전환 완료, 서비스 정상`, { incident_id: iid }); }
      });
    }

    // ---------- 공격 시뮬레이터 ----------
    let attackTimer = null;
    function attackStart() {
      if (attackTimer) return;
      const cred = primary();
      if (!cred) return;
      S.attack = true;
      event('ATTACK_STARTED', `유출 키로 Mock 직접 호출 시작 (${ATTACK_RPS}건/초)`);
      attackTimer = setInterval(() => {
        if (provider.call(cred.ref, ATTACK_TOKENS) === 401) attackStop(`${cred.masked} 401(폐기됨)`);
      }, 1000 / ATTACK_RPS);
    }
    function attackStop(reason) {
      if (!attackTimer) return false;
      clearInterval(attackTimer); attackTimer = null; S.attack = false;
      event('ATTACK_STOPPED', `공격 종료: ${reason}`);
      return true;
    }

    // ---------- 조회 ----------
    function dashboard() {
      const lim = S.settings.unauthorized_call_limit, limKrw = S.settings.loss_limit_krw;
      let worst = 'NORMAL';
      const tot = { g: 0, p: 0, gc: 0, pc: 0, dc: 0, cc: 0 };
      const rows = S.creds.map((c) => {
        const g = gwCost(c.id);
        const last = [...S.snaps].reverse().find((s) => s.credential_id === c.id);
        const p = last ? last.cost_krw : 0;
        const a = S.view[c.id] || {};
        const gc = a.gateway_calls || 0, pc = a.provider_calls || 0, dc = a.diff_calls || 0, cc = a.certain_diff_calls || 0;
        tot.g += g; tot.p += p; tot.gc += gc; tot.pc += pc; tot.dc += dc; tot.cc += cc;
        if (c.status === 'ACTIVE') { const j = (S.judged[c.id] || { level: 'NORMAL' }).level; if (ORDER.indexOf(j) > ORDER.indexOf(worst)) worst = j; }
        return {
          id: c.id, provider: c.provider, auth_mode: c.auth_mode, role: c.role, status: c.status, masked: c.masked,
          gateway_cost_krw: g, provider_cost_krw: p, diff_krw: Math.max(0, p - g - 5000), diff_usd: Math.max(0, p - g) / USD_TO_KRW,
          gateway_calls: gc, provider_calls: pc, diff_calls: dc, certain_diff_calls: cc, calls_estimated: false, value: a.value || 0, name: c.name || null,
        };
      });
      const inc = [...S.incidents].reverse().find((i) => i.trigger_type !== 'HONEYKEY');
      let status = worst === 'BREACH' ? 'WARNING' : worst;
      if (inc && inc.status !== 'RESOLVED') status = 'BLOCKED';
      else if (inc && now() - inc.resolved_at < RECOVERED_HOLD_S) status = 'RECOVERED';
      const act = primary();
      // 지금 판정 기준과 활성 키 중 가장 나쁜 값. 화면은 이것 하나로 막대·차단선·단위를 그린다
      const s = S.settings, [suspect, warn, block] = thresholds(s);
      const live = S.creds.filter((c) => c.status === 'ACTIVE').map((c) => S.view[c.id] || {});
      const top = live.reduce((a, v) => ((v.value || 0) > (a.value || 0) ? v : a), (act && S.view[act.id]) || {}); // 모두 0이면 주 키 숫자
      const detection = {
        mode: s.detection_mode, unit: s.detection_mode === 'calls' ? '건' : '%', suspect, warn, block,
        value: top.value || 0, diff_calls: Math.max(top.diff_calls || 0, top.certain_diff_calls || 0), provider_calls: top.provider_calls || 0, tolerance_calls: TOL,
      };
      return {
        status, detection, limit_krw: limKrw, warn_at_krw: limKrw * RATIOS[1], block_at_krw: limKrw * RATIOS[2],
        diff_krw: Math.max(0, tot.p - tot.g - 5000), diff_usd: Math.max(0, tot.p - tot.g) / USD_TO_KRW,
        gateway_cost_krw: tot.g, provider_cost_krw: tot.p,
        limit_calls: lim, warn_at_calls: lim * RATIOS[1], block_at_calls: lim * RATIOS[2],
        diff_calls: tot.dc, certain_diff_calls: tot.cc, gateway_calls: tot.gc, provider_calls: tot.pc,
        active_credential: act ? { id: act.id, provider: act.provider, auth_mode: act.auth_mode, masked: act.masked } : null,
        credentials: rows, attack_running: S.attack,
        incident_id: inc && ['BLOCKED', 'RECOVERED'].includes(status) ? inc.id : null,
        updated_at: iso(S.updatedAt),
        honeykey_hits: S.hkEvents.slice(-5).reverse().map((e) => { const h = S.honeykeys.find((x) => x.id === e.honeykey_id); return { at: iso(e.at), honeykey_masked: h.masked, planted_at: h.planted_at, source_ip: e.source_ip }; }),
        blocked_ips: Object.entries(S.blockedIps).filter(([, u]) => u > now()).map(([source_ip, u]) => ({ source_ip, until: iso(u) })),
      };
    }

    function timeseries(range = 300) {
      const t1 = now(), t0 = Math.max(t1 - range, S.t0 - 4); // 방금 시작한 세계는 시작 시점부터 그린다
      const pts = [];
      for (let t = t0 - (t0 % 2); t <= t1 + 2; t += 2) {
        const last = {};
        for (const s of S.snaps) if (s.at <= t) last[s.credential_id] = s;
        const ul = S.usage.filter((u) => u.at <= t);
        pts.push({
          t: iso(t), gateway_calls: ul.length, gateway_krw: ul.reduce((a, u) => a + u.cost_krw, 0),
          provider_calls: Object.values(last).reduce((a, s) => a + s.requests, 0), provider_krw: Object.values(last).reduce((a, s) => a + s.cost_krw, 0),
        });
      }
      return { points: pts };
    }

    function incidentJson(i) {
      const m = (id) => (S.creds.find((c) => c.id === id) || {}).masked || null;
      return {
        id: i.id, trigger_type: i.trigger_type, status: i.status, credential_id: i.credential_id, calls_estimated: false,
        credential_masked: m(i.credential_id), detected_at: iso(i.detected_at), blocked_at: iso(i.blocked_at), resolved_at: iso(i.resolved_at),
        duration_s: i.blocked_at ? Math.round((i.blocked_at - i.detected_at) * 1000) / 1000 : null,
        loss_krw: i.loss_krw, limit_krw: i.limit_krw, loss_calls: i.loss_calls, limit_calls: i.limit_calls, block_label: i.block_label || null,
        new_credential_id: i.new_credential_id, new_credential_masked: m(i.new_credential_id), timeline: i.timeline,
      };
    }

    // ---------- 사용량 집계·예측 (H절) ----------
    function rangeStart(range) {
      const d = new Date();
      if (range === 'day') { d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
      if (range === 'week') return now() - 7 * 86400;
      if (range === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
      return 0;
    }
    const est = (inp, out) => (inp * PRICE.in + out * PRICE.out) / 1e6 * USD_TO_KRW;
    const zero = () => ({ calls: 0, input_tokens: 0, output_tokens: 0, cost_krw: 0, estimated_cost_krw: 0 });
    const addTo = (a, u) => { a.calls++; a.input_tokens += u.input_tokens; a.output_tokens += u.output_tokens; a.cost_krw += u.cost_krw; a.estimated_cost_krw += est(u.input_tokens, u.output_tokens); };

    function usageSummary(range = 'day') {
      const since = rangeStart(range);
      const total = zero(), svcs = {};
      for (const u of S.usage.filter((x) => x.at >= since)) {
        const s = S.services.find((x) => x.id === u.service_id) || { name: '?' };
        const sv = (svcs[u.service_id] ||= { service_id: u.service_id, name: s.name, ...zero(), models: {} });
        const md = (sv.models[u.model] ||= { model: u.model, ...zero(), estimated: true });
        addTo(total, u); addTo(sv, u); addTo(md, u);
      }
      return {
        range, from: iso(since), to: iso(now()), total,
        services: Object.values(svcs).map((s) => ({ ...s, models: Object.values(s.models) })),
      };
    }

    function usageTimeseries(range, bucket) {
      const since = rangeStart(range);
      const pad = (v) => String(v).padStart(2, '0');
      const key = (at) => { const d = new Date(at * 1000); const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; return bucket === 'day' ? day : `${day}T${pad(d.getHours())}:00`; };
      const svcs = {};
      for (const u of S.usage.filter((x) => x.at >= since)) {
        const s = (svcs[u.service_id] ||= { service_id: u.service_id, name: (S.services.find((x) => x.id === u.service_id) || {}).name, pts: {} });
        const p = (s.pts[key(u.at)] ||= { t: key(u.at), calls: 0, tokens: 0, cost_krw: 0 });
        p.calls++; p.tokens += u.input_tokens + u.output_tokens; p.cost_krw += u.cost_krw;
      }
      return { range, bucket, from: iso(since), to: iso(now()), services: Object.values(svcs).map((s) => ({ service_id: s.service_id, name: s.name, points: Object.values(s.pts).sort((a, b) => a.t.localeCompare(b.t)) })) };
    }

    function usageForecast(windowHours = 1) {
      const t = now(), w = windowHours * 3600;
      const recent = S.usage.filter((u) => u.at >= t - w);
      // 시뮬레이션은 방금 시작했으므로 실제 경과 시간으로 속도를 잡는다(창이 비면 0)
      const span = Math.max(60, Math.min(w, t - (S.usage[0] ? S.usage[0].at : t)));
      const rate = { calls: recent.length / span * 3600, tokens: recent.reduce((a, u) => a + u.input_tokens + u.output_tokens, 0) / span * 3600, cost_krw: recent.reduce((a, u) => a + u.cost_krw, 0) / span * 3600 };
      const day = rangeStart('day'), month = rangeStart('month');
      const spent = (since) => S.usage.filter((u) => u.at >= since).reduce((a, u) => a + u.cost_krw, 0);
      const endDay = day + 86400;
      const d = new Date(); const endMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000;
      const monthSpent = spent(month);
      const b = S.budget;
      const per = {};
      for (const u of recent) (per[u.service_id] ||= { service_id: u.service_id, name: (S.services.find((s) => s.id === u.service_id) || {}).name, c: 0 }).c += u.cost_krw;
      return {
        window_hours: windowHours, rate_per_hour: rate,
        projected: { end_of_day_cost_krw: spent(day) + rate.cost_krw * (endDay - t) / 3600, end_of_month_cost_krw: monthSpent + rate.cost_krw * (endMonth - t) / 3600 },
        per_service: Object.values(per).map((p) => ({ service_id: p.service_id, name: p.name, rate_cost_krw_per_hour: p.c / span * 3600, projected_month_cost_krw: p.c / span * 3600 * (endMonth - t) / 3600 })),
        budget: { monthly_budget_krw: b, hours_to_budget: b == null ? null : rate.cost_krw ? Math.max(0, (b - monthSpent) / rate.cost_krw) : null },
        method: 'linear', note: '최근 창의 시간당 속도가 남은 기간 내내 유지된다고 가정한 단순 선형 추정입니다.',
      };
    }

    // ---------- 공격자 라이브(F절) ----------
    const live = { calls: 0, ips: new Set() };
    function liveChat({ key, message, ip = 'me' }) {
      live.ips.add(ip);
      if (provider.call(key === LEAKED_KEY ? LEAKED_KEY : key, 150) === 401) throw new HttpError(401, { error: 'revoked' });
      live.calls++;
      return { reply: reply(message), status: 200 };
    }

    function reply(msg) {
      const m = (msg || '').trim();
      const bank = [
        '네, 요청하신 내용을 정리해 드릴게요. 핵심은 세 가지예요.',
        '좋은 질문이에요! 간단히 말하면, 상황에 따라 다르지만 보통은 이렇게 해요.',
        '알겠습니다. 요약하면 다음과 같아요: 먼저 목표를 정하고, 그다음 작게 시작하세요.',
        '이건 데모용 모의 응답이에요. 실제 공급자를 연결하면 진짜 답변이 와요.',
      ];
      if (/안녕|hi|hello/i.test(m)) return '안녕하세요! 무엇을 도와드릴까요?';
      return bank[(m.length + live.calls) % bank.length];
    }

    // ---------- 라우터: 실서버 경로를 그대로 받는다 ----------
    function route(method, path, body) {
      const [p, q] = path.split('?');
      const qs = new URLSearchParams(q || '');
      const id = (re) => { const m = p.match(re); return m && +m[1]; };
      const need = (cond, status, error) => { if (!cond) throw new HttpError(status, { detail: error }); };

      if (method === 'GET' && p === '/admin/dashboard') return dashboard();
      if (method === 'GET' && p === '/admin/timeseries') return timeseries(+(qs.get('range') || 300));
      if (method === 'GET' && p === '/admin/incidents') return [...S.incidents].reverse().map(incidentJson);
      if (method === 'GET' && id(/^\/admin\/incidents\/(\d+)$/)) { const i = S.incidents.find((x) => x.id === id(/(\d+)$/)); need(i, 404, 'not found'); return incidentJson(i); }
      if (method === 'GET' && p === '/admin/events') { const s = +(qs.get('since_id') || 0); return { events: S.events.filter((e) => e.id > s) }; }
      if (method === 'GET' && p === '/admin/access-denied') return [...S.denied].reverse().slice(0, +(qs.get('limit') || 20)).map((d) => ({ ...d, at: iso(d.at) }));

      if (method === 'GET' && p === '/admin/credentials') return S.creds.map(credOut);
      if (method === 'POST' && p === '/admin/credentials') {
        need(['PRIMARY', 'STANDBY'].includes(body.role), 400, 'invalid provider/role');
        need((body.provider || 'mock') === 'mock', 400, `${body.provider}는 실서버 연결이 필요합니다`);
        if (body.auth_mode === 'API_KEY') need(body.secret, 400, 'API_KEY needs secret');
        else need(body.audience, 400, 'WIF needs audience');
        need(!(body.role === 'PRIMARY' && primary()), 400, 'active PRIMARY already exists');
        const c = { id: ++seq.cred, provider: 'mock', auth_mode: body.auth_mode, role: body.role, status: 'ACTIVE', key: body.secret || null,
          masked: body.auth_mode === 'WIF' ? `wif:${body.audience}` : mask(body.secret), audience: body.audience || null,
          ref: body.auth_mode === 'WIF' ? `wif:${body.audience}` : body.secret, replaced_by_id: null, created_at: iso(now()) };
        S.creds.push(c); return credOut(c);
      }
      if (method === 'DELETE' && id(/^\/admin\/credentials\/(\d+)$/)) { const c = S.creds.find((x) => x.id === id(/(\d+)$/)); if (c) c.status = 'REVOKED'; return { ok: true }; }
      // 공급자 키 발급: 실서버와 같은 경로·응답. 시뮬레이션에서는 공급자에 가지 않고 같은 모양의 키를 만든다
      if (method === 'POST' && /^\/admin\/(openrouter|openai)\/provision$/.test(p)) {
        const prov = p.split('/')[2];
        need(['PRIMARY', 'STANDBY'].includes(body.role) && (body.limit_usd ?? 0.5) > 0, 400, 'invalid role/limit_usd');
        need(!(body.role === 'PRIMARY' && primary()), 400, 'active PRIMARY already exists');
        const key = prov === 'openrouter' ? `sk-or-v1-${rnd(32)}` : `sk-svcacct-${rnd(32)}`;
        const c = { id: ++seq.cred, provider: prov, auth_mode: 'API_KEY', role: body.role, status: 'ACTIVE', key, masked: mask(key), audience: null,
          ref: key, replaced_by_id: null, created_at: iso(now()), name: `november-${(body.name || `${prov}-${seq.cred}`).replace(/^november-/, '')}` };
        S.creds.push(c);
        return { ...credOut(c), ...(body.role === 'PRIMARY' ? { leaked_key: key } : {}) };
      }

      if (method === 'GET' && p === '/admin/settings') return { ...S.settings };
      if (method === 'PUT' && p === '/admin/settings') {
        const next = { ...S.settings };
        for (const [k, v] of Object.entries(body)) {
          if (k === 'detection_mode') { need(['usage_pct', 'calls'].includes(v), 400, 'detection_mode must be usage_pct or calls'); next[k] = v; continue; }
          need(k in next, 400, `unknown setting ${k}`);
          need(Number.isFinite(v) && v > 0, 400, `${k} must be > 0`);
          need(!k.endsWith('_calls') || Number.isInteger(v), 400, `${k} must be an integer`);
          need(!k.endsWith('_pct') || v <= 100, 400, `${k} must be <= 100`);
          next[k] = v;
        }
        need(next.suspect_pct < next.warn_pct && next.warn_pct < next.block_pct, 400, '의심 < 경고 < 차단 순서여야 해요 (%)');
        need(next.suspect_calls < next.warn_calls && next.warn_calls < next.block_calls, 400, '의심 < 경고 < 차단 순서여야 해요 (건)');
        S.settings = next;
        return { ...S.settings };
      }
      if (method === 'GET' && p === '/admin/cidrs') return S.cidrs.map((c) => ({ ...c }));
      if (method === 'POST' && p === '/admin/cidrs') {
        need(/^[\d.]+\/\d{1,2}$|^[0-9a-f:]+\/\d{1,3}$/i.test(body.cidr || ''), 400, 'invalid cidr');
        const c = { id: ++seq.cidr, cidr: body.cidr, label: body.label || 'INTERNAL' }; S.cidrs.push(c); return c;
      }
      if (method === 'DELETE' && id(/^\/admin\/cidrs\/(\d+)$/)) { S.cidrs = S.cidrs.filter((c) => c.id !== id(/(\d+)$/)); return { ok: true }; }
      if (method === 'GET' && p === '/admin/services') return S.services.map((s) => ({ ...s, tokens: S.tokens.filter((t) => t.service_id === s.id).map(({ token, ...t }) => t) }));
      const sus = p.match(/^\/admin\/services\/(\d+)\/(suspend|resume)$/);
      if (method === 'POST' && sus) { const s = S.services.find((x) => x.id === +sus[1]); need(s, 404, 'service not found'); s.status = sus[2] === 'suspend' ? 'SUSPENDED' : 'ACTIVE'; return { id: s.id, status: s.status }; }
      if (method === 'POST' && p === '/admin/tokens') {
        let s = S.services.find((x) => x.name === body.service_name);
        if (!s) { s = { id: ++seq.svc, name: body.service_name, status: 'ACTIVE' }; S.services.push(s); }
        const t = issue(s.id); return { id: t.id, service_id: s.id, token: t.token, token_masked: t.token_masked };
      }
      if (method === 'DELETE' && id(/^\/admin\/tokens\/(\d+)$/)) { const t = S.tokens.find((x) => x.id === id(/(\d+)$/)); if (t) t.status = 'REVOKED'; return { ok: true }; }
      if (method === 'GET' && p === '/admin/honeykeys') return S.honeykeys.map((h) => ({ id: h.id, masked: h.masked, planted_at: h.planted_at, created_at: h.created_at, hits: S.hkEvents.filter((e) => e.honeykey_id === h.id).length }));

      if (method === 'GET' && p === '/admin/trusted-identities') return S.trusted.map((r) => ({ ...r }));
      if (method === 'POST' && p === '/admin/trusted-identities') {
        const s = S.services.find((x) => x.id === body.service_id || x.name === body.service_name); need(s, 404, 'service not found');
        const r = { id: ++seq.ti, issuer: body.issuer, subject_pattern: body.subject_pattern, audience: body.audience || null, service_id: s.id, jwks_uri: body.jwks_uri || null, created_at: iso(now()) };
        S.trusted.push(r); return r;
      }
      if (method === 'DELETE' && id(/^\/admin\/trusted-identities\/(\d+)$/)) { S.trusted = S.trusted.filter((r) => r.id !== id(/(\d+)$/)); return { ok: true }; }
      if (method === 'GET' && p === '/admin/wif/settings') return { wif_audience: S.wifAudience };
      if (method === 'PUT' && p === '/admin/wif/settings') { need(body.wif_audience, 400, 'empty'); S.wifAudience = body.wif_audience; return { wif_audience: S.wifAudience }; }

      if (method === 'GET' && p === '/admin/usage/summary') return usageSummary(qs.get('range') || 'day');
      if (method === 'GET' && p === '/admin/usage/timeseries') return usageTimeseries(qs.get('range') || 'day', qs.get('bucket') || 'hour');
      if (method === 'POST' && /^\/demo\/reset-(openrouter|openai)$/.test(p)) throw new HttpError(400, { detail: '시뮬레이션에서는 실제 공급자 키를 만들 수 없어요. 실서버에서 쓰는 버튼이에요.' });
      if (method === 'POST' && /^\/demo\/cleanup-(openrouter|openai)$/.test(p)) throw new HttpError(400, { detail: '시뮬레이션에는 지울 실제 공급자 키가 없어요. 실서버에서 쓰는 버튼이에요.' });
      if (method === 'GET' && p === '/admin/usage/forecast') return usageForecast(+(qs.get('window_hours') || 1));
      if (method === 'GET' && p === '/admin/usage/budget') return { monthly_budget_krw: S.budget };
      if (method === 'PUT' && p === '/admin/usage/budget') { const b = body.monthly_budget_krw; need(b == null || (Number.isInteger(b) && b > 0), 400, 'invalid'); S.budget = b; return { monthly_budget_krw: b }; }

      if (method === 'POST' && p === '/demo/reset') { attackStop('리셋'); return reset(); }
      if (method === 'POST' && p === '/demo/attack/start') { attackStart(); return { attack_running: S.attack }; }
      if (method === 'POST' && p === '/demo/attack/stop') { attackStop('공격 수동 종료'); return { attack_running: S.attack }; }
      if (method === 'POST' && p === '/demo/honeypot/hit') {
        const hk = S.honeykeys[0]; need(hk, 409, 'honeykey 없음');
        try { gatewayCall({ token: hk.value, ip: '203.0.113.77' }); } catch (e) { return { source_ip: '203.0.113.77', planted_at: hk.planted_at, status_code: e.status, response: e.body }; }
      }
      if (method === 'POST' && p === '/demo/wif/seed') {
        const s = S.services.find((x) => x.name === '직원A'); need(s, 404, '먼저 /demo/reset');
        const issuer = 'http://localhost:8000/idp';
        const r = S.trusted.find((x) => x.issuer === issuer && x.subject_pattern === 'repo:november/*');
        if (r) { r.service_id = s.id; return { ...r }; }
        return route('POST', '/admin/trusted-identities', { issuer, subject_pattern: 'repo:november/*', service_id: s.id });
      }
      if (method === 'POST' && p === '/demo/wif/token') {
        const sub = (body && body.sub) || 'repo:november/app:ref:refs/heads/main';
        const enc = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, '');
        const token = `${enc({ alg: 'RS256', kid: 'local-1' })}.${enc({ sub, aud: S.wifAudience, exp: Math.round(now() + 600) })}.${rnd(43)}`;
        S.jwts[token] = { sub, exp: now() + 600 };
        return { token, expires_in: 600 };
      }
      if (method === 'POST' && p === '/v1/chat/completions') return gatewayCall(body);
      if (method === 'GET' && p === '/live/config') return { key: LEAKED_KEY, model: 'openai/gpt-4o-mini' };
      if (method === 'POST' && p === '/live/chat') return liveChat(body);
      if (method === 'GET' && p === '/live/stats') return { participants: live.ips.size, calls: live.calls, key_status: provider.revoked.has(LEAKED_KEY) ? 'revoked' : 'active', updated_at: Math.round(now()) };
      throw new HttpError(404, { detail: `sim: ${method} ${p} 없음` });
    }

    function credOut(c) {
      return { id: c.id, provider: c.provider, auth_mode: c.auth_mode, role: c.role, status: c.status, masked: c.masked, audience: c.audience, name: c.name || null,
        provider_ref_masked: mask(c.ref), replaced_by_id: c.replaced_by_id, created_at: c.created_at };
    }

    reset();
    setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, POLL_S * 1000);

    return {
      request(method, path, body, headers) {
        // 출발 IP 흉내(DEMO_MODE의 X-Demo-Source-IP)
        if (path.startsWith('/v1/')) body = { ...body, token: (headers.Authorization || '').replace(/^Bearer\s+/i, ''), ip: headers['X-Demo-Source-IP'] || '127.0.0.1', message: ((body.messages || []).slice(-1)[0] || {}).content || '' };
        return clone(route(method, path, body || {}));
      },
      provider, // 공격자 페이지 시뮬레이션용
      LEAKED_KEY,
    };
  }

  global.SimWorld = World;
  global.SimHttpError = HttpError;
})(window);
