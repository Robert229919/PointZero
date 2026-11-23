// Rest capture: collects raw samples of one stick for `ms`, restarts if the stick moves.
import { sub } from './state.js';
import { restStats } from './math.js';

export function captureRest(side, ms, { onProgress, onDone, onRestart }) {
  let pts = [], t0 = performance.now();
  const unsub = sub('frame', m => {
    const list = m.samples?.[side];
    if (!list) return;
    for (const p of list) {
      pts.push([p[0], p[1]]);
      if (pts.length > 24) {
        const a = pts.length === 25 ? (pts.anchor = restStats(pts.slice(0, 24))) : pts.anchor;
        if (Math.hypot(p[0] - a.cx, p[1] - a.cy) > 0.12) { pts = []; t0 = performance.now(); onRestart?.(); return; }
      }
    }
    const k = (performance.now() - t0) / ms;
    onProgress?.(Math.min(1, k));
    if (k >= 1) { unsub(); onDone(restStats(pts), pts); }
  });
  return () => unsub();
}
