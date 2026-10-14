// Document and layer operations: editing pixels with a preview, fills, copy/paste, merging, masks,
// Image Size / Canvas Size / Crop / Rotate / Flip / Trim, transforms, paint bucket and healing.
// Each returns a new document (or layer); the caller puts it in history.
import { Pix, materialize, restore, commit, drawPix, pixToCanvas, intersect, union, roundRect, makeCanvas } from './pix.js';
import { selCanvas, translate as translateSel, floodMask } from './selection.js';
import { newBitmap, mapLayers, updateLayer, maskOffset, findLayer, locate, flatten } from './model.js';
import { layerBounds, rasterLayer, textLayout } from './render.js';

const docRect = (doc) => ({ x: 0, y: 0, w: doc.width, h: doc.height });

/** The pixels a tool edits: the layer itself or its mask. */
export function pixTarget(layer, target = 'pix') {
  if (target === 'mask' && layer.mask) { const o = maskOffset(layer); return { pix: layer.mask.pix, ox: o.x, oy: o.y, target }; }
  return { pix: layer.pix, ox: layer.x || 0, oy: layer.y || 0, target: 'pix' };
}
export const withPix = (doc, id, target, pix) => updateLayer(doc, id, (l) => (target === 'mask' ? { mask: { ...l.mask, pix } } : { pix }));

/**
 * A live edit of one layer's pixels (or mask), redrawn from the original tiles each time — used for previews
 * (gradient drag, filter dialogs, moving selected pixels) and one-shot edits (fill, delete, bucket).
 */
export class PixEdit {
  constructor(doc, layer, target = 'pix') {
    Object.assign(this, pixTarget(layer, target));
    this.doc = doc; this.layer = layer;
    this.m = materialize(this.pix, { x: -this.ox, y: -this.oy, w: doc.width, h: doc.height });
    this.dirty = null; // pix-local
  }
  /** Doc rect → mat-canvas coords offset. */
  get dx() { return -this.ox - this.m.x; }
  get dy() { return -this.oy - this.m.y; }
  /** Restores the last preview, then fn(ctx) draws on the mat canvas (already translated so doc coords work). r = doc rect touched. */
  edit(r, fn) {
    const prev = this.dirty;
    if (prev) restore(this.pix, prev);
    const loc = r && roundRect({ x: r.x - this.ox, y: r.y - this.oy, w: r.w, h: r.h });
    if (loc) {
      const ctx = this.m.ctx;
      ctx.save(); ctx.translate(this.dx, this.dy);
      fn(ctx);
      ctx.restore();
    }
    this.dirty = loc;
    const both = union(prev, loc);
    return both && { x: both.x + this.ox, y: both.y + this.oy, w: both.w, h: both.h };
  }
  /** Draws content as if on a layer above: fn(ctx) in doc coords, clipped to the selection, laid on with op/opacity. */
  preview(r, fn, { opacity = 1, op = 'source-over', sel = null, lockAlpha = false } = {}) {
    r = r && intersect(roundRect(r), { x: -1e6, y: -1e6, w: 2e6, h: 2e6 });
    if (!r) return this.edit(null);
    const t = makeCanvas(r.w, r.h); const tc = t.getContext('2d');
    tc.translate(-r.x, -r.y); fn(tc); tc.setTransform(1, 0, 0, 1, 0, 0);
    if (sel) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(selCanvas(sel), sel.x - r.x, sel.y - r.y); }
    return this.edit(r, (ctx) => {
      ctx.globalAlpha = opacity; ctx.globalCompositeOperation = lockAlpha && op === 'source-over' ? 'source-atop' : op;
      ctx.drawImage(t, r.x, r.y);
    });
  }
  /** Replaces pixels in r (doc) with img, but only where selected. */
  put(r, img, sel = null) {
    return this.edit(r, (ctx) => {
      const x = r.x + this.dx; const y = r.y + this.dy;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (!sel) { ctx.putImageData(img, x, y); return; }
      const t = makeCanvas(r.w, r.h); const tc = t.getContext('2d');
      tc.putImageData(img, 0, 0);
      tc.globalCompositeOperation = 'destination-in'; tc.drawImage(selCanvas(sel), sel.x - r.x, sel.y - r.y);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, r.w, r.h); ctx.clip();
      ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selCanvas(sel), sel.x + this.dx, sel.y + this.dy);
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(t, x, y);
      ctx.restore();
    });
  }
  /** Current pixels in a doc rect (as ImageData). */
  read(r) { return this.m.ctx.getImageData(r.x + this.dx, r.y + this.dy, r.w, r.h); }
  cancel() { const d = this.dirty; if (d) restore(this.pix, d); this.dirty = null; return d && { x: d.x + this.ox, y: d.y + this.oy, w: d.w, h: d.h }; }
  /** The new document with the edit committed. */
  commit(doc = this.doc) {
    if (!this.dirty) return doc;
    const next = commit(this.pix, this.dirty);
    this.dirty = null;
    return withPix(doc, this.layer.id, this.target, next);
  }
}

