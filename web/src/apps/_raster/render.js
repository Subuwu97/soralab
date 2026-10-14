// Compositing: turns the layer tree into one canvas the size of the document.
//
// The Renderer keeps that composite cached and only recomposes rectangles that changed: while painting, the tool
// calls invalidate(rect); when the document changes (undo, a property edit…) setDoc() works out which area differs.
// Blend modes are Canvas 2D composite operations; masks, clipping groups, layer effects and groups use scratch
// canvases; adjustment layers rewrite the pixels below them (getImageData) inside the rectangle being drawn.
import { drawPix, intersect, union, padRect, roundRect } from './pix.js';
import { flatten, maskOffset } from './model.js';
import { applyAdjustment } from './adjust.js';
import { parse } from '../../lib/color.js';
import { ensureFont } from '../../lib/fonts.js';

// ---------------------------------------------------------------- scratch canvases

const pool = [];
function acquire(w, h) {
  let c = pool.pop();
  if (!c) { c = document.createElement('canvas'); c.width = 1; c.height = 1; }
  if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return c;
}
const release = (c) => { if (pool.length < 8) pool.push(c); };

// ---------------------------------------------------------------- text, shapes, fills

const rasterCache = new WeakMap();
let asyncHook = null; // called when a font finishes loading so the text can be redrawn
export const onRasterAsync = (fn) => { asyncHook = fn; };

export const fontString = (l, size = l.size) => `${l.italic ? 'italic ' : ''}${l.weight || 400} ${size}px "${l.font}", Inter, sans-serif`;

/** Unrotated layout of a text layer: lines, widths and the box (doc coords, before rotation about x,y). */
export function textLayout(l) {
  const c = textLayout.c ||= document.createElement('canvas').getContext('2d');
  c.font = fontString(l);
  try { c.letterSpacing = `${(l.tracking || 0) * l.size / 1000}px`; } catch { /* older browsers */ }
  const lines = String(l.text ?? '').split('\n');
  const widths = lines.map((s) => c.measureText(s || ' ').width);
  const w = Math.max(1, ...widths);
  const lh = l.size * (l.lineHeight || 1.2);
  const h = lh * lines.length;
  const left = l.align === 'center' ? l.x - w / 2 : l.align === 'right' ? l.x - w : l.x;
  return { lines, widths, w, h, lh, left, top: l.y };
}

/** Corners of a box rotated by deg about (cx, cy). */
export function rotatedCorners(x, y, w, h, deg, cx, cy) {
  const a = (deg || 0) * Math.PI / 180; const cos = Math.cos(a); const sin = Math.sin(a);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]);
}
const boundsOf = (pts, pad = 0) => {
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return roundRect({ x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 });
};

/** Geometry used by the transform handles: { x, y, w, h, rotation, cx, cy } (box before rotation about cx,cy). */
export function layerBox(l) {
  if (l.type === 'text') { const t = textLayout(l); return { x: t.left, y: t.top, w: t.w, h: t.h, rotation: l.rotation || 0, cx: l.x, cy: l.y }; }
  if (l.type === 'shape') {
    const x = Math.min(l.x, l.x + l.w); const y = Math.min(l.y, l.y + l.h);
    return { x, y, w: Math.abs(l.w), h: Math.abs(l.h), rotation: l.rotation || 0, cx: x + Math.abs(l.w) / 2, cy: y + Math.abs(l.h) / 2 };
  }
  return null;
}

/** Text and shape layers drawn once into their own canvas (cached per immutable layer object). */
export function rasterLayer(l) {
  let r = rasterCache.get(l);
  if (r) return r;
  if (l.type === 'text') r = rasterText(l);
  else if (l.type === 'shape') r = rasterShape(l);
  if (r) rasterCache.set(l, r);
  return r;
}

