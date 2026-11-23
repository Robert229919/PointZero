// 02 Diagnostic — guided drift measurement: rest noise, return-to-centre spread, amplitude, verdict.
import { send } from '../bridge.js';
import { S, sub, setStick, stickSource } from '../state.js';
import { h, setText, setClass, segmented, button } from '../ui.js';
import { Scope, C, rgba } from '../scope.js';
import { captureRest } from '../capture.js';
import { fr, pct, clamp, minEnclosingCircle, restStats } from '../math.js';

const DIRS = [
  ['HAUT', 90], ['HAUT-DROITE', 45], ['DROITE', 0], ['BAS-DROITE', -45],
  ['BAS', -90], ['BAS-GAUCHE', -135], ['GAUCHE', 180], ['HAUT-GAUCHE', 135],
];
// Two passes (clockwise, then counter-clockwise): 16 returns sample the rest-position spread far better than 8.
const SEQ = [...DIRS, ...[...DIRS].reverse()];
const N = SEQ.length;
const STEPS = ['Repos', 'Retour au centre', 'Amplitude', 'Résultats'];
const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return Math.abs(d); };
const P = v => fr(v * 100, 1);

export default function diagnostic() {
  let side = 'L';
  let phase = 'intro';      // intro | rest | returns | amp | results
  let unsub = null, cancelRest = null, calibOn = false;
  let rest = null, restPts = [];
  let ret = null;           // returns state
  let amp = null;           // amplitude state
  let result = null;
  let resView = 'centre';

  const canvas = h('canvas', { class: 'scope scope-xl', 'aria-label': 'Oscilloscope du diagnostic' });
  const scope = new Scope(canvas, { margin: 30, persist: 0.6 });
  scope.showZones = false;

  // ---- right column ----
  const stepEls = STEPS.map((s, i) => h('li', { class: 'st' }, h('span', { class: 'st-n' }, String(i + 1).padStart(2, '0')), h('span', { class: 'st-t' }, s)));
  const sideSel = segmented({ options: [{ value: 'L', label: 'Stick gauche' }, { value: 'R', label: 'Stick droit' }], value: 'L', label: 'Stick à diagnostiquer', onChange: v => { side = v; if (phase === 'results') toIntro(); } });
  const say = h('p', { class: 'say' });
  const stage = h('div', { class: 'stage' });
  const foot = h('div', { class: 'stage-foot' });
  const resTabs = segmented({ options: [{ value: 'centre', label: 'Centre' }, { value: 'amp', label: 'Amplitude' }], value: 'centre', small: true, label: 'Vue', onChange: v => { resView = v; } });
  const resTabsWrap = h('div', { class: 'res-tabs', hidden: true }, resTabs.el,
    h('div', { class: 'legend' }, h('span', { class: 'lg lg-pt' }, 'Retours'), h('span', { class: 'lg lg-rest' }, 'Repos'), h('span', { class: 'lg lg-ctr' }, 'Centre conseillé'), h('span', { class: 'lg lg-dz' }, 'Zone morte')));

  const el = h('section', { class: 'screen scr-diag', 'aria-label': 'Diagnostic' },
    h('div', { class: 'diag-l' }, h('div', { class: 'scope-box' }, canvas), resTabsWrap),
    h('div', { class: 'diag-r' },
      h('div', { class: 'diag-top' }, sideSel.el, h('ol', { class: 'steps' }, stepEls)),
      say, stage, foot));

  function setStep(i) { stepEls.forEach((e, k) => { setClass(e, 'done', k < i); setClass(e, 'cur', k === i); }); }
  function calib(on) { if (on !== calibOn) { calibOn = on; send({ t: 'calibrating', on }); } }
  function stopAll() { unsub?.(); unsub = null; cancelRest?.(); cancelRest = null; scope.progress = null; }
  const abortBtn = () => button('Arrêter', toIntro, 'btn-ghost');

  // ---- intro ----
  function toIntro() {
    stopAll(); calib(false); phase = 'intro'; setStep(-1); result = null;
    resTabsWrap.hidden = true; scope.zoom = 1;
    sideSel.el.classList.remove('locked');
    say.textContent = 'Mesure précise du drift, en quatre étapes.';
    const rows = [
      ['Repos', '2 s sans toucher : décalage et bruit.'],
      ['Retour au centre', '16 poussées en butée (deux tours), relâchées : dispersion du retour.'],
      ['Amplitude', '3 tours lents en butée : course et circularité.'],
      ['Résultats', 'Centre, zone morte et zone externe conseillés.'],
    ];
    stage.replaceChildren(h('dl', { class: 'intro' }, rows.map(([k, v], i) => [h('dt', {}, h('span', { class: 'lbl' }, String(i + 1).padStart(2, '0')), k), h('dd', {}, v)])));
    foot.replaceChildren(button('Commencer', startRest, 'btn-acc btn-lg'), h('span', { class: 'lbl' }, '≈ 1 min 30'));
  }

  // ---- a. rest ----
  function startRest() {
    stopAll(); calib(true); phase = 'rest'; setStep(0);
    sideSel.el.classList.add('locked');
    say.textContent = 'Pose la manette. Ne touche à rien.';
    const count = h('span', { class: 'big-count' }, '2,0'), msg = h('p', { class: 'note' });
    stage.replaceChildren(h('div', { class: 'count-row' }, count, h('span', { class: 'lbl' }, 'secondes')), msg);
    foot.replaceChildren(abortBtn());
    scope.progress = 0;
    cancelRest = captureRest(side, 2000, {
      onProgress: k => { scope.progress = k; setText(count, fr((1 - k) * 2, 1)); },
      onRestart: () => setText(msg, 'Mouvement détecté — on recommence.'),
      onDone: (r, pts) => { cancelRest = null; rest = r; restPts = pts; scope.progress = null; startReturns(); },
    });
  }

  // ---- b. return to centre ----
  function startReturns() {
    phase = 'returns'; setStep(1);
    ret = { i: 0, state: 'push', pts: new Array(N).fill(null), t0: performance.now(), settle: 0, avg: [], sm: null, prevSm: null, buf: [] };
    const segs = SEQ.map(() => h('i', { class: 'seg8' }));
    const timer = h('span', { class: 'lbl' });
    stage.replaceChildren(h('div', { class: 'segs' }, segs), h('div', { class: 'seg-meta' }, h('span', { class: 'lbl', id: 'ret-n' }), timer));
    foot.replaceChildren(button('Passer', () => nextDir(true), 'btn-link'), abortBtn());
    ret.ui = { segs, timer, n: stage.querySelector('#ret-n') };
    showDir();
    unsub = sub('frame', m => {
      const list = m.samples?.[side]; if (!list) return;
      const dt = 1000 / (m.s?.hz || 250);
      for (const p of list) { stepReturn(p[0], p[1], dt); if (phase !== 'returns') return; }
    });
  }
  function showDir() {
    const [name] = SEQ[ret.i];
    say.replaceChildren('Pousse le stick vers ', h('b', {}, name), ', jusqu’en butée.');
    ret.ui.segs.forEach((s, k) => { setClass(s, 'cur', k === ret.i); setClass(s, 'ok', !!ret.pts[k]); setClass(s, 'skip', k < ret.i && !ret.pts[k]); });
    setText(ret.ui.n, `Direction ${ret.i + 1} / ${N}`);
  }
  function stepReturn(x, y, dt) {
    const r = ret, mag = Math.hypot(x, y);
    // 5-sample moving average to separate movement from sensor noise
    r.buf.push([x, y]); if (r.buf.length > 5) r.buf.shift();
    const sm = r.buf.reduce((a, p) => [a[0] + p[0] / r.buf.length, a[1] + p[1] / r.buf.length], [0, 0]);
    const move = r.sm ? Math.hypot(sm[0] - r.sm[0], sm[1] - r.sm[1]) : 1;
    r.sm = sm;
    if (r.state === 'push') {
      const a = Math.atan2(y, x) * 180 / Math.PI;
      if (mag > 0.85 && angDiff(a, SEQ[r.i][1]) <= 25) { r.state = 'release'; say.textContent = 'Relâche.'; r.settle = 0; }
    } else if (r.state === 'release') {
      if (Math.hypot(sm[0], sm[1]) < 0.35 && move < 0.004) { r.settle += dt; if (r.settle >= 250) { r.state = 'avg'; r.avg = []; } }
      else r.settle = 0;
    } else if (r.state === 'avg') {
      if (move > 0.01 || Math.hypot(sm[0], sm[1]) >= 0.35) { r.state = 'release'; r.settle = 0; return; }
      r.avg.push([x, y]);
      if (r.avg.length * dt >= 400) {
        const s = restStats(r.avg);
        r.pts[r.i] = [s.cx, s.cy];
        nextDir(false);
      }
    }
  }
  function nextDir() {
    const r = ret;
    r.i++; r.state = 'push'; r.t0 = performance.now(); r.buf = []; r.sm = null;
    if (r.i >= N) { unsub?.(); unsub = null; startAmp(); return; }
    showDir();
  }

  // ---- c. amplitude ----
  function startAmp() {
    phase = 'amp'; setStep(2);
    amp = { max: new Float32Array(36), visits: new Uint8Array(36), last: -1, prev: null, jumps: 0 };
    say.textContent = 'Fais trois tours lents, stick en butée.';
    const n = h('span', { class: 'big-count' }, '0'), j = h('span', { class: 'lbl' });
    stage.replaceChildren(h('div', { class: 'count-row' }, n, h('span', { class: 'lbl' }, '/ 36 secteurs')), j);
    foot.replaceChildren(button('Passer', finish, 'btn-link'), abortBtn());
    amp.ui = { n, j };
    unsub = sub('frame', m => {
      const list = m.samples?.[side]; if (!list) return;
      for (const p of list) {
        const x = p[0], y = p[1], mag = Math.hypot(x, y);
        if (amp.prev && mag > 0.7 && Math.hypot(x - amp.prev[0], y - amp.prev[1]) > 0.25) amp.jumps++;
        amp.prev = [x, y];
        if (mag <= 0.7) { amp.last = -1; continue; }
        const sec = Math.floor(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360 / 10) % 36;
        if (mag > amp.max[sec]) amp.max[sec] = mag;
        if (sec !== amp.last) { amp.visits[sec] = Math.min(255, amp.visits[sec] + 1); amp.last = sec; }
      }
      let done = 0; for (let i = 0; i < 36; i++) if (amp.visits[i] >= 3) done++;
      setText(amp.ui.n, String(done));
      setText(amp.ui.j, amp.jumps ? `Sauts détectés : ${amp.jumps}` : '');
      if (done === 36) finish();
    });
  }

  // ---- d. results ----
  function finish() {
    stopAll(); calib(false); phase = 'results'; setStep(3);
    sideSel.el.classList.remove('locked');
    const pts = ret.pts.filter(Boolean);
    const mec = minEnclosingCircle([...pts, [rest.cx, rest.cy]]);
    // Margin: the measured returns are a sample — real rest positions spread a little wider (seen on a real pad).
    const dz = Math.max(0.02, mec.r * 1.15 + rest.p99 + 0.01);
    const maxes = [...amp.max].filter(v => v > 0);
    const ampMin = maxes.length ? Math.min(...maxes) : NaN;
    const ampMean = maxes.length ? maxes.reduce((a, b) => a + b, 0) / maxes.length : NaN;
    const circ = maxes.length ? maxes.reduce((a, b) => a + Math.abs(b - ampMean), 0) / maxes.length : NaN;
    const outer = Number.isFinite(ampMin) ? clamp(ampMin - 0.01, 0.8, 1) : null;
    result = { pts, mec, dz, ampMin, circ, outer, jumps: amp.jumps, offset: Math.hypot(rest.cx, rest.cy), noise: rest.p99 };
    const reach = Math.max(dz, ...restPts.map(p => Math.hypot(p[0] - mec.x, p[1] - mec.y)), ...pts.map(p => Math.hypot(p[0] - mec.x, p[1] - mec.y)));
    result.zoom = clamp(1 / (reach * 1.3), 1, 30);
    resTabs.set('centre'); resView = 'centre'; resTabsWrap.hidden = false;

    const dzp = dz * 100;
    let verdict, code, warn = false;
    if (dzp > 20 || result.jumps > 0 || rest.p99 > 0.05) { warn = true; code = 'trop-fort'; verdict = 'Trop fort pour une correction logicielle propre — le module du stick est usé. Remplacement conseillé (potentiomètre, ou module à effet Hall / TMR).'; }
    else if (dzp <= 6) { code = 'excellent'; verdict = 'Excellent — la correction sera invisible en jeu.'; }
    else if (dzp <= 12) { code = 'correct'; verdict = 'Correct — zone morte modérée, perceptible seulement sur la visée très fine.'; }
    else { code = 'limite'; verdict = 'Limite — la correction fonctionne mais tu perdras en précision. Un nettoyage ou un remplacement du module est conseillé.'; }

    say.replaceChildren(h('span', { class: 'verdict' + (warn ? ' warn' : '') }, verdict), applied);
    const m = (label, v, unit = '%', cls = '') => h('div', { class: 'met ' + cls }, h('span', { class: 'lbl' }, label), h('span', { class: 'met-v' }, v, unit ? h('small', {}, unit) : null));
    stage.replaceChildren(h('div', { class: 'mets' },
      m('Zone morte conseillée', P(dz), '%', 'acc'),
      m('Décalage au repos', P(result.offset)),
      m('Dispersion du retour', P(mec.r)),
      m('Bruit', P(rest.p99), '%', rest.p99 > 0.05 ? 'bad' : ''),
      m('Amplitude min', Number.isFinite(ampMin) ? P(ampMin) : '—'),
      m('Circularité', Number.isFinite(circ) ? P(circ) : '—'),
      m('Sauts', String(result.jumps), '', result.jumps ? 'bad' : ''),
      m('Retours mesurés', `${pts.length}`, `/ ${N}`)));

    // Applied automatically: the correction is always based on the latest diagnostic.
    const r4 = v => Number.isFinite(v) ? +v.toFixed(4) : null;
    const deadzone = r4(clamp(dz, 0, 0.4));
    const params = {
      cx: r4(mec.x), cy: r4(mec.y), deadzone,
      source: 'diagnostic', diagnosedAt: new Date().toISOString(),
      diag: {
        offset: r4(result.offset), spread: r4(mec.r), noise: r4(rest.p99), deadzone, outer: r4(outer ?? NaN),
        minAmplitude: r4(ampMin), circularity: r4(circ), jumps: result.jumps, verdict: code,
        cx: r4(mec.x), cy: r4(mec.y),
      },
    };
    if (outer != null) params.outer = r4(outer);
    const before = S.profile?.sticks[side];
    const prev = before && {
      cx: before.cx, cy: before.cy, deadzone: before.deadzone, outer: before.outer,
      source: stickSource(before), diagnosedAt: before.diagnosedAt ?? null, diag: before.diag ?? null,
    };
    applyParams(params, prev);

    const other = side === 'L' ? 'R' : 'L', otherName = other === 'L' ? 'gauche' : 'droit';
    const otherDone = !!S.profile?.sticks[other]?.diag || stickSource(S.profile?.sticks[other]) === 'diagnostic';
    foot.replaceChildren(
      button(`${otherDone ? 'Refaire' : 'Diagnostiquer'} le stick ${otherName}`, () => { side = other; sideSel.set(other); startRest(); }, 'btn-acc'),
      button('Recommencer', startRest, 'btn-line'));
  }

  // ---- auto-apply / undo ----
  const applied = h('div', { class: 'applied' });
  function applyParams(params, prev) {
    const s = side, name = S.settings.activeProfile;
    if (!S.profile) { applied.replaceChildren(h('span', { class: 'lbl' }, 'Aucun profil actif — rien n’a été appliqué')); return; }
    setStick(s, params, true);
    applied.replaceChildren(
      h('span', { class: 'applied-t acc' }, `Appliqué au profil « ${name} »`),
      prev ? button('Annuler', () => {
        setStick(s, prev, true);
        applied.replaceChildren(
          h('span', { class: 'applied-t' }, 'Réglages précédents rétablis'),
          button('Appliquer quand même', () => applyParams(params, prev), 'btn-link'));
      }, 'btn-ghost btn-sm') : '');
  }

  // ---- rendering ----
  function drawWedge(a0, a1, r0, r1, fill, stroke) {
    const g = scope.c.ctx, x = scope.X(0), y = scope.Y(0), R = scope.R;
    g.beginPath();
    g.arc(x, y, r1 * R, -a1, -a0);
    g.arc(x, y, r0 * R, -a0, -a1, true);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }
  function label(x, y, text, color = C.muted) {
    const g = scope.c.ctx; g.font = '10px "PZ Mono", Consolas, monospace'; g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(text, scope.X(x) + 5, scope.Y(y) - 3);
  }
  function renderReturnPts(numbered = true) {
    ret?.pts.forEach((p, i) => { if (!p) return; scope.dot(p[0], p[1], 2.5, C.text); if (numbered) label(p[0], p[1], String(i + 1)); });
  }
  function ampChart() {
    const g = scope.c.ctx;
    for (let i = 0; i < 36; i++) {
      const v = amp.visits[i], mx = amp.max[i];
      const a0 = i * 10 * Math.PI / 180, a1 = (i + 1) * 10 * Math.PI / 180 - 0.012;
      if (mx > 0) drawWedge(a0, a1, 0.8, mx, rgba(C.accent, v >= 3 ? 0.7 : v === 2 ? 0.4 : 0.18), null);
      else drawWedge(a0, a1, 0.8, 0.86, null, C.line2);
    }
    g.globalAlpha = 1;
  }

  function render(now) {
    const last = S.last[side];
    if (phase === 'results') {
      scope.clear();
      const r = result;
      if (resView === 'amp') {
        scope.zoom = 1; scope.panX = scope.panY = 0; scope.clear(); ampChart();
        if (r.outer != null) scope.circle(0, 0, r.outer, C.accent, null, [3, 3]);
        return;
      }
      scope.zoom = r.zoom; scope.panX = r.mec.x; scope.panY = r.mec.y;
      scope.clear();
      const o = [scope.X(0), scope.Y(0)];
      if (o[0] > 0 && o[0] < scope.c.w && o[1] > 0 && o[1] < scope.c.h) { scope.cross(0, 0, 6, C.dim); label(0, 0, '0', C.dim); }
      for (const p of restPts) scope.dot(p[0], p[1], 1, rgba(C.muted, 0.5));
      scope.circle(r.mec.x, r.mec.y, r.dz, rgba(C.accent, 0.9), rgba(C.accent, 0.07), [3, 3]);
      scope.circle(r.mec.x, r.mec.y, r.mec.r, C.muted, null, [2, 3]);
      renderReturnPts(true);
      scope.cross(rest.cx, rest.cy, 4, C.muted);
      scope.cross(r.mec.x, r.mec.y, 9, C.accent);
      scope.panX = scope.panY = 0;
      return;
    }
    scope.zoom = 1; scope.panX = scope.panY = 0;
    scope.clear();
    if (phase === 'returns' && ret.i < N) {
      const a = SEQ[ret.i][1] * Math.PI / 180, w = 25 * Math.PI / 180;
      const pushing = ret.state === 'push';
      drawWedge(a - w, a + w, 0.85, 1, rgba(C.accent, pushing ? 0.16 : 0.05), pushing ? C.accent : C.line2);
      // arrow
      const g = scope.c.ctx, X = scope.X(0), Y = scope.Y(0), R = scope.R;
      const p = k => [X + Math.cos(a) * k * R, Y - Math.sin(a) * k * R];
      const [ax, ay] = p(0.78), [bx, by] = p(0.45);
      g.strokeStyle = pushing ? C.accent : C.dim; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ax, ay);
      const n = [Math.cos(a + 2.6), -Math.sin(a + 2.6)], m2 = [Math.cos(a - 2.6), -Math.sin(a - 2.6)];
      g.moveTo(ax + n[0] * 10, ay + n[1] * 10); g.lineTo(ax, ay); g.lineTo(ax + m2[0] * 10, ay + m2[1] * 10); g.stroke();
      if (!pushing) scope.circle(0, 0, 0.35, C.dim, null, [2, 3]);
      const left = Math.max(0, 12 - (now - ret.t0) / 1000);
      setText(ret.ui.timer, `${fr(left, 0)} s`);
      if (left <= 0) nextDir(true);
    }
    if (phase === 'amp') ampChart();
    if (rest && phase !== 'rest') { scope.cross(rest.cx, rest.cy, 5, C.text); renderReturnPts(phase === 'returns'); }
    scope.trail(S.trails[side].raw, now, C.muted, 1.25);
    scope.dot(last[0], last[1], 3, phase === 'rest' ? C.text : C.accent);
    scope.ring();
  }

  // "Diagnostiquer" from the Correction screen: preselect that stick (runs before the shell switches screen).
  sub('navigate', ({ screen, side: s }) => {
    if (screen !== 1 || !s || s === side) return;
    if (phase !== 'intro' && phase !== 'results') return;
    side = s; sideSel.set(s);
    if (phase === 'results') toIntro();
  });

  toIntro();
  return {
    num: '02', title: 'Diagnostic', el, needsController: true,
    enter() { if (phase !== 'results') toIntro(); },
    leave() { if (phase !== 'results') toIntro(); else { stopAll(); calib(false); } },
    render,
  };
}
