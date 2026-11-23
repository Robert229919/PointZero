// Shell: rail, header, master switch, status block, screen switching, single rAF loop.
import { send, isMock } from './bridge.js';
import { S, sub, startBridge, isConnected, hideRealOn, setHideReal, helperHint } from './state.js';
import { h, setText, setClass, toggle, toast } from './ui.js';
import { outlineOnly } from './controller-svg.js';
import correction from './screens/correction.js';
import diagnostic from './screens/diagnostic.js';
import tester from './screens/tester.js';
import settings from './screens/settings.js';
import './update.js';

const $ = id => document.getElementById(id);
const screens = [correction(), diagnostic(), tester(), settings()];
let current = null;

// ---- navigation ----
const nav = $('nav');
const navBtns = screens.map((sc, i) => {
  const b = h('button', { type: 'button', class: 'nav-b', onclick: () => go(i) },
    h('span', { class: 'nav-n' }, sc.num), h('span', { class: 'nav-t' }, sc.title));
  nav.append(b);
  $('main').append(sc.el);
  return b;
});
nav.addEventListener('keydown', e => {
  const i = navBtns.indexOf(document.activeElement);
  if (i < 0) return;
  const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : -1;
  if (j >= 0 && j < navBtns.length) { e.preventDefault(); navBtns[j].focus(); }
});

const enter = sc => { if (!sc._in) { sc._in = true; sc.enter?.(); } };
const leave = sc => { if (sc?._in) { sc._in = false; sc.leave?.(); } };
function animateIn(el) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }

function go(i) {
  const next = screens[i];
  if (next === current) return;
  if (current) { leave(current); current.el.classList.remove('active'); }
  current = next;
  navBtns.forEach((b, k) => { b.classList.toggle('active', k === i); b.setAttribute('aria-current', k === i ? 'page' : 'false'); });
  setText($('secnum'), next.num);
  setText($('sectitle'), next.title);
  next.el.classList.add('active');
  try { localStorage.setItem('pz.screen', String(i)); } catch {}
  emptyShown = null;
  updateEmpty();
}

// ---- master switch ----
const master = toggle({ big: true, checked: false, onChange: v => {
  send({ t: 'setCorrection', on: v });
  if (S.status) S.status.correction = v;
  renderMaster(v); renderHide(); helperHint();
} });
master.btn.setAttribute('aria-label', 'Correction');
master.btn.id = 'msw';
$('master').append(master.el);
function renderMaster(on) {
  master.set(on);
  setText($('mstate'), on ? 'Active' : 'Coupée');
  setClass($('mstate'), 'on', on);
  setClass(document.body, 'corr-on', on);
}

// ---- real pad visibility (hideReal) ----
const hideSw = toggle({ checked: true, onChange: v => { setHideReal(v); renderHide(); } });
hideSw.btn.classList.add('sw-mid');
hideSw.btn.setAttribute('aria-label', 'Cacher la vraie manette aux jeux');
$('hidectl').append(hideSw.el);
const driversMissing = () => { const d = S.status?.drivers; return !!d && (!d.vigem || !d.hidhide); };
function renderHide() {
  const st = S.status, box = $('hidectl');
  const missing = driversMissing(), corr = !!st?.correction;
  const hidden = !missing && corr && hideRealOn();
  hideSw.set(hidden);
  hideSw.btn.disabled = !st || missing || !corr;
  setText($('hstate'), !st ? '—' : missing ? 'Indisponible' : hidden ? 'Cachée' : 'Visible');
  setClass($('hstate'), 'on', hidden);
  setClass(box, 'off', hideSw.btn.disabled);
  box.title = missing ? 'Pilotes manquants — la vraie manette reste visible'
    : !corr ? 'Active la correction pour pouvoir la cacher'
    : hidden ? 'Les jeux ne voient que la manette virtuelle'
    : 'Les jeux voient la vraie manette et la manette virtuelle';
}

// ---- empty state ----
const empty = $('empty');
empty.prepend(outlineOnly());
let emptyShown = false;
function updateEmpty() {
  const show = !!current?.needsController && S.status != null && !isConnected();
  if (show === emptyShown) return;
  emptyShown = show;
  empty.classList.toggle('show', show);
  current.el.classList.toggle('hidden', show);
  if (show) { leave(current); animateIn(empty); } else { enter(current); animateIn(current.el); }
}

// ---- status block ----
const VNAME = { x360: 'Xbox 360', ds4: 'DualShock 4' };
function renderStatus() {
  const st = S.status;
  if (!st) return;
  renderMaster(!!st.correction);
  const led = (id, on) => setClass($(id), 'on', !!on);
  led('led-corr', st.correction && st.virtual?.connected);
  led('led-cloak', st.cloaked);
  const by = st.helper?.blockedBy, reco = !!st.helper?.needsReconnect;
  const bl = [by && `${by} garde la manette ouverte`, reco && 'Reconnecte la manette'].filter(Boolean).join(' · ');
  setText($('blocked'), bl);
  setClass($('blocked'), 'show', !!bl);
  led('led-virt', st.virtual?.connected);
  const v = st.virtual || {};
  setText($('virt-label'), `Manette virtuelle ${VNAME[v.type] || VNAME[S.settings.virtualType] || ''}${v.slot ? ' · J' + v.slot : ''}`);
  const drv = st.drivers || {};
  const missing = [!drv.vigem && 'ViGEmBus', !drv.hidhide && 'HidHide'].filter(Boolean);
  setText($('drv'), missing.length ? `${missing.join(' et ')} ${missing.length > 1 ? 'manquants' : 'manquant'} — Point Zéro ne fonctionne qu’en testeur.` : '');
  setClass($('drv'), 'show', missing.length > 0);
  master.btn.disabled = missing.length > 0;
  if (missing.length) { setText($('mstate'), 'Indisponible'); setClass($('mstate'), 'on', false); }
  renderHide();
  setText($('err'), st.error || '');
  setClass($('err'), 'show', !!st.error);
  renderPadLine();
  updateEmpty();
}
let lastPad = '';
function renderPadLine() {
  const c = S.status?.controller;
  let s = 'Aucune manette';
  if (c?.connected) {
    const bat = S.frame?.bat;
    s = `${c.model || 'DualSense'} · ${c.transport === 'bt' ? 'Bluetooth' : 'USB'}${bat ? ` · ${bat.level} %${bat.charging ? ' ↑' : ''}` : ''}`;
  }
  if (s !== lastPad) { lastPad = s; $('padline').textContent = s; setClass($('padline'), 'off', !c?.connected); }
}

sub('status', renderStatus);
sub('settings', () => { setText($('ver'), S.version ? 'v' + S.version : ''); renderHide(); });
sub('hideReal', renderHide);
sub('navigate', ({ screen }) => go(screen));
sub('toast', toast);

// ---- loop ----
let lastBat = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (current && !emptyShown) current.render?.(now);
  if (now - lastBat > 1000) { lastBat = now; renderPadLine(); }
}

let start = 0;
try { start = Math.min(3, Math.max(0, +localStorage.getItem('pz.screen') || 0)); } catch {}
go(start);
if (isMock) document.documentElement.dataset.mock = '1';
startBridge();
requestAnimationFrame(loop);
