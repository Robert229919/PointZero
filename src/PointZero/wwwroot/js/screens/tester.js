// 03 Testeur — live controller drawing, coverage, sensors, haptics, lights, audio.
import { send } from '../bridge.js';
import { S, sub } from '../state.js';
import { h, setText, setClass, slider, segmented, button, hiDpiCanvas } from '../ui.js';
import { createController, bodyPath } from '../controller-svg.js';
import { C, rgba } from '../scope.js';
import { fr, clamp } from '../math.js';

const BTN = [
  ['□', 'Carré'], ['×', 'Croix'], ['○', 'Rond'], ['△', 'Triangle'], ['L1', 'L1'], ['R1', 'R1'], ['L2', 'L2 (clic)'], ['R2', 'R2 (clic)'],
  ['CRE', 'Create'], ['OPT', 'Options'], ['L3', 'L3'], ['R3', 'R3'], ['PS', 'PS'], ['PAV', 'Clic du pavé tactile'], ['MIC', 'Mute'],
  ['↑', 'Haut'], ['↓', 'Bas'], ['←', 'Gauche'], ['→', 'Droite'],
  ['FnG', 'Fn gauche'], ['FnD', 'Fn droite'], ['ArG', 'Palette arrière gauche'], ['ArD', 'Palette arrière droite'],
];
const isEdge = () => /edge/i.test(S.status?.controller?.model || '');
const panel = (title, ...kids) => h('div', { class: 'pnl' }, h('div', { class: 'pnl-h' }, typeof title === 'string' ? h('span', { class: 'lbl' }, title) : title), ...kids);
const p100 = v => fr(v, 0) + ' %';

// ---------- coverage ----------
function coverage() {
  const seen = new Set();
  const count = h('span', { class: 'cov-n' }), total = h('span', { class: 'cov-t' });
  const cells = BTN.map(([s, name], i) => h('span', { class: 'cov-c', title: name, 'data-i': i }, h('i'), h('span', {}, s)));
  const row = h('div', { class: 'cov-row' }, cells);
  const reset = button('Réinitialiser', () => { seen.clear(); cells.forEach(c => c.classList.remove('ok')); upd(); }, 'btn-link');
  const el = h('div', { class: 'cov' },
    h('div', { class: 'cov-head' }, h('span', { class: 'lbl' }, 'Boutons testés'), h('span', { class: 'cov-num' }, count, total), reset), row);
  let n = 19, prevB = -1;
  function upd() { setText(count, String(seen.size)); setText(total, ` / ${n}`); }
  return {
    el,
    setEdge(e) { n = e ? 23 : 19; cells.forEach((c, i) => { c.hidden = i >= n; }); upd(); },
    update(b) {
      if (b === prevB) return; prevB = b;
      for (let i = 0; i < n; i++) {
        const on = !!((b >> i) & 1);
        setClass(cells[i], 'cur', on);
        if (on && !seen.has(i)) { seen.add(i); cells[i].classList.add('ok'); upd(); }
      }
    },
  };
}

// ---------- triggers (raw) ----------
function triggers() {
  const mk = name => {
    const bar = h('i', { class: 'tb-raw' }), v = h('span', { class: 'tv' }), click = h('span', { class: 'clk' }, 'clic');
    return { el: h('div', { class: 'tt' }, h('span', { class: 'h3' }, name), h('div', { class: 'tb-track' }, bar), v, click), bar, v, click, last: -1 };
  };
  const L = mk('L2'), R = mk('R2');
  return {
    el: h('div', { class: 'tts' }, L.el, R.el),
    update(s) {
      for (const [t, val, bit] of [[L, s.l2, 6], [R, s.r2, 7]]) {
        if (val !== t.last) { t.last = val; t.bar.style.transform = `scaleX(${val / 255})`; setText(t.v, String(val).padStart(3, ' ')); }
        setClass(t.click, 'on', !!((s.b >> bit) & 1));
      }
    },
  };
}

