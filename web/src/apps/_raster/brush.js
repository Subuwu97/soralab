// The brush engine shared by both editors.
//
// A Stroke paints into one Pix (a layer's pixels or its mask). Most brushes stamp "dabs" into a stroke buffer and the
// buffer is laid onto the layer at the stroke's opacity — so flow builds up inside a stroke but never past opacity,
// like Photoshop. Smudge, blending (oil), blur, sharpen, dodge and burn change the pixels directly instead.
//
//   const s = new Stroke({ pix, ox, oy, doc, brush, color, mode, sel, lockAlpha, symmetry })
//   s.add({ x, y, pressure, tiltX, tiltY })   (document coordinates) …  s.flush() → doc rect to recomposite
//   const dirty = s.end()                     → commit(pix, dirty) makes the next Pix
import { materialize, restore, drawPix, union, intersect, roundRect, makeCanvas } from './pix.js';
import { selCanvas } from './selection.js';
import { parse, toHex, rgbToHsv, hsvToRgb } from '../../lib/color.js';

// ---------------------------------------------------------------- brush tips

const tipCache = new Map();
let noiseSeed = 1;
const rand = () => { noiseSeed = (noiseSeed * 16807) % 2147483647; return (noiseSeed - 1) / 2147483646; };

/** Alpha tip canvas for a tip shape at resolution `res` px. */
export function getTip(shape = 'round', hardness = 1, res = 64) {
  res = res <= 32 ? Math.max(2, Math.ceil(res)) : res <= 256 ? Math.ceil(res / 16) * 16 : Math.min(1024, Math.ceil(res / 64) * 64);
  const key = `${shape}|${hardness.toFixed(2)}|${res}`;
  let t = tipCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas'); c.width = res; c.height = res;
  const ctx = c.getContext('2d');
  const r = res / 2;
  if (shape === 'pixel') {
    // aliased disc for the Pencil: every pixel fully in or out
    const img = ctx.createImageData(res, res);
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      if (d <= r || res <= 2) { const i = (y * res + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
  } else {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    const h = Math.min(0.99, Math.max(0, hardness));
    g.addColorStop(0, 'rgba(255,255,255,1)');
    if (h > 0) g.addColorStop(h, 'rgba(255,255,255,1)');
    // a smooth falloff (several stops approximate a cosine curve)
    for (let i = 1; i <= 4; i++) { const t2 = h + (1 - h) * (i / 5); g.addColorStop(t2, `rgba(255,255,255,${(0.5 + 0.5 * Math.cos(Math.PI * i / 5)).toFixed(3)})`); }
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    if (shape === 'chisel') { ctx.fillRect(0, r * 0.45, res, res * 0.55); }
    else { ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fill(); }
    if (shape === 'grain' || shape === 'bristle' || shape === 'wet') {
      // texture: knock holes into the tip (charcoal grain, bristle streaks, watercolour pigment)
      const img = ctx.getImageData(0, 0, res, res);
      noiseSeed = 12345;
      const streaks = shape === 'bristle' ? Array.from({ length: res }, () => 0.45 + rand() * 0.55) : null;
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const i = (y * res + x) * 4 + 3;
        const n = shape === 'grain' ? (rand() < 0.45 ? rand() * 0.4 : 1) : shape === 'bristle' ? streaks[y] * (0.85 + rand() * 0.15) : 0.75 + rand() * 0.25;
        img.data[i] *= n;
      }
      ctx.putImageData(img, 0, 0);
    }
  }
  t = c;
  tipCache.set(key, t);
  if (tipCache.size > 80) tipCache.delete(tipCache.keys().next().value);
  return t;
}

const tintCache = new Map();
function tinted(tip, color) {
  const key = `${tip.width}|${tipKeyOf(tip)}|${color}`;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = tip.width; c.height = tip.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(tip, 0, 0);
  ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  if (tintCache.size > 64) tintCache.delete(tintCache.keys().next().value);
  return c;
}
const tipIds = new WeakMap(); let tipSeq = 0;
const tipKeyOf = (t) => { let k = tipIds.get(t); if (!k) { k = ++tipSeq; tipIds.set(t, k); } return k; };

/** Tip alpha (0..1) as a Float32Array at an exact integer size — dodge/burn/sharpen weights. */
const weightCache = new Map();
function tipWeights(tip, size) {
  const key = `${tipKeyOf(tip)}|${size}`;
  let w = weightCache.get(key);
  if (w) return w;
  const c = makeCanvas(size, size); const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size); ctx.drawImage(tip, 0, 0, size, size);
  const d = ctx.getImageData(0, 0, size, size).data;
  w = new Float32Array(size * size);
  for (let i = 0; i < w.length; i++) w[i] = d[i * 4 + 3] / 255;
  weightCache.set(key, w);
  if (weightCache.size > 40) weightCache.delete(weightCache.keys().next().value);
  return w;
}

