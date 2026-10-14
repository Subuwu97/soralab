// The composition renderer (Motion / Sora Ugoki). Deterministic: the same project, comp and time always draw the same pixels.
//
//   await prepareFrame(project, comp, t, { wait: true })   load fonts/images and seek videos (awaits 'seeked' for export)
//   renderFrame(project, comp, t, ctx, { scale })           draw synchronously into ctx (canvas = comp size × scale)
//
// Layers are listed top first (like After Effects) and drawn bottom-up. Each visible layer is drawn into its own buffer
// (content → masks → effects), then track matte, then composited with its blend mode and opacity.
import { valueAt } from './keyframes.js';
import { seedOf } from './expr.js';
import { rectPoly, ellipsePoly, starPoly, penPoly, trimPolys, tracePolys, trs, mul, I, apply, bbox } from './geom.js';
import { applyEffects, lumaToAlpha } from './effects.js';
import { getImage, getVideo, seekVideo, nudgeVideo, videoReady, loadImageAsset } from './media.js';
import { ensureFont } from '../../lib/fonts.js';
import { colorArr } from './keyframes.js';

export const BLEND_MODES = [
  ['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'], ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['add', 'Add'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
const gco = (b) => (b === 'add' ? 'lighter' : !b || b === 'normal' ? 'source-over' : b);

export const compById = (project, id) => project.comps.find((c) => c.id === id);
export const isActive = (l, t) => t >= l.in - 1e-9 && t < l.out - 1e-9;
const VISUAL = new Set(['solid', 'shape', 'text', 'image', 'video', 'precomp', 'adjustment']);

// ---------------------------------------------------------------- buffers

const free = new Map();
function acquire(w, h) {
  const key = `${w}x${h}`;
  const list = free.get(key);
  const c = list?.pop() || (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  ctx.clearRect(0, 0, w, h);
  return c;
}
function release(c) {
  const key = `${c.width}x${c.height}`;
  if (!free.has(key)) free.set(key, []);
  const l = free.get(key);
  if (l.length < 12) l.push(c);
}

// ---------------------------------------------------------------- property evaluation

/** Evaluates a property of a layer at t (expressions get a per-layer, per-property seed). */
export const prop = (layer, p, path, t, comp, index = 1) => (p ? valueAt(p, t, { seed: seedOf(`${layer.id}|${path}`), index, fps: comp.fps, comp }) : undefined);

/** Layer's own transform matrix (layer space → parent space) at t. */
export function localMatrix(layer, t, comp) {
  const tr = layer.tr;
  const pos = prop(layer, tr.position, 'position', t, comp);
  const sc = prop(layer, tr.scale, 'scale', t, comp);
  return trs(pos, prop(layer, tr.rotation, 'rotation', t, comp), sc[0] / 100, sc[1] / 100, prop(layer, tr.anchor, 'anchor', t, comp));
}
/** Layer space → comp space, following the parent chain. */
export function worldMatrix(layer, t, comp, depth = 0) {
  const m = localMatrix(layer, t, comp);
  if (!layer.parent || depth > 32) return m;
  const parent = comp.layers.find((l) => l.id === layer.parent);
  return parent ? mul(worldMatrix(parent, t, comp, depth + 1), m) : m;
}

// ---------------------------------------------------------------- shapes and text

/** The shape layer's paths (layer space) at t, with trim paths applied. */
export function shapePolys(layer, t, comp) {
  const sh = layer.shape;
  const polys = [];
  for (const s of sh.shapes) {
    if (s.hidden) continue;
    const pos = s.pos ? prop(layer, s.pos, `${s.id}.pos`, t, comp) : [0, 0];
    if (s.kind === 'rect') { const sz = prop(layer, s.size, `${s.id}.size`, t, comp); polys.push(rectPoly(pos[0], pos[1], sz[0], sz[1], prop(layer, s.round, `${s.id}.round`, t, comp) || 0)); }
    else if (s.kind === 'ellipse') { const sz = prop(layer, s.size, `${s.id}.size`, t, comp); polys.push(ellipsePoly(pos[0], pos[1], sz[0], sz[1])); }
    else if (s.kind === 'star' || s.kind === 'polygon') {
      polys.push(starPoly(pos[0], pos[1], prop(layer, s.points, `${s.id}.points`, t, comp), prop(layer, s.outer, `${s.id}.outer`, t, comp),
        s.kind === 'star' ? prop(layer, s.inner, `${s.id}.inner`, t, comp) : null, prop(layer, s.rot, `${s.id}.rot`, t, comp) || 0));
    } else if (s.kind === 'path') {
      const p = penPoly(s.nodes, s.closed);
      polys.push({ pts: p.pts.map(([x, y]) => [x + pos[0], y + pos[1]]), closed: p.closed });
    }
  }
  if (sh.trim?.on) return trimPolys(polys, prop(layer, sh.trim.start, 'trim.start', t, comp), prop(layer, sh.trim.end, 'trim.end', t, comp), prop(layer, sh.trim.offset, 'trim.offset', t, comp));
  return polys;
}

const fontCss = (tx, size) => `${tx.italic ? 'italic ' : ''}${tx.weight || 400} ${size}px "${tx.font || 'Inter'}", system-ui, sans-serif`;
const measureCtx = (() => { let c = null; return () => (c ||= (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas')).getContext('2d')); })();

/** Lays out a text layer: [{ ch, x, y, w }] in layer space (origin = first baseline), plus the block's box. */
export function layoutText(layer, t, comp) {
  const tx = layer.text;
  const size = Math.max(1, prop(layer, tx.size, 'text.size', t, comp));
  const tracking = (prop(layer, tx.tracking, 'text.tracking', t, comp) || 0) * size / 1000;
  const lh = size * (tx.leading || 1.2);
  const ctx = measureCtx();
  ctx.font = fontCss(tx, size);
  const chars = [];
  const lines = String(tx.value ?? '').split('\n');
  let maxW = 0;
  lines.forEach((line, li) => {
    const widths = [...line].map((ch) => ctx.measureText(ch).width + tracking);
    const total = widths.reduce((a, b) => a + b, 0) - (widths.length ? tracking : 0);
    maxW = Math.max(maxW, total);
    let x = tx.align === 'left' ? 0 : tx.align === 'right' ? -total : -total / 2;
    [...line].forEach((ch, i) => { chars.push({ ch, x, y: li * lh, w: widths[i] - tracking, line: li }); x += widths[i]; });
  });
  const x0 = tx.align === 'left' ? 0 : tx.align === 'right' ? -maxW : -maxW / 2;
  return { chars, size, box: { x: x0, y: -size * 0.8, w: maxW, h: (lines.length - 1) * lh + size * 1.05 } };
}

/** Range-selector amount (0..1) for each character. */
function selectorAmounts(layer, n, t, comp) {
  const a = layer.text.anim;
  const off = prop(layer, a.offset, 'anim.offset', t, comp) || 0;
  const s = ((prop(layer, a.start, 'anim.start', t, comp) + off) / 100) * n;
  const e = ((prop(layer, a.end, 'anim.end', t, comp) + off) / 100) * n;
  const soft = Math.max(0, prop(layer, a.soft, 'anim.soft', t, comp) || 0);
  const lo = Math.min(s, e); const hi = Math.max(s, e);
  const out = [];
  for (let i = 0; i < n; i++) {
    let v;
    if (soft > 0.01) {
      const c = i + 0.5;
      v = Math.max(0, Math.min(1, (c - lo) / soft + 0.5)) * Math.max(0, Math.min(1, (hi - c) / soft + 0.5));
    } else v = Math.max(0, Math.min(1, Math.min(hi, i + 1) - Math.max(lo, i)));
    out.push(v);
  }
  return out;
}

function drawText(ctx, layer, t, comp) {
  const tx = layer.text;
  const { chars, size } = layoutText(layer, t, comp);
  const color = prop(layer, tx.color, 'text.color', t, comp);
  const strokeOn = tx.stroke?.on; const sw = strokeOn ? prop(layer, tx.stroke.width, 'text.stroke.width', t, comp) : 0;
  ctx.font = fontCss(tx, size);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  if (strokeOn) { ctx.strokeStyle = prop(layer, tx.stroke.color, 'text.stroke.color', t, comp); ctx.lineWidth = sw; ctx.lineJoin = 'round'; }
  const an = tx.anim?.on ? tx.anim : null;
  const amounts = an ? selectorAmounts(layer, chars.length, t, comp) : null;
  const A = an ? {
    opacity: prop(layer, an.opacity, 'anim.opacity', t, comp), pos: prop(layer, an.pos, 'anim.pos', t, comp), scale: prop(layer, an.scale, 'anim.scale', t, comp),
    rot: prop(layer, an.rot, 'anim.rot', t, comp), blur: 0,
  } : null;
  const base = ctx.globalAlpha;
  chars.forEach((c, i) => {
    if (c.ch === ' ') return;
    const k = amounts ? amounts[i] : 0;
    ctx.save();
    let x = c.x; let y = c.y;
    if (A && k > 0) {
      x += A.pos[0] * k; y += A.pos[1] * k;
      ctx.globalAlpha = base * Math.max(0, Math.min(1, 1 + (A.opacity / 100 - 1) * k));
      const cx = x + c.w / 2; const cy = y - size * 0.35;
      const sc = 1 + (A.scale / 100 - 1) * k;
      ctx.translate(cx, cy); ctx.rotate((A.rot * k * Math.PI) / 180); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    }
    if (ctx.globalAlpha > 0.001) {
      if (strokeOn && tx.stroke.under !== false) ctx.strokeText(c.ch, x, y);
      ctx.fillText(c.ch, x, y);
    }
    ctx.restore();
  });
}

function fillStyleFor(ctx, layer, fill, t, comp) {
  if (fill.gradient?.on) {
    const g = fill.gradient;
    const a = prop(layer, g.a, 'grad.a', t, comp); const b = prop(layer, g.b, 'grad.b', t, comp);
    const grad = g.type === 'radial' ? ctx.createRadialGradient(a[0], a[1], 0, a[0], a[1], Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) : ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
    grad.addColorStop(0, prop(layer, g.c0, 'grad.c0', t, comp)); grad.addColorStop(1, prop(layer, g.c1, 'grad.c1', t, comp));
    return grad;
  }
  return prop(layer, fill.color, 'fill.color', t, comp);
}

function drawShape(ctx, layer, t, comp) {
  const sh = layer.shape;
  const polys = shapePolys(layer, t, comp);
  const once = () => {
    if (sh.fill?.on) {
      ctx.save(); ctx.globalAlpha *= (prop(layer, sh.fill.opacity, 'fill.opacity', t, comp) ?? 100) / 100;
      ctx.beginPath(); tracePolys(ctx, polys); ctx.fillStyle = fillStyleFor(ctx, layer, sh.fill, t, comp); ctx.fill(sh.fill.rule || 'nonzero');
      ctx.restore();
    }
    if (sh.stroke?.on) {
      const w = prop(layer, sh.stroke.width, 'stroke.width', t, comp);
      if (w > 0) {
        ctx.save(); ctx.globalAlpha *= (prop(layer, sh.stroke.opacity, 'stroke.opacity', t, comp) ?? 100) / 100;
        ctx.beginPath(); tracePolys(ctx, polys);
        ctx.strokeStyle = prop(layer, sh.stroke.color, 'stroke.color', t, comp); ctx.lineWidth = w;
        ctx.lineCap = sh.stroke.cap || 'round'; ctx.lineJoin = sh.stroke.join || 'round';
        if (sh.stroke.dash > 0) ctx.setLineDash([sh.stroke.dash, sh.stroke.gap ?? sh.stroke.dash]);
        ctx.stroke(); ctx.restore();
      }
    }
  };
  const rp = sh.repeater;
  if (!rp?.on) { once(); return; }
  const n = Math.max(1, Math.min(200, Math.round(prop(layer, rp.copies, 'rep.copies', t, comp))));
  const off = prop(layer, rp.offset, 'rep.offset', t, comp); const rot = prop(layer, rp.rotation, 'rep.rotation', t, comp);
  const sc = prop(layer, rp.scale, 'rep.scale', t, comp); const endO = prop(layer, rp.endOpacity, 'rep.endOpacity', t, comp);
  const base = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.translate(off[0] * i, off[1] * i); ctx.rotate((rot * i * Math.PI) / 180); ctx.scale((sc[0] / 100) ** i, (sc[1] / 100) ** i);
    ctx.globalAlpha = base * (1 + (endO / 100 - 1) * (n > 1 ? i / (n - 1) : 0));
    once();
    ctx.restore();
  }
}

/** Size of a layer's content box (layer space), used for anchors, handles and hit testing. */
export function layerBox(project, layer, t, comp) {
  switch (layer.type) {
    case 'solid': case 'image': case 'video': return { x: 0, y: 0, w: layer.w, h: layer.h };
    case 'adjustment': return { x: 0, y: 0, w: layer.w || comp.width, h: layer.h || comp.height };
    case 'precomp': { const c = compById(project, layer.comp); return { x: 0, y: 0, w: c?.width || 100, h: c?.height || 100 }; }
    case 'null': return { x: 0, y: 0, w: 100, h: 100 };
    case 'text': return layoutText(layer, t, comp).box;
    case 'shape': {
      const polys = shapePolys({ ...layer, shape: { ...layer.shape, trim: null } }, t, comp);
      const b = bbox(polys.map((p) => p.pts));
      const sw = layer.shape.stroke?.on ? (prop(layer, layer.shape.stroke.width, 'stroke.width', t, comp) || 0) / 2 : 0;
      return { x: b.x - sw, y: b.y - sw, w: b.w + sw * 2, h: b.h + sw * 2 };
    }
    default: return { x: 0, y: 0, w: 0, h: 0 };
  }
}

// ---------------------------------------------------------------- masks

function maskPoly(m) {
  if (m.kind === 'rect') return rectPoly(m.rect[0] + m.rect[2] / 2, m.rect[1] + m.rect[3] / 2, m.rect[2], m.rect[3], 0);
  if (m.kind === 'ellipse') return ellipsePoly(m.rect[0] + m.rect[2] / 2, m.rect[1] + m.rect[3] / 2, m.rect[2], m.rect[3]);
  return penPoly(m.nodes || [], true);
}
export { maskPoly };

function applyMasks(buf, layer, M, s, t, comp) {
  const masks = (layer.masks || []).filter((m) => m.mode !== 'none');
  if (!masks.length) return;
  const W = buf.width; const H = buf.height;
  const mc = acquire(W, H); const mctx = mc.getContext('2d');
  if (masks[0].mode === 'subtract') { mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, W, H); }
  const one = acquire(W, H); const octx = one.getContext('2d');
  for (const m of masks) {
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.globalCompositeOperation = 'source-over'; octx.clearRect(0, 0, W, H);
    const feather = Math.max(0, prop(layer, m.feather, `mask.${m.id}.feather`, t, comp) || 0) * s;
    const op = (prop(layer, m.opacity, `mask.${m.id}.opacity`, t, comp) ?? 100) / 100;
    octx.filter = feather > 0.3 ? `blur(${(feather / 2).toFixed(2)}px)` : 'none';
    octx.setTransform(s * M[0], s * M[1], s * M[2], s * M[3], s * M[4], s * M[5]);
    octx.beginPath(); tracePolys(octx, [maskPoly(m)]);
    octx.fillStyle = `rgba(255,255,255,${op})`;
    if (m.inverted) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.rect(0, 0, W, H); octx.fill('evenodd'); } else octx.fill();
    octx.filter = 'none';
    mctx.globalCompositeOperation = m.mode === 'subtract' ? 'destination-out' : m.mode === 'intersect' ? 'destination-in' : 'source-over';
    mctx.drawImage(one, 0, 0);
  }
  const bctx = buf.getContext('2d');
  bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.globalCompositeOperation = 'destination-in'; bctx.drawImage(mc, 0, 0); bctx.restore();
  release(one); release(mc);
}

// ---------------------------------------------------------------- layers

function evalEffects(layer, t, comp) {
  return (layer.effects || []).filter((e) => e.on !== false).map((e) => ({
    type: e.type,
    params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, p && typeof p === 'object' && 'v' in p ? prop(layer, p, `fx.${e.id}.${k}`, t, comp) : p])),
  }));
}

/** Draws a layer's content into a fresh comp-sized buffer (content, masks, effects). Caller releases it. */
function layerBuffer(project, comp, layer, t, s, depth, opts) {
  const W = Math.max(1, Math.round(comp.width * s)); const H = Math.max(1, Math.round(comp.height * s));
  const buf = acquire(W, H);
  const ctx = buf.getContext('2d');
  const M = worldMatrix(layer, t, comp);
  ctx.setTransform(s * M[0], s * M[1], s * M[2], s * M[3], s * M[4], s * M[5]);
  ctx.imageSmoothingQuality = 'high';
  switch (layer.type) {
    case 'solid': ctx.fillStyle = prop(layer, layer.color, 'color', t, comp); ctx.fillRect(0, 0, layer.w, layer.h); break;
    case 'shape': drawShape(ctx, layer, t, comp); break;
    case 'text': drawText(ctx, layer, t, comp); break;
    case 'image': { const img = getImage(layer.asset); if (img) ctx.drawImage(img, 0, 0, layer.w, layer.h); break; }
    case 'video': {
      const v = getVideo(layer.id, layer.asset);
      if (!opts.wait) nudgeVideo(v, t - layer.start);
      if (videoReady(v)) ctx.drawImage(v, 0, 0, layer.w, layer.h);
      break;
    }
    case 'precomp': {
      const sub = compById(project, layer.comp);
      if (sub && depth < 8) {
        const sw = Math.max(1, Math.round(sub.width * s)); const sh = Math.max(1, Math.round(sub.height * s));
        const nb = acquire(sw, sh);
        renderInto(project, sub, t - layer.start, nb.getContext('2d'), s, depth + 1, { ...opts, transparent: !layer.keepBg });
        ctx.drawImage(nb, 0, 0, sub.width, sub.height);
        release(nb);
      }
      break;
    }
    default:
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyMasks(buf, layer, M, s, t, comp);
  const fx = evalEffects(layer, t, comp);
  if (fx.length) applyEffects(buf, fx, { scale: s, t, fps: comp.fps, seed: layer.id });
  return buf;
}

/** Buffer with motion blur: averages subframes across the shutter (180°) when the layer and comp ask for it. */
function layerBufferMB(project, comp, layer, t, s, depth, opts) {
  if (!(layer.motionBlur && comp.motionBlur) || opts.noMB) return layerBuffer(project, comp, layer, t, s, depth, opts);
  const N = 6; const span = 0.5 / comp.fps;
  const W = Math.max(1, Math.round(comp.width * s)); const H = Math.max(1, Math.round(comp.height * s));
  const acc = acquire(W, H); const actx = acc.getContext('2d');
  actx.globalCompositeOperation = 'lighter'; actx.globalAlpha = 1 / N;
  for (let i = 0; i < N; i++) { const b = layerBuffer(project, comp, layer, t - span / 2 + (span * i) / (N - 1), s, depth, opts); actx.drawImage(b, 0, 0); release(b); }
  actx.globalAlpha = 1; actx.globalCompositeOperation = 'source-over';
  return acc;
}

function renderInto(project, comp, t, ctx, s, depth, opts) {
  const W = ctx.canvas.width; const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  if (opts.transparent) ctx.clearRect(0, 0, W, H);
  else { ctx.fillStyle = comp.bg || '#000'; ctx.fillRect(0, 0, W, H); }
  const layers = comp.layers;
  const anySolo = layers.some((l) => l.solo && VISUAL.has(l.type));
  const matteSources = new Set(layers.filter((l) => l.matte?.layer && l.enabled !== false).map((l) => l.matte.layer));
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!VISUAL.has(layer.type) || layer.enabled === false || !isActive(layer, t) || matteSources.has(layer.id)) continue;
    if (anySolo && !layer.solo) continue;
    if (opts.hide?.has(layer.id)) continue;
    const opacity = Math.max(0, Math.min(1, prop(layer, layer.tr.opacity, 'opacity', t, comp) / 100));
    if (opacity <= 0) continue;
    if (layer.type === 'adjustment') {
      // Effects on everything below, inside the adjustment layer's area (and masks).
      const area = layerBuffer(project, comp, { ...layer, type: 'solid', color: { v: '#fff' }, effects: [], w: layer.w || comp.width, h: layer.h || comp.height }, t, s, depth, opts);
      const below = acquire(W, H); const bctx = below.getContext('2d');
      bctx.drawImage(ctx.canvas, 0, 0);
      const fx = evalEffects(layer, t, comp);
      if (fx.length) applyEffects(below, fx, { scale: s, t, fps: comp.fps, seed: layer.id });
      bctx.globalCompositeOperation = 'destination-in'; bctx.drawImage(area, 0, 0);
      ctx.globalAlpha = opacity; ctx.drawImage(below, 0, 0); ctx.globalAlpha = 1;
      release(area); release(below);
      continue;
    }
    const buf = layerBufferMB(project, comp, layer, t, s, depth, opts);
    if (layer.matte?.layer) {
      const src = layers.find((l) => l.id === layer.matte.layer);
      const bctx = buf.getContext('2d');
      const inverted = /Inv$/.test(layer.matte.mode);
      if (src && isActive(src, t)) {
        const mb = layerBufferMB(project, comp, src, t, s, depth, opts);
        if (/^luma/.test(layer.matte.mode)) lumaToAlpha(mb);
        const mo = Math.max(0, Math.min(1, prop(src, src.tr.opacity, 'opacity', t, comp) / 100));
        bctx.globalAlpha = mo; bctx.globalCompositeOperation = inverted ? 'destination-out' : 'destination-in';
        if (!inverted && mo < 1) { // destination-in with partial alpha must still scale everything
          const tmp = acquire(W, H); const tctx = tmp.getContext('2d'); tctx.globalAlpha = mo; tctx.drawImage(mb, 0, 0);
          bctx.globalAlpha = 1; bctx.drawImage(tmp, 0, 0); release(tmp);
        } else bctx.drawImage(mb, 0, 0);
        bctx.globalAlpha = 1; bctx.globalCompositeOperation = 'source-over';
        release(mb);
      } else if (!inverted) bctx.clearRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = gco(layer.blend);
    ctx.globalAlpha = opacity;
    ctx.drawImage(buf, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    release(buf);
  }
  ctx.restore();
}

/**
 * Draws the composition at time t into ctx. The canvas should be comp.width × comp.height times opts.scale.
 * opts: { scale = 1, transparent, hide: Set of layer ids, wait (export: videos were seeked by prepareFrame), noMB }
 */
export function renderFrame(project, comp, t, ctx, opts = {}) {
  const s = opts.scale ?? ctx.canvas.width / comp.width;
  renderInto(project, comp, t, ctx, s, 0, opts);
}

/** Everything a frame needs: fonts, images, and video frames at their media times (recurses into precomps). */
export function collectMedia(project, comp, t, out = [], depth = 0) {
  for (const l of comp.layers) {
    if (l.enabled === false && !comp.layers.some((x) => x.matte?.layer === l.id)) continue;
    if (!isActive(l, t)) continue;
    if (l.type === 'text') out.push({ kind: 'font', family: l.text.font || 'Inter', weight: l.text.weight || 400, italic: l.text.italic });
    else if (l.type === 'image') out.push({ kind: 'image', asset: l.asset });
    else if (l.type === 'video') out.push({ kind: 'video', key: l.id, asset: l.asset, time: t - l.start });
    else if (l.type === 'precomp' && depth < 8) { const sub = compById(project, l.comp); if (sub) collectMedia(project, sub, t - l.start, out, depth + 1); }
  }
  return out;
}

/** Gets a frame ready to draw. wait: await every video seek (export); otherwise just ask and redraw later (preview). */
export async function prepareFrame(project, comp, t, { wait = false } = {}) {
  const list = collectMedia(project, comp, t);
  const jobs = [];
  for (const m of list) {
    if (m.kind === 'font') jobs.push(ensureFont(m.family, m.weight, m.italic ? 'italic' : 'normal'));
    else if (m.kind === 'image') jobs.push(loadImageAsset(m.asset));
    else if (m.kind === 'video') { const v = getVideo(m.key, m.asset); if (wait) jobs.push(seekVideo(v, m.time)); else nudgeVideo(v, m.time); }
  }
  if (wait) await Promise.all(jobs);
}

/** Sound in the comp, for mixAudio(): audio layers and video layers with sound on (recurses into precomps). */
export function audioClips(project, comp, offset = 0, range = [0, Infinity], depth = 0) {
  const out = [];
  const anySolo = comp.layers.some((l) => l.solo && (l.type === 'audio' || l.type === 'video'));
  for (const l of comp.layers) {
    if ((l.type === 'audio' || l.type === 'video') && l.audioOn !== false && l.asset && (!anySolo || l.solo) && (l.type === 'audio' ? l.enabled !== false : true)) {
      const gain = Math.max(0, (l.volume?.v ?? 100) / 100);
      out.push({ asset: l.asset, at: offset + l.start, from: Math.max(range[0], offset + l.in), to: Math.min(range[1], offset + l.out), gain });
    } else if (l.type === 'precomp' && depth < 8) {
      const sub = compById(project, l.comp);
      if (sub) out.push(...audioClips(project, sub, offset + l.start, [Math.max(range[0], offset + l.in), Math.min(range[1], offset + l.out)], depth + 1));
    }
  }
  return out;
}

/** Topmost visible layer under a comp-space point (for clicking in the viewer). */
export function hitTest(project, comp, t, pt) {
  for (const l of comp.layers) {
    if (!VISUAL.has(l.type) && l.type !== 'null') continue;
    if (l.enabled === false && l.type !== 'null') continue;
    if (!isActive(l, t) || l.locked) continue;
    const M = worldMatrix(l, t, comp);
    const det = M[0] * M[3] - M[1] * M[2];
    if (Math.abs(det) < 1e-9) continue;
    const inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det];
    const p = apply(inv, pt);
    const b = layerBox(project, l, t, comp);
    if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return l;
  }
  return null;
}
export { I, colorArr };