// ---------------------------------------------------------------- fills, delete, copy

const tintedSel = (sel, color) => {
  const c = makeCanvas(sel.w, sel.h); const ctx = c.getContext('2d');
  ctx.drawImage(selCanvas(sel), 0, 0); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = color; ctx.fillRect(0, 0, sel.w, sel.h);
  return c;
};

/** Fill the selection (or everything) with a colour. */
export function fillPixels(doc, layer, target, color, sel, { opacity = 1, op = 'source-over', lockAlpha = layer.lockAlpha } = {}) {
  const e = new PixEdit(doc, layer, target);
  const r = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : docRect(doc);
  e.preview(r, (ctx) => { if (sel) ctx.drawImage(tintedSel(sel, color), sel.x, sel.y); else { ctx.fillStyle = color; ctx.fillRect(0, 0, doc.width, doc.height); } }, { opacity, op, lockAlpha });
  return e.commit();
}
/** Delete selected pixels (on a mask: hide them). */
export function clearPixels(doc, layer, target, sel) {
  const e = new PixEdit(doc, layer, target);
  const r = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : docRect(doc);
  if (target === 'mask') e.preview(r, (ctx) => { if (sel) ctx.drawImage(tintedSel(sel, '#000'), sel.x, sel.y); else ctx.fillRect(0, 0, doc.width, doc.height); });
  else e.preview(r, (ctx) => { if (sel) ctx.drawImage(selCanvas(sel), sel.x, sel.y); else ctx.fillRect(0, 0, doc.width, doc.height); }, { op: 'destination-out' });
  return e.commit();
}

/** Selected pixels of one layer (or the merged image) → { canvas, x, y } in doc coords. */
export function copyPixels(renderer, doc, layer, sel, merged = false) {
  const r = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : merged ? docRect(doc) : (layerBounds(layer, doc) && intersect(roundRect(layerBounds(layer, doc)), docRect(doc)));
  if (!r) return null;
  const c = makeCanvas(r.w, r.h); const ctx = c.getContext('2d');
  if (merged) { renderer.flush(); ctx.drawImage(renderer.canvas, -r.x, -r.y); }
  else { renderer.drawContent(ctx, layer, -r.x, -r.y, r); renderer.applyMask(ctx, layer, -r.x, -r.y, r); }
  if (sel) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selCanvas(sel), 0, 0); }
  return { canvas: c, x: r.x, y: r.y };
}

/** A bitmap layer from a canvas placed at x,y. */
export const bitmapFrom = (canvas, x, y, name, extra) => newBitmap(name, { pix: Pix.fromCanvas(canvas, Math.round(x), Math.round(y)), ...extra });

// ---------------------------------------------------------------- masks