function rasterText(l) {
  const fs = fontString(l);
  if (!document.fonts.check(fs)) {
    ensureFont(l.font, l.weight || 400, l.italic ? 'italic' : 'normal').then((ok) => { if (ok && rasterCache.has(l)) { rasterCache.delete(l); asyncHook?.(l); } });
  }
  const t = textLayout(l);
  const pad = Math.ceil(l.size * 0.35) + 2;
  const b = boundsOf(rotatedCorners(t.left, t.top, t.w, t.h, l.rotation, l.x, l.y), pad);
  const c = document.createElement('canvas');
  c.width = Math.max(1, b.w); c.height = Math.max(1, b.h);
  const ctx = c.getContext('2d');
  ctx.translate(l.x - b.x, l.y - b.y);
  ctx.rotate((l.rotation || 0) * Math.PI / 180);
  ctx.font = fs;
  try { ctx.letterSpacing = `${(l.tracking || 0) * l.size / 1000}px`; } catch { /* ignore */ }
  ctx.fillStyle = l.color || '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = l.align || 'left';
  const ascent = l.size * 0.8 + (t.lh - l.size) / 2;
  t.lines.forEach((s, i) => ctx.fillText(s, 0, ascent + i * t.lh));
  return { canvas: c, x: b.x, y: b.y, w: b.w, h: b.h };
}

export function shapePath(ctx, l, x, y, w, h) {
  ctx.beginPath();
  if (l.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  else if (l.shape === 'polygon') {
    const n = Math.max(3, l.sides || 6);
    for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; const px = x + w / 2 + Math.cos(a) * w / 2; const py = y + h / 2 + Math.sin(a) * h / 2; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.closePath();
  } else if (l.shape === 'line') { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); }
  else if (l.radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(l.radius, Math.abs(w) / 2, Math.abs(h) / 2));
  else ctx.rect(x, y, w, h);
}

function rasterShape(l) {
  const sw = l.stroke || l.shape === 'line' ? l.strokeWidth || 1 : 0;
  const pad = Math.ceil(sw) + 2;
  let b;
  if (l.shape === 'line') b = boundsOf([[l.x, l.y], [l.x + l.w, l.y + l.h]], pad);
  else { const bx = layerBox(l); b = boundsOf(rotatedCorners(bx.x, bx.y, bx.w, bx.h, l.rotation, bx.cx, bx.cy), pad); }
  const c = document.createElement('canvas');
  c.width = Math.max(1, b.w); c.height = Math.max(1, b.h);
  const ctx = c.getContext('2d');
  ctx.translate(-b.x, -b.y);
  if (l.shape === 'line') {
    shapePath(ctx, l, l.x, l.y, l.w, l.h);
    ctx.lineCap = 'round'; ctx.lineWidth = sw; ctx.strokeStyle = l.stroke || l.fill || '#000'; ctx.stroke();
  } else {
    const bx = layerBox(l);
    ctx.translate(bx.cx, bx.cy); ctx.rotate((l.rotation || 0) * Math.PI / 180); ctx.translate(-bx.cx, -bx.cy);
    shapePath(ctx, l, bx.x, bx.y, bx.w, bx.h);
    if (l.fill) { ctx.fillStyle = l.fill; ctx.fill(); }
    if (l.stroke && sw) { ctx.lineJoin = 'round'; ctx.lineWidth = sw; ctx.strokeStyle = l.stroke; ctx.stroke(); }
  }
  return { canvas: c, x: b.x, y: b.y, w: b.w, h: b.h };
}

export function fillStyle(ctx, f, doc, dx, dy) {
  if (f.kind !== 'gradient') return f.color || '#000';
  const cx = doc.width / 2 + dx; const cy = doc.height / 2 + dy;
  let g;
  if (f.type === 'radial') g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(doc.width, doc.height) / 2 * (f.scale || 1));
  else {
    const a = (f.angle ?? 90) * Math.PI / 180;
    const ux = Math.cos(a); const uy = -Math.sin(a);
    const half = (Math.abs(ux) * doc.width + Math.abs(uy) * doc.height) / 2 * (f.scale || 1);
    g = ctx.createLinearGradient(cx - ux * half, cy - uy * half, cx + ux * half, cy + uy * half);
  }
  const cols = f.colors || ['#000', '#fff'];
  cols.forEach((c, i) => g.addColorStop(i / Math.max(1, cols.length - 1), c));
  return g;
}