// ---------- motion: gyro sparklines + 3D wireframe ----------
function motion() {
  const N = 180;
  const hist = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  let head = 0, count = 0;
  const sparkC = h('canvas', { class: 'spark' }), cubeC = h('canvas', { class: 'cube' });
  const spark = hiDpiCanvas(sparkC), cube = hiDpiCanvas(cubeC);
  const gv = [0, 1, 2].map(() => h('span', { class: 'mv' }));
  const av = [0, 1, 2, 3].map(() => h('span', { class: 'mv' }));
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const recenter = button('Recentrer', () => { R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; }, 'btn-link');

  // extruded outline of the controller, sampled from the drawing's body path
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', bodyPath());
  let outline = [];
  try {
    const L = path.getTotalLength();
    for (let i = 0; i < 40; i++) { const p = path.getPointAtLength(L * i / 40); outline.push([(p.x - 300) / 260, (p.y - 210) / 260]); }
  } catch { outline = [[-1, -0.6], [1, -0.6], [1, 0.6], [-1, 0.6]]; }

  const axes = ['Tangage', 'Lacet', 'Roulis'];
  const el = h('div', { class: 'motion' },
    panel(h('span', { class: 'pnl-hh' }, h('span', { class: 'lbl' }, 'Gyroscope · °/s'), recenter),
      h('div', { class: 'gyro' },
        cubeC,
        h('div', { class: 'gyro-r' }, sparkC, h('div', { class: 'gyro-v' }, axes.map((a, i) => h('div', { class: 'mvr' }, h('span', { class: 'lbl' }, a), gv[i])))))),
    panel('Accéléromètre · g', h('div', { class: 'acc4' }, ['X', 'Y', 'Z', '|g|'].map((a, i) => h('div', { class: 'mvr' }, h('span', { class: 'lbl' }, a), av[i])))));

  const mul = (a, b) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  function rot(wx, wy, wz) {
    const th = Math.hypot(wx, wy, wz);
    if (th < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const x = wx / th, y = wy / th, z = wz / th, c = Math.cos(th), s = Math.sin(th), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  let lastT = 0, slow = 0;
  return {
    el,
    onFrame(s) {
      const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0; lastT = now;
      const g = s.gyro || [0, 0, 0], k = Math.PI / 180 * dt;
      R = mul(R, rot(g[0] * k, g[1] * k, -g[2] * k));
      for (let i = 0; i < 3; i++) hist[i][head] = g[i];
      head = (head + 1) % N; count = Math.min(N, count + 1);
      if ((slow++ & 3) === 0) {
        g.forEach((v, i) => setText(gv[i], ((v >= 0 ? '+' : '') + fr(v, 1)).padStart(7, ' ')));
        const a = s.accel || [0, 0, 0];
        a.forEach((v, i) => setText(av[i], (v >= 0 ? '+' : '') + fr(v, 3)));
        setText(av[3], fr(Math.hypot(...a), 3));
      }
    },
    reset() { lastT = 0; },
    render() {
      // sparklines: 3 stacked rows, symmetric autoscale
      const w = spark.w, hh = spark.h, g = spark.ctx;
      g.clearRect(0, 0, w, hh);
      const rowH = hh / 3;
      for (let a = 0; a < 3; a++) {
        let mx = 20; for (let i = 0; i < count; i++) mx = Math.max(mx, Math.abs(hist[a][i]));
        const y0 = rowH * a + rowH / 2;
        g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Math.round(y0) + 0.5); g.lineTo(w, Math.round(y0) + 0.5); g.stroke();
        g.strokeStyle = C.muted; g.beginPath();
        for (let i = 0; i < count; i++) {
          const idx = (head - count + i + N) % N;
          const x = w - (count - 1 - i) * (w / (N - 1)), y = y0 - hist[a][idx] / mx * (rowH / 2 - 3);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        if (count) { const y = y0 - hist[a][(head - 1 + N) % N] / mx * (rowH / 2 - 3); g.fillStyle = C.accent; g.fillRect(w - 3, y - 1.5, 3, 3); }
      }
      // wireframe
      const c = cube.ctx, cw = cube.w, ch = cube.h;
      c.clearRect(0, 0, cw, ch);
      const tilt = -0.95, ct = Math.cos(tilt), st = Math.sin(tilt);
      const proj = ([x, y, z]) => {
        const X = R[0] * x + R[1] * y + R[2] * z, Y = R[3] * x + R[4] * y + R[5] * z, Z = R[6] * x + R[7] * y + R[8] * z;
        const y2 = Y * ct - Z * st, z2 = Y * st + Z * ct;
        const f = 3.2 / (3.2 + z2), sc = Math.min(cw, ch) * 0.36;
        return [cw / 2 + X * sc * f, ch / 2 - y2 * sc * f];
      };
      const top = outline.map(([x, z]) => proj([x, 0.09, z])), bot = outline.map(([x, z]) => proj([x, -0.09, z]));
      const poly = (pts, col) => { c.strokeStyle = col; c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.stroke(); };
      c.lineWidth = 1;
      poly(bot, C.dim);
      c.strokeStyle = C.line2; c.beginPath();
      for (let i = 0; i < top.length; i += 4) { c.moveTo(top[i][0], top[i][1]); c.lineTo(bot[i][0], bot[i][1]); } c.stroke();
      poly(top, C.text);
      // forward axis (towards the touchpad)
      const o = proj([0, 0.09, 0]), f = proj([0, 0.09, -0.75]);
      c.strokeStyle = C.accent; c.beginPath(); c.moveTo(o[0], o[1]); c.lineTo(f[0], f[1]); c.stroke();
      c.fillStyle = C.accent; c.fillRect(f[0] - 2, f[1] - 2, 4, 4);
    },
  };
}

// ---------- touchpad ----------
function touchpad() {
  const cv = h('canvas', { class: 'tpad' });
  const cx = hiDpiCanvas(cv);
  const info = [0, 1].map(() => h('span', { class: 'mv tinfo' }));
  const trails = [[], []];
  let pressed = false, last = [null, null];
  const el = panel('Pavé tactile · 1920 × 1080', h('div', { class: 'tp' }, cv, h('div', { class: 'tp-info' }, info.map((x, i) => h('div', { class: 'mvr' }, h('span', { class: 'lbl' }, `Contact ${i + 1}`), x)))));
  return {
    el,
    onFrame(s) {
      pressed = !!((s.b >> 13) & 1);
      const now = performance.now();
      (s.touch || []).slice(0, 2).forEach((t, i) => {
        last[i] = t.on ? t : null;
        if (t.on) trails[i].push([t.x, t.y, now]);
        while (trails[i].length && (now - trails[i][0][2] > 400 || !t.on)) trails[i].shift();
        setText(info[i], t.on ? `#${String(t.id).padStart(3, '0')}  ${String(t.x).padStart(4, ' ')} · ${String(t.y).padStart(4, ' ')}` : '—');
      });
    },
    render() {
      const g = cx.ctx, w = cx.w, hh = cx.h;
      g.clearRect(0, 0, w, hh);
      g.strokeStyle = pressed ? C.accent : C.line2; g.lineWidth = pressed ? 2 : 1;
      g.strokeRect(pressed ? 1 : 0.5, pressed ? 1 : 0.5, w - (pressed ? 2 : 1), hh - (pressed ? 2 : 1));
      g.strokeStyle = C.line; g.lineWidth = 1; g.setLineDash([1, 3]); g.beginPath();
      for (const k of [1 / 3, 2 / 3]) { g.moveTo(Math.round(w * k) + 0.5, 0); g.lineTo(Math.round(w * k) + 0.5, hh); g.moveTo(0, Math.round(hh * k) + 0.5); g.lineTo(w, Math.round(hh * k) + 0.5); }
      g.stroke(); g.setLineDash([]);
      const X = x => x / 1919 * w, Y = y => y / 1079 * hh;
      trails.forEach(tr => {
        if (tr.length < 2) return;
        g.strokeStyle = rgba(C.accent, 0.45); g.lineWidth = 1.5; g.beginPath();
        tr.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))); g.stroke();
      });
      g.font = '10px "PZ Mono", Consolas, monospace'; g.textBaseline = 'bottom';
      last.forEach(t => {
        if (!t) return;
        g.fillStyle = C.accent; g.beginPath(); g.arc(X(t.x), Y(t.y), 4, 0, Math.PI * 2); g.fill();
        g.strokeStyle = rgba(C.accent, 0.4); g.beginPath(); g.arc(X(t.x), Y(t.y), 9, 0, Math.PI * 2); g.stroke();
        g.fillStyle = C.text; g.fillText(String(t.id), X(t.x) + 11, Y(t.y) - 4);
      });
    },
  };
}

