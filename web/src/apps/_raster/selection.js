// Selections are 8-bit masks kept only over their bounding box: { x, y, w, h, data: Uint8Array(w*h) } in document
// coordinates (255 = selected). Small selections stay small in undo history; "Select all" on 4000×4000 is 16 MB.
import { intersect, union } from './pix.js';

const make = (x, y, w, h, data) => ({ x, y, w, h, data: data || new Uint8Array(w * h) });
const docRect = (doc) => ({ x: 0, y: 0, w: doc.width, h: doc.height });

/** Draws a path with fn(ctx) into a mask covering r (doc coords). */
function rasterize(r, fn) {
  if (!r) return null;
  const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(-r.x, -r.y);
  ctx.fillStyle = '#fff';
  fn(ctx);
  const px = ctx.getImageData(0, 0, r.w, r.h).data;
  const s = make(r.x, r.y, r.w, r.h);
  for (let i = 0, j = 3; i < s.data.length; i++, j += 4) s.data[i] = px[j];
  return trim(s);
}

export function selRect(doc, x, y, w, h) {
  const r = intersect({ x: Math.round(Math.min(x, x + w)), y: Math.round(Math.min(y, y + h)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) }, docRect(doc));
  if (!r) return null;
  const s = make(r.x, r.y, r.w, r.h); s.data.fill(255); return s;
}
export function selEllipse(doc, x, y, w, h) {
  const bx = Math.min(x, x + w); const by = Math.min(y, y + h); const bw = Math.abs(w); const bh = Math.abs(h);
  const r = intersect({ x: Math.floor(bx), y: Math.floor(by), w: Math.ceil(bw) + 1, h: Math.ceil(bh) + 1 }, docRect(doc));
  return rasterize(r, (ctx) => { ctx.beginPath(); ctx.ellipse(bx + bw / 2, by + bh / 2, Math.max(0.5, bw / 2), Math.max(0.5, bh / 2), 0, 0, Math.PI * 2); ctx.fill(); });
}
export function selPolygon(doc, pts) {
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const r = intersect({ x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), w: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 2, h: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 2 }, docRect(doc));
  return rasterize(r, (ctx) => { ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); ctx.fill(); });
}
export const selAll = (doc) => selRect(doc, 0, 0, doc.width, doc.height);

/** Selection from a canvas' alpha placed at x,y (layer transparency → selection). */
export function selFromAlpha(doc, canvas, x = 0, y = 0) {
  const r = intersect({ x, y, w: canvas.width, h: canvas.height }, docRect(doc));
  if (!r) return null;
  const px = canvas.getContext('2d').getImageData(r.x - x, r.y - y, r.w, r.h).data;
  const s = make(r.x, r.y, r.w, r.h);
  for (let i = 0, j = 3; i < s.data.length; i++, j += 4) s.data[i] = px[j];
  return trim(s);
}

/** Shrinks the box to the selected pixels; null if nothing is selected. */
export function trim(s) {
  if (!s) return null;
  let x0 = s.w; let y0 = s.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < s.h; y++) {
    const row = y * s.w;
    for (let x = 0; x < s.w; x++) if (s.data[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return null;
  if (x0 === 0 && y0 === 0 && x1 === s.w - 1 && y1 === s.h - 1) return s;
  const n = make(s.x + x0, s.y + y0, x1 - x0 + 1, y1 - y0 + 1);
  for (let y = 0; y < n.h; y++) n.data.set(s.data.subarray((y + y0) * s.w + x0, (y + y0) * s.w + x1 + 1), y * n.w);
  return n;
}

export const at = (s, x, y) => (s && x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h ? s.data[(y - s.y) * s.w + (x - s.x)] : 0);

/** Combines selections. mode: replace | add | subtract | intersect. */
export function combine(a, b, mode) {
  if (mode === 'replace' || !mode) return b;
  if (!a) return mode === 'add' ? b : mode === 'intersect' ? null : null;
  if (!b) return mode === 'subtract' || mode === 'add' ? a : null;
  const r = mode === 'add' ? union(a, b) : mode === 'subtract' ? a : intersect(a, b);
  if (!r) return null;
  const n = make(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const va = at(a, x + r.x, y + r.y); const vb = at(b, x + r.x, y + r.y);
      n.data[y * r.w + x] = mode === 'add' ? Math.max(va, vb) : mode === 'subtract' ? va * (255 - vb) / 255 : va * vb / 255;
    }
  }
  return trim(n);
}

export function invert(s, doc) {
  const n = make(0, 0, doc.width, doc.height);
  n.data.fill(255);
  if (s) for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const X = x + s.x; const Y = y + s.y;
    if (X >= 0 && Y >= 0 && X < doc.width && Y < doc.height) n.data[Y * doc.width + X] = 255 - s.data[y * s.w + x];
  }
  return trim(n);
}

/** Feathers (Gaussian blur) by radius px. */
export function feather(s, radius, doc) {
  if (!s || radius <= 0) return s;
  const pad = Math.ceil(radius * 2);
  const r = intersect({ x: s.x - pad, y: s.y - pad, w: s.w + pad * 2, h: s.h + pad * 2 }, docRect(doc));
  return rasterize(r, (ctx) => { ctx.filter = `blur(${radius / 2}px)`; ctx.drawImage(selCanvas(s), s.x, s.y); });
}

