// 01 Correction — live scopes, stick & trigger parameters, centre calibration, profiles.
import { send } from '../bridge.js';
import { S, sub, setStick, setTrigger, stickSource, navigate } from '../state.js';
import { h, setText, setClass, slider, toggle, segmented, button } from '../ui.js';
import { Scope } from '../scope.js';
import { captureRest } from '../capture.js';
import { fr, frs, pct, clamp } from '../math.js';

const CURVES = [{ value: 1, label: 'Linéaire' }, { value: 1.6, label: 'Précise' }, { value: 0.75, label: 'Réactive' }];
const p100 = v => fr(v * 100, 1) + ' %';

/** ISO date → « 23/11 · 18:52 » (local time). */
function frDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function readout(label, n = 2) {
  const vals = Array.from({ length: n }, () => h('span', { class: 'ro-v' }));
  return { el: h('div', { class: 'ro' }, h('span', { class: 'lbl' }, label), h('span', { class: 'ro-vals' }, vals)), vals };
}

function stickColumn(side) {
  const name = side === 'L' ? 'Stick gauche' : 'Stick droit';
  const canvas = h('canvas', { class: 'scope', 'aria-label': `Oscilloscope ${name}` });
  const scope = new Scope(canvas);
  const hint = h('div', { class: 'scope-hint' });
  const ro = { raw: readout('Brut'), out: readout('Corrigé'), amp: readout('Amplitude', 1), off: readout('Décalage', 1) };

  const P = () => S.profile?.sticks[side];
  // Any slider move marks the stick as hand-tuned (diag / diagnosedAt stay untouched).
  const set = (k, v) => setStick(side, { [k]: v, source: 'manual' });
  const ctl = {
    deadzone: slider({ label: 'Zone morte', min: 0, max: 0.3, step: 0.001, value: 0.05, format: p100, onInput: v => set('deadzone', v) }),
    outer: slider({ label: 'Zone externe', min: 0.7, max: 1, step: 0.001, value: 0.97, format: p100, onInput: v => set('outer', v) }),
    curve: slider({ label: 'Courbe', min: 0.4, max: 3, step: 0.01, value: 1, format: v => fr(v, 2), onInput: v => { set('curve', v); preset.set(v); } }),
    anti: slider({ label: 'Anti-zone morte', min: 0, max: 0.4, step: 0.001, value: 0, format: p100, onInput: v => set('antiDeadzone', v) }),
  };
  const preset = segmented({ options: CURVES, value: 1, small: true, label: 'Préréglage de courbe', onChange: v => { ctl.curve.set(v); set('curve', v); } });
  const track = toggle({ label: 'Suivi du drift', onChange: v => setStick(side, { tracking: v }, true) });

  const controls = h('div', { class: 'ctl' },
    ctl.deadzone.el, ctl.outer.el,
    h('div', { class: 'curve' }, ctl.curve.el, preset.el),
    ctl.anti.el, track.el);
  const scopeBtns = h('div', { class: 'ctl-btns' },
    button('Calibrer le centre', () => startCalib(), 'btn-line'),
    button('Réinitialiser', () => send({ t: 'resetStick', side }), 'btn-ghost'));

  // ---- inline centre calibration ----
  const calTitle = h('p', { class: 'cal-say' });
  const calBody = h('div', { class: 'cal-body' });
  const calBtns = h('div', { class: 'ctl-btns' });
  const calPanel = h('div', { class: 'cal', hidden: true }, h('span', { class: 'lbl' }, 'Calibrage du centre'), calTitle, calBody, calBtns);
  let cancelCap = null;

  function endCalib() {
    cancelCap?.(); cancelCap = null;
    if (scope.progress != null) send({ t: 'calibrating', on: false });
    scope.progress = null; scope.preview = null;
    calPanel.hidden = true; controls.hidden = false; scopeBtns.hidden = false; setText(hint, '');
  }
  function startCalib() {
    controls.hidden = true; scopeBtns.hidden = true; calPanel.hidden = false;
    calTitle.textContent = 'Pose la manette. Ne touche à rien.';
    calBody.replaceChildren(h('span', { class: 'cal-count' }, '2,0 s'));
    calBtns.replaceChildren(button('Annuler', endCalib, 'btn-ghost'));
    send({ t: 'calibrating', on: true });
    scope.progress = 0;
    cancelCap = captureRest(side, 2000, {
      onProgress: k => { scope.progress = k; setText(calBody.firstChild, fr((1 - k) * 2, 1) + ' s'); },
      onRestart: () => setText(hint, 'Mouvement détecté — on recommence.'),
      onDone: r => {
        cancelCap = null;
        send({ t: 'calibrating', on: false });
        scope.progress = null; setText(hint, '');
        const dz = clamp(Math.max(0.02, r.max + 0.012), 0, 0.3);
        scope.preview = { cx: r.cx, cy: r.cy, deadzone: dz };
        calTitle.textContent = 'Mesure terminée.';
        const row = (k, v, cls = '') => h('div', { class: 'kv ' + cls }, h('span', { class: 'lbl' }, k), h('span', { class: 'kv-v' }, v));
        calBody.replaceChildren(
          row('Décalage', `${frs(r.cx)}  ${frs(r.cy)}`),
          row('Bruit 99 % / max', `${pct(r.p99)} / ${pct(r.max)}`),
          row('Zone morte proposée', pct(dz), 'kv-big'));
        calBtns.replaceChildren(
          button('Appliquer', () => { setStick(side, { cx: +r.cx.toFixed(4), cy: +r.cy.toFixed(4), deadzone: +dz.toFixed(4), source: 'calibration' }, true); endCalib(); sync(); }, 'btn-acc'),
          button('Annuler', endCalib, 'btn-ghost'));
      },
    });
  }

  // ---- origin of the current settings (diagnostic / calibration / manual / default) ----
  const origin = h('div', { class: 'origin' });
  let originKey = '';
  const diagBtn = label => button(label, () => navigate(1, { side }), 'btn-link');
  function renderOrigin() {
    const p = P(); if (!p) return;
    const src = stickSource(p), d = p.diag;
    const key = [src, p.diagnosedAt, d?.deadzone, d?.cx, d?.cy].join('|');
    if (key === originKey) return;
    originKey = key;
    const txt = (s, cls = '') => h('span', { class: 'origin-t ' + cls }, s);
    if (src === 'diagnostic') {
      origin.replaceChildren(txt(p.diagnosedAt ? `Basé sur le diagnostic du ${frDate(p.diagnosedAt)}` : 'Basé sur le diagnostic', 'acc'));
    } else if (src === 'manual' && d && Number.isFinite(d.deadzone)) {
      origin.replaceChildren(txt(`Ajusté à la main · le diagnostic conseillait ${pct(d.deadzone)}`),
        button('Revenir au diagnostic', () => {
          const q = { cx: d.cx ?? p.cx, cy: d.cy ?? p.cy, deadzone: d.deadzone, source: 'diagnostic' };
          if (Number.isFinite(d.outer)) q.outer = d.outer;
          setStick(side, q, true); sync();
        }, 'btn-link'));
    } else if (src === 'calibration') {
      origin.replaceChildren(txt('Centre calibré au repos (2 s)'), diagBtn('Faire le diagnostic complet'));
    } else if (src === 'manual') {
      origin.replaceChildren(txt('Ajusté à la main — ce stick n’a pas été diagnostiqué', 'dim'), diagBtn('Diagnostiquer'));
    } else {
      origin.replaceChildren(txt('Réglages standard — ce stick n’a pas été diagnostiqué', 'dim'), diagBtn('Diagnostiquer'));
    }
  }
  sub('stickParams', s => { if (s === side) renderOrigin(); });

  const el = h('div', { class: 'stick' },
    h('div', { class: 'col-head' }, h('h2', { class: 'h2' }, name), h('span', { class: 'lbl' }, side === 'L' ? 'L3' : 'R3')),
    origin,
    h('div', { class: 'stick-body' },
      h('div', { class: 'scope-col' }, h('div', { class: 'scope-box' }, canvas, hint),
        h('div', { class: 'ros' }, ro.raw.el, ro.out.el, ro.amp.el, ro.off.el), scopeBtns),
      h('div', { class: 'ctl-col' }, controls, calPanel)));

  function sync() {
    const p = P(); if (!p) return;
    ctl.deadzone.set(p.deadzone); ctl.outer.set(p.outer); ctl.curve.set(p.curve); ctl.anti.set(p.antiDeadzone);
    preset.set(CURVES.find(c => Math.abs(c.value - p.curve) < 0.005)?.value);
    track.set(p.tracking);
    renderOrigin();
  }

  return {
    el, sync, endCalib,
    render(now, slow) {
      const p = P(); if (!p) return;
      const c = S.center[side] || [p.cx, p.cy];
      scope.params.cx = c[0]; scope.params.cy = c[1]; scope.params.deadzone = p.deadzone; scope.params.outer = p.outer;
      scope.render(now, S.trails[side], S.last[side]);
      if (slow) {
        const l = S.last[side];
        setText(ro.raw.vals[0], frs(l[0])); setText(ro.raw.vals[1], frs(l[1]));
        setText(ro.out.vals[0], frs(l[2])); setText(ro.out.vals[1], frs(l[3]));
        setText(ro.amp.vals[0], p100(Math.hypot(l[2], l[3])));
        setText(ro.off.vals[0], p100(Math.hypot(c[0], c[1])));
      }
    },
  };
}