// ---------- battery ----------
function battery() {
  const lvl = h('span', { class: 'bat-n' }), state = h('span', { class: 'mv' }), hp = h('span', { class: 'mv' });
  const gauge = h('i', { class: 'bat-fill' });
  const el = panel('Batterie', h('div', { class: 'bat' }, h('div', { class: 'bat-l' }, lvl, h('div', { class: 'bat-g' }, gauge)),
    h('div', { class: 'bat-r' }, h('div', { class: 'mvr' }, h('span', { class: 'lbl' }, 'État'), state), h('div', { class: 'mvr' }, h('span', { class: 'lbl' }, 'Prise jack'), hp))));
  let k = '';
  return {
    el,
    onFrame(s) {
      const b = s.bat || {}, p = s.plug || {};
      const key = `${b.level}|${b.charging}|${b.full}|${p.headphones}|${p.mic}`;
      if (key === k) return; k = key;
      lvl.replaceChildren(String(b.level ?? '—'), h('small', {}, '%'));
      gauge.style.transform = `scaleX(${clamp((b.level ?? 0) / 100, 0, 1)})`;
      setText(state, b.full ? 'Pleine' : b.charging ? 'En charge' : 'Sur batterie');
      setText(hp, p.headphones ? (p.mic ? 'Casque + micro' : 'Casque') : 'Libre');
    },
  };
}

