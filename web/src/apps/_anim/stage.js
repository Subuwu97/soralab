// The frame-based stage renderer (Animate / Sora ANI): timelines of layers made of keyframe spans, vector shapes,
// bitmaps, text and symbol instances, with classic (motion) tweens and shape tweens. Deterministic like comp.js.
//
//   timeline = { layers: [{ id, name, visible, locked, outline, color, frames: [key] }] }  (layers listed top first)
//   key      = { i: first frame, len: frames it spans, els: [element], tween: null | 'motion' | 'shape', ease: -100..100, bz? }
//   element  = { id, type: 'shape' | 'bitmap' | 'symbol' | 'text', x, y, sx, sy, r, alpha, tint: { color, amount }, … }
//     shape  : subs: [{ pts: [[x, y]…], closed }], fill, stroke, sw, smooth     (points in the element's own space)
//     bitmap : asset, w, h        symbol: symbol (id), loop: 'loop' | 'once' | 'single', first      text: text, font, size, color, weight
import { lerpValue, cubicBezier, colorArr } from './keyframes.js';
import { resample, alignRing, traceSmooth, tracePolys, trs, apply, invert, bbox, pointInPoly, distToPolyline } from './geom.js';
import { getImage } from './media.js';

export const timelineLength = (tl) => Math.max(1, ...tl.layers.flatMap((l) => l.frames.map((k) => k.i + k.len)));
/** The key whose span covers frame f on a layer (or null). */
export const keyAt = (layer, f) => layer.frames.find((k) => f >= k.i && f < k.i + k.len) || null;
export const nextKey = (layer, k) => layer.frames.find((x) => x.i === k.i + k.len) || null;
export const symbolById = (doc, id) => doc.symbols.find((s) => s.id === id);

export const elMatrix = (e) => trs([e.x || 0, e.y || 0], e.r || 0, e.sx ?? 1, e.sy ?? 1, [0, 0]);

/** Classic-tween easing: -100 (ease in) … 0 (linear) … 100 (ease out), or a custom bezier. */
export function easeT(k, t) {
  if (k.bz) return cubicBezier(...k.bz)(t);
  const e = Math.max(-1, Math.min(1, (k.ease || 0) / 100));
  return t + e * t * (1 - t);
}

const TWEENABLE = ['x', 'y', 'sx', 'sy', 'r', 'alpha'];
function lerpEl(a, b, t) {
  const out = { ...a };
  for (const p of TWEENABLE) if (typeof a[p] === 'number' || typeof b[p] === 'number') out[p] = lerpValue(a[p] ?? (p === 'sx' || p === 'sy' || p === 'alpha' ? 1 : 0), b[p] ?? (p === 'sx' || p === 'sy' || p === 'alpha' ? 1 : 0), t);
  const ta = a.tint || { color: b.tint?.color || '#000000', amount: 0 }; const tb = b.tint || { color: ta.color, amount: 0 };
  if (ta.amount || tb.amount) out.tint = { color: lerpValue(ta.color, tb.color, t), amount: lerpValue(ta.amount, tb.amount, t) };
  if (a.fill && b.fill) out.fill = lerpValue(a.fill, b.fill, t);
  if (a.stroke && b.stroke) out.stroke = lerpValue(a.stroke, b.stroke, t);
  if (typeof a.sw === 'number' && typeof b.sw === 'number') out.sw = lerpValue(a.sw, b.sw, t);
  if (a.type === 'text' && typeof a.size === 'number' && typeof b.size === 'number') out.size = lerpValue(a.size, b.size, t);
  if (a.color && b.color) out.color = lerpValue(a.color, b.color, t);
  return out;
}