/** A mask that reveals the selection (or hides it). With no selection: reveal all / hide all. */
export function maskFrom(doc, layer, sel, hideSelected = false) {
  const o = maskOffset({ ...layer, mask: null });
  if (!sel) {
    if (!hideSelected) return { pix: Pix.empty(), enabled: true, inverted: false, x: 0, y: 0 };
    const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d'); ctx.fillRect(0, 0, doc.width, doc.height);
    return { pix: Pix.fromCanvas(c, -o.x, -o.y, { checkEmpty: false }), enabled: true, inverted: false, x: 0, y: 0 };
  }
  const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d');
  if (hideSelected) ctx.drawImage(selCanvas(sel), sel.x, sel.y);
  else { ctx.fillRect(0, 0, doc.width, doc.height); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selCanvas(sel), sel.x, sel.y); }
  return { pix: Pix.fromCanvas(c, -o.x, -o.y), enabled: true, inverted: false, x: 0, y: 0 };
}
/** Bakes the mask into the pixels (bitmap layers). */
export function applyMask(renderer, doc, layer) {
  if (layer.type !== 'bitmap' || !layer.mask) return doc;
  const b = layer.pix.bounds;
  if (!b) return updateLayer(doc, layer.id, { mask: null });
  const c = pixToCanvas(layer.pix, b); const ctx = c.getContext('2d');
  renderer.applyMask(ctx, layer, -(b.x + layer.x), -(b.y + layer.y), { x: b.x + layer.x, y: b.y + layer.y, w: b.w, h: b.h });
  return updateLayer(doc, layer.id, { mask: null, pix: Pix.fromCanvas(c, b.x, b.y) });
}

// ---------------------------------------------------------------- rasterise, merge, flatten

/** Turns any layer into a bitmap layer (content + mask + effects baked in for non-pixel layers). */
export function rasterize(renderer, doc, layer, { keepMask = true } = {}) {
  if (layer.type === 'bitmap' && !keepMask) return layer;
  const b = layerBounds(layer, doc);
  const r = b && roundRect(layer.type === 'fill' ? docRect(doc) : b);
  if (!r) return { ...newBitmap(layer.name), id: layer.id, opacity: layer.opacity, blend: layer.blend, visible: layer.visible, clip: layer.clip };
  const c = makeCanvas(r.w, r.h); const ctx = c.getContext('2d');
  if (layer.type === 'group') renderer.drawLayers({ ctx, ox: r.x, oy: r.y }, layer.children, r);
  else renderer.drawContent(ctx, layer, -r.x, -r.y, r);
  const out = { ...newBitmap(layer.name), id: layer.id, visible: layer.visible, opacity: layer.opacity, blend: layer.type === 'group' ? 'source-over' : layer.blend, clip: layer.clip, locked: false, fx: layer.fx };
  out.pix = Pix.fromCanvas(c, r.x, r.y);
  if (keepMask && layer.mask) out.mask = { ...layer.mask, x: maskOffset(layer).x, y: maskOffset(layer).y };
  return out;
}

/** Everything in `layers` drawn (with all their settings) into one bitmap layer covering `r`. */
function mergeInto(renderer, doc, layers, r, name, extra = {}) {
  const c = makeCanvas(r.w, r.h); const ctx = c.getContext('2d');
  renderer.drawLayers({ ctx, ox: r.x, oy: r.y }, layers, r);
  return newBitmap(name, { pix: Pix.fromCanvas(c, r.x, r.y), ...extra });
}
const boundsOfAll = (layers, doc) => {
  let r = null;
  for (const l of layers) r = union(r, layerBounds(l, doc));
  return r ? roundRect(r) : null;
};

