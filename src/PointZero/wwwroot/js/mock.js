// Host simulator for browser development (only loaded when window.chrome.webview is absent).
//
// Clavier :
//   WASD / flèches     stick gauche            I J K L        stick droit
//   R                  rotation continue du stick gauche (Maj+R : stick droit)
//   1 2 3 4            carré, croix, rond, triangle
//   Q / O              L1 / R1                 E / U          L2 / R2 (analogiques, montée progressive)
//   F / ;              L3 / R3                 C / V          Create / Options
//   P / M              PS / Mute               5 6 7 8        croix directionnelle haut, bas, gauche, droite
//   T / H              doigt 1 / doigt 2 sur le pavé tactile, Y = clic du pavé
//   G                  brancher / débrancher la manette
//   B                  bascule USB / Bluetooth
//   X                  pilotes ViGEmBus + HidHide absents / présents
//   N                  stick gauche « usé » (bruit fort + sauts) pour tester le verdict du diagnostic
//   Z                  cycle helper : rien → blockedBy (MoonSweepers.exe) → blockedBy + needsReconnect (K est déjà le stick droit)
//                      G (débrancher puis rebrancher) efface needsReconnect
//
// Actualisation (helper) : absente au départ ; helperInstall l’installe après 600 ms, refreshPad dure 800 ms.

import { DEFAULT_STICK, DEFAULT_TRIGGER, clamp, correctStick, correctTrigger } from './math.js';

const SAMPLE_MS = 4; // 250 Hz
const r4 = v => Math.round(v * 10000) / 10000;
const clone = o => structuredClone(o);
const NO_DIAG = { source: 'default', diagnosedAt: null, diag: null };

function makeProfile(name, stick = {}) {
  return {
    name,
    sticks: { L: { ...DEFAULT_STICK, ...NO_DIAG, ...stick }, R: { ...DEFAULT_STICK, ...NO_DIAG, ...stick } },
    triggers: { L: { ...DEFAULT_TRIGGER }, R: { ...DEFAULT_TRIGGER } },
  };
}

