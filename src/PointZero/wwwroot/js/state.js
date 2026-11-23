// Shared state fed by host messages + tiny event bus for screens.
import { on, send } from './bridge.js';
import { DEFAULT_STICK, DEFAULT_TRIGGER } from './math.js';

/** Fixed-size ring buffer of timestamped 2D points (trails, persistence). */
export class Trail {
  constructor(cap = 384) {
    this.cap = cap; this.x = new Float32Array(cap); this.y = new Float32Array(cap);
    this.t = new Float64Array(cap); this.i = 0; this.n = 0;
  }
  push(x, y, t) {
    this.x[this.i] = x; this.y[this.i] = y; this.t[this.i] = t;
    this.i = (this.i + 1) % this.cap; if (this.n < this.cap) this.n++;
  }
  /** index of the k-th newest point (k = 0 newest) */
  at(k) { return (this.i - 1 - k + this.cap * 2) % this.cap; }
  clear() { this.n = 0; }
}

export const S = {
  version: '',
  settings: { activeProfile: '', virtualType: 'x360', correction: false, hideReal: true, autostart: false, closeToTray: true, startMinimized: false, whitelist: [] },
  profiles: [],
  profile: null,
  status: null,
  frame: null,              // latest frame.s
  center: { L: [0, 0], R: [0, 0] },
  last: { L: [0, 0, 0, 0], R: [0, 0, 0, 0] },
  trails: { L: { raw: new Trail(), out: new Trail() }, R: { raw: new Trail(), out: new Trail() } },
  frameCount: 0,
  // outputs set by the UI (host does not report them back)
  lightbar: null, playerLeds: 0, muteLed: 0,
};

const subs = new Map();
export function sub(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, data) { const l = subs.get(evt); if (l) for (const f of l) f(data); }

function normProfile(p) {
  if (!p) return null;
  const st = k => ({ ...DEFAULT_STICK, ...(p.sticks?.[k] || {}) });
  const tr = k => ({ ...DEFAULT_TRIGGER, ...(p.triggers?.[k] || {}) });
  return { name: p.name, sticks: { L: st('L'), R: st('R') }, triggers: { L: tr('L'), R: tr('R') } };
}

on('hello', m => {
  S.version = m.version || '';
  Object.assign(S.settings, m.settings || {});
  S.profiles = m.profiles || [];
  S.profile = normProfile(m.profile);
  S.status = m.status || S.status;
  emit('settings'); emit('profiles'); emit('profile'); emit('status');
});
on('status', m => { S.status = m; emit('status'); });
on('profile', m => { S.profile = normProfile(m.profile); emit('profile'); });
on('profiles', m => { S.profiles = m.list || []; S.settings.activeProfile = m.active; emit('profiles'); });
// Not in protocol.md: proposed host message after whitelist changes (see report).
on('settings', m => { Object.assign(S.settings, m.settings || {}); emit('settings'); });
on('toast', m => emit('toast', m.text));

on('frame', m => {
  const now = performance.now();
  const hz = m.s?.hz || 250;
  for (const side of ['L', 'R']) {
    const list = m.samples?.[side];
    if (!list?.length) continue;
    const tr = S.trails[side];
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const p = list[i], t = now - (n - 1 - i) * (1000 / hz);
      tr.raw.push(p[0], p[1], t); tr.out.push(p[2], p[3], t);
    }
    S.last[side] = list[n - 1];
  }
  S.frame = m.s;
  if (m.center) S.center = m.center;
  S.frameCount++;
  emit('frame', m);
});

export const isConnected = () => !!S.status?.controller?.connected;

/** Merge stick params locally (instant visual feedback) and send them, throttled to ~30 Hz. */
const pending = { L: null, R: null, TL: null, TR: null };
let timer = 0;
function flush() {
  timer = 0;
  for (const side of ['L', 'R']) if (pending[side]) { send({ t: 'setStick', side, params: pending[side] }); pending[side] = null; }
  for (const side of ['L', 'R']) if (pending['T' + side]) { send({ t: 'setTrigger', side, params: pending['T' + side] }); pending['T' + side] = null; }
}
function queue(key, params) {
  pending[key] = { ...(pending[key] || {}), ...params };
  if (!timer) timer = setTimeout(flush, 33);
}
export function setStick(side, params, now = false) {
  if (S.profile) Object.assign(S.profile.sticks[side], params);
  queue(side, params); if (now) { clearTimeout(timer); flush(); }
  emit('stickParams', side);
}
export function setTrigger(side, params) {
  if (S.profile) Object.assign(S.profile.triggers[side], params);
  queue('T' + side, params);
}

/** Where the stick's current centre/deadzone come from (profile field, with fallback for older profiles). */
export function stickSource(p) {
  if (!p) return 'default';
  if (p.source) return p.source;
  return (Math.abs(p.cx) > 1e-6 || Math.abs(p.cy) > 1e-6) ? 'manual' : 'default';
}

/** User intent "hide the real pad while correcting" (status first, then settings). */
export const hideRealOn = () => (S.status?.hideReal ?? S.settings.hideReal ?? true) !== false;
export const helperInstalled = () => !!S.status?.helper?.installed;

let helperHinted = false;
/** Once per session: point at the pad-refresh helper after a change of the hidden state. */
export function helperHint() {
  if (helperHinted || !S.status || helperInstalled()) return;
  helperHinted = true;
  emit('toast', { text: 'Steam ou ton navigateur ne voient pas le changement ? Réglages → Actualisation de la manette.', ms: 6000 });
}

/** Toggle "hide the real pad" (optimistic local update; the host answers with status). */
export function setHideReal(v) {
  v = !!v;
  S.settings.hideReal = v;
  if (S.status) S.status.hideReal = v;
  send({ t: 'setting', key: 'hideReal', value: v });
  emit('hideReal');
  helperHint();
}

/** Ask the shell to show another screen. opts.side preselects a stick on the diagnostic. */
export const navigate = (screen, opts = {}) => emit('navigate', { screen, ...opts });

export function startBridge() { send({ t: 'ready' }); }