/** Merge a layer into the one below (Ctrl+E). */
export function mergeDown(renderer, doc, id) {
  const loc = locate(doc.layers, id);
  if (!loc || loc.index === 0) return doc;
  const top = loc.list[loc.index]; const below = loc.list[loc.index - 1];
  if (below.type === 'adjust') return doc;
  const r = boundsOfAll([top, below], doc) || docRect(doc);
  const merged = mergeInto(renderer, doc, [{ ...below, opacity: 1, blend: 'source-over', clip: false }, { ...top, clip: false }], r, below.name,
    { id: below.id, opacity: below.opacity, blend: below.blend === 'pass-through' ? 'source-over' : below.blend, visible: below.visible, clip: below.clip });
  return replaceInList(doc, loc.parent, (list) => [...list.slice(0, loc.index - 1), merged, ...list.slice(loc.index + 1)]);
}
function replaceInList(doc, parent, fn) {
  if (!parent) return { ...doc, layers: fn(doc.layers) };
  return { ...doc, layers: mapLayers(doc.layers, (l) => (l.id === parent.id ? { ...l, children: fn(l.children) } : l)) };
}
/** Merge several layers (same list) into one, placed where the top one was. */
export function mergeLayers(renderer, doc, ids) {
  const all = flatten(doc.layers).filter((l) => ids.includes(l.id));
  if (all.length < 2) return doc;
  const loc = locate(doc.layers, all[all.length - 1].id);
  const inList = loc.list.filter((l) => ids.includes(l.id));
  const r = boundsOfAll(inList, doc) || docRect(doc);
  const merged = mergeInto(renderer, doc, inList, r, inList[inList.length - 1].name);
  const keepIdx = loc.list.indexOf(inList[inList.length - 1]);
  return replaceInList(doc, loc.parent, (list) => list.flatMap((l, i) => (i === keepIdx ? [merged] : ids.includes(l.id) ? [] : [l])));
}
export function mergeVisible(renderer, doc) {
  const vis = doc.layers.filter((l) => l.visible);
  if (!vis.length) return doc;
  const merged = mergeInto(renderer, doc, vis, docRect(doc), 'Merged');
  return { ...doc, layers: [...doc.layers.filter((l) => !l.visible), merged] };
}
export function flattenImage(renderer, doc, bg = '#ffffff') {
  const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, doc.width, doc.height); }
  renderer.drawLayers({ ctx, ox: 0, oy: 0 }, doc.layers, docRect(doc));
  return { ...doc, layers: [newBitmap('Background', { pix: Pix.fromCanvas(c, 0, 0) })] };
}

// ---------------------------------------------------------------- moving and transforming

/** Moves a layer (or group) by dx, dy. Pixels aren't touched: only offsets change. */
export function shiftLayer(l, dx, dy) {
  if (l.type === 'group') return { ...l, children: l.children.map((k) => shiftLayer(k, dx, dy)) };
  const mask = l.mask && l.type !== 'bitmap' ? { ...l.mask, x: (l.mask.x || 0) + dx, y: (l.mask.y || 0) + dy } : l.mask;
  if (l.type === 'bitmap' || l.type === 'text' || l.type === 'shape') return { ...l, x: l.x + dx, y: l.y + dy, mask };
  return { ...l, mask };
}

/** Pixels of a Pix (placed at ox,oy) through a doc-space matrix → { pix, x0, y0 } where pix is local to (ox,oy). */
export function transformPix(pix, ox, oy, mtx, smooth = true) {
  const b = pix.bounds;
  if (!b) return pix;
  const src = pixToCanvas(pix, b);
  const corners = [[b.x + ox, b.y + oy], [b.x + b.w + ox, b.y + oy], [b.x + b.w + ox, b.y + b.h + oy], [b.x + ox, b.y + b.h + oy]].map(([x, y]) => mtx.transformPoint(new DOMPoint(x, y)));
  const nb = roundRect({ x: Math.min(...corners.map((p) => p.x)), y: Math.min(...corners.map((p) => p.y)), w: 0, h: 0 });
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x))); const y1 = Math.ceil(Math.max(...corners.map((p) => p.y)));
  nb.w = Math.max(1, x1 - nb.x); nb.h = Math.max(1, y1 - nb.y);
  if (nb.w * nb.h > 400e6) return pix;
  const c = makeCanvas(nb.w, nb.h); const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = smooth; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(new DOMMatrix().translate(-nb.x, -nb.y).multiply(mtx).translate(b.x + ox, b.y + oy));
  ctx.drawImage(src, 0, 0);
  return Pix.fromCanvas(c, nb.x - ox, nb.y - oy);
}

