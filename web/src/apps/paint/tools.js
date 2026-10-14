// Paint's tools: the brush (any family, with pressure, tilt, smoothing, symmetry, long-press eyedropper),
// fill, lasso fill, lasso selection, eyedropper and the rotate-view drag (hold R).
import { Stroke, Smoother } from '../_raster/brush.js';
import { commit as commitPix, makeCanvas, intersect } from '../_raster/pix.js';
import { selPolygon, combine } from '../_raster/selection.js';
import { PixEdit, pixTarget, withPix, bucketFill } from '../_raster/ops.js';
import { toHex } from '../../lib/color.js';

export function sampleAt(ed, x, y) {
  const doc = ed.doc;
  const r = intersect({ x: Math.floor(x) - 1, y: Math.floor(y) - 1, w: 3, h: 3 }, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!r) return null;
  ed.renderer.flush();
  const d = ed.renderer.ctx.getImageData(r.x, r.y, r.w, r.h).data;
  let R = 0; let G = 0; let B = 0; let A = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i] * d[i + 3]; G += d[i + 1] * d[i + 3]; B += d[i + 2] * d[i + 3]; A += d[i + 3]; }
  return A ? toHex({ r: R / A, g: G / A, b: B / A }) : null;
}

function target(ed) {
  const l = ed.layer();
  if (!l) { ed.toast('Add a layer to paint on'); return null; }
  if (l.locked) { ed.toast('This layer is locked'); return null; }
  if (!l.visible) { ed.toast('This layer is hidden — show it to paint'); return null; }
  if (l.type !== 'bitmap') { ed.toast('Choose a pixel layer'); return null; }
  return { layer: l, ...pixTarget(l, 'pix') };
}

