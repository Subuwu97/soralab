// Photo's tools. makeTools(ed) returns one object per tool; the Viewport calls down/move/up/hover with document
// coordinates, and overlay(ctx, api) to draw guides for the tool (marquee box, crop frame, transform handles…).
//
// `ed` is the editor's live context (see index.jsx): ed.doc, ed.commit(doc, label), ed.layer(), ed.target, ed.opts(id),
// ed.fg/ed.bg, ed.renderer, ed.vp, ed.live (an operation flushed every frame), ed.setActive, ed.toast…
import { Stroke, Smoother } from '../_raster/brush.js';
import { commit as commitPix, restore, makeCanvas, pixToCanvas, intersect, union, roundRect, contentBounds } from '../_raster/pix.js';
import { selRect, selEllipse, selPolygon, combine, magicWand, at as selAt, translate as translateSel, selCanvas, selFromAlpha } from '../_raster/selection.js';
import { PixEdit, pixTarget, withPix, bucketFill, drawGradient, healArea, layerAt, copyPixels, shiftLayer, transformLayer, cropDoc } from '../_raster/ops.js';
import { updateLayer, newShape, newText, insertLayers, findLayer, uniqueName } from '../_raster/model.js';
import { layerBounds, layerBox, rasterLayer, textLayout, rotatedCorners } from '../_raster/render.js';
import { toHex } from '../../lib/color.js';
import { stepZoom } from '../_raster/Viewport.jsx';

const docRect = (d) => ({ x: 0, y: 0, w: d.width, h: d.height });

/** Selection mode from modifier keys (Shift add, Alt subtract, both intersect) or the options bar. */
export const selMode = (p, fallback = 'replace') => (p.shift && p.alt ? 'intersect' : p.shift ? 'add' : p.alt ? 'subtract' : fallback);

/** Sample a colour at a doc point: merged image or the active layer, averaged over size×size. */
export function sampleColor(ed, x, y, { merged = true, size = 1 } = {}) {
  const doc = ed.doc; const r = Math.floor(size / 2);
  const rect = intersect({ x: Math.floor(x) - r, y: Math.floor(y) - r, w: size, h: size }, docRect(doc));
  if (!rect) return null;
  let data;
  if (merged) { ed.renderer.flush(); data = ed.renderer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data; }
  else {
    const c = makeCanvas(rect.w, rect.h); const ctx = c.getContext('2d', { willReadFrequently: true });
    const l = ed.layer(); if (!l) return null;
    ed.renderer.drawContent(ctx, l, -rect.x, -rect.y, rect);
    data = ctx.getImageData(0, 0, rect.w, rect.h).data;
  }
  let R = 0; let G = 0; let B = 0; let A = 0;
  for (let i = 0; i < data.length; i += 4) { R += data[i] * data[i + 3]; G += data[i + 1] * data[i + 3]; B += data[i + 2] * data[i + 3]; A += data[i + 3]; }
  if (!A) return null;
  return toHex({ r: R / A, g: G / A, b: B / A });
}

/** The pixels a painting tool can edit right now, or null (with a message). */
export function paintTarget(ed) {
  const l = ed.layer();
  if (!l) { ed.toast('Choose a layer first'); return null; }
  if (l.locked) { ed.toast('This layer is locked'); return null; }
  if (!l.visible) { ed.toast('This layer is hidden'); return null; }
  if (ed.target === 'mask' && l.mask) return { layer: l, ...pixTarget(l, 'mask') };
  if (l.type !== 'bitmap') {
    if ((l.type === 'adjust' || l.type === 'fill') && l.mask) return { layer: l, ...pixTarget(l, 'mask') };
    ed.toast(l.type === 'group' ? 'Choose a layer inside the group to paint on' : 'Rasterize this layer to paint on it', l.type === 'group' ? undefined : { action: { label: 'Rasterize', onClick: () => ed.rasterizeActive() } });
    return null;
  }
  return { layer: l, ...pixTarget(l, 'pix') };
}

// ---------------------------------------------------------------- painting tools (brush, pencil, eraser, clone, heal, dodge/burn, blur/sharpen/smudge)