// ---------- haptics ----------
function haptics() {
  let tm = 0, pend = false, timerPulse = 0;
  const flush = () => { tm = 0; send({ t: 'rumble', left: Math.round(L.value * 2.55), right: Math.round(R.value * 2.55) }); };
  const queue = () => { if (!tm) tm = setTimeout(flush, 33); };
  const L = slider({ label: 'Moteur gauche (fort)', min: 0, max: 100, step: 1, value: 0, format: p100, onInput: queue });
  const R = slider({ label: 'Moteur droit (léger)', min: 0, max: 100, step: 1, value: 0, format: p100, onInput: queue });
  const stop = () => { clearTimeout(timerPulse); L.set(0); R.set(0); clearTimeout(tm); tm = 0; send({ t: 'rumble', left: 0, right: 0 }); };
  const vib = panel('Vibrations', L.el, R.el, h('div', { class: 'row-btns' },
    button('Impulsion', () => { send({ t: 'rumble', left: 255, right: 255 }); clearTimeout(timerPulse); timerPulse = setTimeout(flush, 300); }, 'btn-line'),
    button('Stop', stop, 'btn-ghost')));

  // adaptive triggers
  const MODES = [{ value: 'off', label: 'Aucune' }, { value: 'feedback', label: 'Résistance' }, { value: 'weapon', label: 'Point de rupture' }, { value: 'vibration', label: 'Vibration' }];
  const mkTrig = side => {
    const st = { mode: 'off', start: 2, end: 6, strength: 5, amplitude: 4, frequency: 30 };
    let t2 = 0;
    const emit = () => { clearTimeout(t2); t2 = setTimeout(() => send({ t: 'triggerEffect', side, effect: effect() }), 33); };
    const effect = () => {
      switch (st.mode) {
        case 'feedback': return { mode: 'feedback', start: st.start, strength: st.strength };
        case 'weapon': { const s = clamp(st.start, 2, 7); return { mode: 'weapon', start: s, end: clamp(Math.max(st.end, s + 1), 3, 8), strength: st.strength }; }
        case 'vibration': return { mode: 'vibration', start: st.start, amplitude: st.amplitude, frequency: st.frequency };
        default: return { mode: 'off' };
      }
    };
    const int = v => String(v);
    const sl = {
      start: slider({ label: 'Début', min: 0, max: 9, step: 1, value: st.start, compact: true, format: int, onInput: v => { st.start = v; if (st.mode === 'weapon' && st.end <= v) { st.end = Math.min(8, v + 1); sl.end.set(st.end); } emit(); } }),
      end: slider({ label: 'Fin', min: 3, max: 8, step: 1, value: st.end, compact: true, format: int, onInput: v => { st.end = v; if (st.start >= v) { st.start = v - 1; sl.start.set(st.start); } emit(); } }),
      strength: slider({ label: 'Force', min: 1, max: 8, step: 1, value: st.strength, compact: true, format: int, onInput: v => { st.strength = v; emit(); } }),
      amplitude: slider({ label: 'Amplitude', min: 1, max: 8, step: 1, value: st.amplitude, compact: true, format: int, onInput: v => { st.amplitude = v; emit(); } }),
      frequency: slider({ label: 'Fréquence', min: 1, max: 255, step: 1, value: st.frequency, compact: true, format: v => v + ' Hz', onInput: v => { st.frequency = v; emit(); } }),
    };
    const SHOW = { off: [], feedback: ['start', 'strength'], weapon: ['start', 'end', 'strength'], vibration: ['start', 'amplitude', 'frequency'] };
    const params = h('div', { class: 'te-params' }, Object.values(sl).map(s => s.el));
    const show = () => {
      for (const k in sl) sl[k].el.hidden = !SHOW[st.mode].includes(k);
      sl.start.input.min = st.mode === 'weapon' ? 2 : 0; sl.start.input.max = st.mode === 'weapon' ? 7 : 9;
      sl.start.set(st.start = clamp(st.start, +sl.start.input.min, +sl.start.input.max));
      params.classList.toggle('empty', st.mode === 'off');
    };
    const seg = segmented({ options: MODES, value: 'off', small: true, label: `Effet ${side}2`, onChange: v => { st.mode = v; show(); emit(); } });
    show();
    return {
      el: h('div', { class: 'te' }, h('div', { class: 'te-h' }, h('span', { class: 'h3' }, side + '2'), seg.el), params),
      reset() { clearTimeout(t2); st.mode = 'off'; seg.set('off'); show(); send({ t: 'triggerEffect', side, effect: { mode: 'off' } }); },
    };
  };
  const TL = mkTrig('L'), TR = mkTrig('R');
  return {
    el: h('div', { class: 'tab-body' }, vib, panel('Gâchettes adaptatives', TL.el, TR.el)),
    reset() { stop(); TL.reset(); TR.reset(); },
  };
}

