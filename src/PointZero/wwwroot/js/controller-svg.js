// Original hairline illustration of a twin-grip controller with the DualSense layout.
// Every control has an id/data-bit and is animated from frame data.

const NS = 'http://www.w3.org/2000/svg';

// Left half of the body outline (cubic segments from top centre to bottom centre); mirrored for the right.
const HALF = [
  [[300, 58], [240, 58], [190, 56], [160, 62]],
  [[160, 62], [120, 70], [96, 92], [86, 126]],
  [[86, 126], [70, 180], [48, 270], [54, 318]],
  [[54, 318], [60, 352], [98, 368], [128, 356]],
  [[128, 356], [156, 344], [172, 314], [194, 286]],
  [[194, 286], [214, 262], [244, 262], [300, 262]],
];
export function bodyPath() {
  const m = p => [600 - p[0], p[1]];
  let d = `M${HALF[0][0]}`;
  for (const s of HALF) d += ` C${s[1]} ${s[2]} ${s[3]}`;
  for (let i = HALF.length - 1; i >= 0; i--) { const s = HALF[i]; d += ` C${m(s[2])} ${m(s[1])} ${m(s[0])}`; }
  return d + ' Z';
}

const DPAD = { 15: 0, 18: 90, 16: 180, 17: 270 };
const FACE = { 3: [450, 120], 2: [480, 150], 1: [450, 180], 0: [420, 150] };
const GLYPH = {
  3: '<path class="g" d="M0 -6.5 L5.8 3.8 H-5.8 Z"/>',
  2: '<circle class="g" r="5.6"/>',
  1: '<path class="g" d="M-5 -5 L5 5 M5 -5 L-5 5"/>',
  0: '<rect class="g" x="-4.8" y="-4.8" width="9.6" height="9.6"/>',
};
export const STICK = { L: [228, 220], R: [372, 220] };
const TRAVEL = 14;

function markup(edge) {
  const dpad = Object.entries(DPAD).map(([bit, a]) =>
    `<path class="k" data-bit="${bit}" transform="translate(150 150) rotate(${a})" d="M-9 -33 H9 V-15 L0 -6 L-9 -15 Z"/>`).join('');
  const face = Object.entries(FACE).map(([bit, [x, y]]) =>
    `<g class="k kf" data-bit="${bit}" transform="translate(${x} ${y})"><circle r="13.5"/>${GLYPH[bit]}</g>`).join('');
  const stick = s => {
    const [x, y] = STICK[s];
    return `<circle class="well" cx="${x}" cy="${y}" r="34"/>
      <circle class="travel" cx="${x}" cy="${y}" r="${TRAVEL}"/>
      <g id="cap${s}" class="k cap" data-bit="${s === 'L' ? 10 : 11}"><circle cx="${x}" cy="${y}" r="20"/><circle class="g" cx="${x}" cy="${y}" r="12.5"/></g>`;
  };
  const trig = (s, x) => `
    <g class="trig"><rect class="frame" x="${x}" y="8" width="96" height="20" rx="2"/>
      <rect id="t${s}2" class="fillr" x="${x}" y="8" width="0" height="20" rx="2"/>
      <rect class="k click" data-bit="${s === 'L' ? 6 : 7}" x="${s === 'L' ? x + 100 : x - 9}" y="8" width="5" height="20"/></g>
    <rect class="k" data-bit="${s === 'L' ? 4 : 5}" x="${x}" y="36" width="96" height="11" rx="2"/>`;
  const edgeParts = edge ? `
    <rect class="k" data-bit="19" x="252" y="246" width="16" height="6" rx="3"/>
    <rect class="k" data-bit="20" x="332" y="246" width="16" height="6" rx="3"/>
    <path class="k back" data-bit="21" d="M82 300 Q86 330 112 340"/>
    <path class="k back" data-bit="22" d="M518 300 Q514 330 488 340"/>` : '';
  const leds = [0, 1, 2, 3, 4].map(i => `<rect class="pled" data-led="${i}" x="${281 + i * 8}" y="165" width="6" height="2"/>`).join('');
  return `
  <svg class="pad-svg" viewBox="0 0 600 380" xmlns="${NS}" aria-hidden="true">
    <line class="axis" x1="300" y1="0" x2="300" y2="380"/>
    <text class="tl" x="108" y="22" text-anchor="end">L2</text><text class="tl" x="108" y="45" text-anchor="end">L1</text>
    <text class="tl" x="492" y="22">R2</text><text class="tl" x="492" y="45">R1</text>
    ${trig('L', 118)}${trig('R', 386)}
    <path class="body" d="${bodyPath()}"/>
    <path id="tp" class="k pad" data-bit="13" d="M206 64 H394 L388 148 Q300 160 212 148 Z"/>
    <g id="touches"><circle class="tch" r="5" cx="0" cy="0"/><circle class="tch" r="5" cx="0" cy="0"/></g>
    <path id="barL" class="bar" d="M198 70 Q194 112 206 154"/>
    <path id="barR" class="bar" d="M402 70 Q406 112 394 154"/>
    <rect class="k" data-bit="8" x="176" y="72" width="7" height="20" rx="3.5"/>
    <rect class="k" data-bit="9" x="417" y="72" width="7" height="20" rx="3.5"/>
    ${leds}
    ${dpad}${face}
    ${stick('L')}${stick('R')}
    <circle class="k" data-bit="12" cx="300" cy="212" r="9"/>
    <rect id="mute" class="k" data-bit="14" x="291" y="236" width="18" height="6" rx="3"/>
    ${edgeParts}
  </svg>`;
}