/** Applies a doc-space matrix to any layer (pixels resampled; text/shape geometry updated). */
export function transformLayer(l, mtx, { smooth = true } = {}) {
  const pt = (x, y) => { const p = mtx.transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; };
  const sx = Math.hypot(mtx.a, mtx.b); const sy = Math.hypot(mtx.c, mtx.d);
  const rot = Math.atan2(mtx.b, mtx.a) * 180 / Math.PI;
  const det = mtx.a * mtx.d - mtx.b * mtx.c;
  let out = l;
  if (l.type === 'group') return { ...l, children: l.children.map((k) => transformLayer(k, mtx, { smooth })) };
  if (l.type === 'bitmap') out = { ...l, pix: transformPix(l.pix, l.x, l.y, mtx, smooth) };
  else if (l.type === 'text') {
    const [x, y] = pt(l.x, l.y);
    out = { ...l, x, y, size: Math.max(1, l.size * Math.sqrt(Math.abs(det))), rotation: ((l.rotation || 0) + rot) % 360 };
  } else if (l.type === 'shape') {
    if (l.shape === 'line') { const [x, y] = pt(l.x, l.y); const [x2, y2] = pt(l.x + l.w, l.y + l.h); out = { ...l, x, y, w: x2 - x, h: y2 - y, strokeWidth: l.strokeWidth * Math.sqrt(Math.abs(det)) }; }
    else {
      const w = Math.abs(l.w) * sx; const h = Math.abs(l.h) * sy;
      const [cx, cy] = pt(Math.min(l.x, l.x + l.w) + Math.abs(l.w) / 2, Math.min(l.y, l.y + l.h) + Math.abs(l.h) / 2);
      out = { ...l, x: cx - w / 2, y: cy - h / 2, w, h, rotation: ((l.rotation || 0) + rot) % 360, strokeWidth: l.strokeWidth * Math.sqrt(Math.abs(det)) };
    }
  }
  if (l.mask?.pix) {
    const o = maskOffset(l); const no = maskOffset({ ...out, mask: { x: 0, y: 0 } });
    const mp = transformPix(l.mask.pix, o.x, o.y, mtx, smooth);
    // transformPix keeps coordinates local to the old offset; re-express them for the new one
    out = { ...out, mask: { ...l.mask, pix: mp, x: o.x - no.x, y: o.y - no.y } };
  }
  return out;
}

// ---------------------------------------------------------------- image / canvas size, crop, rotate, flip, trim

const mapAll = (doc, fn) => ({ ...doc, layers: doc.layers.map(function walk(l) { return l.type === 'group' ? fn({ ...l, children: l.children.map(walk) }) : fn(l); }) });

export function resizeImage(doc, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const sx = w / doc.width; const sy = h / doc.height;
  const m = new DOMMatrix().scale(sx, sy);
  const next = mapAll(doc, (l) => {
    if (l.type === 'group') return l;
    let t = l.type === 'bitmap' ? l : transformLayer(l, m);
    if (l.type === 'bitmap') {
      // keep the offset whole: shift it into the pixels' local coordinates
      const nx = Math.round(l.x * sx); const ny = Math.round(l.y * sy);
      t = { ...t, x: nx, y: ny, pix: transformPix(l.pix, l.x, l.y, new DOMMatrix().translate(-nx + l.x, -ny + l.y).multiply(m)) };
      if (l.mask?.pix) t.mask = { ...l.mask, pix: transformPix(l.mask.pix, maskOffset(l).x, maskOffset(l).y, new DOMMatrix().translate(-nx + l.x, -ny + l.y).multiply(m)) };
    }
    return t;
  });
  return { ...next, width: w, height: h, sel: null, guides: (doc.guides || []).map((g) => ({ ...g, pos: g.pos * (g.axis === 'x' ? sx : sy) })) };
}

