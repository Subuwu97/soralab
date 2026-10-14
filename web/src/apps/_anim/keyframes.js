// Animatable properties, shared by Motion (Ugoki) and Animate (ANI).
//
// A property is { v } when static, or { v, k: [{ t, v, in, out, bz }] } when animated (keyframes sorted by time),
// optionally with an expression { x: 'wiggle(2, 30)' }. Values are numbers, arrays (points, scale) or colour strings.
//   in / out: 'linear' | 'ease' (out may also be 'hold')   — the keyframe's incoming / outgoing interpolation
//   bz: [x1, y1, x2, y2]                                     — custom cubic bezier for the segment leaving this key
import { parse, toHex } from '../../lib/color.js';
import { evalExpression } from './expr.js';

export const P = (v) => ({ v });
export const isAnimated = (p) => !!(p && p.k && p.k.length);
export const EPS = 1e-6;

// ---------------------------------------------------------------- easing

/** Cubic bezier easing like CSS cubic-bezier(x1, y1, x2, y2): returns f(t) for t in 0..1. */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { // Newton first, bisection if the slope is flat
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0; let hi = 1; t = x;
    for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const bzCache = new Map();
const bezierFn = (b) => { const key = b.join(','); let f = bzCache.get(key); if (!f) { f = cubicBezier(...b); bzCache.set(key, f); } return f; };

/** The bezier used between keyframes a and b (easy ease = 33% influence, like After Effects). */
export function segmentBezier(a, b) {
  if (a.bz) return a.bz;
  const o = a.out === 'ease' ? [0.333, 0] : [0.333, 0.333];
  const i = b.in === 'ease' ? [0.667, 1] : [0.667, 0.667];
  return [o[0], o[1], i[0], i[1]];
}
export const EASE_PRESETS = {
  linear: [0.333, 0.333, 0.667, 0.667], easy: [0.333, 0, 0.667, 1], easeIn: [0.333, 0.333, 0.667, 1], easeOut: [0.333, 0, 0.667, 0.667],
  snappy: [0.2, 0.9, 0.3, 1], anticipate: [0.6, -0.4, 0.4, 1.4], overshoot: [0.3, 1.6, 0.6, 1],
};

// ---------------------------------------------------------------- value maths

const isColor = (v) => typeof v === 'string';
export const colorArr = (c) => { const { r, g, b, a } = parse(c); return [r / 255, g / 255, b / 255, a ?? 1]; };
export const arrColor = (a) => toHex({ r: clamp01(a[0]) * 255, g: clamp01(a[1]) * 255, b: clamp01(a[2]) * 255, a: clamp01(a[3] ?? 1) });
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function lerpValue(a, b, t) {
  if (typeof a === 'number') return a + (b - a) * t;
  if (Array.isArray(a)) return a.map((x, i) => x + ((b?.[i] ?? x) - x) * t);
  if (isColor(a)) { const p = colorArr(a); const q = colorArr(b); return arrColor(p.map((x, i) => x + (q[i] - x) * t)); }
  return t < 1 ? a : b;
}

/** The keyframed value at time t (no expression). */
export function keyedValue(p, t) {
  if (!p) return undefined;
  const k = p.k;
  if (!k || !k.length) return p.v;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < k.length - 2 && k[i + 1].t <= t) i++;
  const a = k[i]; const b = k[i + 1];
  if (a.out === 'hold') return a.v;
  const x = (t - a.t) / Math.max(EPS, b.t - a.t);
  return lerpValue(a.v, b.v, bezierFn(segmentBezier(a, b))(x));
}

/**
 * The property's value at time t, with its expression applied. env: { seed, index, fps, time? } for expressions.
 * Returns the keyed value if the expression fails (the UI shows the error).
 */
export function valueAt(p, t, env) {
  const base = keyedValue(p, t);
  if (!p?.x) return base;
  const r = evalExpression(p.x, { value: base, time: t, prop: p, keyed: (tt) => keyedValue(p, tt), ...env });
  return r.ok ? r.value : base;
}

// ---------------------------------------------------------------- editing helpers (return new property objects)

export const keyIndexAt = (p, t, tol = 1e-4) => (p?.k || []).findIndex((k) => Math.abs(k.t - t) < tol);

/** Sets the value at time t: adds/updates a keyframe when animated, else changes the static value. */
export function setValueAt(p, t, v) {
  if (!isAnimated(p)) return { ...p, v };
  const k = p.k.slice();
  const i = keyIndexAt(p, t);
  if (i >= 0) k[i] = { ...k[i], v };
  else { k.push({ t, v, in: 'linear', out: 'linear' }); k.sort((a, b) => a.t - b.t); }
  return { ...p, k, v };
}
/** Stopwatch: turn animation on (key at t with the current value) or off (keep the value at t). */
export function toggleStopwatch(p, t) {
  if (isAnimated(p)) { const { k, ...rest } = p; return { ...rest, v: keyedValue(p, t) }; } // eslint-disable-line no-unused-vars
  return { ...p, k: [{ t, v: p.v, in: 'linear', out: 'linear' }] };
}
/** Adds a keyframe at t (current value) or removes the one there. */
export function toggleKeyAt(p, t) {
  const i = keyIndexAt(p, t);
  if (i >= 0) {
    const k = p.k.filter((_, j) => j !== i);
    return k.length ? { ...p, k } : { ...p, k: undefined, v: p.k[i].v };
  }
  const v = keyedValue(p, t);
  const k = [...(p.k || []), { t, v, in: 'linear', out: 'linear' }].sort((a, b) => a.t - b.t);
  return { ...p, k };
}
export const keyTimes = (p) => (p?.k || []).map((k) => k.t);