export function createController({ edge = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pad-wrap';
  wrap.innerHTML = markup(edge);
  const svg = wrap.firstElementChild;
  const bits = [];
  svg.querySelectorAll('[data-bit]').forEach(el => { (bits[+el.dataset.bit] ||= []).push(el); });
  const caps = { L: svg.querySelector('#capL'), R: svg.querySelector('#capR') };
  const trig = { L: svg.querySelector('#tL2'), R: svg.querySelector('#tR2') };
  const touches = [...svg.querySelectorAll('.tch')];
  const bars = [svg.querySelector('#barL'), svg.querySelector('#barR')];
  const pleds = [...svg.querySelectorAll('.pled')];
  const mute = svg.querySelector('#mute');
  const prev = { b: -1, L: '', R: '', l2: -1, r2: -1, t: ['', ''], lb: undefined, leds: -1, mute: -1 };

  return {
    el: wrap,
    /** s = frame.s, last = {L:[rx,ry,..], R:[...]} */
    update(s, last) {
      if (s.b !== prev.b) {
        const diff = s.b ^ (prev.b < 0 ? 0 : prev.b);
        for (let i = 0; i < bits.length; i++) if (bits[i] && (diff >> i) & 1 || prev.b < 0 && bits[i])
          for (const el of bits[i]) el.classList.toggle('on', !!((s.b >> i) & 1));
        prev.b = s.b;
      }
      for (const side of ['L', 'R']) {
        const p = last[side];
        const tr = `translate(${(p[0] * TRAVEL).toFixed(1)} ${(-p[1] * TRAVEL).toFixed(1)})`;
        if (tr !== prev[side]) { caps[side].setAttribute('transform', tr); prev[side] = tr; }
      }
      for (const [side, key] of [['L', 'l2'], ['R', 'r2']]) {
        const v = s[key];
        if (v !== prev[key]) {
          const w = 96 * v / 255;
          trig[side].setAttribute('width', w.toFixed(1));
          if (side === 'R') trig[side].setAttribute('x', (386 + 96 - w).toFixed(1));
          prev[key] = v;
        }
      }
      (s.touch || []).slice(0, 2).forEach((t, i) => {
        const k = t.on ? `${t.x},${t.y}` : '';
        if (k === prev.t[i]) return;
        prev.t[i] = k;
        touches[i].classList.toggle('on', !!t.on);
        if (t.on) { touches[i].setAttribute('cx', (212 + t.x / 1919 * 176).toFixed(1)); touches[i].setAttribute('cy', (68 + t.y / 1079 * 80).toFixed(1)); }
      });
    },
    setOutputs({ lightbar, playerLeds, muteLed }) {
      const lb = lightbar ? `rgb(${lightbar.r},${lightbar.g},${lightbar.b})` : '';
      if (lb !== prev.lb) {
        prev.lb = lb;
        for (const b of bars) { b.style.stroke = lb; b.classList.toggle('lit', !!lb && lb !== 'rgb(0,0,0)'); }
      }
      if (playerLeds !== prev.leds) { prev.leds = playerLeds; pleds.forEach((l, i) => l.classList.toggle('on', !!((playerLeds >> i) & 1))); }
      if (muteLed !== prev.mute) { prev.mute = muteLed; mute.classList.toggle('led-on', muteLed === 1); mute.classList.toggle('led-pulse', muteLed === 2); }
    },
    reset() { prev.b = -1; },
  };
}

/** Static dim outline used for the "no controller" state. */
export function outlineOnly() {
  const c = createController();
  c.el.classList.add('dim');
  return c.el;
}