// van Herk / Gil–Werman running max (or min) over a window, one row at a time — O(n) whatever the radius.
function runMax(src, dst, n, stride, offset, r, isMax) {
  const k = 2 * r + 1;
  const g = new Uint8Array(n + k); const h = new Uint8Array(n + k);
  const fill = isMax ? 0 : 255;
  const get = (i) => (i < r || i >= n + r ? fill : src[offset + (i - r) * stride]);
  const op = isMax ? Math.max : Math.min;
  const len = n + 2 * r;
  for (let i = 0; i < len; i++) g[i] = i % k === 0 ? get(i) : op(g[i - 1], get(i));
  for (let i = len - 1; i >= 0; i--) h[i] = i === len - 1 || (i + 1) % k === 0 ? get(i) : op(h[i + 1], get(i));
  for (let i = 0; i < n; i++) dst[offset + i * stride] = op(h[i], g[i + 2 * r] ?? fill);
}
/** Grows (px > 0) or shrinks (px < 0) the selection. */
export function expand(s, px, doc) {
  if (!s || !px) return s;
  const r0 = Math.abs(Math.round(px)); const grow = px > 0;
  const pad = grow ? r0 : 0;
  const r = intersect({ x: s.x - pad, y: s.y - pad, w: s.w + pad * 2, h: s.h + pad * 2 }, docRect(doc));
  const a = make(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) a.data[y * r.w + x] = at(s, x + r.x, y + r.y);
  const b = new Uint8Array(a.data.length);
  for (let y = 0; y < r.h; y++) runMax(a.data, b, r.w, 1, y * r.w, r0, grow);
  for (let x = 0; x < r.w; x++) runMax(b, a.data, r.h, r.w, x, r0, grow);
  return trim(a);
}

/** Smooth: blur then re-threshold (rounds off jaggies of magic wand selections). */
export function smooth(s, radius, doc) {
  const f = feather(s, radius, doc);
  if (!f) return null;
  for (let i = 0; i < f.data.length; i++) f.data[i] = f.data[i] >= 128 ? 255 : 0;
  return trim(f);
}

/**
 * Magic wand: pixels similar to the one at (x, y) in `img` (ImageData of the whole document).
 * tolerance 0..255; contiguous = flood fill, otherwise every similar pixel.
 */
export function magicWand(img, x, y, tolerance, contiguous = true) {
  const { width: w, height: h, data } = img;
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const mask = floodMask(data, w, h, x, y, tolerance, contiguous);
  const s = make(0, 0, w, h, mask);
  return trim(s);
}

/** Shared by the wand and the paint bucket: 255 where pixels match the seed colour. */
export function floodMask(data, w, h, x, y, tolerance, contiguous) {
  const i0 = (y * w + x) * 4;
  const r0 = data[i0]; const g0 = data[i0 + 1]; const b0 = data[i0 + 2]; const a0 = data[i0 + 3];
  const t = tolerance;
  const ok = (i) => Math.abs(data[i] - r0) <= t && Math.abs(data[i + 1] - g0) <= t && Math.abs(data[i + 2] - b0) <= t && Math.abs(data[i + 3] - a0) <= t;
  const mask = new Uint8Array(w * h);
  if (!contiguous) { for (let p = 0, i = 0; p < w * h; p++, i += 4) if (ok(i)) mask[p] = 255; return mask; }
  const stack = [x, y];
  while (stack.length) {
    const sy = stack.pop(); let sx = stack.pop();
    let p = sy * w + sx;
    while (sx >= 0 && !mask[p] && ok(p * 4)) { sx--; p--; }
    sx++; p++;
    let up = false; let down = false;
    while (sx < w && !mask[p] && ok(p * 4)) {
      mask[p] = 255;
      if (sy > 0) { const q = p - w; const m = !mask[q] && ok(q * 4); if (m && !up) { stack.push(sx, sy - 1); up = true; } else if (!m) up = false; }
      if (sy < h - 1) { const q = p + w; const m = !mask[q] && ok(q * 4); if (m && !down) { stack.push(sx, sy + 1); down = true; } else if (!m) down = false; }
      sx++; p++;
    }
  }
  return mask;
}

// ---------------------------------------------------------------- drawing helpers (cached per selection)

const canvasCache = new WeakMap();
/** The selection as an alpha canvas (its box size; draw it at s.x, s.y). */
export function selCanvas(s) {
  let c = canvasCache.get(s);
  if (c) return c;
  c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s.w, s.h);
  for (let i = 0, j = 0; i < s.data.length; i++, j += 4) { img.data[j] = 255; img.data[j + 1] = 255; img.data[j + 2] = 255; img.data[j + 3] = s.data[i]; }
  ctx.putImageData(img, 0, 0);
  canvasCache.set(s, c);
  return c;
}

const outlineCache = new WeakMap();
/** Boundary of the selection (where it crosses 50%) as a Path2D in document pixels — for marching ants. */
export function outline(s) {
  let p = outlineCache.get(s);
  if (p) return p;
  p = new Path2D();
  const { w, h, data } = s;
  const v = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128 ? 1 : 0);
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const e = x < w && v(x, y) !== v(x, y - 1);
      if (e && run < 0) run = x;
      if (!e && run >= 0) { p.moveTo(s.x + run, s.y + y); p.lineTo(s.x + x, s.y + y); run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const e = y < h && v(x, y) !== v(x - 1, y);
      if (e && run < 0) run = y;
      if (!e && run >= 0) { p.moveTo(s.x + x, s.y + run); p.lineTo(s.x + x, s.y + y); run = -1; }
    }
  }
  outlineCache.set(s, p);
  return p;
}

/** Moves a selection by dx, dy (clipped to the document). */
export function translate(s, dx, dy, doc) {
  if (!s) return s;
  const n = { ...s, x: s.x + Math.round(dx), y: s.y + Math.round(dy) };
  const r = intersect(n, docRect(doc));
  if (!r) return null;
  if (r.w === n.w && r.h === n.h) return n;
  const c = make(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) c.data[y * r.w + x] = at(n, x + r.x, y + r.y);
  return trim(c);
}