// ---------- lights ----------
function lights(onChange) {
  const strip = h('canvas', { class: 'hue', tabindex: 0, role: 'slider', 'aria-label': 'Teinte de la barre lumineuse', 'aria-valuemin': 0, 'aria-valuemax': 360 });
  const sc = hiDpiCanvas(strip, () => paintStrip());
  let hue = 220, val = 1, tm = 0;
  const hsv = (H, V) => { const f = n => { const k = (n + H / 60) % 6; return Math.round(V * 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))); }; return { r: f(5), g: f(3), b: f(1) }; };
  function paintStrip() {
    const g = sc.ctx, w = sc.w, hh = sc.h;
    for (let x = 0; x < w; x++) { const c = hsv(x / w * 360, 1); g.fillStyle = `rgb(${c.r},${c.g},${c.b})`; g.fillRect(x, 0, 1.5, hh); }
    if (S.lightbar && hue != null) { const x = Math.round(hue / 360 * w) + 0.5; g.fillStyle = C.bg; g.fillRect(x - 2, 0, 4, hh); g.fillStyle = C.text; g.fillRect(x - 0.5, 0, 1, hh); }
  }
  const apply = (c, now) => {
    S.lightbar = c; onChange();
    clearTimeout(tm); const go = () => send({ t: 'lightbar', r: c.r, g: c.g, b: c.b });
    now ? go() : (tm = setTimeout(go, 33));
    paintStrip();
  };
  const fromHue = () => apply(hsv(hue, val));
  const pick = e => { const r = strip.getBoundingClientRect(); hue = clamp((e.clientX - r.left) / r.width, 0, 0.999) * 360; strip.setAttribute('aria-valuenow', Math.round(hue)); fromHue(); };
  strip.addEventListener('pointerdown', e => { strip.setPointerCapture(e.pointerId); pick(e); });
  strip.addEventListener('pointermove', e => { if (strip.hasPointerCapture(e.pointerId)) pick(e); });
  strip.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); hue = (hue + (e.key === 'ArrowRight' ? 5 : 355)) % 360; fromHue(); } });
  const bright = slider({ label: 'Luminosité', min: 0, max: 100, step: 1, value: 100, format: p100, onInput: v => { val = v / 100; if (hue != null) fromHue(); else apply({ r: Math.round(255 * val), g: Math.round(255 * val), b: Math.round(255 * val) }); } });
  const PRESETS = [['Blanc', null, { r: 255, g: 255, b: 255 }], ['Bleu', 240], ['Rouge', 0], ['Vert', 120], ['Éteinte', null, { r: 0, g: 0, b: 0 }]];
  const sw = PRESETS.map(([name, H, fixed]) => {
    const c = fixed || hsv(H, 1);
    return h('button', { type: 'button', class: 'swatch' + (name === 'Éteinte' ? ' sw-off' : ''), title: name, 'aria-label': name, style: `--c:rgb(${c.r},${c.g},${c.b})`,
      onclick: () => { if (H != null) { hue = H; fromHue(); } else { hue = null; val = 1; bright.set(100); apply(c, true); } } }, h('span', {}, name));
  });

  const ledBtns = [0, 1, 2, 3, 4].map(i => h('button', { type: 'button', class: 'pl', 'aria-pressed': 'false', 'aria-label': `Témoin ${i + 1}`,
    onclick: () => { S.playerLeds ^= 1 << i; ledBtns[i].setAttribute('aria-pressed', String(!!(S.playerLeds >> i & 1))); send({ t: 'playerLeds', mask: S.playerLeds }); onChange(); } }));
  const mute = segmented({ options: [{ value: 0, label: 'Éteinte' }, { value: 1, label: 'Allumée' }], value: 0, small: true, label: 'LED du bouton micro',
    onChange: v => { S.muteLed = v; send({ t: 'muteLed', mode: v }); onChange(); } });
  return h('div', { class: 'tab-body' },
    panel('Barre lumineuse', strip, h('div', { class: 'swatches' }, sw), bright.el),
    panel('Témoins joueur', h('div', { class: 'pls' }, ledBtns)),
    panel('LED du bouton micro', mute.el));
}