// ---------------------------------------------------------------- bounds

export function fxMargin(l) {
  const f = l.fx;
  if (!f) return 0;
  let m = 0;
  if (f.shadow?.on) m = Math.max(m, (f.shadow.distance || 0) + (f.shadow.size || 0) * 1.5);
  if (f.glow?.on) m = Math.max(m, (f.glow.size || 0) * 1.5);
  if (f.stroke?.on) m = Math.max(m, f.stroke.size || 0);
  return Math.ceil(m) + (m ? 2 : 0);
}
const hasFx = (l) => !!(l.fx && (l.fx.shadow?.on || l.fx.glow?.on || l.fx.stroke?.on || l.fx.overlay?.on));

/** Area (doc coords) a layer can draw into. Fill/adjustment layers and groups with them cover the whole document. */
export function layerBounds(l, doc) {
  const full = { x: 0, y: 0, w: doc.width, h: doc.height };
  let r = null;
  if (l.type === 'bitmap') { const b = l.pix?.bounds; r = b && { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h }; }
  else if (l.type === 'text' || l.type === 'shape') { const ra = rasterLayer(l); r = ra && { x: ra.x, y: ra.y, w: ra.w, h: ra.h }; }
  else if (l.type === 'group') { for (const k of l.children) { const b = layerBounds(k, doc); if (b === full || (b && b.w >= doc.width && b.h >= doc.height && b.x <= 0 && b.y <= 0)) return full; r = union(r, b); } }
  else return full;
  return r && padRect(r, fxMargin(l));
}