// ---------------------------------------------------------------- input smoothing

/**
 * Stabiliser: a "pulled string" — the brush only moves once the pointer is `radius` away, which irons out wobble —
 * plus light averaging. finish() returns the remaining points to the pen tip so the line ends where you lifted.
 */
export class Smoother {
  constructor(radius = 0) { this.radius = radius; this.p = null; }
  push(pt) {
    if (!this.p || this.radius <= 0.5) { this.p = { ...pt }; return [{ ...pt }]; }
    const dx = pt.x - this.p.x; const dy = pt.y - this.p.y; const d = Math.hypot(dx, dy);
    this.last = pt;
    if (d <= this.radius) { this.p.pressure += (pt.pressure - this.p.pressure) * 0.3; return []; }
    const k = (d - this.radius) / d;
    this.p = { ...pt, x: this.p.x + dx * k, y: this.p.y + dy * k, pressure: this.p.pressure + (pt.pressure - this.p.pressure) * 0.5 };
    return [{ ...this.p }];
  }
  finish() {
    if (!this.last || !this.p || this.radius <= 0.5) return [];
    return [{ ...this.last, pressure: this.p.pressure }];
  }
}

// ---------------------------------------------------------------- strokes

/** Brush settings with defaults. */
export const BRUSH_DEFAULTS = {
  size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.15, tip: 'round', angle: 0, roundness: 1,
  pressureSize: true, pressureOpacity: false, sizeCurve: 1, opacityCurve: 1, minSize: 0.15,
  jitterHue: 0, jitterSat: 0, jitterBri: 0, angleJitter: 0, scatter: 0, tilt: false,
  blend: 'source-over', kind: 'paint', strength: 0.5, buildUp: false, wetEdges: false, pickup: 0, exposure: 0.5, range: 'midtones',
};

let BUF = null; // the stroke buffer, shared (one stroke at a time)
let TMP = null;

const scratch = (w, h) => {
  TMP = makeCanvas(Math.max(w, TMP?.width || 1), Math.max(h, TMP?.height || 1), TMP);
  const ctx = TMP.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return TMP;
};

