// Pure math helpers: correction model, statistics, minimum enclosing circle, French formatting.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const DEFAULT_STICK = { cx: 0, cy: 0, deadzone: 0.05, outer: 0.97, curve: 1, antiDeadzone: 0, tracking: false };
export const DEFAULT_TRIGGER = { deadzone: 0.02, outer: 0.98 };

/** Stick correction (same model as the host, simplified). Input/output y up. */
export function correctStick(x, y, p) {
  let dx = x - p.cx, dy = y - p.cy;
  dx /= dx >= 0 ? 1 - p.cx : 1 + p.cx;
  dy /= dy >= 0 ? 1 - p.cy : 1 + p.cy;
  const m = Math.hypot(dx, dy);
  if (m <= p.deadzone || m === 0) return [0, 0];
  let n = clamp((m - p.deadzone) / Math.max(1e-6, p.outer - p.deadzone), 0, 1);
  n = Math.pow(n, p.curve);
  n = p.antiDeadzone + (1 - p.antiDeadzone) * n;
  return [(dx / m) * n, (dy / m) * n];
}

/** Trigger correction, raw 0-255 → 0-255. */
export function correctTrigger(v, p) {
  const f = clamp((v / 255 - p.deadzone) / Math.max(1e-6, p.outer - p.deadzone), 0, 1);
  return Math.round(f * 255);
}

export function mean2(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  const n = pts.length || 1;
  return [x / n, y / n];
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const i = clamp((s.length - 1) * p, 0, s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Rest capture statistics: centre = mean, noise = distances from the mean. */
export function restStats(pts) {
  const [cx, cy] = mean2(pts);
  const d = pts.map(p => Math.hypot(p[0] - cx, p[1] - cy));
  return { cx, cy, p99: percentile(d, 0.99), max: d.length ? Math.max(...d) : 0, n: pts.length };
}

// ---- Minimum enclosing circle (Welzl, iterative form) ----
const inCircle = (c, p) => Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r + 1e-9;
const circle2 = (a, b) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
function circle3(a, b, c) {
  const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) {
    const cs = [circle2(a, b), circle2(a, c), circle2(b, c)];
    return cs.reduce((m, k) => (k.r > m.r ? k : m));
  }
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (cy * b2 - by * c2) / d, y = (bx * c2 - cx * b2) / d;
  return { x: x + a[0], y: y + a[1], r: Math.hypot(x, y) };
}
export function minEnclosingCircle(points) {
  const p = points.slice();
  for (let i = p.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  let c = null;
  for (let i = 0; i < p.length; i++) {
    if (c && inCircle(c, p[i])) continue;
    c = { x: p[i][0], y: p[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (inCircle(c, p[j])) continue;
      c = circle2(p[i], p[j]);
      for (let k = 0; k < j; k++) if (!inCircle(c, p[k])) c = circle3(p[i], p[j], p[k]);
    }
  }
  return c || { x: 0, y: 0, r: 0 };
}

// ---- French number formatting ----
const NB = ' ';
export function fr(v, d = 1) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(d).replace('.', ',');
  return (v < 0 && Number(s.replace(',', '.')) !== 0 ? '−' : '') + s;
}
export function frs(v, d = 3) { // always signed
  const s = fr(v, d);
  return s.startsWith('−') ? s : (Number(v.toFixed(d)) === 0 ? ' ' : '+') + s;
}
export const pct = (v, d = 1) => fr(v * 100, d) + NB + '%';