/** Morphs one shape into another: point-to-point when the paths match, otherwise both are resampled. */
function morph(a, b, t) {
  const n = Math.max(a.subs.length, b.subs.length);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const sa = a.subs[i] || collapsed(b.subs[i], a); const sb = b.subs[i] || collapsed(a.subs[i], b);
    let pa = sa.pts; let pb = sb.pts;
    const closed = sa.closed && sb.closed;
    if (pa.length !== pb.length || sa.closed !== sb.closed) {
      const m = Math.max(pa.length, pb.length, 8);
      pa = resample(pa, m, closed); pb = resample(pb, m, closed);
      if (closed) pb = alignRing(pb, pa);
    }
    subs.push({ pts: pa.map((p, j) => [p[0] + (pb[j][0] - p[0]) * t, p[1] + (pb[j][1] - p[1]) * t]), closed: t < 0.5 ? sa.closed : sb.closed });
  }
  const fillA = a.fill || (b.fill ? withA(b.fill, 0) : null); const fillB = b.fill || (a.fill ? withA(a.fill, 0) : null);
  const strokeA = a.stroke || (b.stroke ? withA(b.stroke, 0) : null); const strokeB = b.stroke || (a.stroke ? withA(a.stroke, 0) : null);
  return { ...lerpEl(a, b, t), subs, fill: fillA && lerpValue(fillA, fillB, t), stroke: strokeA && lerpValue(strokeA, strokeB, t), sw: lerpValue(a.sw || 0, b.sw || 0, t), smooth: a.smooth && b.smooth };
}
const withA = (c, a) => { const [r, g, b] = colorArr(c); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`; };
/** A path squeezed to the centre of another (so extra paths grow out of nothing in a morph). */
function collapsed(sub, el) {
  const b = bbox([sub.pts]);
  const c = [b.x + b.w / 2, b.y + b.h / 2];
  return { pts: sub.pts.map(() => c.slice()), closed: sub.closed, _el: el };
}

/** The elements a layer shows at frame f, with tweens applied. */
export function layerElements(layer, f) {
  const k = keyAt(layer, f);
  if (!k) return [];
  if (!k.tween || f === k.i) return k.els;
  const n = nextKey(layer, k);
  if (!n) return k.els;
  const t = easeT(k, (f - k.i) / k.len);
  if (k.tween === 'shape') {
    const sa = k.els.filter((e) => e.type === 'shape'); const sb = n.els.filter((e) => e.type === 'shape');
    const others = k.els.filter((e) => e.type !== 'shape').map((e) => { const m = n.els.find((x) => x.id === e.id); return m ? lerpEl(e, m, t) : e; });
    const shapes = [];
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      if (sa[i] && sb[i]) shapes.push(morph(sa[i], sb[i], t));
      else if (sa[i]) shapes.push({ ...sa[i], alpha: (sa[i].alpha ?? 1) * (1 - t) });
      else shapes.push({ ...sb[i], alpha: (sb[i].alpha ?? 1) * t });
    }
    return [...shapes, ...others];
  }
  // motion / classic tween: elements with the same id in both keys move between them
  return k.els.map((e) => { const m = n.els.find((x) => x.id === e.id); return m ? lerpEl(e, m, t) : e; });
}

// ---------------------------------------------------------------- drawing

const tintPool = [];
function tintBuffer(depth, w, h) {
  let c = tintPool[depth];
  if (!c) { c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); tintPool[depth] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, w, h);
  return c;
}

export function textFont(e) { return `${e.italic ? 'italic ' : ''}${e.weight || 400} ${e.size || 32}px "${e.font || 'Inter'}", system-ui, sans-serif`; }

function drawShape(ctx, e, outline) {
  ctx.beginPath();
  for (const s of e.subs) { if (e.smooth) traceSmooth(ctx, s.pts, s.closed); else tracePolys(ctx, [s]); }
  if (outline) { ctx.lineWidth = 1 / Math.max(0.01, Math.hypot(ctx.getTransform().a, ctx.getTransform().b)); ctx.strokeStyle = outline; ctx.stroke(); return; }
  if (e.fill) { ctx.fillStyle = e.fill; ctx.fill('evenodd'); }
  if (e.stroke && e.sw > 0) { ctx.strokeStyle = e.stroke; ctx.lineWidth = e.sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); }
}

/** Draws one element with ctx already in the parent's space. env: { doc, frame (local), depth, outline } */
function drawElement(ctx, e, env) {
  const alpha = e.alpha ?? 1;
  if (alpha <= 0.001) return;
  const tint = e.tint?.amount > 0.001 ? e.tint : null;
  let target = ctx;
  let buf = null;
  if (tint) {
    buf = tintBuffer(env.depth, ctx.canvas.width, ctx.canvas.height);
    target = buf.getContext('2d');
    target.setTransform(ctx.getTransform());
  }
  target.save();
  const m = elMatrix(e);
  target.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (!tint) target.globalAlpha *= alpha;
  switch (e.type) {
    case 'shape': drawShape(target, e, env.outline); break;
    case 'bitmap': {
      const img = getImage(e.asset);
      if (env.outline) { target.strokeStyle = env.outline; target.lineWidth = 1; target.strokeRect(0, 0, e.w, e.h); }
      else if (img) target.drawImage(img, 0, 0, e.w, e.h);
      break;
    }
    case 'text': {
      target.font = textFont(e); target.textBaseline = 'top'; target.fillStyle = env.outline || e.color || '#000';
      String(e.text || '').split('\n').forEach((line, i) => target.fillText(line, 0, i * (e.size || 32) * 1.2));
      break;
    }
    case 'symbol': {
      const sym = symbolById(env.doc, e.symbol);
      if (sym && env.depth < 12) {
        const len = timelineLength(sym.timeline);
        const local = e.loop === 'single' ? (e.first || 0) : e.loop === 'once' ? Math.min(len - 1, (e.first || 0) + env.sinceKey) : ((e.first || 0) + env.sinceKey) % len;
        drawTimeline(target, env.doc, sym.timeline, Math.max(0, local), { ...env, depth: env.depth + 1 });
      }
      break;
    }
    default:
  }
  target.restore();
  if (tint) {
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = 'source-atop'; target.globalAlpha = Math.min(1, tint.amount); target.fillStyle = tint.color; target.fillRect(0, 0, buf.width, buf.height);
    target.restore();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha *= alpha; ctx.drawImage(buf, 0, 0); ctx.restore();
  }
}

/** Draws a timeline's frame f. env: { doc, depth, outline?, onlyLayer?, hideLayers? } */
export function drawTimeline(ctx, doc, tl, f, env = {}) {
  const e = { doc, depth: 0, ...env };
  for (let i = tl.layers.length - 1; i >= 0; i--) {
    const layer = tl.layers[i];
    if (!layer.visible && !env.showHidden) continue;
    if (env.onlyLayer && env.onlyLayer !== layer.id) continue;
    if (layer.guide && !env.showGuides) continue;
    const k = keyAt(layer, f);
    if (!k) continue;
    const els = layerElements(layer, f);
    const outline = layer.outline ? layer.color || '#4aa3ff' : e.outline;
    for (const el of els) drawElement(ctx, el, { ...e, outline, sinceKey: f - k.i });
  }
}

/** Draws a full stage frame (background + scene) into ctx scaled to fit ctx.canvas. */
export function renderStage(doc, f, ctx, { timeline = doc.scene, transparent = false, scale } = {}) {
  const s = scale ?? ctx.canvas.width / doc.width;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  if (transparent) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  else { ctx.fillStyle = doc.bg || '#ffffff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawTimeline(ctx, doc, timeline, f, { doc });
  ctx.restore();
}

/** Every bitmap a frame needs (recursing into symbols), so export can wait for them. */
export function bitmapsIn(doc, tl, depth = 0, out = new Set()) {
  for (const l of tl.layers) for (const k of l.frames) for (const e of k.els) {
    if (e.type === 'bitmap') out.add(e.asset);
    else if (e.type === 'symbol' && depth < 12) { const s = symbolById(doc, e.symbol); if (s) bitmapsIn(doc, s.timeline, depth + 1, out); }
  }
  return out;
}
export function fontsIn(doc, tl, depth = 0, out = new Map()) {
  for (const l of tl.layers) for (const k of l.frames) for (const e of k.els) {
    if (e.type === 'text') out.set(`${e.font}|${e.weight}`, { family: e.font || 'Inter', weight: e.weight || 400 });
    else if (e.type === 'symbol' && depth < 12) { const s = symbolById(doc, e.symbol); if (s) fontsIn(doc, s.timeline, depth + 1, out); }
  }
  return out;
}

// ---------------------------------------------------------------- geometry of elements

const measure = (() => { let c; return () => (c ||= (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas')).getContext('2d')); })();

/** Element bounds in its own space. */
export function localBounds(doc, e, depth = 0) {
  if (e.type === 'shape') { const b = bbox(e.subs.map((s) => s.pts)); const h = e.stroke ? (e.sw || 0) / 2 : 0; return { x: b.x - h, y: b.y - h, w: b.w + 2 * h, h: b.h + 2 * h }; }
  if (e.type === 'bitmap') return { x: 0, y: 0, w: e.w, h: e.h };
  if (e.type === 'text') {
    const c = measure(); c.font = textFont(e);
    const lines = String(e.text || '').split('\n');
    return { x: 0, y: 0, w: Math.max(4, ...lines.map((l) => c.measureText(l).width)), h: lines.length * (e.size || 32) * 1.2 };
  }
  if (e.type === 'symbol') {
    const s = symbolById(doc, e.symbol);
    if (!s || depth > 12) return { x: -10, y: -10, w: 20, h: 20 };
    const pts = [];
    const f = e.loop === 'single' ? e.first || 0 : e.first || 0;
    for (const l of s.timeline.layers) for (const el of layerElements(l, f)) {
      const b = localBounds(doc, el, depth + 1); const m = elMatrix(el);
      pts.push(apply(m, [b.x, b.y]), apply(m, [b.x + b.w, b.y]), apply(m, [b.x, b.y + b.h]), apply(m, [b.x + b.w, b.y + b.h]));
    }
    return pts.length ? bbox([pts]) : { x: -10, y: -10, w: 20, h: 20 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}
/** Bounds in the parent (stage) space. */
export function worldBounds(doc, e) {
  const b = localBounds(doc, e); const m = elMatrix(e);
  return bbox([[[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map((p) => apply(m, p))]);
}
/** Is the stage point on the element (fills, strokes within reach, bitmaps/symbols/text by their box)? */
export function hitElement(doc, e, pt, tol = 4) {
  const inv = invert(elMatrix(e));
  const p = apply(inv, pt);
  const sc = Math.hypot(inv[0], inv[1]);
  if (e.type === 'shape') {
    for (const s of e.subs) {
      if (s.closed && e.fill && pointInPoly(p, s.pts)) return true;
      if (distToPolyline(p, s.pts, s.closed) <= ((e.stroke ? e.sw || 1 : 1) / 2) + tol * sc) return true;
    }
    return false;
  }
  const b = localBounds(doc, e);
  return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
}