export class Stroke {
  /**
   * pix: the Pix to paint; ox, oy: where its (0,0) sits in the document; doc: { width, height }
   * brush: settings (see BRUSH_DEFAULTS); color: '#rrggbb'; mode: 'paint' | 'erase' | 'hide' | 'reveal' (masks)
   * sel: selection or null; lockAlpha; symmetry: { mode: 'v'|'h'|'quad'|'radial', cx, cy, n }
   * clone: { offsetX, offsetY } for the clone stamp (source = this pix as it was).
   */
  constructor(o) {
    Object.assign(this, { sel: null, lockAlpha: false, symmetry: null, mode: 'paint' }, o);
    this.b = { ...BRUSH_DEFAULTS, ...o.brush };
    this.m = materialize(this.pix, { x: -this.ox, y: -this.oy, w: this.doc.width, h: this.doc.height });
    this.direct = ['smudge', 'blend', 'blur', 'sharpen', 'dodge', 'burn'].includes(this.b.kind);
    if (!this.direct) {
      BUF = makeCanvas(Math.max(this.m.w, BUF?.width || 1), Math.max(this.m.h, BUF?.height || 1), BUF);
      this.bctx = BUF.getContext('2d');
      this.bctx.setTransform(1, 0, 0, 1, 0, 0); this.bctx.globalAlpha = 1; this.bctx.globalCompositeOperation = 'source-over';
      this.bctx.clearRect(0, 0, BUF.width, BUF.height);
    }
    this.pending = null; // mat-canvas rect awaiting compose
    this.total = null; // pix-local rect touched
    this.last = null; this.dist = 0;
    this.color = color(o.color || '#000000');
    this.dabColor = this.color;
    this.res = Math.max(4, this.b.size * (this.b.tilt ? 1.6 : 1));
    this.tip = getTip(this.b.tip, this.b.hardness, this.b.tip === 'pixel' ? Math.round(this.b.size) : this.res);
    this.carry = null; // smudge / blend sample
  }

  /** Feed one input point (document coords). */
  add(pt) {
    const p = { pressure: 1, ...pt };
    if (!this.last) { this.last = p; this.dabsAt(p); this.lastDab = p; return; }
    const a = this.last;
    const seg = Math.hypot(p.x - a.x, p.y - a.y);
    if (seg < 1e-3) { this.last = p; return; }
    let t = 0;
    while (true) {
      const pr = a.pressure + (p.pressure - a.pressure) * t;
      const step = Math.max(this.b.tip === 'pixel' ? 1 : 0.5, this.sizeAt(pr) * this.b.spacing);
      const need = step - this.dist;
      const left = seg * (1 - t);
      if (need > left) { this.dist += left; break; }
      t += need / seg;
      this.dist = 0;
      const q = { x: a.x + (p.x - a.x) * t, y: a.y + (p.y - a.y) * t, pressure: a.pressure + (p.pressure - a.pressure) * t, tiltX: p.tiltX, tiltY: p.tiltY };
      this.dabsAt(q, Math.atan2(p.y - a.y, p.x - a.x));
      this.lastDab = q;
    }
    this.last = p;
  }

  /** Airbrush: keep spraying while the pen rests. */
  tick() { if (this.b.buildUp && this.lastDab) this.dabsAt(this.lastDab); }

  sizeAt(pr) {
    const b = this.b;
    if (!b.pressureSize) return b.size;
    return b.size * (b.minSize + (1 - b.minSize) * Math.pow(Math.max(0, pr), b.sizeCurve));
  }

  dabsAt(p, dir = 0) {
    const pts = mirror(p, this.symmetry);
    for (const q of pts) this.dab(q, dir);
  }

  dab(p, dir) {
    const b = this.b;
    let size = this.sizeAt(p.pressure);
    let alpha = b.flow * (b.pressureOpacity ? Math.pow(Math.max(0, p.pressure), b.opacityCurve) : 1);
    let angle = (b.angle * Math.PI) / 180; let round = b.roundness;
    if (b.tilt && (p.tiltX || p.tiltY)) {
      // a tilted pencil lays down a wider, lighter mark along the tilt direction
      const t = Math.min(1, Math.hypot(p.tiltX, p.tiltY) / 70);
      size *= 1 + t * 1.2; round *= 1 - t * 0.55; alpha *= 1 - t * 0.45; angle = Math.atan2(p.tiltY, p.tiltX);
    }
    if (b.angleJitter) angle += (Math.random() - 0.5) * Math.PI * 2 * b.angleJitter;
    if (b.tip === 'chisel' && !b.tilt) angle = (b.angle * Math.PI) / 180;
    let { x, y } = p;
    if (b.scatter) { x += (Math.random() - 0.5) * size * b.scatter; y += (Math.random() - 0.5) * size * b.scatter; }
    const cx = x - this.ox - this.m.x; const cy = y - this.oy - this.m.y; // mat-canvas coords
    const w = Math.max(b.tip === 'pixel' ? 1 : 0.5, size); const h = w * round;
    const ext = Math.ceil(Math.max(w, h) / 2) + 2;
    const rect = { x: Math.floor(cx - ext), y: Math.floor(cy - ext), w: ext * 2 + 1, h: ext * 2 + 1 };
    const r = intersect(rect, { x: 0, y: 0, w: this.m.w, h: this.m.h });
    if (!r) return;
    if (this.direct) this.directDab(cx, cy, w, h, angle, alpha, r);
    else this.bufferDab(cx, cy, w, h, angle, alpha);
    this.touch(r);
  }