export function createMock(emit) {
  const out = m => setTimeout(() => emit(clone(m)), 0);

  const profiles = new Map([
    ['Défaut', makeProfile('Défaut')],
    ['FPS', makeProfile('FPS', { deadzone: 0.08, curve: 1.6 })],
  ]);
  // FPS: right stick diagnosed once, then hand-tuned (exercises « Ajusté à la main »).
  Object.assign(profiles.get('FPS').sticks.R, {
    cx: 0.004, cy: -0.003, source: 'manual', diagnosedAt: '2026-11-20T21:14:00.000Z',
    diag: { offset: 0.005, spread: 0.012, noise: 0.004, deadzone: 0.028, outer: 0.975, minAmplitude: 0.985, circularity: 0.012, jumps: 0, verdict: 'excellent', cx: 0.004, cy: -0.003 },
  });
  const settings = {
    activeProfile: 'Défaut', virtualType: 'x360', correction: true, hideReal: true,
    autostart: false, closeToTray: true, startMinimized: false, checkUpdates: true,
    whitelist: ['C:\\Program Files\\BatteryHub\\BatteryHub.exe'],
  };
  const ctrl = { connected: true, model: 'DualSense', transport: 'usb', firmware: '0x0630' };
  const drivers = { vigem: true, hidhide: true };
  const helper = { installed: false, refreshing: false, blockedBy: null, needsReconnect: false };
  const BLOCKER = 'MoonSweepers.exe';
  let blocker = false;   // a game launched before Point Zéro holds the pad
  const blockedToast = () => out({ t: 'toast', text: `${BLOCKER} garde la manette ouverte : ferme-la, puis « Actualiser maintenant ».` });
  let calibrating = false, worn = false;

  const profile = () => profiles.get(settings.activeProfile);
  const status = () => {
    const on = settings.correction && ctrl.connected;
    return {
      t: 'status', controller: { ...ctrl }, drivers: { ...drivers },
      correction: settings.correction, hideReal: settings.hideReal,
      cloaked: on && drivers.hidhide && settings.hideReal,
      virtual: { connected: on && drivers.vigem, type: settings.virtualType, slot: on && drivers.vigem ? 1 : 0 },
      helper: { ...helper },
      error: null,
    };
  };
  // Pad restart through the helper (no-op while it is not installed).
  let refreshTimer = 0;
  const refresh = (quiet = true) => {
    if (!helper.installed) return;
    if (helper.needsReconnect) { out(status()); return; }   // Windows ignores restarts until the pad is reconnected
    helper.refreshing = true; out(status());
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      helper.refreshing = false;
      helper.blockedBy = blocker ? BLOCKER : null;
      out(status());
      if (blocker) blockedToast(); else if (!quiet) out({ t: 'toast', text: 'Manette actualisée' });
    }, 800);
  };
  const cloakedNow = () => status().cloaked;
  const profilesMsg = () => ({ t: 'profiles', list: [...profiles.keys()], active: settings.activeProfile });

  // ---- simulated sticks ----
  const mkStick = (base, drift) => ({ x: base[0], y: base[1], base, rest: [...base], drift, active: false, ang: 0, spin: false });
  const sticks = { L: mkStick([0.06, -0.03], true), R: mkStick([0, 0], false) };
  const center = { L: [0, 0], R: [0, 0] };
  const resetCenter = s => { const p = profile().sticks[s]; center[s] = [p.cx, p.cy]; };
  resetCenter('L'); resetCenter('R');

  const keys = new Set();
  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };
  addEventListener('keydown', e => {
    if (typing() || e.ctrlKey || e.altKey) return;
    if (e.code.startsWith('Arrow') && document.activeElement?.type === 'range') return;
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyR') { const s = e.shiftKey ? sticks.R : sticks.L; s.spin = !s.spin; }
    if (e.code === 'KeyG') { ctrl.connected = !ctrl.connected; if (ctrl.connected) helper.needsReconnect = false; out(status()); }
    if (e.code === 'KeyB') { ctrl.transport = ctrl.transport === 'usb' ? 'bt' : 'usb'; out(status()); }
    if (e.code === 'KeyX') { drivers.vigem = drivers.hidhide = !drivers.vigem; out(status()); }
    if (e.code === 'KeyZ') {
      if (!blocker) { blocker = true; helper.blockedBy = BLOCKER; blockedToast(); }
      else if (!helper.needsReconnect) helper.needsReconnect = true;
      else { blocker = false; helper.blockedBy = null; helper.needsReconnect = false; }
      out(status());
    }
    if (e.code === 'KeyN') { worn = !worn; out({ t: 'toast', text: worn ? 'Mock : stick gauche usé' : 'Mock : stick gauche normal' }); }
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const dirOf = (up, down, left, right) => {
    const x = (keys.has(right) ? 1 : 0) - (keys.has(left) ? 1 : 0);
    const y = (keys.has(up) ? 1 : 0) - (keys.has(down) ? 1 : 0);
    return [x, y];
  };
  // Mechanical gate: slightly non-circular maximum, like a real module.
  const maxMag = a => 0.985 + 0.02 * Math.cos(4 * a + 0.5) - 0.012 * Math.cos(a);

  function stepStick(s, dir, dt) {
    let tx, ty;
    if (s.spin) {
      s.ang += Math.PI * 2 * 0.7 * dt;
      const m = maxMag(s.ang); tx = Math.cos(s.ang) * m; ty = Math.sin(s.ang) * m;
    } else if (dir[0] || dir[1]) {
      const a = Math.atan2(dir[1], dir[0]); const m = maxMag(a);
      tx = Math.cos(a) * m; ty = Math.sin(a) * m;
    }
    const active = tx !== undefined;
    if (s.active && !active) {
      // settles at a slightly different point after each release
      const r = s.drift ? Math.sqrt(Math.random()) * 0.02 : Math.random() * 0.002;
      const a = Math.random() * Math.PI * 2;
      s.rest = [s.base[0] + Math.cos(a) * r, s.base[1] + Math.sin(a) * r];
    }
    s.active = active;
    if (!active) { tx = s.rest[0]; ty = s.rest[1]; }
    const k = 1 - Math.exp(-dt / (active ? 0.03 : 0.022));
    s.x += (tx - s.x) * k; s.y += (ty - s.y) * k;
  }

  const quant = v => clamp(Math.round((v + 1) * 127.5), 0, 255);
  function rawOf(s, wornNow) {
    const amp = s.drift ? (wornNow ? 0.03 : 0.008) : 0.0025;
    let x = s.x + (Math.random() * 2 - 1) * amp, y = s.y + (Math.random() * 2 - 1) * amp;
    if (wornNow && Math.hypot(s.x, s.y) > 0.7 && Math.random() < 0.004) { x *= 0.6; y *= 0.6; }
    const bx = quant(x), by = quant(-y); // bytes are y down
    return { bx, by, x: bx / 127.5 - 1, y: -(by / 127.5 - 1) };
  }

  // ---- other simulated inputs ----
  let l2 = 0, r2 = 0, t = 0, touchId = 0;
  const fingers = [{ on: false, id: 0 }, { on: false, id: 0 }];
  const ang = [0, 0, 0];

  let last = performance.now(), acc = 0;
  setInterval(() => {
    const now = performance.now();
    acc += Math.min(now - last, 100); last = now;
    if (!ctrl.connected) { acc = 0; return; }
    const n = Math.floor(acc / SAMPLE_MS); acc -= n * SAMPLE_MS;
    if (!n) return;
    const dt = SAMPLE_MS / 1000;
    const samples = { L: [], R: [] };
    let rl, rr;
    for (let i = 0; i < n; i++) {
      t += dt;
      stepStick(sticks.L, dirOf('KeyW', 'KeyS', 'KeyA', 'KeyD').map((v, j) => v || dirOf('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight')[j]), dt);
      stepStick(sticks.R, dirOf('KeyI', 'KeyK', 'KeyJ', 'KeyL'), dt);
      rl = rawOf(sticks.L, worn); rr = rawOf(sticks.R, false);
      for (const [side, r] of [['L', rl], ['R', rr]]) {
        const p = profile().sticks[side];
        const c = center[side];
        if (p.tracking && !calibrating && Math.hypot(r.x - c[0], r.y - c[1]) < p.deadzone * 0.9) {
          c[0] += (r.x - c[0]) * 0.002; c[1] += (r.y - c[1]) * 0.002;
        }
        const o = correctStick(r.x, r.y, { ...p, cx: c[0], cy: c[1] });
        samples[side].push([r4(r.x), r4(r.y), r4(o[0]), r4(o[1])]);
      }
    }
    const span = n * dt;
    l2 = clamp(l2 + (keys.has('KeyE') ? 1 : -1) * 1100 * span, 0, 255);
    r2 = clamp(r2 + (keys.has('KeyU') ? 1 : -1) * 1100 * span, 0, 255);
    const tp = profile().triggers;

    const map = { 0: 'Digit1', 1: 'Digit2', 2: 'Digit3', 3: 'Digit4', 4: 'KeyQ', 5: 'KeyO', 8: 'KeyC', 9: 'KeyV',
      10: 'KeyF', 11: 'Semicolon', 12: 'KeyP', 13: 'KeyY', 14: 'KeyM', 15: 'Digit5', 16: 'Digit6', 17: 'Digit7', 18: 'Digit8' };
    let b = 0;
    for (const bit in map) if (keys.has(map[bit])) b |= 1 << bit;
    if (l2 >= 250) b |= 1 << 6;
    if (r2 >= 250) b |= 1 << 7;

    // gentle hand movement
    const gyro = [7 * Math.sin(t * 0.9), 11 * Math.sin(t * 0.5 + 1), 5 * Math.sin(t * 1.3 + 2)].map(v => r4(v + (Math.random() - 0.5) * 0.3));
    for (let i = 0; i < 3; i++) ang[i] += gyro[i] * span * Math.PI / 180;
    const accel = [Math.sin(ang[2]), Math.cos(ang[0]) * Math.cos(ang[2]), Math.sin(ang[0])].map(v => r4(v + (Math.random() - 0.5) * 0.01));

    const finger = (i, on, fx, fy) => {
      if (on && !fingers[i].on) fingers[i].id = touchId = (touchId + 1) & 127;
      fingers[i].on = on;
      return { on, id: fingers[i].id, x: on ? Math.round(fx) : 0, y: on ? Math.round(fy) : 0 };
    };
    const touch = [
      finger(0, keys.has('KeyT'), 960 + 700 * Math.sin(t * 1.3), 540 + 380 * Math.sin(t * 1.9)),
      finger(1, keys.has('KeyH'), 960 + 500 * Math.cos(t * 0.8), 540 + 300 * Math.sin(t * 2.4 + 1)),
    ];

    emit({
      t: 'frame', samples,
      s: {
        lx: rl.bx, ly: rl.by, rx: rr.bx, ry: rr.by,
        l2: Math.round(l2), r2: Math.round(r2),
        l2c: correctTrigger(l2, tp.L), r2c: correctTrigger(r2, tp.R),
        b, gyro, accel, touch,
        bat: { level: 70, charging: ctrl.transport === 'usb', full: false },
        plug: { headphones: false, mic: false },
        hz: 250,
      },
      center: { L: center.L.map(r4), R: center.R.map(r4) },
    });
  }, 1000 / 60);

  // ---- UI → host ----
  function receive(m) {
    const p = profile();
    switch (m.t) {
      case 'ready':
        out({ t: 'hello', version: '1.0.0-mock', settings, profiles: [...profiles.keys()], profile: p, status: status() });
        break;
      case 'setCorrection': { const was = cloakedNow(); settings.correction = !!m.on; out(status()); if (was !== cloakedNow()) refresh(); break; }
      case 'setStick':
        Object.assign(p.sticks[m.side], m.params);
        if ('cx' in m.params || 'cy' in m.params) resetCenter(m.side);
        break;
      case 'setTrigger': Object.assign(p.triggers[m.side], m.params); break;
      case 'resetStick':
        p.sticks[m.side] = { ...DEFAULT_STICK, ...NO_DIAG }; resetCenter(m.side);
        out({ t: 'profile', profile: p });
        break;
      case 'calibrating': calibrating = !!m.on; break;
      case 'setVirtualType': settings.virtualType = m.type; out(status()); break;
      case 'profileSave':
        profiles.set(m.name, { ...clone(p), name: m.name });
        settings.activeProfile = m.name;
        out(profilesMsg()); out({ t: 'profile', profile: profile() }); out({ t: 'toast', text: 'Profil enregistré' });
        break;
      case 'profileLoad':
        if (profiles.has(m.name)) {
          settings.activeProfile = m.name; resetCenter('L'); resetCenter('R');
          out(profilesMsg()); out({ t: 'profile', profile: profile() });
        }
        break;
      case 'profileDelete':
        if (profiles.size > 1 && profiles.delete(m.name)) {
          if (settings.activeProfile === m.name) {
            settings.activeProfile = profiles.keys().next().value; out({ t: 'profile', profile: profile() });
          }
          out(profilesMsg());
        }
        break;
      case 'setting': {
        const was = cloakedNow();
        settings[m.key] = m.value;
        if (m.key === 'hideReal') { out(status()); if (was !== cloakedNow()) refresh(); }
        break;
      }
      case 'helperInstall':
        setTimeout(() => { helper.installed = true; out(status()); out({ t: 'toast', text: 'Actualisation automatique activée' }); }, 600);
        break;
      case 'helperRemove':
        helper.installed = false; helper.refreshing = false; helper.blockedBy = null; helper.needsReconnect = false; out(status()); out({ t: 'toast', text: 'Actualisation automatique désactivée' });
        break;
      case 'refreshPad':
        if (helper.installed) refresh(false);
        break;
      case 'checkUpdates':
        setTimeout(() => out({ t: 'update', version: '1.1.0', current: '1.0.0', url: 'https://github.com/Robert229919/PointZero/releases/tag/v1.1.0',
          name: 'v1.1.0', publishedAt: new Date().toISOString(),
          notes: '- Diagnostic : 16 retours au centre et marge plus sûre\n- Interrupteur « Vraie manette » visible / cachée\n- Actualisation de la manette pour Steam et les navigateurs' }), 400);
        break;
      case 'openUrl': case 'skipVersion':
        break;
      case 'whitelistAdd':
        settings.whitelist = [...settings.whitelist, 'C:\\Jeux\\Outils\\DSX\\DSX.exe'];
        out({ t: 'settings', settings });
        break;
      case 'whitelistRemove':
        settings.whitelist = settings.whitelist.filter(x => x !== m.path);
        out({ t: 'settings', settings });
        break;
      case 'unhideNow':
        settings.hideReal = false; out(status()); out({ t: 'toast', text: 'Vraie manette visible' });
        break;
      default:
        console.debug('[mock] ←', m);
    }
  }
  return { receive };
}
