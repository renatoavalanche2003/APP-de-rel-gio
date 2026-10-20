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

  return { EPOCH_S, EPM, T, act, isMove, isTwitch, score, summarize, sampleNight, findOnset, dScores };
})();

if (typeof module !== 'undefined') module.exports = Core;
