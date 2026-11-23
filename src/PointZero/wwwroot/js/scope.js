// Oscilloscope-style stick scope on canvas: graticule, zones, persistent raw/corrected traces.
import { hiDpiCanvas } from './ui.js';

export const C = {
  bg: '#0A0A0A', line: '#222222', line2: '#2E2E2E', text: '#ECECE8', muted: '#8A8A84', dim: '#55554F',
  accent: '#C8FF3C', warn: '#FF5A36',
};
export const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const MONO = '"PZ Mono","Cascadia Mono",Consolas,monospace';
const BUCKETS = 10;

export class Scope {
  /** opts: { margin, persist (s), labels } */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.margin = opts.margin ?? 26;
    this.persist = (opts.persist ?? 0.7) * 1000;
    this.labels = opts.labels ?? true;
    this.params = { cx: 0, cy: 0, deadzone: 0.05, outer: 0.97 };
    this.progress = null;       // 0..1 → ring around the scope
    this.showZones = true;
    this.showCenter = true;
    this.preview = null;        // {cx, cy, deadzone} dashed proposal
    this.layer = document.createElement('canvas');
    this.paths = Array.from({ length: BUCKETS });
    this.c = hiDpiCanvas(canvas, () => this.buildLayer());
  }
  get size() { return Math.min(this.c.w, this.c.h); }
  get R() { return (this.size / 2 - this.margin) * (this.zoom || 1); }
  X(x) { return this.c.w / 2 + (x - (this.panX || 0)) * this.R; }
  Y(y) { return this.c.h / 2 - (y - (this.panY || 0)) * this.R; }

  /** Graticule for zoomed views (results scatter): labelled rings in %. */
  zoomGrid() {
    const g = this.c.ctx, cx = this.c.w / 2, cy = this.c.h / 2, R0 = this.size / 2 - this.margin;
    const range = 1 / this.zoom;
    const step = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1].find(s => range / s <= 5) || 0.1;
    g.lineWidth = 1; g.font = `9px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    for (let v = step, i = 1; v <= range + 1e-9; v += step, i++) {
      const r = v * this.R, last = v + step > range + 1e-9;
      g.strokeStyle = last ? C.line2 : C.line; g.setLineDash(last ? [] : [1, 3]);
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.fillStyle = C.dim; g.fillText(`${+(v * 100).toFixed(1)}`.replace('.', ',') + ' %', cx + r * 0.7071 + 4, cy - r * 0.7071 - 4);
    }
    g.setLineDash([]); g.strokeStyle = C.line;
    g.beginPath(); g.moveTo(cx - R0, cy + 0.5); g.lineTo(cx + R0, cy + 0.5); g.moveTo(cx + 0.5, cy - R0); g.lineTo(cx + 0.5, cy + R0); g.stroke();
  }

  buildLayer() {
    const d = devicePixelRatio || 1, w = this.c.w, hh = this.c.h;
    const L = this.layer; L.width = w * d; L.height = hh * d;
    const g = L.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    const cx = w / 2, cy = hh / 2, R = this.size / 2 - this.margin;
    g.lineWidth = 1;
    // concentric graticule
    g.strokeStyle = C.line; g.setLineDash([1, 3]);
    for (const k of [0.25, 0.5, 0.75]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }
    g.setLineDash([]);
    g.beginPath(); g.moveTo(cx - R, cy + 0.5); g.lineTo(cx + R, cy + 0.5); g.moveTo(cx + 0.5, cy - R); g.lineTo(cx + 0.5, cy + R); g.stroke();
    // 100 % ring + ticks
    g.strokeStyle = C.line2; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    for (let a = 0; a < 360; a += 10) {
      const major = a % 90 === 0, mid = a % 30 === 0;
      const r0 = R + 3, r1 = R + (major ? 10 : mid ? 7 : 5);
      const t = a * Math.PI / 180;
      g.strokeStyle = major ? C.muted : C.dim;
      g.beginPath(); g.moveTo(cx + Math.cos(t) * r0, cy - Math.sin(t) * r0); g.lineTo(cx + Math.cos(t) * r1, cy - Math.sin(t) * r1); g.stroke();
    }
    if (this.labels) {
      g.font = `9px ${MONO}`; g.fillStyle = C.dim; g.textBaseline = 'middle';
      g.textAlign = 'right'; g.fillText('+X', cx + R - 4, cy - 8);
      g.textAlign = 'left'; g.fillText('+Y', cx + 6, cy - R + 9);
      g.fillText('50', cx + R * 0.5 + 3, cy + 8);
    }
  }

  clear() {
    const g = this.c.ctx;
    g.clearRect(0, 0, this.c.w, this.c.h);
    if (this.zoom && this.zoom !== 1) this.zoomGrid();
    else if (this.layer.width) g.drawImage(this.layer, 0, 0, this.c.w, this.c.h);
    return g;
  }

  /** Draws a trail with phosphor persistence from every sample of a Trail buffer. */
  trail(buf, now, color, width) {
    const g = this.c.ctx, n = buf.n, P = this.persist;
    if (n < 2) return;
    for (let b = 0; b < BUCKETS; b++) this.paths[b] = null;
    let k = 0, i0 = buf.at(0);
    let px = this.X(buf.x[i0]), py = this.Y(buf.y[i0]);
    for (k = 1; k < n; k++) {
      const i = buf.at(k), age = now - buf.t[buf.at(k - 1)];
      if (age > P) break;
      const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(age / P * BUCKETS)));
      const x = this.X(buf.x[i]), y = this.Y(buf.y[i]);
      const path = this.paths[b] || (this.paths[b] = new Path2D());
      path.moveTo(px, py); path.lineTo(x, y);
      px = x; py = y;
    }
    g.lineWidth = width; g.strokeStyle = color; g.lineCap = 'round';
    for (let b = 0; b < BUCKETS; b++) {
      if (!this.paths[b]) continue;
      g.globalAlpha = Math.pow(1 - b / BUCKETS, 1.6);
      g.stroke(this.paths[b]);
    }
    g.globalAlpha = 1;
  }

  circle(x, y, r, stroke, fill, dash) {
    const g = this.c.ctx;
    g.beginPath(); g.arc(this.X(x), this.Y(y), r * this.R, 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.setLineDash(dash || []); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
  }
  dot(x, y, r, fill) {
    const g = this.c.ctx; g.beginPath(); g.arc(this.X(x), this.Y(y), r, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
  }
  cross(x, y, s, color) {
    const g = this.c.ctx, X = Math.round(this.X(x)) + 0.5, Y = Math.round(this.Y(y)) + 0.5;
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X - s, Y); g.lineTo(X + s, Y); g.moveTo(X, Y - s); g.lineTo(X, Y + s); g.stroke();
  }

  zones() {
    const p = this.params;
    this.circle(0, 0, p.outer, C.muted, null, [2, 4]);
    if (p.deadzone > 0.001) this.circle(p.cx, p.cy, p.deadzone, rgba(C.accent, 0.85), rgba(C.accent, 0.07), [3, 3]);
    if (this.showCenter) this.cross(p.cx, p.cy, 5, C.text);
    const pv = this.preview;
    if (pv) {
      this.circle(pv.cx, pv.cy, pv.deadzone, C.accent, rgba(C.accent, 0.12));
      this.cross(pv.cx, pv.cy, 8, C.accent);
    }
  }

  ring() {
    if (this.progress == null) return;
    const g = this.c.ctx, r = this.size / 2 - this.margin + 16, x = this.c.w / 2, y = this.c.h / 2;
    g.lineWidth = 2; g.strokeStyle = C.line2;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = C.accent; g.beginPath();
    g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.progress)); g.stroke();
  }

  /** Standard render: zones, raw (grey) + corrected (accent) persistent traces, current dots. */
  render(now, trails, last, { raw = true, out = true } = {}) {
    this.clear();
    if (this.showZones) this.zones();
    if (raw && trails) this.trail(trails.raw, now, C.muted, 1.25);
    if (out && trails) this.trail(trails.out, now, C.accent, 1.5);
    if (last) {
      if (raw) this.dot(last[0], last[1], 2.75, C.text);
      if (out) {
        this.dot(last[2], last[3], 3.25, C.accent);
        this.circle(last[2], last[3], 7 / this.R, rgba(C.accent, 0.4));
      }
    }
    this.ring();
  }
}