function triggerColumn(side) {
  const name = side === 'L' ? 'L2' : 'R2';
  const key = side === 'L' ? 'l2' : 'r2';
  const raw = h('i', { class: 'tb-raw' }), cor = h('i', { class: 'tb-cor' });
  const mDz = h('i', { class: 'tb-mark' }), mOut = h('i', { class: 'tb-mark' });
  const vRaw = h('span', { class: 'tv' }), vCor = h('span', { class: 'tv acc' });
  const P = () => S.profile?.triggers[side];
  const dz = slider({ label: 'Zone morte', min: 0, max: 0.3, step: 0.001, value: 0.02, compact: true, format: p100, onInput: v => { setTrigger(side, { deadzone: v }); marks(); } });
  const out = slider({ label: 'Zone externe', min: 0.7, max: 1, step: 0.001, value: 0.98, compact: true, format: p100, onInput: v => { setTrigger(side, { outer: v }); marks(); } });
  function marks() {
    const p = P(); if (!p) return;
    mDz.style.left = p.deadzone * 100 + '%'; mOut.style.left = p.outer * 100 + '%';
  }
  const el = h('div', { class: 'trg' },
    h('span', { class: 'h2 trg-name' }, name),
    h('div', { class: 'trg-main' },
      h('div', { class: 'trg-bars' },
        h('div', { class: 'tb' }, h('span', { class: 'lbl' }, 'Brut'), h('div', { class: 'tb-track' }, raw, mDz, mOut), vRaw),
        h('div', { class: 'tb' }, h('span', { class: 'lbl' }, 'Corrigé'), h('div', { class: 'tb-track' }, cor), vCor)),
      h('div', { class: 'trg-sl' }, dz.el, out.el)));
  let lr = -1, lc = -1;
  return {
    el,
    sync() { const p = P(); if (!p) return; dz.set(p.deadzone); out.set(p.outer); marks(); },
    render() {
      const s = S.frame; if (!s) return;
      const r = s[key], c = s[key + 'c'];
      if (r !== lr) { lr = r; raw.style.transform = `scaleX(${r / 255})`; setText(vRaw, String(r).padStart(3, ' ')); }
      if (c !== lc) { lc = c; cor.style.transform = `scaleX(${c / 255})`; setText(vCor, String(c).padStart(3, ' ')); }
    },
  };
}