// ---------- audio ----------
function audio() {
  const RX = /DualSense|Wireless Controller/i;
  const spkMsg = h('p', { class: 'note' }), micMsg = h('p', { class: 'note' });
  const btHint = h('p', { class: 'note warn-txt', hidden: true }, 'En Bluetooth, Windows n’expose pas l’audio de la DualSense : branche-la en USB.');
  const vuFill = h('i', { class: 'vu-fill' }), vuPeak = h('i', { class: 'vu-peak' }), vuVal = h('span', { class: 'mv vu-v' }, '—');
  let mic = null;

  async function find(kind) {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return null;
    let devs = await md.enumerateDevices();
    if (!devs.some(d => d.label)) {
      const st = await md.getUserMedia({ audio: true }); st.getTracks().forEach(t => t.stop());
      devs = await md.enumerateDevices();
    }
    // Prefer the controller's own endpoint over Windows' "default"/"communications" aliases.
    const match = devs.filter(d => d.kind === kind && RX.test(d.label));
    return match.find(d => d.deviceId !== 'default' && d.deviceId !== 'communications') || match[0] || null;
  }

  const play = button('Jouer un son test', async () => {
    play.disabled = true; spkMsg.textContent = 'Recherche du haut-parleur…';
    try {
      const dev = await find('audiooutput');
      if (!dev) { spkMsg.textContent = 'Haut-parleur de la manette introuvable — branche-la en USB.'; return; }
      send({ t: 'audio', route: 'speaker', volume: 80 });
      const ctx = new AudioContext();
      if (ctx.setSinkId) await ctx.setSinkId(dev.deviceId);
      else { spkMsg.textContent = 'Sortie audio non sélectionnable sur ce système.'; ctx.close(); return; }
      const t0 = ctx.currentTime + 0.05;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), s = t0 + i * 0.3, d = i === 3 ? 0.6 : 0.34;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.32, s + 0.015); g.gain.exponentialRampToValueAtTime(0.001, s + d);
        o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + d + 0.02);
      });
      spkMsg.textContent = `Lecture sur « ${dev.label} ».`;
      setTimeout(() => ctx.close(), 1700);
    } catch (e) {
      spkMsg.textContent = e?.name === 'NotAllowedError' ? 'Accès audio refusé.' : 'Lecture impossible : ' + (e?.message || e);
    } finally { play.disabled = false; }
  }, 'btn-line');

  async function stopMic() {
    if (!mic) return;
    cancelAnimationFrame(mic.raf); mic.stream.getTracks().forEach(t => t.stop()); mic.ctx.close();
    mic = null; listen.textContent = 'Écouter le micro'; listen.classList.remove('live');
    vuFill.style.transform = 'scaleX(0)'; vuPeak.style.left = '0%'; vuVal.textContent = '—';
  }
  const listen = button('Écouter le micro', async () => {
    if (mic) { stopMic(); micMsg.textContent = ''; return; }
    micMsg.textContent = 'Recherche du micro…';
    try {
      const dev = await find('audioinput');
      if (!dev) { micMsg.textContent = 'Micro de la manette introuvable — branche-la en USB.'; return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new AudioContext(), an = ctx.createAnalyser();
      an.fftSize = 2048; ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      mic = { stream, ctx, raf: 0, peak: -90, peakT: 0, txt: '' };
      listen.textContent = 'Arrêter l’écoute'; listen.classList.add('live');
      micMsg.textContent = `Écoute de « ${dev.label} ».`;
      const pos = db => clamp((db + 60) / 60, 0, 1);
      const tick = now => {
        if (!mic) return;
        an.getFloatTimeDomainData(buf);
        let sum = 0, pk = 0; for (const v of buf) { sum += v * v; pk = Math.max(pk, Math.abs(v)); }
        const rms = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6), pdb = 20 * Math.log10(pk || 1e-6);
        if (pdb > mic.peak || now - mic.peakT > 1500) { mic.peak = pdb; mic.peakT = now; }
        vuFill.style.transform = `scaleX(${pos(rms)})`; vuPeak.style.left = pos(mic.peak) * 100 + '%';
        const t = (rms < -89 ? '−∞' : fr(rms, 1)) + ' dBFS';
        if (t !== mic.txt) { mic.txt = t; vuVal.textContent = t; }
        mic.raf = requestAnimationFrame(tick);
      };
      mic.raf = requestAnimationFrame(tick);
    } catch (e) {
      micMsg.textContent = e?.name === 'NotAllowedError' ? 'Accès au micro refusé.' : 'Micro indisponible : ' + (e?.message || e);
    }
  }, 'btn-line');

  const scale = h('div', { class: 'vu-scale' }, ['−60', '−48', '−36', '−24', '−12', '0'].map(s => h('span', {}, s)));
  return {
    el: h('div', { class: 'tab-body' }, btHint,
      panel('Haut-parleur', h('div', { class: 'row-btns' }, play), spkMsg),
      panel('Micro', h('div', { class: 'row-btns' }, listen, vuVal), h('div', { class: 'vu' }, vuFill, vuPeak), scale, micMsg)),
    stop: stopMic,
    setBt(bt) { btHint.hidden = !bt; },
  };
}