const sameExcept = (a, b, skip) => {
  for (const k in a) if (!skip.includes(k) && a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
};
const related = (p, q) => p && q && (p.base === q || q.base === p);

/** The doc-space area that differs between two documents: null (nothing), a rect, or the whole document. */
export function diffRect(a, b) {
  const full = { x: 0, y: 0, w: b.width, h: b.height };
  if (!a || a.width !== b.width || a.height !== b.height) return full;
  if (a.layers === b.layers) return null;
  const fa = flatten(a.layers); const fb = flatten(b.layers);
  if (fa.length !== fb.length || fa.some((l, i) => l.id !== fb[i].id || l.clip !== fb[i].clip)) return full;
  let r = null;
  for (let i = 0; i < fa.length; i++) {
    const p = fa[i]; const q = fb[i];
    if (p === q) continue;
    if (p.type === 'group' && sameExcept(p, q, ['children', 'open'])) continue; // its children are compared on their own
    if (p.type === 'bitmap' && sameExcept(p, q, ['pix']) && related(p.pix, q.pix)) {
      const d = p.pix.base === q.pix ? p.pix.delta : q.pix.delta;
      r = union(r, padRect({ x: d.x + p.x, y: d.y + p.y, w: d.w, h: d.h }, fxMargin(p)));
      continue;
    }
    if (sameExcept(p, q, ['mask', 'name', 'locked', 'lockAlpha']) && p.mask && q.mask && sameExcept(p.mask, q.mask, ['pix']) && related(p.mask.pix, q.mask.pix)) {
      const d = p.mask.pix.base === q.mask.pix ? p.mask.pix.delta : q.mask.pix.delta; const o = maskOffset(p);
      r = union(r, padRect({ x: d.x + o.x, y: d.y + o.y, w: d.w, h: d.h }, fxMargin(p)));
      continue;
    }
    if (sameExcept(p, q, ['name', 'locked', 'lockAlpha', 'open'])) continue;
    r = union(r, union(layerBounds(p, a), layerBounds(q, b)));
    if (r && r.w >= full.w && r.h >= full.h) return full;
  }
  return r && intersect(roundRect(r), full);
}

// ---------------------------------------------------------------- the renderer

export class Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.doc = null;
    this.pending = null;
    this.overrides = new Map(); // layer id → { draw(ctx, dx, dy, clip), bounds } — live previews (free transform, moving pixels)
    this.version = 0;
  }
  setDoc(doc) {
    if (doc === this.doc) return;
    const d = diffRect(this.doc, doc);
    if (!this.doc || this.canvas.width !== doc.width || this.canvas.height !== doc.height) {
      this.canvas.width = doc.width; this.canvas.height = doc.height;
    }
    this.doc = doc;
    if (d) this.invalidate(d);
  }
  invalidate(r) {
    if (!this.doc) return;
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const c = r === 'full' || !r ? full : intersect(roundRect(r), full);
    if (c) this.pending = union(this.pending, c);
  }
  /** Recomposes whatever changed; returns the rect redrawn (or null). */
  flush() {
    const r = this.pending;
    if (!r || !this.doc) return null;
    this.pending = null;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    this.drawLayers({ ctx, ox: 0, oy: 0 }, this.doc.layers, r);
    ctx.restore();
    this.version++;
    return r;
  }
  /** Renders the visible layers into another canvas (doc coords → ctx scaled by `scale`), e.g. a flattened copy. */
  renderTo(ctx, layers = this.doc.layers, r = { x: 0, y: 0, w: this.doc.width, h: this.doc.height }) {
    this.drawLayers({ ctx, ox: r.x, oy: r.y }, layers, r);
  }

  drawLayers(s, layers, r) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      let j = i + 1;
      while (j < layers.length && layers[j].clip) j++;
      const clipped = l.clip && i > 0 ? [] : layers.slice(i + 1, j).filter((c) => c.visible);
      if (!(l.clip && i > 0)) i = j - 1; // clipped layers are drawn with their base
      if (!l.visible) continue;
      this.drawLayer(s, l, r, clipped);
    }
  }

  drawLayer(s, l, r, clipped = []) {
    const { ctx } = s;
    if (l.type === 'adjust') { this.applyAdjust(s, l, r); return; }
    if (l.type === 'group' && l.blend === 'pass-through' && l.opacity >= 1 && !(l.mask?.enabled) && !hasFx(l) && !clipped.length) {
      this.drawLayers(s, l.children, r); return;
    }
    if (l.type !== 'group' && !(l.mask?.enabled) && !hasFx(l) && !clipped.length) {
      ctx.save();
      ctx.globalAlpha = l.opacity; ctx.globalCompositeOperation = l.blend || 'source-over';
      this.drawContent(ctx, l, -s.ox, -s.oy, r);
      ctx.restore();
      return;
    }
    const iso = this.isolate(l, r);
    for (const c of clipped) {
      if (c.type === 'adjust') { this.applyAdjust({ ctx: iso.canvas.getContext('2d'), ox: iso.r.x, oy: iso.r.y }, c, intersect(r, iso.r)); continue; }
      const ci = this.isolate(c, iso.r);
      const cc = ci.canvas.getContext('2d');
      cc.globalCompositeOperation = 'destination-in';
      cc.drawImage(iso.canvas, 0, 0, iso.r.w, iso.r.h, iso.r.x - ci.r.x, iso.r.y - ci.r.y, iso.r.w, iso.r.h);
      const ic = iso.canvas.getContext('2d');
      ic.save(); ic.globalAlpha = c.opacity; ic.globalCompositeOperation = c.blend === 'pass-through' ? 'source-over' : c.blend;
      ic.drawImage(ci.canvas, 0, 0, ci.r.w, ci.r.h, ci.r.x - iso.r.x, ci.r.y - iso.r.y, ci.r.w, ci.r.h);
      ic.restore();
      release(ci.canvas);
    }
    ctx.save();
    ctx.globalAlpha = l.opacity; ctx.globalCompositeOperation = l.blend === 'pass-through' ? 'source-over' : l.blend || 'source-over';
    ctx.drawImage(iso.canvas, r.x - iso.r.x, r.y - iso.r.y, r.w, r.h, r.x - s.ox, r.y - s.oy, r.w, r.h);
    ctx.restore();
    release(iso.canvas);
  }

  /** A layer (or group) drawn alone at full opacity with its mask and effects. Returns { canvas, r } — release it. */
  isolate(l, r0) {
    const m = fxMargin(l);
    const r = m ? padRect(r0, m) : r0;
    const c = acquire(r.w, r.h);
    const ctx = c.getContext('2d');
    if (l.type === 'group') this.drawLayers({ ctx, ox: r.x, oy: r.y }, l.children, r);
    else this.drawContent(ctx, l, -r.x, -r.y, r);
    this.applyMask(ctx, l, -r.x, -r.y, r);
    if (hasFx(l)) this.applyFx(c, l, r);
    return { canvas: c, r };
  }

  drawContent(ctx, l, dx, dy, clip) {
    const o = this.overrides.get(l.id);
    if (o) { o.draw(ctx, dx, dy, clip); return; }
    const tclip = { x: clip.x + dx, y: clip.y + dy, w: clip.w, h: clip.h };
    if (l.type === 'bitmap') drawPix(ctx, l.pix, dx + l.x, dy + l.y, tclip);
    else if (l.type === 'text' || l.type === 'shape') { const ra = rasterLayer(l); if (ra) ctx.drawImage(ra.canvas, ra.x + dx, ra.y + dy); }
    else if (l.type === 'fill') { ctx.fillStyle = fillStyle(ctx, l.fill, this.doc, dx, dy); ctx.fillRect(tclip.x, tclip.y, tclip.w, tclip.h); }
    else if (l.type === 'group') { ctx.save(); this.drawLayers({ ctx, ox: -dx, oy: -dy }, l.children, clip); ctx.restore(); }
  }

  applyMask(ctx, l, dx, dy, clip) {
    const mk = l.mask;
    if (!mk?.enabled || !mk.pix) return;
    const o = maskOffset(l);
    ctx.save();
    if (!mk.inverted) {
      // the mask stores how much is hidden: cut it out
      ctx.globalCompositeOperation = 'destination-out';
      drawPix(ctx, mk.pix, dx + o.x, dy + o.y, { x: clip.x + dx, y: clip.y + dy, w: clip.w, h: clip.h });
    } else {
      const t = acquire(clip.w, clip.h);
      drawPix(t.getContext('2d'), mk.pix, o.x - clip.x, o.y - clip.y, { x: 0, y: 0, w: clip.w, h: clip.h });
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(t, 0, 0, clip.w, clip.h, clip.x + dx, clip.y + dy, clip.w, clip.h);
      release(t);
    }
    ctx.restore();
  }

  applyFx(c, l, r) {
    const f = l.fx;
    const ctx = c.getContext('2d');
    if (f.overlay?.on) {
      ctx.save(); ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = f.overlay.opacity ?? 1; ctx.fillStyle = f.overlay.color || '#f00'; ctx.fillRect(0, 0, r.w, r.h); ctx.restore();
    }
    const out = acquire(r.w, r.h);
    const o = out.getContext('2d');
    const rgba = (col, a) => { const p = parse(col); return `rgba(${p.r},${p.g},${p.b},${a ?? 1})`; };
    const shadowOnly = (color, blur, ox, oy) => {
      o.save(); o.shadowColor = color; o.shadowBlur = blur; o.shadowOffsetX = ox + 20000; o.shadowOffsetY = oy;
      o.drawImage(c, 0, 0, r.w, r.h, -20000, 0, r.w, r.h); o.restore();
    };
    if (f.shadow?.on) {
      const a = (f.shadow.angle ?? 135) * Math.PI / 180; const d = f.shadow.distance ?? 8;
      shadowOnly(rgba(f.shadow.color || '#000', f.shadow.opacity ?? 0.6), f.shadow.size ?? 10, -Math.cos(a) * d, Math.sin(a) * d);
    }
    if (f.glow?.on) { shadowOnly(rgba(f.glow.color || '#ffe08a', f.glow.opacity ?? 0.8), f.glow.size ?? 16, 0, 0); shadowOnly(rgba(f.glow.color || '#ffe08a', (f.glow.opacity ?? 0.8) * 0.6), (f.glow.size ?? 16) / 2, 0, 0); }
    if (f.stroke?.on && f.stroke.size > 0) {
      // silhouette in the stroke colour, stamped around a circle
      const sil = acquire(r.w, r.h); const sc = sil.getContext('2d');
      sc.drawImage(c, 0, 0); sc.globalCompositeOperation = 'source-in'; sc.fillStyle = f.stroke.color || '#000'; sc.fillRect(0, 0, r.w, r.h);
      const n = Math.max(12, Math.min(40, Math.round(f.stroke.size * 3)));
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; o.drawImage(sil, 0, 0, r.w, r.h, Math.cos(a) * f.stroke.size, Math.sin(a) * f.stroke.size, r.w, r.h); }
      release(sil);
    }
    o.drawImage(c, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(out, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    ctx.globalCompositeOperation = 'source-over';
    release(out);
  }

  applyAdjust(s, l, r) {
    if (!r || r.w <= 0 || r.h <= 0) return;
    const { ctx } = s;
    const x = r.x - s.ox; const y = r.y - s.oy;
    const img = ctx.getImageData(x, y, r.w, r.h);
    const masked = l.mask?.enabled && l.mask.pix;
    if (!masked && l.opacity >= 1) { applyAdjustment(img.data, l.adj); ctx.putImageData(img, x, y); return; }
    const orig = new Uint8ClampedArray(img.data);
    applyAdjustment(img.data, l.adj);
    let mdata = null;
    if (masked) {
      const t = acquire(r.w, r.h); const tc = t.getContext('2d');
      const o = maskOffset(l);
      if (l.mask.inverted) { drawPix(tc, l.mask.pix, o.x - r.x, o.y - r.y, { x: 0, y: 0, w: r.w, h: r.h }); }
      else { tc.fillStyle = '#000'; tc.fillRect(0, 0, r.w, r.h); tc.globalCompositeOperation = 'destination-out'; drawPix(tc, l.mask.pix, o.x - r.x, o.y - r.y, { x: 0, y: 0, w: r.w, h: r.h }); }
      mdata = tc.getImageData(0, 0, r.w, r.h).data;
      release(t);
    }
    const d = img.data; const op = l.opacity;
    for (let i = 0; i < d.length; i += 4) {
      const k = op * (mdata ? mdata[i + 3] / 255 : 1);
      if (k >= 1) continue;
      d[i] = orig[i] + (d[i] - orig[i]) * k; d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * k; d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * k;
    }
    ctx.putImageData(img, x, y);
  }
}

/** A small preview of one layer (for the Layers panel). Returns a canvas `size` px on its long side. */
export function layerThumb(renderer, l, doc, size = 40, which = 'content') {
  const s = Math.min(size / doc.width, size / doc.height);
  const w = Math.max(1, Math.round(doc.width * s)); const h = Math.max(1, Math.round(doc.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'medium';
  const r = { x: 0, y: 0, w: doc.width, h: doc.height };
  if (which === 'mask') {
    const o = maskOffset(l);
    ctx.save(); ctx.scale(s, s); drawPix(ctx, l.mask.pix, o.x, o.y, r); ctx.restore();
    ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = l.mask.inverted ? '#fff' : '#000'; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = l.mask.inverted ? '#000' : '#fff'; ctx.fillRect(0, 0, w, h);
    return c;
  }
  if (l.type === 'adjust') return null;
  ctx.save(); ctx.scale(s, s);
  if (l.type === 'group') renderer.drawLayers({ ctx, ox: 0, oy: 0 }, l.children, r);
  else renderer.drawContent(ctx, l, 0, 0, r);
  ctx.restore();
  return c;
}