function profileBar() {
  const select = h('select', { class: 'sel', id: 'prof-sel', 'aria-label': 'Profil actif', onchange: e => send({ t: 'profileLoad', name: e.target.value }) });
  const input = h('input', { class: 'inp', type: 'text', placeholder: 'Nom du profil', maxlength: 40, 'aria-label': 'Nom du nouveau profil' });
  const form = h('form', { class: 'saveas', hidden: true }, input, h('button', { class: 'btn btn-acc btn-sm', type: 'submit' }, 'Enregistrer'),
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => close() }, 'Annuler'));
  const openBtn = button('Enregistrer sous…', () => { form.hidden = false; openBtn.hidden = true; input.value = S.settings.activeProfile || ''; input.focus(); input.select(); }, 'btn-link');
  const close = () => { form.hidden = true; openBtn.hidden = false; };
  form.addEventListener('submit', e => { e.preventDefault(); const n = input.value.trim(); if (n) { send({ t: 'profileSave', name: n }); close(); } });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  const fill = () => {
    select.replaceChildren(...S.profiles.map(n => h('option', { value: n }, n)));
    select.value = S.settings.activeProfile;
  };
  sub('profiles', fill); sub('settings', fill);
  return h('div', { class: 'pbar' },
    h('label', { class: 'lbl', for: 'prof-sel' }, 'Profil'), select, openBtn, form,
    h('div', { class: 'legend' },
      h('span', { class: 'lg lg-raw' }, 'Brut'), h('span', { class: 'lg lg-cor' }, 'Corrigé'),
      h('span', { class: 'lg lg-dz' }, 'Zone morte'), h('span', { class: 'lg lg-out' }, 'Zone externe')));
}

export default function correction() {
  const L = stickColumn('L'), R = stickColumn('R');
  const TL = triggerColumn('L'), TR = triggerColumn('R');
  const el = h('section', { class: 'screen scr-corr', 'aria-label': 'Correction' },
    profileBar(),
    h('div', { class: 'sticks' }, L.el, R.el),
    h('div', { class: 'trigs' }, h('div', { class: 'col-head' }, h('h2', { class: 'h2' }, 'Gâchettes'), h('span', { class: 'lbl' }, '0 – 255')), TL.el, TR.el));
  const syncAll = () => { L.sync(); R.sync(); TL.sync(); TR.sync(); };
  sub('profile', syncAll);
  let n = 0;
  return {
    num: '01', title: 'Correction', el, needsController: true,
    enter() { syncAll(); },
    leave() { L.endCalib(); R.endCalib(); },
    render(now) {
      const slow = (n++ & 3) === 0;
      L.render(now, slow); R.render(now, slow); TL.render(); TR.render();
    },
  };
}