/** anchor: 'tl' 't' 'tr' 'l' 'c' 'r' 'bl' 'b' 'br' */
export function resizeCanvas(doc, w, h, anchor = 'c') {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const ax = anchor.includes('l') ? 0 : anchor.includes('r') ? 1 : 0.5;
  const ay = anchor.includes('t') ? 0 : anchor.includes('b') ? 1 : 0.5;
  const dx = Math.round((w - doc.width) * ax); const dy = Math.round((h - doc.height) * ay);
  return offsetDoc(doc, dx, dy, w, h);
}
function offsetDoc(doc, dx, dy, w, h) {
  const layers = doc.layers.map((l) => shiftLayer(l, dx, dy));
  const nd = { ...doc, width: w, height: h, layers, guides: (doc.guides || []).map((g) => ({ ...g, pos: g.pos + (g.axis === 'x' ? dx : dy) })) };
  return { ...nd, sel: doc.sel ? translateSel(doc.sel, dx, dy, nd) : null };
}

export function cropDoc(doc, rect, deleteCropped = true) {
  const r = roundRect(rect);
  let nd = offsetDoc(doc, -r.x, -r.y, Math.max(1, r.w), Math.max(1, r.h));
  nd = { ...nd, sel: null };
  if (!deleteCropped) return nd;
  // drop pixels outside the new canvas so they don't bloat the file
  return mapAll(nd, (l) => {
    if (l.type !== 'bitmap' || !l.pix.bounds) return l;
    const b = l.pix.bounds; const keep = intersect({ x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h }, docRect(nd));
    if (keep && keep.x === b.x + l.x && keep.y === b.y + l.y && keep.w === b.w && keep.h === b.h) return l;
    if (!keep) return { ...l, pix: Pix.empty() };
    const c = pixToCanvas(l.pix, { x: keep.x - l.x, y: keep.y - l.y, w: keep.w, h: keep.h });
    return { ...l, pix: Pix.fromCanvas(c, keep.x - l.x, keep.y - l.y) };
  });
}

export function rotateDoc(renderer, doc, deg) {
  const W = doc.width; const H = doc.height;
  const swap = deg % 180 !== 0;
  const m = deg === 90 ? new DOMMatrix([0, 1, -1, 0, H, 0]) : deg === -90 || deg === 270 ? new DOMMatrix([0, -1, 1, 0, 0, W]) : new DOMMatrix([-1, 0, 0, -1, W, H]);
  const next = mapAll(doc, (l) => (l.type === 'group' ? l : transformLayer(l, m, { smooth: false })));
  return { ...next, width: swap ? H : W, height: swap ? W : H, sel: null, guides: [] };
}

export function flipDoc(renderer, doc, axis) {
  const W = doc.width; const H = doc.height;
  const m = axis === 'h' ? new DOMMatrix([-1, 0, 0, 1, W, 0]) : new DOMMatrix([1, 0, 0, -1, 0, H]);
  return mapAll({ ...doc, sel: null }, (l) => flipLayer(renderer, doc, l, m));
}
/** Mirrors a layer; text (which can't be mirrored and stay editable) is rasterised first. */
export function flipLayer(renderer, doc, l, m) {
  if (l.type === 'group') return l;
  if (l.type === 'text' || (l.type === 'shape' && l.shape === 'polygon')) l = rasterize(renderer, doc, l);
  if (l.type === 'bitmap') {
    const out = { ...l, pix: transformPix(l.pix, l.x, l.y, m, false) };
    if (l.mask?.pix) { const o = maskOffset(l); out.mask = { ...l.mask, pix: transformPix(l.mask.pix, o.x, o.y, m, false) }; }
    return out;
  }
  if (l.type === 'shape') {
    const t = transformLayer(l, m);
    return l.shape === 'line' ? t : { ...t, rotation: -(l.rotation || 0) };
  }
  if (l.mask?.pix) { const o = maskOffset(l); return { ...l, mask: { ...l.mask, pix: transformPix(l.mask.pix, o.x, o.y, m, false) } }; }
  return l;
}