function brushTool(ed) {
  let stroke = null; let smooth = null; let tgt = null; let air = null; let press = null; let picking = null;
  const pick = (p) => { const c = sampleAt(ed, p.x, p.y); if (c) { ed.setFg(c); picking = { ...p, c }; } else picking = { ...p, c: picking?.c }; ed.vp.overlay(); };
  const t = {
    id: 'brush', cursor: 'crosshair', animated: false,
    brushSize: () => (picking ? 0 : ed.brush().size),
    down(p) {
      if (ed.readOnly) return;
      if (p.alt) { pick(p); return; }
      tgt = target(ed); if (!tgt) return;
      const fam = ed.family();
      const b = { ...ed.brush() };
      const mode = fam === 'eraser' ? 'erase' : 'paint';
      const doc = ed.doc;
      stroke = new Stroke({ pix: tgt.pix, ox: tgt.ox, oy: tgt.oy, doc, brush: b, color: ed.fg, mode, sel: doc.sel, lockAlpha: tgt.layer.lockAlpha, symmetry: ed.symmetry() });
      smooth = new Smoother(((b.smoothing || 0) * 0.45) / ed.vp.matrix().a * (window.devicePixelRatio || 1) / (window.devicePixelRatio || 1));
      ed.live = { flush: () => stroke?.flush() };
      for (const q of smooth.push(p)) stroke.add(q);
      if (b.buildUp) air = setInterval(() => stroke?.tick(), 40);
      // long press without moving = eyedropper (as in Fresco)
      press = { sx: p.sx, sy: p.sy, timer: setTimeout(() => {
        if (!stroke) return;
        ed.renderer.invalidate(stroke.cancel()); stroke = null; ed.live = null; clearInterval(air);
        pick(p);
      }, 550) };
    },
    move(p) {
      if (picking) { pick(p); return; }
      if (press && Math.hypot(p.sx - press.sx, p.sy - press.sy) > 6) { clearTimeout(press.timer); press = null; }
      if (stroke) for (const q of smooth.push(p)) stroke.add(q);
    },
    up() {
      clearTimeout(press?.timer); press = null; clearInterval(air);
      if (picking) { picking = null; ed.pickedColor?.(); ed.vp.overlay(); return; }
      if (!stroke) return;
      for (const q of smooth.finish()) stroke.add(q);
      const s = stroke; stroke = null;
      const dirty = s.end();
      ed.renderer.invalidate(s.flush());
      ed.live = null;
      if (!dirty) return;
      ed.commit(withPix(ed.doc, tgt.layer.id, 'pix', commitPix(s.pix, dirty)), LABEL[ed.family()] || 'Brush');
    },
    cancel() { clearTimeout(press?.timer); clearInterval(air); if (stroke) { ed.renderer.invalidate(stroke.cancel()); stroke = null; ed.live = null; } picking = null; },
    overlay(ctx, api) {
      const sym = ed.symmetry();
      if (sym?.mode && sym.mode !== 'off') {
        const doc = ed.doc;
        ctx.save(); ctx.strokeStyle = 'rgba(255,111,168,.85)'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1;
        const line = (x1, y1, x2, y2) => { const a = api.toScreen(x1, y1); const b = api.toScreen(x2, y2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
        if (sym.mode === 'v' || sym.mode === 'quad') line(sym.cx, 0, sym.cx, doc.height);
        if (sym.mode === 'h' || sym.mode === 'quad') line(0, sym.cy, doc.width, sym.cy);
        if (sym.mode === 'radial') for (let i = 0; i < sym.n; i++) { const a = (i / sym.n) * Math.PI * 2 - Math.PI / 2; const R = Math.hypot(doc.width, doc.height); line(sym.cx, sym.cy, sym.cx + Math.cos(a) * R, sym.cy + Math.sin(a) * R); }
        ctx.restore();
      }
      if (picking?.c) {
        // loupe: ring in the picked colour
        ctx.save();
        ctx.lineWidth = 14; ctx.strokeStyle = picking.c; ctx.beginPath(); ctx.arc(picking.sx, picking.sy - 70, 34, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.arc(picking.sx, picking.sy - 70, 41, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(picking.sx, picking.sy - 70, 27, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(picking.sx - 6, picking.sy); ctx.lineTo(picking.sx + 6, picking.sy); ctx.moveTo(picking.sx, picking.sy - 6); ctx.lineTo(picking.sx, picking.sy + 6); ctx.stroke();
        ctx.restore();
      }
    },
  };
  return t;
}
const LABEL = { pencil: 'Pencil', ink: 'Ink', marker: 'Marker', airbrush: 'Airbrush', soft: 'Soft brush', charcoal: 'Charcoal', watercolor: 'Watercolour', oil: 'Oil', smudge: 'Smudge', eraser: 'Erase' };

function lassoBase(ed, onClose) {
  let pts = null; let mods = null;
  return {
    cursor: 'crosshair',
    down(p) { if (ed.readOnly) return; pts = [[p.x, p.y]]; mods = p; },
    move(p) { if (pts) { pts.push([p.x, p.y]); ed.vp.overlay(); } },
    up() { const list = pts; pts = null; ed.vp.overlay(); if (list && list.length > 2) onClose(list, mods); },
    cancel() { pts = null; },
    overlay(ctx, api) {
      if (!pts) return;
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const s = api.toScreen(x, y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,111,168,.15)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff6fa8'; ctx.stroke();
    },
  };
}

export function makePaintTools(ed) {
  return {
    brush: brushTool(ed),
    fill: {
      id: 'fill', cursor: 'crosshair',
      down(p) {
        if (ed.readOnly) return;
        if (p.alt) { const c = sampleAt(ed, p.x, p.y); if (c) ed.setFg(c); return; }
        const t = target(ed); if (!t) return;
        const o = ed.fillOpts();
        const d = bucketFill(ed.renderer, ed.doc, t.layer, p.x, p.y, ed.fg, { tolerance: o.tolerance, contiguous: true, merged: o.merged, sel: ed.doc.sel });
        if (d !== ed.doc) ed.commit(d, 'Fill');
      },
    },
    lassoFill: { id: 'lassoFill', ...lassoBase(ed, (pts) => {
      const t = target(ed); if (!t) return;
      const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
      const r = { x: Math.floor(Math.min(...xs)) - 1, y: Math.floor(Math.min(...ys)) - 1, w: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 3, h: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 3 };
      const e = new PixEdit(ed.doc, t.layer, 'pix');
      e.preview(r, (ctx) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = ed.fg; ctx.fill(); }, { sel: ed.doc.sel, lockAlpha: t.layer.lockAlpha });
      ed.commit(e.commit(ed.doc), 'Lasso Fill');
    }) },
    select: { id: 'select', ...lassoBase(ed, (pts, m) => {
      const doc = ed.doc;
      const mode = m.shift && m.alt ? 'intersect' : m.shift ? 'add' : m.alt ? 'subtract' : 'replace';
      ed.commit({ ...doc, sel: combine(doc.sel, selPolygon(doc, pts), mode) }, 'Lasso Select');
    }) },
    eyedropper: {
      id: 'eyedropper', cursor: 'crosshair',
      down(p) { const c = sampleAt(ed, p.x, p.y); if (c) ed.setFg(c); },
      move(p) { const c = sampleAt(ed, p.x, p.y); if (c) ed.setFg(c); },
      up() { ed.pickedColor?.(); },
    },
    hand: { id: 'hand', cursor: 'grab' },
  };
}

/** Hold R and drag to rotate the view around its centre; tap R to straighten it again. */
export function rotateViewTool(ed) {
  let s = null;
  return {
    id: 'rotateView', cursor: 'grabbing',
    down(p, e, api) { const { w, h } = api.size(); s = { a0: Math.atan2(p.sy - h / 2, p.sx - w / 2), rot0: ed.view().rot || 0, w, h }; ed.rotated = true; },
    move(p) { if (!s) return; let r = s.rot0 + (Math.atan2(p.sy - s.h / 2, p.sx - s.w / 2) - s.a0) * 180 / Math.PI; if (p.shift) r = Math.round(r / 15) * 15; ed.setView({ ...ed.view(), rot: r }); },
    up() { s = null; },
  };
}

export { makeCanvas };
