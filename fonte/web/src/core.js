/* Maré — núcleo de análise (puro, sem DOM). Testável em Node. */
const Core = (() => {
  const EPOCH_S = 30;
  const EPM = 60 / EPOCH_S; // épocas por minuto

  const T = {
    moveAct: 1.5,     // atividade mínima de uma época para contar como "movimento"
    moveSec: 2,       // ou: nº de segundos com movimento dentro da época
    majorAct: 6,      // mudança de posição (candidata a fronteira de ciclo)
    wakeD: 4,         // escore ponderado acima disso = vigília
    onsetNight: 5 * EPM,
    onsetNap: 3 * EPM,
    deepStill: 10 * EPM,  // imobilidade contínua que separa "leve" de "profundo/REM"
    cycle: 90 * EPM,
    cycleMin: 70 * EPM,
    cycleMax: 120 * EPM,
    actCap: 40
  };

  // Janela ponderada no espírito de Cole-Kripke (1992): passado, presente e um pouco de futuro.
  const W = [[-8, .04], [-7, .04], [-6, .05], [-5, .05], [-4, .06], [-3, .07], [-2, .09],
             [-1, .12], [0, .30], [1, .10], [2, .08], [3, .05], [4, .04]];

  // Propensão a N3 cai e a REM sobe ao longo dos ciclos (índice = ciclo-1).
  const W3 = [1, .75, .4, .15, .05];
  const WR = [.35, .6, .85, 1, 1];

  const act = e => e.gap ? 0 : Math.min(T.actCap, (e.a || 0) + 1.5 * (e.s || 0));
  const isMove = e => !e.gap && (act(e) >= T.moveAct || (e.m || 0) >= T.moveSec);
  const isTwitch = e => !e.gap && !isMove(e) && act(e) > 0.2;
  const g = (p, c, w) => Math.exp(-(((p - c) / w) ** 2));

  function dScores(ep) {
    const n = ep.length, A = ep.map(act), D = new Array(n);
    for (let t = 0; t < n; t++) {
      let d = 0;
      for (const [k, w] of W) {
        const i = t + k;
        if (i >= 0 && i < n) d += w * A[i];
      }
      D[t] = d;
    }
    return D;
  }

  function findOnset(ep, D, need) {
    let run = 0;
    for (let t = 0; t < ep.length; t++) {
      const ok = !ep[t].gap && !isMove(ep[t]) && D[t] < T.wakeD;
      run = ok ? run + 1 : 0;
      if (run >= need) return t - need + 1;
    }
    return -1;
  }

  function cycleBounds(ep, onset) {
    const n = ep.length, bounds = [onset];
    let b = onset;
    for (;;) {
      const lo = b + T.cycleMin, hi = Math.min(n - 1, b + T.cycleMax);
      if (lo >= n) break;
      let best = -1, bestScore = 0;
      for (let i = lo; i <= hi; i++) {
        if (!isMove(ep[i]) || act(ep[i]) < T.majorAct) continue;
        let s = 0;
        for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n) s += act(ep[j]);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best < 0) {
        if (b + T.cycle < n && hi === b + T.cycleMax) best = b + T.cycle; // sem movimento claro: assume 90 min
        else break;
      }
      bounds.push(best);
      b = best;
    }
    return bounds;
  }

  function twitchRate(ep, t) {
    let c = 0, n = 0;
    for (let i = Math.max(0, t - 19); i <= t; i++) { n++; if (isTwitch(ep[i])) c++; }
    return n ? c / n : 0;
  }

  /* Frequência cardíaca (relógio): N3 = FC baixa e estável (predomínio vagal);
     REM = FC mais alta e oscilante (instabilidade autonômica). Normalizada pela própria noite. */
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  function hrFeatures(ep, onset) {
    const n = ep.length;
    if (onset < 0) return null;
    const hr = ep.map(e => (!e.gap && e.hr > 0) ? e.hr : 0);
    let tot = 0, ok = 0;
    for (let t = onset; t < n; t++) if (!ep[t].gap) { tot++; if (hr[t]) ok++; }
    if (!tot || ok / tot < 0.5) return null;
    const V = new Array(n).fill(NaN);
    for (let t = 0; t < n; t++) {
      const v = []; let sdIn = 0;
      for (let i = Math.max(0, t - 5); i <= t; i++) if (hr[i]) { v.push(hr[i]); sdIn += ep[i].hrSd || 0; }
      if (v.length >= 3) {
        const m = v.reduce((a, x) => a + x, 0) / v.length;
        V[t] = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) + 0.5 * sdIn / v.length;
      }
    }
    const hs = [], vs = [];
    for (let t = onset; t < n; t++) if (hr[t] && !isMove(ep[t])) { hs.push(hr[t]); if (!isNaN(V[t])) vs.push(V[t]); }
    if (hs.length < 20) return null;
    const mH = median(hs), sH = Math.max(2, median(hs.map(x => Math.abs(x - mH))) * 1.4826);
    const mV = median(vs), sV = Math.max(0.4, median(vs.map(x => Math.abs(x - mV))) * 1.4826);
    const cl = x => Math.max(-3, Math.min(3, x));
    return { hr, mH, zH: hr.map(x => x ? cl((x - mH) / sH) : 0), zV: V.map(x => isNaN(x) ? 0 : cl((x - mV) / sV)) };
  }

  /** Estágios: W acordado · L leve (N1/N2) · D profundo provável (N3) · R REM provável · ? sem dados */
  function score(ep, opts = {}) {
    const nap = opts.mode === 'nap';
    const n = ep.length;
    const D = dScores(ep);
    const onset = findOnset(ep, D, nap ? T.onsetNap : T.onsetNight);
    const S = new Array(n);
    let run = 0;
    for (let t = 0; t < n; t++) { run = (ep[t].gap || isMove(ep[t])) ? 0 : run + 1; S[t] = run; }
    const bounds = onset >= 0 ? cycleBounds(ep, onset) : [];
    const F = hrFeatures(ep, onset);
    const still = F ? 8 * EPM : T.deepStill; // com FC dá para decidir um pouco mais cedo
    const stage = new Array(n);
    let k = 0;
    for (let t = 0; t < n; t++) {
      if (ep[t].gap) { stage[t] = '?'; continue; }
      if (onset < 0 || t < onset || D[t] >= T.wakeD) { stage[t] = 'W'; continue; }
      if (S[t] < still) { stage[t] = 'L'; continue; }
      while (k + 1 < bounds.length && bounds[k + 1] <= t) k++;
      const b0 = bounds[k], b1 = bounds[k + 1];
      const len = b1 != null ? (b1 - b0) : Math.max(T.cycle, opts.live ? T.cycle : n - b0);
      const p = Math.min(1, (t - b0) / len);
      const ci = Math.min(W3.length - 1, k);
      const n3 = W3[ci] * g(p, .30, .22);
      const rem = WR[ci] * g(p, .85, .16) + .5 * twitchRate(ep, t);
      if (F && F.hr[t]) {
        // probabilidade a priori (posição no ciclo) × verossimilhança da FC de cada estágio
        const zh = F.zH[t], zv = F.zV[t];
        const lk = (mh, mv) => Math.exp(-((zh - mh) ** 2 + (zv - mv) ** 2) / (2 * 1.2 ** 2));
        const pD = (n3 + .05) * lk(-1.3, -.9), pR = (rem + .05) * lk(1.1, 1.3), pL = .3 * lk(0, -.1);
        stage[t] = pL >= pD && pL >= pR ? 'L' : (pD >= pR ? 'D' : 'R');
        continue;
      }
      stage[t] = Math.max(n3, rem) < .2 ? 'L' : (n3 >= rem ? 'D' : 'R');
    }
    return { D, onset, S, bounds, stage, hasHr: !!F };
  }

  function summarize(sess, sc) {
    const ep = sess.epochs, n = ep.length, min = c => c / EPM;
    const c = { W: 0, L: 0, D: 0, R: 0, '?': 0 };
    for (let t = Math.max(0, sc.onset); t < n; t++) c[sc.stage[t]]++;
    const inBed = (sess.end - sess.start) / 60000;
    const tst = min(c.L + c.D + c.R);
    const last = sc.bounds.length ? sc.bounds[sc.bounds.length - 1] : -1;
    let endStage = null;
    for (let t = n - 1; t >= Math.max(0, n - 3); t--) { if (sc.stage[t] !== '?') { endStage = sc.stage[t]; break; } }
    // FC mínima: menor média móvel de 10 min durante o sono
    let hrMin = null;
    if (sc.hasHr) {
      for (let t = Math.max(0, sc.onset); t + 20 <= n; t++) {
        let s = 0, c = 0;
        for (let i = t; i < t + 20; i++) if (ep[i].hr > 0 && sc.stage[i] !== 'W') { s += ep[i].hr; c++; }
        if (c >= 15) { const m = s / c; if (hrMin == null || m < hrMin) hrMin = m; }
      }
    }
    return {
      hrMin,
      inBed, tst,
      latency: sc.onset >= 0 ? sc.onset / EPM : null,
      waso: sc.onset >= 0 ? min(c.W) : 0,
      eff: inBed > 0 ? Math.min(1, tst / inBed) : 0,
      W: min(c.W), L: min(c.L), D: min(c.D), R: min(c.R), gap: min(c['?']),
      cyclesDone: Math.max(0, sc.bounds.length - 1),
      lastCycleMin: last >= 0 ? (n - last) / EPM : 0,
      snore: min(ep.filter(e => e.snore).length),
      moves: ep.filter(isMove).length,
      endStage
    };
  }

  /* ---------- noite de exemplo (determinística) ---------- */
  function prng(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function sampleNight(baseDate = new Date()) {
    const r = prng(19);
    const U = (a, b) => a + (b - a) * r();
    const d = new Date(baseDate); d.setHours(23, 20, 0, 0); d.setDate(d.getDate() - 1);
    const start = d.getTime();
    // roteiro "verdadeiro" (para testar o classificador)
    const plan = [['W', 14]];
    const cyc = [
      { n2a: 12, n3: 44, n2b: 22, rem: 10 },
      { n2a: 14, n3: 30, n2b: 32, rem: 20 },
      { n2a: 20, n3: 12, n2b: 34, rem: 26, wakeAfter: 3 },
      { n2a: 26, n3: 4, n2b: 30, rem: 30 },
      { n2a: 22, n3: 0, n2b: 24, rem: 10 }
    ];
    cyc.forEach((c, i) => {
      plan.push(['N2', c.n2a, i]);
      if (c.n3) plan.push(['N3', c.n3, i]);
      plan.push(['N2', c.n2b, i]);
      plan.push(['REM', c.rem, i]);
      if (i < cyc.length - 1) plan.push(['MOVE', 0.5, i]);
      if (c.wakeAfter) plan.push(['W', c.wakeAfter, i]);
    });
    const ep = [], truth = [];
    for (const [st, mins, ci] of plan) {
      const k = Math.round(mins * EPM);
      for (let j = 0; j < k; j++) {
        const e = { a: 0, m: 0, s: 0, snore: false };
        if (st === 'W') {
          if (r() < .65) { e.a = U(3, 12); e.m = Math.round(U(3, 9)); } else e.a = U(0, .8);
          if (r() < .3) e.s = 1;
        } else if (st === 'MOVE') {
          e.a = U(15, 28); e.m = Math.round(U(7, 13)); e.s = 1;
        } else if (st === 'N2') {
          const x = r();
          if (x < .035) { e.a = U(2, 5); e.m = 2 + Math.round(r()); } else if (x < .11) e.a = U(.25, 1);
          if (ci < 2 && r() < .6) e.snore = true;
        } else if (st === 'N3') {
          if (r() < .02) e.a = U(.25, .8);
          if (ci < 2 && r() < .75) e.snore = true;
        } else if (st === 'REM') {
          const x = r();
          if (x < .02) { e.a = U(2, 3.5); e.m = 2; } else if (x < .3) e.a = U(.3, 1.2);
        }
        e.a = Math.round(e.a * 10) / 10;
        ep.push(e);
        truth.push(st === 'N2' ? 'L' : st === 'N3' ? 'D' : st === 'REM' ? 'R' : 'W');
      }
    }
    // despertar: movimento em sono leve dentro da janela (06:30–07:00)
    const end = start + ep.length * EPOCH_S * 1000;
    const wakeBy = new Date(d); wakeBy.setDate(wakeBy.getDate() + 1); wakeBy.setHours(7, 0, 0, 0);
    ep[ep.length - 1].a = 9.5; ep[ep.length - 1].m = 6;
    return {
      id: 'exemplo', example: true, mode: 'night', start, end,
      wakeBy: wakeBy.getTime(), windowMin: 30,
      alarm: { at: end, reason: 'move' }, kss: 4, epochs: ep, truth
    };
  }

  /* ---------- relógio: protocolo Bluetooth (espelha Codec.java) ---------- */
  const WATCH = {
    SVC: '4d415245-0000-4b1c-8f0a-5c3e9d7a1b20',
    CTRL: '4d415245-0001-4b1c-8f0a-5c3e9d7a1b20',
    DATA: '4d415245-0002-4b1c-8f0a-5c3e9d7a1b20',
    REC: 6, PER_CHUNK: 80
  };
  function decodeWatch(bytes) {
    const out = [];
    for (let i = 0; i + WATCH.REC <= bytes.length; i += WATCH.REC) {
      const fl = bytes[i + 5];
      out.push({
        a: (bytes[i] | (bytes[i + 1] << 8)) / 10, m: bytes[i + 2], s: 0, snore: false,
        hr: bytes[i + 3], hrSd: bytes[i + 4] / 10, gap: !!(fl & 1)
      });
    }
    return out;
  }
  function fromWatch(meta, epochs) {
    const s = {
      id: meta.id, source: 'watch', mode: meta.mode, start: meta.start, end: meta.end,
      epochs: epochs.slice(0, meta.n), sensors: { motion: true, mic: false, hr: true }, snoozes: meta.sz || 0
    };
    if (meta.mode === 'night') { s.wakeBy = meta.wakeBy; s.windowMin = meta.win; } else s.napMin = meta.nap;
    if (meta.alarmAt) s.alarm = { at: meta.alarmAt, reason: meta.reason };
    return s;
  }
  const u32le = x => [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255];
  const cmd = {
    list: () => [1], meta: i => [2, i], chunk: (i, k) => [3, i, k & 255, (k >> 8) & 255],
    night: (wakeByMs, win) => [4, ...u32le(Math.floor(wakeByMs / 1000)), win], nap: min => [5, min], stop: () => [6]
  };

  return { EPOCH_S, EPM, T, act, isMove, isTwitch, score, summarize, sampleNight, findOnset, dScores, WATCH, decodeWatch, fromWatch, cmd };
})();