// ---------- screen ----------
export default function tester() {
  let pad = createController(), padEdge = false;
  const cov = coverage(), trg = triggers(), mot = motion(), tp = touchpad(), bat = battery(), hap = haptics(), aud = audio();
  const refreshOutputs = () => pad.setOutputs(S);
  const lig = lights(refreshOutputs);
  cov.setEdge(false);

  const TABS = [
    { value: 'sensors', label: 'Capteurs', el: h('div', { class: 'tab-body' }, mot.el, tp.el, bat.el) },
    { value: 'haptics', label: 'Haptique', el: hap.el },
    { value: 'lights', label: 'Lumières', el: lig },
    { value: 'audio', label: 'Audio', el: aud.el },
  ];
  let tab = 'sensors';
  const body = h('div', { class: 'tabs-body' }, TABS.map(t => t.el));
  const showTab = v => { tab = v; TABS.forEach(t => { t.el.hidden = t.value !== v; }); };
  const tabs = segmented({ options: TABS, value: tab, label: 'Panneaux du testeur', onChange: showTab });
  showTab(tab);

  const padBox = h('div', { class: 'pad-box' }, pad.el);
  const el = h('section', { class: 'screen scr-test', 'aria-label': 'Testeur' },
    h('div', { class: 'test-l' }, padBox, cov.el, trg.el),
    h('div', { class: 'test-r' }, tabs.el, body));

  function checkModel() {
    const e = isEdge();
    if (e !== padEdge) { padEdge = e; pad = createController({ edge: e }); padBox.replaceChildren(pad.el); cov.setEdge(e); refreshOutputs(); }
    aud.setBt(S.status?.controller?.transport === 'bt');
  }
  sub('status', checkModel);

  let unsub = null;
  return {
    num: '03', title: 'Testeur', el, needsController: true,
    enter() {
      send({ t: 'testerActive', on: true });
      checkModel(); refreshOutputs(); pad.reset(); mot.reset();
      unsub = sub('frame', m => { const s = m.s; if (!s) return; mot.onFrame(s); tp.onFrame(s); bat.onFrame(s); });
    },
    leave() {
      unsub?.(); unsub = null;
      hap.reset(); aud.stop();
      send({ t: 'testerActive', on: false });
    },
    render() {
      const s = S.frame; if (!s) return;
      pad.update(s, S.last); cov.update(s.b); trg.update(s);
      if (tab === 'sensors') { mot.render(); tp.render(); }
    },
  };
}