/** Crop away transparent edges (or edges matching the top-left colour). */
export function trimDoc(renderer, doc, mode = 'transparent') {
  renderer.flush();
  const d = renderer.ctx.getImageData(0, 0, doc.width, doc.height).data;
  const W = doc.width; const H = doc.height;
  const ref = [d[0], d[1], d[2], d[3]];
  const same = (i) => (mode === 'transparent' ? d[i + 3] === 0 : Math.abs(d[i] - ref[0]) < 3 && Math.abs(d[i + 1] - ref[1]) < 3 && Math.abs(d[i + 2] - ref[2]) < 3 && Math.abs(d[i + 3] - ref[3]) < 3);
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!same((y * W + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  if (x1 < 0) return doc;
  return cropDoc(doc, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

// ---------------------------------------------------------------- paint bucket

/** Fills similar, connected pixels with a colour. Samples the layer, or all layers (merged). */
export function bucketFill(renderer, doc, layer, x, y, color, { tolerance = 32, contiguous = true, merged = false, sel = null, opacity = 1, target = 'pix' } = {}) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return doc;
  const W = doc.width; const H = doc.height;
  let data;
  if (merged) { renderer.flush(); data = renderer.ctx.getImageData(0, 0, W, H).data; }
  else {
    const c = makeCanvas(W, H); const ctx = c.getContext('2d', { willReadFrequently: true });
    const { pix, ox, oy } = pixTarget(layer, target);
    drawPix(ctx, pix, ox, oy, docRect(doc));
    data = ctx.getImageData(0, 0, W, H).data;
  }
  const mask = floodMask(data, W, H, x, y, tolerance, contiguous);
  // bounding box of the fill, then draw it as a coloured canvas
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (mask[yy * W + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; y1 = yy; }
  if (x1 < 0) return doc;
  const r = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const c = makeCanvas(r.w, r.h); const cc = c.getContext('2d');
  const img = cc.createImageData(r.w, r.h);
  const col = parseHex(target === 'mask' ? '#000000' : color);
  for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
    if (!mask[(yy + r.y) * W + xx + r.x]) continue;
    const i = (yy * r.w + xx) * 4; img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  cc.putImageData(img, 0, 0);
  const e = new PixEdit(doc, layer, target);
  e.preview(r, (ctx) => ctx.drawImage(c, r.x, r.y), { opacity, sel, lockAlpha: layer.lockAlpha });
  return e.commit();
}
const parseHex = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };

// ---------------------------------------------------------------- gradient

/** Draws a gradient across the document (linear / radial / reflected / diamond-ish) from p0 to p1. */
export function drawGradient(ctx, doc, p0, p1, type, colors) {
  const len = Math.max(1, Math.hypot(p1.x - p0.x, p1.y - p0.y));
  let g;
  if (type === 'radial') g = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, len);
  else if (type === 'reflected') {
    g = ctx.createLinearGradient(2 * p0.x - p1.x, 2 * p0.y - p1.y, p1.x, p1.y);
    const cols = [...colors].reverse().concat(colors.slice(1));
    cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, doc.width, doc.height);
    return;
  } else g = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, doc.width, doc.height);
}

// ---------------------------------------------------------------- spot healing

/**
 * Heals the area in `maskCanvas` (alpha = where to heal; mat-canvas coords, covering rect r) on the edit's canvas:
 * finds a nearby patch whose surroundings match best, copies it, then smoothly corrects its colour so the seams
 * vanish (boundary differences spread inwards with inverse-distance weights).
 */
