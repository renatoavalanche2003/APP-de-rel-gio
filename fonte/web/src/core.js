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

/* Análise do sono: números por noite, padrão do período e dicas priorizadas com mecanismo e referência. */
const Analysis = (() => {
  const REF = {
    watson: { t: 'Watson et al. Sleep 2015 · consenso AASM/SRS', doi: '10.5665/sleep.4716' },
    windred: { t: 'Windred et al. Sleep 2024', doi: '10.1093/sleep/zsad253' },
    qaseem: { t: 'Qaseem et al. Ann Intern Med 2016 · diretriz ACP', doi: '10.7326/M15-2175' },
    drake: { t: 'Drake et al. J Clin Sleep Med 2013', doi: '10.5664/jcsm.3170' },
    ebrahim: { t: 'Ebrahim et al. Alcohol Clin Exp Res 2013', doi: '10.1111/acer.12006' },
    kredlow: { t: 'Kredlow et al. J Behav Med 2015', doi: '10.1007/s10865-015-9617-6' },
    ravesloot: { t: 'Ravesloot et al. Sleep Breath 2013', doi: '10.1007/s11325-012-0683-5' },
    liira: { t: 'Liira et al. Cochrane 2014', doi: '10.1002/14651858.CD009776.pub2' },
    hilditch: { t: 'Hilditch & McHill. Nat Sci Sleep 2019', doi: '10.2147/NSS.S188911' },
    tassi: { t: 'Tassi & Muzet. Sleep Med Rev 2000', doi: '10.1053/smrv.2000.0098' }
  };
  const pad = n => String(n).padStart(2, '0');
  const dur = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h ${pad(r)} min` : `${r} min`; };
  const clock = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const sinceSix = ms => { const d = new Date(ms); return ((d.getHours() * 60 + d.getMinutes()) - 18 * 60 + 1440) % 1440; }; // minutos desde 18:00

  function nightStats(sess, sc) {
    sc = sc || Core.score(sess.epochs, { mode: sess.mode });
    const s = Core.summarize(sess, sc), onset = sess.start + (s.latency || 0) * 60000, end = sess.end;
    const wakeAt = sess.alarm && !sess.example ? Math.min(end, sess.alarm.at) : end;
    return {
      id: sess.id, start: sess.start, end, onset, wakeAt, mode: sess.mode,
      tst: s.tst, inBed: s.inBed, latency: s.latency, eff: s.eff, waso: s.waso,
      W: s.W, L: s.L, D: s.D, R: s.R, gap: s.gap, cycles: s.cyclesDone + (s.lastCycleMin >= 45 ? 1 : 0),
      snore: s.snore, mic: !(sess.sensors && sess.sensors.mic === false), kss: sess.kss || null,
      reason: sess.alarm ? sess.alarm.reason : null, endStage: s.endStage,
      mid: sinceSix((onset + wakeAt) / 2), daySleep: (() => { const h = new Date(onset).getHours(); return h >= 6 && h < 15; })()
    };
  }

  /** nights: estatísticas de noites (mais recente primeiro). focus: a noite do relatório, se houver. */
  function analyze(nights, focus) {
    const N = nights.filter(n => n.mode === 'night' && n.tst >= 60).slice(0, 14), tips = [];
    const last7 = N.slice(0, 7), n = last7.length;
    const avg = k => mean(last7.map(x => x[k]).filter(v => v != null && !isNaN(v)));
    const P = {
      n, tst: avg('tst'), R: avg('R'), D: avg('D'), L: avg('L'), latency: median(last7.map(x => x.latency).filter(v => v != null)),
      eff: avg('eff'), waso: avg('waso'), regularity: n >= 3 ? sd(last7.map(x => x.mid)) : null,
      kss: avg('kss'), snoreNights: last7.filter(x => x.mic && x.snore >= 20).length, micNights: last7.filter(x => x.mic).length,
      wake: n ? median(last7.map(x => sinceSix(x.wakeAt))) : null
    };
    const wakeClock = P.wake != null ? (() => { const m = (P.wake + 18 * 60) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(Math.round(m % 60)); })() : null;
    const bedFor = (wakeMin, needMin) => { const m = ((wakeMin + 18 * 60 - needMin) % 1440 + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(Math.round(m % 60) % 60); };
    const add = (o) => tips.push(o);
    const enough = n >= 3;

    // 1. duração
    if (enough && P.tst < 420) {
      const lat = isNaN(P.latency) ? 15 : Math.min(30, P.latency);
      add({
        id: 'curto', prio: P.tst < 360 ? 1 : 2, level: P.tst < 360 ? 'alerta' : 'atencao',
        title: `Média de ${dur(P.tst)} de sono, abaixo das 7 h recomendadas`,
        why: 'Abaixo de 7 h por noite, a pressão de sono (adenosina) que sobra de um dia se soma à do seguinte, e atenção, humor e metabolismo pioram de forma dose-dependente. O REM se concentra no último terço da noite: encurtar o fim da noite corta justamente ele.',
        do: [wakeClock ? `Para acordar às ${wakeClock} com 7 h 30 min de sono, deite por volta de ${bedFor(P.wake, 450 + lat)}.` : 'Some 7 h 30 min de sono ao tempo que você leva para dormir e conte de trás para frente a partir do horário de acordar.',
             'Antecipe o horário de deitar em 15–30 min por semana, mantendo fixo o de acordar.'],
        ref: [REF.watson]
      });
    }
    // 2. regularidade
    if (n >= 4 && P.regularity > 60) {
      add({
        id: 'irregular', prio: P.regularity > 90 ? 1 : 2, level: 'atencao',
        title: `Seus horários variam cerca de ${Math.round(P.regularity)} min de uma noite para outra`,
        why: 'O relógio central (núcleo supraquiasmático) se acerta pela luz e pela rotina. Mudar o horário todo dia funciona como um jet lag pequeno e repetido. Numa coorte de 60 mil pessoas medidas por acelerômetro, a regularidade previu mortalidade melhor que a duração do sono.',
        do: ['Fixe o horário de acordar, inclusive nas folgas (variação de até 30–60 min).', 'Pegue luz forte logo ao acordar e reduza a luz nas 2 h antes de deitar.'],
        ref: [REF.windred]
      });
    }
    // 3. latência longa
    const latF = focus && focus.latency != null && focus.latency > 45;
    if ((enough && P.latency > 30) || latF) {
      add({
        id: 'latencia', prio: 2, level: 'atencao',
        title: enough && P.latency > 30 ? `Você leva cerca de ${dur(P.latency)} para pegar no sono` : `Nesta noite você levou ${dur(focus.latency)} para pegar no sono`,
        why: 'Ficar acordado na cama ensina o cérebro a associar cama com vigília e mantém o sistema de alerta ligado. A terapia cognitivo-comportamental para insônia (TCC-I) é o tratamento de primeira linha justamente por quebrar essa associação. Cafeína ainda ativa 6 h antes de deitar reduziu o sono de forma mensurável.',
        do: ['Sem sono em uns 20 min, saia da cama, faça algo calmo com pouca luz e volte quando sentir sono.', 'Use a cama só para dormir e mantenha o horário de acordar fixo.', 'Última cafeína pelo menos 6 h antes de deitar.'],
        ref: [REF.qaseem, REF.drake]
      });
    }
    // 4. fragmentação
    const wasoF = focus && focus.waso > 45;
    if ((enough && (P.eff < 0.85 || P.waso > 30)) || wasoF) {
      add({
        id: 'fragmentado', prio: 2, level: 'atencao',
        title: enough && (P.eff < 0.85 || P.waso > 30) ? `Sono interrompido: média de ${dur(P.waso)} acordado depois de dormir` : `Nesta noite você ficou ${dur(focus.waso)} acordado depois de pegar no sono`,
        why: 'Cada despertar reinicia parte do ciclo e reduz o tempo em N3 e REM. Causas frequentes: cafeína tarde, álcool (consolida a primeira metade da noite e fragmenta a segunda), quarto quente ou barulhento e urinar de madrugada. Exercício regular reduz de forma moderada o tempo acordado durante a noite.',
        do: ['Corte cafeína 6 h antes e álcool 3–4 h antes de deitar.', 'Quarto fresco, escuro e silencioso; menos líquido nas 2 h finais.', 'Exercício regular, de preferência terminando algumas horas antes de deitar.'],
        ref: [REF.ebrahim, REF.kredlow]
      });
    }
    // 5. ronco
    if (P.micNights >= 3 && P.snoreNights >= 3) {
      const sn = mean(last7.filter(x => x.mic).map(x => x.snore));
      add({
        id: 'ronco', prio: sn > 60 ? 1 : 3, level: sn > 60 ? 'alerta' : 'atencao',
        title: `Ronco em ${P.snoreNights} de ${P.micNights} noites (média de ${dur(sn)})`,
        why: 'No sono, o tônus dos dilatadores da faringe (como o genioglosso) cai; de barriga para cima, a gravidade leva língua e palato para trás e a via aérea vibra ou colapsa. Álcool reduz ainda mais esse tônus. Em média, 56% das pessoas com apneia obstrutiva têm apneia dependente da posição.',
        do: ['Durma de lado. Um travesseiro nas costas ajuda a não virar.', 'Evite álcool e sedativos à noite.', 'Pausas na respiração percebidas por alguém, engasgos, sonolência de dia ou pressão alta pedem avaliação de apneia (STOP-Bang e polissonografia).'],
        ref: [REF.ravesloot]
      });
    }
    // 6. acordar grogue
    const kssList = last7.filter(x => x.kss);
    const kHigh = kssList.filter(x => x.kss >= 7).length;
    const focusLimit = focus && focus.reason === 'limit';
    if ((kssList.length >= 3 && mean(kssList.map(x => x.kss)) >= 6.5) || (focus && focus.kss >= 7) || focusLimit) {
      const lim = kssList.filter(x => x.reason === 'limit').map(x => x.kss), mov = kssList.filter(x => x.reason === 'move' || x.reason === 'light').map(x => x.kss);
      let title = focusLimit ? 'O alarme tocou no horário limite, sem movimento antes' : `Você tem acordado sonolento (escala de sonolência ≥ 7 em ${kHigh} noites)`;
      if (!focusLimit && focus && focus.kss >= 7) title = `Você acordou bem sonolento (escala de sonolência ${focus.kss}/9)`;
      const extra = lim.length >= 2 && mov.length >= 2 ? ` Nas suas noites, a média foi ${mean(mov).toFixed(1).replace('.', ',')} acordando pelo movimento e ${mean(lim).toFixed(1).replace('.', ',')} pelo limite.` : '';
      add({
        id: 'inercia', prio: focusLimit ? 2 : 3, level: 'atencao', title,
        why: 'Acordar de N3 produz mais inércia do sono que acordar de N1 ou N2; o REM fica no meio. A inércia piora com dívida de sono e quando você acorda perto do vale da temperatura corporal, de madrugada.' + extra,
        do: ['Aumente a janela do alarme para 30–45 min: sobe a chance de pegar um movimento de sono leve.', 'Ao acordar, levante, pegue luz forte e, se quiser, tome a cafeína logo cedo.', 'Se continuar grogue mesmo acordando em sono leve, o problema provável é dormir pouco, não a hora do alarme.'],
        ref: [REF.tassi, REF.hilditch]
      });
    }
    // 7. sono diurno (plantão)
    const day = N.slice(0, 7).filter(x => x.daySleep && x.tst >= 180);
    if (day.length) {
      add({
        id: 'turno', prio: 2, level: 'atencao',
        title: day.length === 1 ? 'Uma das suas noites foi dormida de dia' : `${day.length} das suas últimas noites foram dormidas de dia`,
        why: 'De dia o relógio circadiano trabalha contra o sono: a temperatura e o cortisol sobem e a melatonina fica baixa, então o sono diurno tende a ser mais curto e fragmentado. Em revisão Cochrane, cochilo antes do plantão somado a cafeína reduziu a sonolência no turno; melatonina após o plantão acrescentou cerca de 24 min ao sono diurno, com evidência de baixa qualidade.',
        do: ['Antes de um plantão noturno, cochile de 20 a 90 min no fim da tarde.', 'Na volta, óculos escuros; em casa, quarto totalmente escuro e ruído branco ou protetor auricular.', 'Mantenha um "sono-âncora": um bloco de umas 4 h no mesmo horário todos os dias, de plantão ou de folga.'],
        ref: [REF.liira]
      });
    }
    // 8. tudo certo
    if (enough && !tips.length) {
      add({
        id: 'bom', prio: 4, level: 'ok',
        title: 'Noites dentro do esperado',
        why: `Média de ${dur(P.tst)} de sono${P.regularity != null ? (P.regularity < 15 ? ', horários quase sem variar' : `, horários variando cerca de ${Math.round(P.regularity)} min`) : ''} e pouco tempo acordado durante a noite.`,
        do: ['Mantenha o horário de acordar fixo, inclusive nas folgas: é o que mais protege esse padrão.'],
        ref: [REF.watson, REF.windred]
      });
    }
    tips.sort((a, b) => a.prio - b.prio);

    // fatos da noite em foco
    const facts = [];
    if (focus) {
      const cmp = (v, a, unit) => (n >= 3 && !isNaN(a)) ? ` (sua média: ${unit(a)})` : '';
      facts.push(`Sono total: ${dur(focus.tst)}${cmp(focus.tst, P.tst, dur)}.`);
      if (focus.latency != null) facts.push(`Latência: ${dur(focus.latency)}${n >= 3 && !isNaN(P.latency) ? ` (costuma ser ${dur(P.latency)})` : ''}.`);
      if (focus.R) facts.push(`REM provável: ${dur(focus.R)}${cmp(focus.R, P.R, dur)}; profundo provável: ${dur(focus.D)}${cmp(focus.D, P.D, dur)}.`);
      if (focus.reason === 'move' || focus.reason === 'light') facts.push('O alarme pegou um movimento dentro da janela, como planejado.');
    }
    return { period: P, tips, facts, nights: N.length };
  }

  return { nightStats, analyze, REF, dur, clock };
})();
Core.Analysis = Analysis;

if (typeof module !== 'undefined') module.exports = Core;
