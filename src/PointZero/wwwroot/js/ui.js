// Small DOM helpers and form controls.
import { fr } from './math.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

/** Sets textContent only when it actually changes. */
export function setText(el, s) { if (el._t !== s) { el._t = s; el.textContent = s; } }
export function setClass(el, cls, on) { const k = '_c' + cls; if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); } }

let uid = 0;
/** Range slider: thin track, square thumb, accent fill, mono value. */
export function slider({ label, min, max, step, value, format = v => fr(v, 1), onInput, compact = false }) {
  const id = 'sl' + ++uid;
  const val = h('output', { class: 'sl-val', for: id });
  const input = h('input', { type: 'range', id, min, max, step, value });
  const fill = h('span', { class: 'sl-fill' });
  const el = h('div', { class: 'sl' + (compact ? ' sl-compact' : '') },
    h('div', { class: 'sl-head' }, h('label', { for: id, class: 'sl-lbl' }, label), val),
    h('div', { class: 'sl-track' }, h('span', { class: 'sl-rail' }), fill, input));
  let dragging = false;
  const paint = v => {
    fill.style.transform = `scaleX(${(v - min) / (max - min)})`;
    setText(val, format(v));
  };
  input.addEventListener('pointerdown', () => { dragging = true; el.classList.add('drag'); });
  const end = () => { dragging = false; el.classList.remove('drag'); };
  input.addEventListener('pointerup', end); input.addEventListener('pointercancel', end); input.addEventListener('blur', end);
  input.addEventListener('input', () => { const v = +input.value; paint(v); onInput?.(v); });
  paint(+value);
  return {
    el, input,
    set(v) { if (dragging || document.activeElement === input && el.matches(':active')) return; input.value = v; paint(+input.value); },
    get value() { return +input.value; },
    disable(d) { input.disabled = d; el.classList.toggle('off', d); },
  };
}

/** Toggle switch (button role=switch). */
export function toggle({ label, checked = false, onChange, big = false, hint }) {
  const btn = h('button', { class: 'sw' + (big ? ' sw-big' : ''), role: 'switch', 'aria-checked': String(checked), type: 'button' },
    h('span', { class: 'sw-knob' }));
  const el = label
    ? h('label', { class: 'sw-row' }, h('span', { class: 'sw-txt' }, h('span', { class: 'sw-lbl' }, label), hint ? h('span', { class: 'hint' }, hint) : null), btn)
    : btn;
  if (label) btn.setAttribute('aria-label', label);
  let state = checked;
  const set = v => { state = !!v; btn.setAttribute('aria-checked', String(state)); };
  btn.addEventListener('click', e => { e.preventDefault(); set(!state); onChange?.(state); });
  return { el, btn, set, get checked() { return state; } };
}

/** Segmented choice. options: [{value, label}] */
export function segmented({ options, value, onChange, label, small = false }) {
  const el = h('div', { class: 'seg' + (small ? ' seg-sm' : ''), role: 'radiogroup', 'aria-label': label || '' });
  const btns = options.map(o => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', class: 'seg-b' }, o.label);
    b.addEventListener('click', () => { set(o.value); onChange?.(o.value); });
    el.append(b); return [o.value, b];
  });
  let cur;
  function set(v) { cur = v; for (const [k, b] of btns) b.setAttribute('aria-checked', String(k === v)); }
  set(value);
  return { el, set, get value() { return cur; } };
}

export function button(label, onClick, cls = '') {
  return h('button', { type: 'button', class: 'btn ' + cls, onclick: onClick }, label);
}

/** Canvas with devicePixelRatio-aware backing store, resized from its CSS box. */
export function hiDpiCanvas(canvas, onResize) {
  const ctx = canvas.getContext('2d');
  const fit = () => {
    const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    const w = Math.round(r.width * d), hh = Math.round(r.height * d);
    if (canvas.width !== w || canvas.height !== hh) {
      canvas.width = w; canvas.height = hh;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      onResize?.(r.width, r.height);
    }
  };
  new ResizeObserver(fit).observe(canvas);
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener?.('change', fit);
  return { ctx, fit, get w() { return canvas.width / (devicePixelRatio || 1); }, get h() { return canvas.height / (devicePixelRatio || 1); } };
}

export function toast(text, ms = 2600) {
  if (text && typeof text === 'object') ({ text, ms = 2600 } = text);
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast' }, text);
  box.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 260); }, ms);
}

export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