  bufferDab(cx, cy, w, h, angle, alpha) {
    const b = this.b; const ctx = this.bctx;
    let col = this.color;
    if (b.jitterHue || b.jitterSat || b.jitterBri) col = jitter(col, b);
    if (b.pickup && this.mode === 'paint') {
      // watercolour: the brush picks up a little of the colour already there
      const under = sampleAvg(this.m.ctx, cx, cy, Math.max(2, w / 3));
      if (under) this.dabColor = mixHex(this.dabColor, under, b.pickup * 0.12);
      this.dabColor = mixHex(this.dabColor, col, 0.08);
      col = this.dabColor;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    if (b.tip === 'pixel') { ctx.imageSmoothingEnabled = false; }
    ctx.translate(b.tip === 'pixel' ? Math.round(cx) : cx, b.tip === 'pixel' ? Math.round(cy) : cy);
    if (angle) ctx.rotate(angle);
    if (b.kind === 'clone' && this.clone) {
      // the stamp: pixels from the source offset, shaped by the tip
      const s = Math.ceil(Math.max(w, h)) + 2;
      const t = scratch(s, s); const tc = t.getContext('2d');
      const sx = cx + this.m.x - this.clone.offsetX - s / 2; const sy = cy + this.m.y - this.clone.offsetY - s / 2;
      drawPix(tc, this.clone.pix || this.pix, -sx, -sy, { x: 0, y: 0, w: s, h: s });
      tc.globalCompositeOperation = 'destination-in';
      tc.translate(s / 2, s / 2); if (angle) tc.rotate(angle); tc.drawImage(this.tip, -w / 2, -h / 2, w, h);
      if (angle) ctx.rotate(-angle);
      ctx.drawImage(t, 0, 0, s, s, -s / 2, -s / 2, s, s);
    } else {
      ctx.drawImage(tinted(this.tip, this.mode === 'paint' ? col : '#000000'), -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  directDab(cx, cy, w, h, angle, alpha, r) {
    const b = this.b; const m = this.m;
    const s = Math.ceil(Math.max(w, h)) + 2;
    const x0 = Math.round(cx - s / 2); const y0 = Math.round(cy - s / 2);
    const strength = Math.min(1, b.strength * (b.pressureOpacity ? alpha / Math.max(0.01, b.flow) : 1));
    if (b.kind === 'smudge' || b.kind === 'blend') {
      // "smearing": take the patch under the previous dab and lay it down here. The strength is per 40% of a
      // brush-width of travel, so the smear length doesn't depend on spacing, and the smear fades naturally.
      const prev = this.prevDab;
      this.prevDab = { x0, y0, s };
      if (!prev) return;
      const step = Math.hypot(x0 - prev.x0, y0 - prev.y0);
      if (step < 0.5) return;
      const a = Math.pow(strength, step / Math.max(1, w * 0.4));
      const t = scratch(s, s); const tc = t.getContext('2d');
      tc.drawImage(m.canvas, prev.x0 + (prev.s - s) / 2, prev.y0 + (prev.s - s) / 2, s, s, 0, 0, s, s);
      if (b.kind === 'blend') { tc.globalAlpha = Math.min(1, alpha * 0.18); tc.drawImage(tinted(this.tip, this.color), 0, 0, s, s); tc.globalAlpha = 1; }
      tc.globalCompositeOperation = 'destination-in';
      tc.translate(s / 2, s / 2); if (angle) tc.rotate(angle); tc.drawImage(this.tip, -w / 2, -h / 2, w, h); tc.setTransform(1, 0, 0, 1, 0, 0);
      // 'copy'-like replacement inside the tip: fade out what's here, then add the smeared patch
      m.ctx.save();
      m.ctx.globalAlpha = a; m.ctx.globalCompositeOperation = 'destination-out';
      m.ctx.drawImage(this.tip, x0 + (s - w) / 2, y0 + (s - h) / 2, w, h);
      m.ctx.globalCompositeOperation = 'lighter';
      m.ctx.drawImage(t, 0, 0, s, s, x0, y0, s, s);
      m.ctx.restore();
    } else if (b.kind === 'blur') {
      const pad = 6;
      const t = scratch(s + pad * 2, s + pad * 2); const tc = t.getContext('2d');
      tc.filter = `blur(${Math.max(0.5, strength * Math.max(1, w / 12))}px)`;
      tc.drawImage(m.canvas, x0 - pad, y0 - pad, s + pad * 2, s + pad * 2, 0, 0, s + pad * 2, s + pad * 2);
      tc.filter = 'none';
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(this.tip, pad + (s - w) / 2, pad + (s - h) / 2, w, h);
      m.ctx.save(); m.ctx.globalAlpha = Math.min(1, 0.3 + strength); m.ctx.drawImage(t, pad, pad, s, s, x0, y0, s, s); m.ctx.restore();
    } else {
      // sharpen / dodge / burn work on the pixels
      const rr = intersect({ x: x0, y: y0, w: s, h: s }, { x: 0, y: 0, w: m.w, h: m.h });
      if (!rr) return;
      const img = m.ctx.getImageData(rr.x, rr.y, rr.w, rr.h); const d = img.data;
      const wts = tipWeights(this.tip, s);
      const src = b.kind === 'sharpen' ? new Uint8ClampedArray(d) : null;
      const k = strength * (b.kind === 'sharpen' ? 0.6 : 0.12);
      for (let y = 0; y < rr.h; y++) for (let x = 0; x < rr.w; x++) {
        const wt = wts[(y + rr.y - y0) * s + (x + rr.x - x0)] * k;
        if (wt <= 0.001) continue;
        const i = (y * rr.w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = d[i + c];
          if (b.kind === 'sharpen') {
            if (x === 0 || y === 0 || x === rr.w - 1 || y === rr.h - 1) continue;
            const nb = (src[i + c - 4] + src[i + c + 4] + src[i + c - rr.w * 4] + src[i + c + rr.w * 4]) / 4;
            d[i + c] = v + (v - nb) * wt * 2;
          } else {
            const L = v / 255;
            const tone = b.range === 'shadows' ? (1 - L) ** 2 : b.range === 'highlights' ? L * L : 1 - Math.abs(L - 0.5) * 2 * 0.8;
            const amt = wt * tone * (b.exposure * 2);
            d[i + c] = b.kind === 'dodge' ? v + (255 - v) * amt : v * (1 - amt);
          }
        }
      }
      m.ctx.putImageData(img, rr.x, rr.y);
    }
    if (this.sel || this.lockAlpha) this.clipDirect({ x: x0, y: y0, w: s, h: s });
  }

  /** After a direct dab: put back pixels outside the selection (and keep transparency when locked). */
  clipDirect(r0) {
    const m = this.m;
    const r = intersect(r0, { x: 0, y: 0, w: m.w, h: m.h });
    if (!r) return;
    const t = scratch(r.w, r.h); const tc = t.getContext('2d');
    drawPix(tc, this.pix, -(r.x + m.x), -(r.y + m.y), { x: 0, y: 0, w: r.w, h: r.h });
    const keep = this.keepMask(r);
    if (keep) { tc.globalCompositeOperation = 'destination-out'; tc.drawImage(keep, 0, 0); }
    m.ctx.save();
    m.ctx.beginPath(); m.ctx.rect(r.x, r.y, r.w, r.h); m.ctx.clip();
    if (keep) { m.ctx.globalCompositeOperation = 'destination-in'; m.ctx.drawImage(keep, r.x, r.y); }
    m.ctx.globalCompositeOperation = 'lighter';
    m.ctx.drawImage(t, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
    m.ctx.restore();
  }

  /** Where painting may land inside r (mat coords): selection × original alpha (lock transparency). */
  keepMask(r) {
    if (!this.sel && !this.lockAlpha) return null;
    const c = makeCanvas(r.w, r.h); const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, r.w, r.h);
    if (this.sel) ctx.drawImage(selCanvas(this.sel), this.sel.x - this.ox - this.m.x - r.x, this.sel.y - this.oy - this.m.y - r.y);
    else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.w, r.h); }
    if (this.lockAlpha) { ctx.globalCompositeOperation = 'destination-in'; drawPix(ctx, this.pix, -(r.x + this.m.x), -(r.y + this.m.y), { x: 0, y: 0, w: r.w, h: r.h }); }
    return c;
  }

  touch(r) {
    this.pending = union(this.pending, r);
    this.total = union(this.total, { x: r.x + this.m.x, y: r.y + this.m.y, w: r.w, h: r.h });
  }

  /** Lays the stroke buffer onto the layer where it changed. Returns the doc rect to recomposite (or null). */
  flush() {
    const d = this.pending;
    if (!d) return null;
    this.pending = null;
    if (!this.direct) this.compose(d);
    return { x: d.x + this.m.x + this.ox, y: d.y + this.m.y + this.oy, w: d.w, h: d.h };
  }

  compose(d) {
    const m = this.m; const b = this.b;
    restore(this.pix, { x: d.x + m.x, y: d.y + m.y, w: d.w, h: d.h });
    const t = scratch(d.w, d.h); const tc = t.getContext('2d');
    tc.drawImage(BUF, d.x, d.y, d.w, d.h, 0, 0, d.w, d.h);
    if (b.kind === 'heal') { tc.globalCompositeOperation = 'source-in'; tc.fillStyle = 'rgba(120,120,140,0.55)'; tc.fillRect(0, 0, d.w, d.h); tc.globalCompositeOperation = 'source-over'; }
    if (this.sel) {
      // the selection may only cover part of d: clear d first, then keep what's selected
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(selCanvas(this.sel), this.sel.x - this.ox - m.x - d.x, this.sel.y - this.oy - m.y - d.y);
      tc.globalCompositeOperation = 'source-over';
    }
    const op = this.mode === 'erase' || this.mode === 'reveal' ? 'destination-out'
      : this.lockAlpha && this.mode === 'paint' ? 'source-atop' : this.mode === 'paint' ? b.blend || 'source-over' : 'source-over';
    m.ctx.save();
    m.ctx.beginPath(); m.ctx.rect(d.x, d.y, d.w, d.h); m.ctx.clip();
    m.ctx.globalAlpha = b.opacity; m.ctx.globalCompositeOperation = op;
    m.ctx.drawImage(t, 0, 0, d.w, d.h, d.x, d.y, d.w, d.h);
    m.ctx.restore();
  }

  /** Finishes: returns the pix-local dirty rect for commit(), or null if nothing was painted. */
  end() {
    if (this.b.wetEdges && this.total && !this.direct) this.wetEdges();
    this.flush();
    return this.total && roundRect(this.total);
  }

  /** Watercolour: pigment gathers at the edges of the wash, and the wash softens a little. */
  wetEdges() {
    const m = this.m;
    const r = intersect({ x: this.total.x - m.x - 4, y: this.total.y - m.y - 4, w: this.total.w + 8, h: this.total.h + 8 }, { x: 0, y: 0, w: m.w, h: m.h });
    if (!r) return;
    const blur = Math.max(2, this.b.size / 10);
    const e = makeCanvas(r.w, r.h); const ec = e.getContext('2d');
    ec.drawImage(BUF, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const bl = makeCanvas(r.w, r.h); const bc = bl.getContext('2d');
    bc.filter = `blur(${blur}px)`; bc.drawImage(BUF, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); bc.filter = 'none';
    ec.globalCompositeOperation = 'destination-out'; ec.drawImage(bl, 0, 0); // ring just inside the edge
    this.bctx.save();
    this.bctx.filter = 'blur(1px)';
    const soft = makeCanvas(r.w, r.h); const sc = soft.getContext('2d'); sc.drawImage(BUF, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    this.bctx.clearRect(r.x, r.y, r.w, r.h); this.bctx.drawImage(soft, r.x, r.y);
    this.bctx.filter = 'none'; this.bctx.globalAlpha = 0.85; this.bctx.drawImage(e, r.x, r.y);
    this.bctx.restore();
    this.pending = union(this.pending, r);
  }

  /** The stroke buffer (mat-canvas coordinates) — the heal tool uses its alpha as the area to patch. */
  bufferCanvas() { return BUF; }

  /** Undo the stroke so far (e.g. a second finger turned out to be a gesture). */
  cancel() {
    if (this.total) restore(this.pix, this.total);
    const d = this.total;
    this.total = null; this.pending = null;
    return d && { x: d.x + this.ox, y: d.y + this.oy, w: d.w, h: d.h };
  }
}

// ---------------------------------------------------------------- helpers

function color(c) { return toHex(parse(c)); }
function mixHex(a, b, t) { const p = parse(a); const q = parse(b); return toHex({ r: p.r + (q.r - p.r) * t, g: p.g + (q.g - p.g) * t, b: p.b + (q.b - p.b) * t }); }
function jitter(c, b) {
  const hsv = rgbToHsv(parse(c));
  hsv.h = (hsv.h + (Math.random() - 0.5) * 360 * b.jitterHue + 360) % 360;
  hsv.s = Math.max(0, Math.min(1, hsv.s + (Math.random() - 0.5) * b.jitterSat));
  hsv.v = Math.max(0, Math.min(1, hsv.v + (Math.random() - 0.5) * b.jitterBri));
  // quantise so the tinted-tip cache stays useful
  hsv.h = Math.round(hsv.h / 3) * 3; hsv.s = Math.round(hsv.s * 40) / 40; hsv.v = Math.round(hsv.v * 40) / 40;
  return toHex(hsvToRgb(hsv));
}
let avgC = null;
function sampleAvg(ctx, x, y, r) {
  avgC ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  avgC.canvas.width = 1; avgC.canvas.height = 1;
  avgC.clearRect(0, 0, 1, 1);
  avgC.drawImage(ctx.canvas, x - r, y - r, r * 2, r * 2, 0, 0, 1, 1);
  const d = avgC.getImageData(0, 0, 1, 1).data;
  if (d[3] < 20) return null;
  return toHex({ r: d[0], g: d[1], b: d[2] });
}

/** Mirror a point for symmetry painting. */
export function mirror(p, sym) {
  if (!sym || !sym.mode || sym.mode === 'off') return [p];
  const { cx, cy } = sym;
  const out = [p];
  if (sym.mode === 'v' || sym.mode === 'quad') out.push({ ...p, x: 2 * cx - p.x });
  if (sym.mode === 'h' || sym.mode === 'quad') out.push({ ...p, y: 2 * cy - p.y });
  if (sym.mode === 'quad') out.push({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y });
  if (sym.mode === 'radial') {
    const n = Math.max(2, sym.n || 6);
    for (let i = 1; i < n; i++) {
      const a = (i / n) * Math.PI * 2; const dx = p.x - cx; const dy = p.y - cy;
      out.push({ ...p, x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) });
    }
  }
  return out;
}