export function healArea(m, maskCanvas, r) {
  const pad = Math.max(6, Math.round(Math.max(r.w, r.h) * 0.25));
  const R = intersect({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, { x: 0, y: 0, w: m.w, h: m.h });
  if (!R) return null;
  const mk = makeCanvas(R.w, R.h); const mc = mk.getContext('2d', { willReadFrequently: true });
  mc.drawImage(maskCanvas, r.x, r.y, r.w, r.h, r.x - R.x, r.y - R.y, r.w, r.h);
  const ma = mc.getImageData(0, 0, R.w, R.h).data;
  const M = new Float32Array(R.w * R.h); let any = false;
  for (let i = 0; i < M.length; i++) { M[i] = ma[i * 4 + 3] / 255; if (M[i] > 0.02) any = true; }
  if (!any) return null;
  const tgt = m.ctx.getImageData(R.x, R.y, R.w, R.h);
  const T = tgt.data;
  // candidate offsets around the area
  const span = Math.max(r.w, r.h);
  const big = intersect({ x: R.x - span * 3, y: R.y - span * 3, w: R.w + span * 6, h: R.h + span * 6 }, { x: 0, y: 0, w: m.w, h: m.h });
  const all = m.ctx.getImageData(big.x, big.y, big.w, big.h).data;
  const get = (x, y, c) => all[((y - big.y) * big.w + (x - big.x)) * 4 + c];
  let best = null; let bestScore = Infinity;
  for (const k of [1.1, 1.6, 2.2, 2.9]) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * span * k); const dy = Math.round(Math.sin(ang) * span * k);
      if (R.x + dx < big.x || R.y + dy < big.y || R.x + R.w + dx > big.x + big.w || R.y + R.h + dy > big.y + big.h) continue;
      let s = 0; let n = 0;
      for (let y = 0; y < R.h; y += 2) for (let x = 0; x < R.w; x += 2) {
        if (M[y * R.w + x] > 0.02) continue;
        const i = (y * R.w + x) * 4;
        for (let c = 0; c < 4; c++) { const dd = T[i + c] - get(R.x + x + dx, R.y + y + dy, c); s += dd * dd; }
        n++;
      }
      s = n ? s / n : Infinity;
      if (s < bestScore) { bestScore = s; best = [dx, dy]; }
    }
  }
  if (!best) return null;
  const [dx, dy] = best;
  // boundary samples: colour difference between target and source just outside the area
  const samples = [];
  for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
    const i = y * R.w + x;
    if (M[i] > 0.02) continue;
    const edge = (x > 0 && M[i - 1] > 0.02) || (x < R.w - 1 && M[i + 1] > 0.02) || (y > 0 && M[i - R.w] > 0.02) || (y < R.h - 1 && M[i + R.w] > 0.02);
    if (!edge) continue;
    const d = [0, 1, 2, 3].map((c) => T[i * 4 + c] - get(R.x + x + dx, R.y + y + dy, c));
    samples.push([x, y, d]);
  }
  const step = Math.max(1, Math.floor(samples.length / 96));
  const S = samples.filter((_, i) => i % step === 0);
  const out = new Uint8ClampedArray(T);
  for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
    const i = y * R.w + x; const w = M[i];
    if (w <= 0.02) continue;
    let ws = 0; const corr = [0, 0, 0, 0];
    for (const [sx, sy, d] of S) { const q = 1 / ((sx - x) ** 2 + (sy - y) ** 2 + 1); ws += q; corr[0] += d[0] * q; corr[1] += d[1] * q; corr[2] += d[2] * q; corr[3] += d[3] * q; }
    for (let c = 0; c < 4; c++) {
      const v = get(R.x + x + dx, R.y + y + dy, c) + (ws ? corr[c] / ws : 0);
      out[i * 4 + c] = T[i * 4 + c] + (v - T[i * 4 + c]) * Math.min(1, w * 1.5);
    }
  }
  m.ctx.putImageData(new ImageData(out, R.w, R.h), R.x, R.y);
  return R;
}

// ---------------------------------------------------------------- misc

/** Size of a text layer's box (for hit testing / the text editor). */
export function textBox(l) { const t = textLayout(l); return { x: t.left, y: t.top, w: t.w, h: t.h }; }

/** Topmost visible layer with a pixel at (x, y) — Move tool auto-select. */
export function layerAt(renderer, doc, x, y) {
  const all = flatten(doc.layers).filter((l) => l.type !== 'group' && l.type !== 'adjust' && l.visible);
  const c = makeCanvas(1, 1); const ctx = c.getContext('2d', { willReadFrequently: true });
  for (let i = all.length - 1; i >= 0; i--) {
    const l = all[i];
    if (l.type === 'fill') continue;
    ctx.clearRect(0, 0, 1, 1);
    renderer.drawContent(ctx, l, -Math.floor(x), -Math.floor(y), { x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 });
    if (ctx.getImageData(0, 0, 1, 1).data[3] > 10) return l;
  }
  return null;
}
export { rasterLayer, findLayer };