function paintTool(ed, id) {
  let stroke = null; let smooth = null; let tgt = null; let lastPt = null; let cloneSrc = null; let cloneOff = null; let airTimer = null;
  const brushFor = () => {
    const o = ed.opts(id);
    const base = { size: o.size, hardness: o.hardness ?? 0.8, opacity: o.opacity ?? 1, flow: o.flow ?? 1, spacing: (o.spacing ?? 15) / 100, pressureSize: o.pressureSize ?? true, pressureOpacity: o.pressureOpacity ?? false, blend: o.blend || 'source-over' };
    switch (id) {
      case 'pencil': return { ...base, tip: 'pixel', hardness: 1, spacing: 0.05, pressureSize: false };
      case 'eraser': return o.mode === 'pencil' ? { ...base, tip: 'pixel', hardness: 1, spacing: 0.05 } : base;
      case 'clone': return { ...base, kind: 'clone' };
      case 'heal': return { ...base, kind: 'heal', hardness: 0.6, opacity: 1, flow: 1 };
      case 'dodge': return { ...base, kind: o.mode || 'dodge', exposure: (o.exposure ?? 50) / 100, range: o.range || 'midtones', strength: 1, hardness: 0.3, pressureOpacity: true };
      case 'blur': return { ...base, kind: o.mode || 'blur', strength: (o.strength ?? 50) / 100, hardness: 0.3, spacing: o.mode === 'smudge' ? 0.08 : 0.25, pressureOpacity: true };
      default: return { ...base, buildUp: !!o.airbrush };
    }
  };
  const tool = {
    id,
    cursor: 'crosshair',
    brushSize: () => ed.opts(id).size,
    down(p) {
      if (ed.readOnly) return;
      if (p.alt && (id === 'brush' || id === 'pencil')) { const c = sampleColor(ed, p.x, p.y); if (c) ed.setFg(c); return; }
      if (id === 'clone' && p.alt) { cloneSrc = { x: p.x, y: p.y }; cloneOff = null; ed.toast('Clone source set'); return; }
      if (id === 'clone' && !cloneSrc) { ed.toast('Alt-click to set where to clone from'); return; }
      tgt = paintTarget(ed);
      if (!tgt) return;
      const doc = ed.doc;
      let mode = 'paint';
      if (tgt.target === 'mask') {
        const fg = id === 'eraser' ? ed.bg : ed.fg;
        mode = lum(fg) < 0.5 ? 'hide' : 'reveal';
      } else if (id === 'eraser') mode = 'erase';
      const brush = brushFor();
      if (tgt.target === 'mask' && mode === 'hide') brush.opacity *= 1 - lum(id === 'eraser' ? ed.bg : ed.fg) * 2;
      if (tgt.target === 'mask' && mode === 'reveal') brush.opacity *= (lum(id === 'eraser' ? ed.bg : ed.fg) - 0.5) * 2;
      let clone = null;
      if (id === 'clone') {
        const aligned = ed.opts(id).aligned !== false;
        if (!cloneOff || !aligned) cloneOff = { x: p.x - cloneSrc.x, y: p.y - cloneSrc.y };
        clone = { offsetX: cloneOff.x, offsetY: cloneOff.y, pix: tgt.pix };
      }
      stroke = new Stroke({ pix: tgt.pix, ox: tgt.ox, oy: tgt.oy, doc, brush, color: ed.fg, mode, sel: doc.sel, lockAlpha: tgt.target === 'pix' && tgt.layer.lockAlpha, clone });
      smooth = new Smoother((ed.opts(id).smoothing || 0) * 0.3 / ed.vp.matrix().a);
      ed.live = { flush: () => stroke?.flush() };
      if (p.shift && lastPt) { stroke.add(lastPt); }
      for (const q of smooth.push(p)) stroke.add(q);
      if (brush.buildUp) airTimer = setInterval(() => stroke?.tick(), 40);
    },
    move(p) { if (stroke) for (const q of smooth.push(p)) stroke.add(q); ed.vp.overlay(); },
    up(p) {
      clearInterval(airTimer);
      if (!stroke) return;
      for (const q of smooth.finish()) stroke.add(q);
      const s = stroke; stroke = null;
      lastPt = { x: p.x, y: p.y, pressure: 1 };
      let dirty = s.end();
      ed.renderer.invalidate(s.flush());
      ed.live = null;
      if (!dirty) return;
      if (id === 'heal') {
        // heal the painted area: drop the grey preview, then patch it
        restore(s.pix, dirty);
        const m = s.m;
        const R = healArea(m, s.bufferCanvas(), { x: dirty.x - m.x, y: dirty.y - m.y, w: dirty.w, h: dirty.h });
        if (R) dirty = union(dirty, { x: R.x + m.x, y: R.y + m.y, w: R.w, h: R.h });
        ed.renderer.invalidate({ x: dirty.x + s.ox, y: dirty.y + s.oy, w: dirty.w, h: dirty.h });
      }
      const next = commitPix(s.pix, dirty);
      ed.commit(withPix(ed.doc, tgt.layer.id, tgt.target, next), LABELS[id]);
    },
    cancel() { clearInterval(airTimer); if (stroke) { ed.renderer.invalidate(stroke.cancel()); stroke = null; ed.live = null; } },
    overlay(ctx, api) {
      if (id === 'clone' && cloneSrc) {
        const h = api.hover();
        let pt = cloneSrc;
        if (h && cloneOff) { const d = api.toDoc(h.sx, h.sy); pt = { x: d.x - cloneOff.x, y: d.y - cloneOff.y }; }
        const s = api.toScreen(pt.x, pt.y);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(s.x - 7, s.y); ctx.lineTo(s.x + 7, s.y); ctx.moveTo(s.x, s.y - 7); ctx.lineTo(s.x, s.y + 7); ctx.stroke();
      }
    },
  };
  return tool;
}
const LABELS = { brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', clone: 'Clone Stamp', heal: 'Spot Healing', dodge: 'Dodge/Burn', blur: 'Blur/Sharpen' };
const lum = (hex) => { const n = parseInt(hex.slice(1, 7), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };

// ---------------------------------------------------------------- selection tools

function marqueeTool(ed) {
  let drag = null;
  return {
    id: 'marquee', cursor: 'crosshair',
    down(p) {
      const doc = ed.doc;
      const mode = selMode(p, ed.opts('marquee').mode);
      if (mode === 'replace' && doc.sel && selAt(doc.sel, Math.floor(p.x), Math.floor(p.y)) && !p.mod) { drag = { moveSel: true, x0: p.x, y0: p.y, sel: doc.sel }; return; }
      drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, mode, shift: false };
    },
    move(p) {
      if (!drag) return;
      if (drag.moveSel) { const s = translateSel(drag.sel, p.x - drag.x0, p.y - drag.y0, ed.doc); ed.renderer.setDoc({ ...ed.doc, sel: s }); ed.preview({ ...ed.doc, sel: s }); return; }
      drag.x1 = p.x; drag.y1 = p.y; drag.alt = p.alt && drag.mode === 'replace'; drag.square = p.shift && drag.mode !== 'add';
      ed.vp.overlay();
    },
    up(p) {
      if (!drag) return;
      const d = drag; drag = null;
      const doc = ed.doc;
      if (d.moveSel) { ed.preview(null); ed.commit({ ...doc, sel: translateSel(d.sel, p.x - d.x0, p.y - d.y0, doc) }, 'Move selection'); return; }
      const r = rectOf(d);
      if (r.w < 1 || r.h < 1) { if (d.mode === 'replace' && doc.sel) ed.commit({ ...doc, sel: null }, 'Deselect'); ed.vp.overlay(); return; }
      const o = ed.opts('marquee');
      let s = o.shape === 'ellipse' ? selEllipse(doc, r.x, r.y, r.w, r.h) : selRect(doc, r.x, r.y, r.w, r.h);
      if (o.feather > 0) s = ed.featherSel(s, o.feather);
      ed.commit({ ...doc, sel: combine(doc.sel, s, d.mode) }, o.shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    overlay(ctx, api) {
      if (!drag || drag.moveSel) return;
      const r = rectOf(drag);
      ctx.save();
      ctx.setTransform(api.matrix().preMultiplySelf(new DOMMatrix().scale(devicePixelRatio, devicePixelRatio)));
      ctx.beginPath();
      if (ed.opts('marquee').shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, r.w / 2), Math.max(0.1, r.h / 2), 0, 0, Math.PI * 2); else ctx.rect(r.x, r.y, r.w, r.h);
      ctx.restore();
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#000'; ctx.stroke(); ctx.setLineDash([]);
      const s = api.toScreen(drag.x1, drag.y1);
      label(ctx, s.x + 14, s.y + 18, `W: ${Math.round(r.w)} px  H: ${Math.round(r.h)} px`);
    },
  };
}
function rectOf(d) {
  let w = d.x1 - d.x0; let h = d.y1 - d.y0;
  if (d.square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  if (d.alt) return { x: d.x0 - Math.abs(w), y: d.y0 - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
  return { x: Math.min(d.x0, d.x0 + w), y: Math.min(d.y0, d.y0 + h), w: Math.abs(w), h: Math.abs(h) };
}
export function label(ctx, x, y, text) {
  ctx.font = '11px Inter, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(20,22,28,.92)'; ctx.fillRect(x, y - 13, w, 20);
  ctx.fillStyle = '#eceef6'; ctx.fillText(text, x + 6, y + 1);
}
function pathOverlay(ctx, api, pts, closed, extra) {
  if (!pts.length) return;
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const s = api.toScreen(x, y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
  if (extra) { const s = api.toScreen(extra[0], extra[1]); ctx.lineTo(s.x, s.y); }
  if (closed) ctx.closePath();
  ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#000'; ctx.stroke(); ctx.setLineDash([]);
}

function lassoTool(ed) {
  let pts = null; let mode = 'replace'; let poly = false; let hover = null;
  const finish = () => {
    const doc = ed.doc; const list = pts; pts = null; poly = false;
    ed.vp.overlay();
    if (!list || list.length < 3) return;
    let s = selPolygon(doc, list);
    const f = ed.opts('lasso').feather;
    if (f > 0) s = ed.featherSel(s, f);
    ed.commit({ ...doc, sel: combine(doc.sel, s, mode) }, poly ? 'Polygonal Lasso' : 'Lasso');
  };
  const t = {
    id: 'lasso', cursor: 'crosshair',
    down(p) {
      const o = ed.opts('lasso');
      if (poly && pts) {
        const first = ed.vp.toScreen(pts[0][0], pts[0][1]);
        if (Math.hypot(first.x - p.sx, first.y - p.sy) < 8 || (p.t - (t.lastClick || 0) < 300)) { finish(); return; }
        pts.push([p.x, p.y]); t.lastClick = p.t; return;
      }
      mode = selMode(p, o.mode);
      pts = [[p.x, p.y]]; poly = o.kind === 'poly'; t.lastClick = p.t;
    },
    move(p) { if (pts && !poly) pts.push([p.x, p.y]); },
    hover(p) { hover = [p.x, p.y]; },
    up() { if (pts && !poly) finish(); },
    key(e) { if (poly && pts && e.key === 'Enter') { finish(); return true; } if (pts && e.key === 'Escape') { pts = null; poly = false; ed.vp.overlay(); return true; } return false; },
    cancel() { pts = null; poly = false; },
    overlay(ctx, api) { if (pts) pathOverlay(ctx, api, pts, !poly, poly ? hover : null); },
  };
  return t;
}

function wandTool(ed) {
  return {
    id: 'wand', cursor: 'crosshair',
    down(p) {
      const doc = ed.doc; const o = ed.opts('wand');
      let img;
      const al = ed.layer();
      if (o.merged || !al || !['bitmap', 'text', 'shape'].includes(al.type)) { ed.renderer.flush(); img = ed.renderer.ctx.getImageData(0, 0, doc.width, doc.height); }
      else {
        const l = ed.layer(); if (!l) return;
        const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d', { willReadFrequently: true });
        ed.renderer.drawContent(ctx, l, 0, 0, docRect(doc));
        img = ctx.getImageData(0, 0, doc.width, doc.height);
      }
      let s = magicWand(img, p.x, p.y, o.tolerance, o.contiguous);
      if (s && o.antiAlias) s = ed.featherSel(s, 0.8);
      ed.commit({ ...doc, sel: combine(doc.sel, s, selMode(p, o.mode)) }, 'Magic Wand');
    },
  };
}

// ---------------------------------------------------------------- move

function moveTool(ed) {
  let drag = null;
  return {
    id: 'move', cursor: 'move',
    down(p) {
      if (ed.readOnly) return;
      let l = ed.layer();
      if (ed.opts('move').autoSelect || p.mod) {
        const hit = layerAt(ed.renderer, ed.doc, p.x, p.y);
        if (hit) { ed.setActive(hit.id); l = hit; }
      }
      if (!l) return;
      if (l.locked) { ed.toast('This layer is locked'); return; }
      const doc = ed.doc;
      if (doc.sel && l.type === 'bitmap' && ed.target === 'pix') {
        // move the selected pixels: cut them out and float them while dragging
        const cut = copyPixels(ed.renderer, doc, { ...l, mask: null }, doc.sel, false);
        const e = new PixEdit(doc, l, 'pix');
        drag = { x0: p.x, y0: p.y, cut, edit: e, layer: l, sel: doc.sel, dx: 0, dy: 0, dup: p.alt };
      } else drag = { x0: p.x, y0: p.y, layer: l, dx: 0, dy: 0 };
    },
    move(p) {
      if (!drag) return;
      let dx = Math.round(p.x - drag.x0); let dy = Math.round(p.y - drag.y0);
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      drag.dx = dx; drag.dy = dy;
      const doc = ed.doc;
      if (drag.edit) {
        const { cut, sel } = drag;
        const r = union({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, { x: cut.x + dx, y: cut.y + dy, w: cut.canvas.width, h: cut.canvas.height });
        const inv = drag.edit.edit(r, (ctx) => {
          if (!drag.dup) { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selCanvas(sel), sel.x, sel.y); ctx.globalCompositeOperation = 'source-over'; }
          ctx.drawImage(cut.canvas, cut.x + dx, cut.y + dy);
        });
        ed.renderer.invalidate(inv);
        ed.preview({ ...doc, sel: translateSel(sel, dx, dy, doc) });
      } else {
        const next = { ...doc, layers: doc.layers === undefined ? [] : mapMove(doc.layers, drag.layer.id, dx, dy) };
        ed.renderer.setDoc(next);
        ed.preview(next);
      }
    },
    up() {
      if (!drag) return;
      const d = drag; drag = null;
      ed.preview(null);
      const doc = ed.doc;
      if (!d.dx && !d.dy) { if (d.edit) d.edit.cancel(); ed.renderer.setDoc(doc); return; }
      if (d.edit) { const next = d.edit.commit(doc); ed.commit({ ...next, sel: translateSel(d.sel, d.dx, d.dy, doc) }, 'Move'); }
      else ed.commit({ ...doc, layers: mapMove(doc.layers, d.layer.id, d.dx, d.dy) }, 'Move');
    },
    cancel() { if (drag?.edit) ed.renderer.invalidate(drag.edit.cancel()); drag = null; ed.preview(null); ed.renderer.setDoc(ed.doc); },
  };
}
const mapMove = (layers, id, dx, dy) => layers.map((l) => (l.id === id ? shiftLayer(l, dx, dy) : l.type === 'group' ? { ...l, children: mapMove(l.children, id, dx, dy) } : l));

// ---------------------------------------------------------------- crop

export function cropTool(ed) {
  let box = null; let drag = null;
  const t = {
    id: 'crop', cursor: 'crosshair',
    get box() { return box; },
    reset() { const d = ed.doc; box = { x: 0, y: 0, w: d.width, h: d.height }; ed.vp?.overlay(); },
    down(p, e, api) {
      if (!box) t.reset();
      const h = hitBox(api, box, p);
      drag = { h, x0: p.x, y0: p.y, b0: { ...box } };
      if (h === 'new') { box = { x: p.x, y: p.y, w: 0, h: 0 }; drag.b0 = { ...box }; drag.h = 'se'; }
    },
    move(p) {
      if (!drag) return;
      const dx = p.x - drag.x0; const dy = p.y - drag.y0; const b = { ...drag.b0 };
      if (drag.h === 'move') { b.x += dx; b.y += dy; }
      else {
        if (drag.h.includes('w')) { b.x += dx; b.w -= dx; }
        if (drag.h.includes('e')) b.w += dx;
        if (drag.h.includes('n')) { b.y += dy; b.h -= dy; }
        if (drag.h.includes('s')) b.h += dy;
        const ratio = ed.opts('crop').ratio;
        if (ratio && ratio !== 'free') {
          const [rw, rh] = ratio.split(':').map(Number);
          const want = rw / rh;
          if (drag.h === 'n' || drag.h === 's') b.w = Math.abs(b.h) * want * Math.sign(b.w || 1);
          else b.h = Math.abs(b.w) / want * Math.sign(b.h || 1);
        }
      }
      if (b.w < 0) { b.x += b.w; b.w = -b.w; }
      if (b.h < 0) { b.y += b.h; b.h = -b.h; }
      box = b; ed.vp.overlay();
    },
    up() { drag = null; },
    hover(p, e, api) { if (box && api) api.el.style.cursor = CURSORS[hitBox(api, box, p)] || 'crosshair'; },
    apply() {
      if (!box || box.w < 1 || box.h < 1) return;
      ed.commit(cropDoc(ed.doc, roundRect(box), ed.opts('crop').deletePixels !== false), 'Crop');
      box = null; ed.fit();
    },
    cancel() { box = null; ed.vp?.overlay(); },
    key(e) { if (e.key === 'Enter') { t.apply(); return true; } if (e.key === 'Escape') { t.reset(); return true; } return false; },
    overlay(ctx, api) {
      if (!box) t.reset();
      const d = ed.doc; const m = api.matrix();
      const corner = (x, y) => m.transformPoint(new DOMPoint(x, y));
      const a = corner(box.x, box.y); const b = corner(box.x + box.w, box.y + box.h);
      const sz = api.size();
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.rect(0, 0, sz.w, sz.h); ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.fill('evenodd');
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      // rule of thirds
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      for (const f of [1 / 3, 2 / 3]) {
        ctx.beginPath(); ctx.moveTo(a.x + (b.x - a.x) * f, a.y); ctx.lineTo(a.x + (b.x - a.x) * f, b.y); ctx.moveTo(a.x, a.y + (b.y - a.y) * f); ctx.lineTo(b.x, a.y + (b.y - a.y) * f); ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      for (const [hx, hy] of HANDLES) { const s = corner(box.x + box.w * hx, box.y + box.h * hy); ctx.fillRect(s.x - 4, s.y - 4, 8, 8); ctx.strokeStyle = '#000'; ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9); }
      label(ctx, Math.max(a.x, b.x) + 10, Math.max(a.y, b.y) + 20, `${Math.round(box.w)} × ${Math.round(box.h)} px`);
      ctx.restore();
      void d;
    },
  };
  return t;
}
const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const HNAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', new: 'crosshair' };
function hitBox(api, box, p) {
  const m = api.matrix();
  for (let i = 0; i < HANDLES.length; i++) {
    const s = m.transformPoint(new DOMPoint(box.x + box.w * HANDLES[i][0], box.y + box.h * HANDLES[i][1]));
    if (Math.hypot(s.x - p.sx, s.y - p.sy) < 9) return HNAMES[i];
  }
  if (p.x > box.x && p.y > box.y && p.x < box.x + box.w && p.y < box.y + box.h) return 'move';
  return 'new';
}

// ---------------------------------------------------------------- eyedropper, bucket, gradient

function eyedropperTool(ed) {
  const pick = (p) => { const o = ed.opts('eyedropper'); const c = sampleColor(ed, p.x, p.y, { merged: o.sample !== 'layer', size: o.size || 1 }); if (c) (p.alt ? ed.setBg : ed.setFg)(c); };
  return { id: 'eyedropper', cursor: 'crosshair', down: pick, move: pick };
}

function bucketTool(ed) {
  return {
    id: 'bucket', cursor: 'crosshair',
    down(p) {
      if (ed.readOnly) return;
      if (p.alt) { const c = sampleColor(ed, p.x, p.y); if (c) ed.setFg(c); return; }
      const tgt = paintTarget(ed); if (!tgt) return;
      const o = ed.opts('bucket');
      const doc = bucketFill(ed.renderer, ed.doc, tgt.layer, p.x, p.y, ed.fg, { tolerance: o.tolerance, contiguous: o.contiguous, merged: o.merged, sel: ed.doc.sel, opacity: o.opacity ?? 1, target: tgt.target });
      if (doc !== ed.doc) ed.commit(doc, 'Paint Bucket');
    },
  };
}

function gradientTool(ed) {
  let drag = null;
  const colors = () => {
    const o = ed.opts('gradient');
    let c = o.colors === 'fgtrans' ? [ed.fg, `${ed.fg.slice(0, 7)}00`] : o.colors === 'bw' ? ['#000000', '#ffffff'] : [ed.fg, ed.bg];
    if (o.reverse) c = [...c].reverse();
    return c;
  };
  const draw = () => {
    const o = ed.opts('gradient'); const d = drag;
    const r = ed.doc.sel ? { x: ed.doc.sel.x, y: ed.doc.sel.y, w: ed.doc.sel.w, h: ed.doc.sel.h } : docRect(ed.doc);
    const inv = d.edit.preview(r, (ctx) => drawGradient(ctx, ed.doc, d.p0, d.p1, o.type, colors()), { opacity: o.opacity ?? 1, sel: ed.doc.sel, lockAlpha: d.tgt.layer.lockAlpha, op: o.blend || 'source-over' });
    ed.renderer.invalidate(inv);
  };
  return {
    id: 'gradient', cursor: 'crosshair',
    down(p) {
      if (ed.readOnly) return;
      const tgt = paintTarget(ed); if (!tgt) return;
      drag = { tgt, edit: new PixEdit(ed.doc, tgt.layer, tgt.target), p0: { x: p.x, y: p.y }, p1: { x: p.x, y: p.y } };
    },
    move(p) {
      if (!drag) return;
      let { x, y } = p;
      if (p.shift) { const a = Math.round(Math.atan2(y - drag.p0.y, x - drag.p0.x) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x - drag.p0.x, y - drag.p0.y); x = drag.p0.x + Math.cos(a) * len; y = drag.p0.y + Math.sin(a) * len; }
      drag.p1 = { x, y }; draw();
    },
    up() {
      if (!drag) return;
      const d = drag; drag = null;
      if (Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y) < 2) { ed.renderer.invalidate(d.edit.cancel()); return; }
      ed.commit(d.edit.commit(ed.doc), 'Gradient');
    },
    cancel() { if (drag) ed.renderer.invalidate(drag.edit.cancel()); drag = null; },
    overlay(ctx, api) {
      if (!drag) return;
      const a = api.toScreen(drag.p0.x, drag.p0.y); const b = api.toScreen(drag.p1.x, drag.p1.y);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
      for (const s of [a, b]) { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
    },
  };
}

// ---------------------------------------------------------------- text and shapes

function textTool(ed) {
  return {
    id: 'text', cursor: 'text',
    down(p) {
      if (ed.readOnly) return;
      const doc = ed.doc;
      // click on an existing text layer edits it
      const hit = [...flattenVisible(doc.layers)].reverse().find((l) => l.type === 'text' && inBox(l, p));
      if (hit) { ed.setActive(hit.id); ed.editText(hit.id); return; }
      const o = ed.opts('text');
      const l = newText({ text: '', x: p.x, y: p.y - (o.size || 72) * 0.8, font: o.font || 'Inter', size: o.size || 72, weight: o.weight || 400, color: ed.fg, align: o.align || 'left', name: 'Text' });
      ed.editText(null, l);
    },
  };
}
const flattenVisible = (layers, out = []) => { for (const l of layers) { if (!l.visible) continue; out.push(l); if (l.type === 'group') flattenVisible(l.children, out); } return out; };
function inBox(l, p) {
  const t = textLayout(l);
  const a = -(l.rotation || 0) * Math.PI / 180;
  const dx = p.x - l.x; const dy = p.y - l.y;
  const x = l.x + dx * Math.cos(a) - dy * Math.sin(a); const y = l.y + dx * Math.sin(a) + dy * Math.cos(a);
  return x >= t.left - 4 && x <= t.left + t.w + 4 && y >= t.top - 4 && y <= t.top + t.h + 4;
}

function shapeTool(ed) {
  let drag = null;
  const layerFor = (d, p) => {
    const o = ed.opts('shape');
    let w = p.x - d.x0; let h = p.y - d.y0;
    if (p.shift) {
      if (o.shape === 'line') { const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(w, h); w = Math.cos(a) * len; h = Math.sin(a) * len; }
      else { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    }
    let x = d.x0; let y = d.y0;
    if (p.alt && o.shape !== 'line') { x -= w; y -= h; w *= 2; h *= 2; }
    if (o.shape !== 'line') { if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; } }
    return { ...d.layer, x, y, w, h };
  };
  return {
    id: 'shape', cursor: 'crosshair',
    down(p) {
      if (ed.readOnly) return;
      const o = ed.opts('shape');
      const fill = o.fill === 'none' ? null : o.fill === 'fg' || !o.fill ? ed.fg : o.fill;
      const stroke = o.stroke === 'none' || !o.stroke ? null : o.stroke === 'fg' ? ed.fg : o.stroke;
      const l = newShape({ shape: o.shape || 'rect', fill: o.shape === 'line' ? null : fill, stroke: o.shape === 'line' ? (stroke || ed.fg) : stroke, strokeWidth: o.strokeWidth ?? 4, radius: o.radius || 0, sides: o.sides || 6, x: p.x, y: p.y, w: 0, h: 0 });
      l.name = uniqueName(ed.doc.layers, l.name);
      drag = { x0: p.x, y0: p.y, layer: l, base: ed.doc, above: ed.layer()?.id };
    },
    move(p) {
      if (!drag) return;
      drag.cur = layerFor(drag, p);
      const next = { ...drag.base, layers: insertLayers(drag.base.layers, drag.cur, drag.above ? { above: drag.above } : null) };
      ed.renderer.setDoc(next); ed.preview(next);
    },
    up() {
      if (!drag) return;
      const d = drag; drag = null; ed.preview(null);
      if (!d.cur || (Math.abs(d.cur.w) < 2 && Math.abs(d.cur.h) < 2)) { ed.renderer.setDoc(ed.doc); return; }
      ed.commit({ ...d.base, layers: insertLayers(d.base.layers, d.cur, d.above ? { above: d.above } : null) }, `New ${d.cur.name}`);
      ed.setActive(d.cur.id);
    },
    cancel() { drag = null; ed.preview(null); ed.renderer.setDoc(ed.doc); },
  };
}

// ---------------------------------------------------------------- zoom, hand

function zoomTool(ed) {
  return {
    id: 'zoom', cursor: 'zoom-in',
    down(p, e, api) { api.zoomAt((z) => stepZoom(z, p.alt ? -1 : 1), p.sx, p.sy); },
  };
}

// ---------------------------------------------------------------- free transform (Ctrl+T)

/**
 * Free transform of the active layer — or of the selected pixels when there's a selection on a pixel layer.
 * Corner/edge handles scale (Shift: free aspect for pixels, proportional otherwise; Alt: from the centre), dragging
 * outside the box rotates (Shift snaps to 15°), inside moves. Enter applies, Esc cancels.
 */
export function transformTool(ed, layer, { onEnd } = {}) {
  const doc = ed.doc;
  const sel = layer.type === 'bitmap' && doc.sel ? doc.sel : null;
  let content; let box; let base = null;
  if (sel) {
    const cut = copyPixels(ed.renderer, doc, { ...layer, mask: null }, sel, false);
    content = cut.canvas; box = { x: cut.x, y: cut.y, w: cut.canvas.width, h: cut.canvas.height };
    // the layer with the selected pixels taken out
    const b = layer.pix.bounds;
    if (b) {
      base = { canvas: pixToCanvas(layer.pix, b), x: b.x + layer.x, y: b.y + layer.y };
      const bc = base.canvas.getContext('2d'); bc.globalCompositeOperation = 'destination-out'; bc.drawImage(selCanvas(sel), sel.x - base.x, sel.y - base.y);
    }
  } else {
    const cb = layer.type === 'bitmap' && contentBounds(layer.pix);
    const lb = cb ? { x: cb.x + layer.x, y: cb.y + layer.y, w: cb.w, h: cb.h } : layerBounds(layer, doc);
    const geo = layerBox(layer);
    const r = roundRect(lb || docRect(doc));
    content = makeCanvas(r.w, r.h);
    ed.renderer.drawContent(content.getContext('2d'), layer, -r.x, -r.y, r);
    box = geo && !geo.rotation ? { x: geo.x, y: geo.y, w: geo.w, h: geo.h, cx: r.x, cy: r.y } : { ...r };
    content.ox = r.x; content.oy = r.y;
  }
  const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
  const st = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
  const matrix = () => new DOMMatrix().translate(cx + st.tx, cy + st.ty).rotate(st.rot).scale(st.sx, st.sy).translate(-cx, -cy);
  let lastBounds = null;
  const boundsOf = (m) => {
    const pts = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
    return roundRect({ x: Math.min(...xs) - 4, y: Math.min(...ys) - 4, w: Math.max(...xs) - Math.min(...xs) + 8, h: Math.max(...ys) - Math.min(...ys) + 8 });
  };
  const ox = content.ox ?? box.x; const oy = content.oy ?? box.y;
  const update = () => {
    const m = matrix();
    ed.renderer.overrides.set(layer.id, {
      draw(ctx, dx, dy) {
        ctx.save(); ctx.translate(dx, dy);
        if (base) ctx.drawImage(base.canvas, base.x, base.y);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(content, ox, oy);
        ctx.restore();
      },
    });
    const nb = boundsOf(m);
    ed.renderer.invalidate(union(union(lastBounds, nb), sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : null) || 'full');
    if (!lastBounds) ed.renderer.invalidate(roundRect(layerBounds(layer, doc) || docRect(doc)));
    lastBounds = nb;
    ed.vp.overlay(); ed.onTransformChange?.(t.info());
  };
  let drag = null;
  const handlesScreen = (api) => {
    const m = matrix();
    return HANDLES.map(([hx, hy]) => api.toScreen(...(() => { const p = m.transformPoint(new DOMPoint(box.x + box.w * hx, box.y + box.h * hy)); return [p.x, p.y]; })()));
  };
  const local = (p) => {
    // point in the box's own (unrotated, unscaled-axis) frame, relative to the current centre
    const c = { x: cx + st.tx, y: cy + st.ty }; const a = -st.rot * Math.PI / 180;
    const dx = p.x - c.x; const dy = p.y - c.y;
    return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  };
  const t = {
    id: 'transform', cursor: 'default', layerId: layer.id,
    info: () => ({ w: Math.round(Math.abs(box.w * st.sx)), h: Math.round(Math.abs(box.h * st.sy)), sx: st.sx, sy: st.sy, rot: st.rot, x: Math.round(cx + st.tx), y: Math.round(cy + st.ty) }),
    set(patch) { Object.assign(st, patch); update(); },
    moveTo(x, y) { st.tx = x - cx; st.ty = y - cy; update(); },
    flip(axis) { if (axis === 'h') st.sx = -st.sx; else st.sy = -st.sy; update(); },
    down(p, e, api) {
      const hs = handlesScreen(api);
      const hi = hs.findIndex((s) => Math.hypot(s.x - p.sx, s.y - p.sy) < 9);
      const L = local(p); const W = box.w / 2; const H = box.h / 2;
      const inside = Math.abs(L.x) <= Math.abs(W * st.sx) && Math.abs(L.y) <= Math.abs(H * st.sy);
      if (hi >= 0) drag = { kind: 'scale', h: HANDLES[hi], st0: { ...st } };
      else if (inside) drag = { kind: 'move', x0: p.x, y0: p.y, st0: { ...st } };
      else drag = { kind: 'rotate', a0: Math.atan2(p.y - (cy + st.ty), p.x - (cx + st.tx)), st0: { ...st } };
    },
    move(p) {
      if (!drag) return;
      const s0 = drag.st0;
      if (drag.kind === 'move') { st.tx = s0.tx + p.x - drag.x0; st.ty = s0.ty + p.y - drag.y0; }
      else if (drag.kind === 'rotate') {
        let r = s0.rot + (Math.atan2(p.y - (cy + s0.ty), p.x - (cx + s0.tx)) - drag.a0) * 180 / Math.PI;
        if (p.shift) r = Math.round(r / 15) * 15;
        st.rot = r;
      } else {
        Object.assign(st, s0);
        const [fx, fy] = drag.h; const hx = fx * 2 - 1; const hy = fy * 2 - 1; // −1, 0, 1
        const W = box.w / 2; const H = box.h / 2;
        const L = local(p);
        const A = { x: p.alt ? 0 : -hx * W * s0.sx, y: p.alt ? 0 : -hy * H * s0.sy };
        let nsx = s0.sx; let nsy = s0.sy;
        if (hx) nsx = p.alt ? (L.x * hx) / W * Math.sign(s0.sx) * Math.sign(s0.sx) : (L.x - A.x) / (2 * hx * W);
        if (hy) nsy = p.alt ? (L.y * hy) / H : (L.y - A.y) / (2 * hy * H);
        const proportional = hx && hy && (layer.type === 'bitmap' || layer.type === 'text' ? !p.shift : p.shift);
        if (proportional) { const k = Math.abs(nsx / s0.sx) > Math.abs(nsy / s0.sy) ? nsx / s0.sx : nsy / s0.sy; nsx = s0.sx * k; nsy = s0.sy * k; }
        if (layer.type === 'text' && (!hx || !hy)) { /* text scales evenly only */ const k = hx ? nsx / s0.sx : nsy / s0.sy; nsx = s0.sx * k; nsy = s0.sy * k; }
        st.sx = Math.abs(nsx) < 0.001 ? 0.001 : nsx; st.sy = Math.abs(nsy) < 0.001 ? 0.001 : nsy;
        if (!p.alt) {
          // keep the opposite handle where it was
          const cl = { x: hx ? A.x + hx * W * st.sx : 0, y: hy ? A.y + hy * H * st.sy : 0 };
          const a = st.rot * Math.PI / 180;
          st.tx = s0.tx + cl.x * Math.cos(a) - cl.y * Math.sin(a);
          st.ty = s0.ty + cl.x * Math.sin(a) + cl.y * Math.cos(a);
        }
      }
      update();
    },
    up() { drag = null; },
    hover(p, e, api) {
      if (!api) return;
      const hs = handlesScreen(api);
      const hi = hs.findIndex((s) => Math.hypot(s.x - p.sx, s.y - p.sy) < 9);
      const L = local(p);
      const inside = Math.abs(L.x) <= Math.abs(box.w / 2 * st.sx) && Math.abs(L.y) <= Math.abs(box.h / 2 * st.sy);
      api.el.style.cursor = hi >= 0 ? (hi % 4 === 1 ? 'ns-resize' : hi % 4 === 3 ? 'ew-resize' : hi % 4 === 0 ? 'nwse-resize' : 'nesw-resize') : inside ? 'move' : 'alias';
    },
    key(e) { if (e.key === 'Enter') { t.apply(); return true; } if (e.key === 'Escape') { t.cancel(); return true; } return false; },
    apply() {
      const m = matrix();
      ed.renderer.overrides.delete(layer.id);
      const cur = ed.doc;
      const l = findLayer(cur.layers, layer.id);
      if (!l) { onEnd?.(); return; }
      if (m.isIdentity) { ed.renderer.invalidate('full'); onEnd?.(); return; }
      let next;
      if (sel) {
        const e = new PixEdit(cur, l, 'pix');
        const nb = boundsOf(m);
        e.edit(union({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, nb), (ctx) => {
          ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selCanvas(sel), sel.x, sel.y);
          ctx.globalCompositeOperation = 'source-over';
          ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(content, box.x, box.y);
        });
        next = e.commit(cur);
        // the selection follows the pixels
        const sc = makeCanvas(cur.width, cur.height); const sctx = sc.getContext('2d');
        sctx.setTransform(m); sctx.drawImage(selCanvas(sel), sel.x, sel.y);
        next = { ...next, sel: selFromAlpha(cur, sc, 0, 0) };
      } else next = updateLayerTree(cur, layer.id, (x) => transformLayer(x, m));
      ed.renderer.invalidate('full');
      ed.commit(next, 'Free Transform');
      onEnd?.();
    },
    cancel() { ed.renderer.overrides.delete(layer.id); ed.renderer.invalidate('full'); onEnd?.(); },
    overlay(ctx, api) {
      const hs = handlesScreen(api);
      ctx.strokeStyle = '#5AB4FF'; ctx.lineWidth = 1;
      ctx.beginPath(); [0, 2, 4, 6].forEach((i, k) => (k ? ctx.lineTo(hs[i].x, hs[i].y) : ctx.moveTo(hs[i].x, hs[i].y))); ctx.closePath(); ctx.stroke();
      for (const s of hs) { ctx.fillStyle = '#fff'; ctx.fillRect(s.x - 4, s.y - 4, 8, 8); ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9); }
      const c = api.toScreen(cx + st.tx, cy + st.ty);
      ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.stroke();
    },
  };
  update();
  return t;
}
const updateLayerTree = (doc, id, fn) => ({ ...doc, layers: doc.layers.map(function walk(l) { return l.id === id ? fn(l) : l.type === 'group' ? { ...l, children: l.children.map(walk) } : l; }) });

// ---------------------------------------------------------------- all tools

export function makeTools(ed) {
  return {
    move: moveTool(ed),
    marquee: marqueeTool(ed),
    lasso: lassoTool(ed),
    wand: wandTool(ed),
    crop: cropTool(ed),
    eyedropper: eyedropperTool(ed),
    heal: paintTool(ed, 'heal'),
    brush: paintTool(ed, 'brush'),
    pencil: paintTool(ed, 'pencil'),
    clone: paintTool(ed, 'clone'),
    eraser: paintTool(ed, 'eraser'),
    bucket: bucketTool(ed),
    gradient: gradientTool(ed),
    blur: paintTool(ed, 'blur'),
    dodge: paintTool(ed, 'dodge'),
    text: textTool(ed),
    shape: shapeTool(ed),
    hand: { id: 'hand', cursor: 'grab' },
    zoom: zoomTool(ed),
  };
}

export { rasterLayer, rotatedCorners, updateLayer };