/* Samsung Health — lê a exportação de dados pessoais (zip ou CSV/JSON soltos). */
const SH = (() => {
  const STAGE = { 40001: 'W', 40002: 'L', 40003: 'D', 40004: 'R', awake: 'W', wake: 'W', light: 'L', deep: 'D', rem: 'R' };
  const MIN = 60000;
  const base = n => n.split(/[\\/]/).pop().toLowerCase();

  /* ---------- zip (com zip64) usando DecompressionStream ---------- */
  async function inflateRaw(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  function unzip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), td = new TextDecoder();
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip');
    let count = dv.getUint16(eocd + 10, true), cd = dv.getUint32(eocd + 16, true);
    if ((count === 0xffff || cd === 0xffffffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
      const z = Number(dv.getBigUint64(eocd - 12, true));
      if (dv.getUint32(z, true) === 0x06064b50) { count = Number(dv.getBigUint64(z + 32, true)); cd = Number(dv.getBigUint64(z + 48, true)); }
    }
    const out = [];
    let p = cd;
    for (let k = 0; k < count && p + 46 <= buf.length; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      let cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true), lho = dv.getUint32(p + 42, true);
      const name = td.decode(buf.subarray(p + 46, p + 46 + nl));
      for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) { // campo extra zip64
        const id = dv.getUint16(x, true), sz = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (us === 0xffffffff) { us = Number(dv.getBigUint64(q, true)); q += 8; }
          if (cs === 0xffffffff) { cs = Number(dv.getBigUint64(q, true)); q += 8; }
          if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true));
        }
        x += 4 + sz;
      }
      if (!name.endsWith('/')) out.push({
        name,
        async bytes() {
          const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true), d = buf.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + cs);
          if (method === 0) return d;
          if (method === 8) return inflateRaw(d);
          throw new Error('compressão');
        }
      });
      p += 46 + nl + xl + cl;
    }
    return out;
  }

  /* ---------- CSV / JSON → linhas ---------- */
  function csv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    let h = rows.findIndex(r => r.some(x => x.trim()));
    if (h < 0) return [];
    if (/^com\.samsung\./i.test(rows[h][0] || '') && /^\d+$/.test((rows[h][1] || '').trim())) h++; // preâmbulo
    const head = (rows[h] || []).map(k => k.trim().split('.').pop().toLowerCase());
    return rows.slice(h + 1).filter(r => r.some(x => x.trim())).map(r => {
      const o = {}; head.forEach((k, i) => { if (k && r[i] != null && r[i] !== '' && o[k] == null) o[k] = r[i].trim(); }); return o;
    });
  }
  function jsonRows(text) {
    let j; try { j = JSON.parse(text); } catch (e) { return []; }
    if (j && !Array.isArray(j)) j = j.data || j.records || Object.values(j).find(Array.isArray) || [];
    return (Array.isArray(j) ? j : []).filter(o => o && typeof o === 'object').map(o => {
      const r = {}; for (const k in o) r[k.split('.').pop().toLowerCase()] = o[k]; return r;
    });
  }

  /* ---------- horários ---------- */
  function offMin(s) { // "UTC-0400" -> -240
    const m = /UTC([+-])(\d{1,2}):?(\d{2})?/i.exec(String(s || ''));
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0)) : null;
  }
  function ts(v, off, mode) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number' || /^\d{9,}(\.\d+)?$/.test(String(v))) { const n = +v; return n > 1e11 ? n : n * 1000; }
    const s = String(v).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /T/.test(s)) return Date.parse(s);
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(s);
    if (!m) return Date.parse(s);
    const u = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3));
    const o = offMin(off);
    if (mode === 'local') return o == null ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : u - o * MIN;
    return u; // padrão do Samsung Health: horário em UTC, fuso em time_offset
  }

  /* ---------- leitura principal ---------- */
  async function read(files, opt = {}) {
    const now = opt.now || Date.now(), days = opt.days || 30, ref = opt.ref || [];
    const items = [];
    for (const f of files) {
      const nm = f.name || '';
      const raw = f.bytes ? await f.bytes() : new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(nm) || (raw[0] === 0x50 && raw[1] === 0x4b)) unzip(raw).forEach(e => items.push(e));
      else items.push({ name: nm, bytes: async () => raw });
    }
    const td = new TextDecoder();
    const rowsOf = async e => { const t = td.decode(await e.bytes()); return /\.json$/i.test(e.name) ? jsonRows(t) : csv(t); };
    const stageRows = [], hrRows = [], binIdx = new Map();
    for (const e of items) {
      const b = base(e.name);
      if (!/\.(csv|json)$/.test(b)) continue;
      if (b.includes('heart_rate') && b.includes('binning')) { binIdx.set(b, e); continue; }
      if (b.includes('sleep_stage')) (await rowsOf(e)).forEach(r => stageRows.push(r));
      else if (b.includes('heart_rate') && !/resting|hrv|variability|_summary/.test(b)) (await rowsOf(e)).forEach(r => hrRows.push(r));
    }
    if (!stageRows.length) return { nights: [], mode: null, found: { stages: 0, hr: hrRows.length, bins: binIdx.size } };

    const binFor = r => {
      const v = r.binning_data ? base(String(r.binning_data)) : '';
      if (v && binIdx.has(v)) return binIdx.get(v);
      const id = String(r.datauuid || '').toLowerCase();
      if (id) for (const [k, e] of binIdx) if (k.startsWith(id)) return e;
      return null;
    };
    const readBin = async e => jsonRows(td.decode(await e.bytes()))
      .map(o => [+o.start_time, +o.heart_rate]).filter(x => x[0] > 1e11 && x[1] >= 30 && x[1] <= 220);

    // decide se os horários do CSV estão em UTC ou em hora local
    let mode = null;
    const withBin = hrRows.filter(r => r.start_time && binFor(r)).slice(0, 12);
    let vu = 0, vl = 0;
    for (const r of withBin) {
      const b = await readBin(binFor(r)); if (!b.length) continue;
      const t0 = Math.min(...b.map(x => x[0]));
      if (Math.abs(ts(r.start_time, r.time_offset, 'utc') - t0) <= 2 * MIN) vu++;
      else if (Math.abs(ts(r.start_time, r.time_offset, 'local') - t0) <= 2 * MIN) vl++;
    }
    if (vu || vl) mode = vu >= vl ? 'utc' : 'local';
    const segsFor = md => stageRows.map(r => ({
      s: ts(r.start_time, r.time_offset, md), e: ts(r.end_time, r.time_offset, md),
      st: STAGE[String(r.stage != null ? r.stage : r.sleep_stage).toLowerCase()], sid: r.sleep_id || ''
    })).filter(x => x.st && x.e > x.s && x.e - x.s < 6 * 3600000);
    if (!mode) {
      const score = md => {
        const sg = segsFor(md); let ov = 0, night = 0, tot = 0;
        for (const x of sg) {
          for (const r of ref) ov += Math.max(0, Math.min(x.e, r.end) - Math.max(x.s, r.start));
          const h = new Date((x.s + x.e) / 2).getHours(), d = x.e - x.s; tot += d; if (h >= 20 || h < 10) night += d;
        }
        return ov / MIN + (tot ? night / tot : 0);
      };
      mode = score('local') > score('utc') + 1e-9 ? 'local' : 'utc';
    }

    // agrupa em noites
    const segs = segsFor(mode).sort((a, b) => a.s - b.s);
    const groups = [];
    for (const x of segs) {
      const g = groups[groups.length - 1];
      if (g && ((x.sid && x.sid === g.sid) || x.s - g.end <= 90 * MIN)) { g.stages.push(x); g.end = Math.max(g.end, x.e); }
      else groups.push({ sid: x.sid, start: x.s, end: x.e, stages: [x] });
    }
    const nights = groups.filter(g => g.end > now - days * 86400000 && g.end - g.start >= 20 * MIN);

    // frequência cardíaca de cada noite
    let perMinute = false;
    for (const n of nights) {
      const lo = n.start - 15 * MIN, hi = n.end + 15 * MIN, hr = [];
      for (const r of hrRows) {
        const s = ts(r.start_time, r.time_offset, mode), e = ts(r.end_time, r.time_offset, mode) || s;
        if (!(e >= lo && s <= hi)) continue;
        const be = binFor(r);
        const b = be ? await readBin(be) : [];
        if (b.length) { perMinute = true; b.forEach(x => { if (x[0] >= lo && x[0] <= hi) hr.push(x); }); }
        else { const v = +(r.heart_rate != null ? r.heart_rate : r.value); if (v >= 30 && v <= 220) hr.push([s, v]); }
      }
      hr.sort((a, b) => a[0] - b[0]);
      n.hr = hr.filter((x, i) => !i || x[0] - hr[i - 1][0] >= 20000); // sem duplicatas
      n.stages = n.stages.map(x => ({ s: x.s, e: x.e, st: x.st }));
      delete n.sid;
    }
    return { nights, mode, perMinute, found: { stages: stageRows.length, hr: hrRows.length, bins: binIdx.size } };
  }

  function stageAt(stages, t) {
    let best = null, dist = Infinity;
    for (const x of stages) {
      if (t >= x.s && t < x.e) return x.st;
      const d = Math.min(Math.abs(t - x.s), Math.abs(t - x.e));
      if (d < dist) { dist = d; best = x.st; }
    }
    return dist <= 3 * MIN ? best : null;
  }

  return { read, stageAt, unzip, csv, ts };
})();
Core.SH = SH;

if (typeof module !== 'undefined') module.exports = Core;
