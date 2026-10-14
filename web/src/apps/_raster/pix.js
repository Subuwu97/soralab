// Pixel storage for bitmap layers and masks.
//
// A Pix is an immutable grid of 256×256 tiles (ImageBitmaps). Editing never changes a Pix: a stroke paints into a
// "materialised" full canvas, and committing makes a new Pix that shares every untouched tile with the old one.
// That keeps undo cheap (each history step only holds the tiles it changed) even for 4000×4000 documents.
//
//   const pix = Pix.fromCanvas(canvas, x, y)    tiles cut from a canvas placed at x,y (layer-local coordinates)
//   pix.bounds                                   { x, y, w, h } of the tiles in use, or null when empty
//   drawPix(ctx, pix, dx, dy, clip)              draw it (pix-local 0,0 lands at dx,dy) limited to clip (target coords)
//   const m = materialize(pix, rect)             a mutable canvas covering rect (+ the tiles) — paint into m.canvas
//   const next = commit(pix, dirtyRect)          new Pix from the materialised canvas (dirty tiles re-cut)
export const T = 256;
let nextId = 1;

export class Pix {
  constructor(tiles = new Map(), base = null, delta = null) {
    this.id = nextId++;
    this.tiles = tiles; // "tx,ty" → ImageBitmap
    this.base = base; // the Pix this one was made from (for cheap redraw on undo/redo)
    this.delta = delta; // the rect that differs from base
    this.asset = null; // saved PNG asset id (set after upload)
    this.mat = null; // materialised canvas { canvas, ctx, x, y, w, h } while being edited
    this._bounds = undefined;
  }
  get bounds() {
    if (this._bounds !== undefined) return this._bounds;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const k of this.tiles.keys()) {
      const [tx, ty] = k.split(',').map(Number);
      x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
    }
    this._bounds = x0 === Infinity ? null : { x: x0 * T, y: y0 * T, w: (x1 - x0 + 1) * T, h: (y1 - y0 + 1) * T };
    return this._bounds;
  }
  get empty() { return this.tiles.size === 0; }

  static fromCanvas(src, x = 0, y = 0, { checkEmpty = true } = {}) {
    const w = src.width; const h = src.height;
    const tiles = new Map();
    const data = checkEmpty ? readAll(src) : null;
    const tx0 = Math.floor(x / T); const ty0 = Math.floor(y / T);
    const tx1 = Math.floor((x + w - 1) / T); const ty1 = Math.floor((y + h - 1) / T);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const sx = tx * T - x; const sy = ty * T - y;
        if (data && regionEmpty(data, w, h, sx, sy, T, T)) continue;
        tiles.set(`${tx},${ty}`, cutTile(src, sx, sy));
      }
    }
    return new Pix(tiles);
  }
  static empty() { return new Pix(); }
}

const readAll = (c) => {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, c.width, c.height).data;
};
function regionEmpty(data, w, h, sx, sy, rw, rh) {
  const x0 = Math.max(0, sx); const y0 = Math.max(0, sy);
  const x1 = Math.min(w, sx + rw); const y1 = Math.min(h, sy + rh);
  for (let y = y0; y < y1; y++) {
    let i = (y * w + x0) * 4 + 3;
    for (let x = x0; x < x1; x++, i += 4) if (data[i]) return false;
  }
  return true;
}

let scratch = null;
function cutTile(src, sx, sy) {
  scratch ||= new OffscreenCanvas(T, T);
  const c = scratch.getContext('2d');
  c.clearRect(0, 0, T, T);
  c.drawImage(src, -sx, -sy);
  return scratch.transferToImageBitmap();
}

/** Draws a Pix onto ctx so that pix-local (0,0) is at (dx,dy); clip (target coords) limits the tiles drawn. */
export function drawPix(ctx, pix, dx, dy, clip) {
  if (!pix) return;
  if (pix.mat) {
    const m = pix.mat;
    if (!clip) { ctx.drawImage(m.canvas, dx + m.x, dy + m.y); return; }
    // copy just the clip region out of the big canvas
    const sx = Math.max(0, clip.x - dx - m.x); const sy = Math.max(0, clip.y - dy - m.y);
    const ex = Math.min(m.w, clip.x + clip.w - dx - m.x); const ey = Math.min(m.h, clip.y + clip.h - dy - m.y);
    if (ex > sx && ey > sy) ctx.drawImage(m.canvas, sx, sy, ex - sx, ey - sy, dx + m.x + sx, dy + m.y + sy, ex - sx, ey - sy);
    // tiles outside the materialised area (layer moved far away) — rare, fall through to tiles for them
    if (covers(m, clip && { x: clip.x - dx, y: clip.y - dy, w: clip.w, h: clip.h })) return;
    for (const [k, bmp] of pix.tiles) {
      const [tx, ty] = k.split(',').map(Number);
      const r = { x: tx * T, y: ty * T, w: T, h: T };
      if (covers(m, r)) continue;
      if (clip && !hit(r.x + dx, r.y + dy, T, T, clip)) continue;
      ctx.drawImage(bmp, r.x + dx, r.y + dy);
    }
    return;
  }
  for (const [k, bmp] of pix.tiles) {
    const i = k.indexOf(',');
    const x = +k.slice(0, i) * T + dx; const y = +k.slice(i + 1) * T + dy;
    if (clip && !hit(x, y, T, T, clip)) continue;
    ctx.drawImage(bmp, x, y);
  }
}
const hit = (x, y, w, h, r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;
const covers = (m, r) => !r || (r.x >= m.x && r.y >= m.y && r.x + r.w <= m.x + m.w && r.y + r.h <= m.y + m.h);

// ---------------------------------------------------------------- materialised canvases (a few at a time)

const MATS = [];
const MAX_MATS = 4;
const alignDown = (v) => Math.floor(v / T) * T;
const alignUp = (v) => Math.ceil(v / T) * T;

/**
 * A full, mutable canvas for a Pix covering `need` (pix-local rect) and all its tiles.
 * The canvas is shared with the Pix until committed — treat it as "the current pixels".
 */
export function materialize(pix, need) {
  const b = pix.bounds;
  if (pix.mat && covers(pix.mat, need)) { touch(pix.mat); return pix.mat; }
  let x0 = need ? need.x : 0; let y0 = need ? need.y : 0; let x1 = need ? need.x + need.w : 0; let y1 = need ? need.y + need.h : 0;
  if (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (pix.mat) { const m = pix.mat; x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x + m.w); y1 = Math.max(y1, m.y + m.h); }
  x0 = alignDown(x0); y0 = alignDown(y0); x1 = Math.max(x0 + T, alignUp(x1)); y1 = Math.max(y0 + T, alignUp(y1));
  const canvas = document.createElement('canvas');
  canvas.width = x1 - x0; canvas.height = y1 - y0;
  const ctx = canvas.getContext('2d');
  if (pix.mat) { ctx.drawImage(pix.mat.canvas, pix.mat.x - x0, pix.mat.y - y0); release(pix.mat); }
  else for (const [k, bmp] of pix.tiles) { const [tx, ty] = k.split(',').map(Number); ctx.drawImage(bmp, tx * T - x0, ty * T - y0); }
  const m = { canvas, ctx, x: x0, y: y0, w: x1 - x0, h: y1 - y0, pix };
  pix.mat = m;
  MATS.push(m);
  while (MATS.length > MAX_MATS) { const old = MATS.shift(); if (old.pix.mat === old) old.pix.mat = null; }
  return m;
}
function touch(m) { const i = MATS.indexOf(m); if (i >= 0) { MATS.splice(i, 1); MATS.push(m); } }
function release(m) { const i = MATS.indexOf(m); if (i >= 0) MATS.splice(i, 1); if (m.pix.mat === m) m.pix.mat = null; }

/** Throws away unsaved changes in the materialised canvas (redraws `rect` from the tiles). */
export function restore(pix, rect) {
  const m = pix.mat;
  if (!m) return;
  const r = rect ? intersect(rect, m) : m;
  if (!r) return;
  m.ctx.save();
  m.ctx.beginPath(); m.ctx.rect(r.x - m.x, r.y - m.y, r.w, r.h); m.ctx.clip();
  m.ctx.clearRect(r.x - m.x, r.y - m.y, r.w, r.h);
  for (const [k, bmp] of pix.tiles) {
    const [tx, ty] = k.split(',').map(Number);
    if (hit(tx * T, ty * T, T, T, r)) m.ctx.drawImage(bmp, tx * T - m.x, ty * T - m.y);
  }
  m.ctx.restore();
}

/** Makes the next Pix from the materialised canvas: tiles touching `dirty` (pix-local) are re-cut, the rest shared. */
export function commit(pix, dirty) {
  const m = pix.mat;
  if (!m || !dirty) return pix;
  const r = intersect(dirty, m);
  const tiles = new Map(pix.tiles);
  if (r) {
    const tx0 = Math.floor(r.x / T); const ty0 = Math.floor(r.y / T);
    const tx1 = Math.floor((r.x + r.w - 1) / T); const ty1 = Math.floor((r.y + r.h - 1) / T);
    // one read-back for the whole dirty area, to drop tiles that became empty
    const ax = tx0 * T - m.x; const ay = ty0 * T - m.y; const aw = (tx1 - tx0 + 1) * T; const ah = (ty1 - ty0 + 1) * T;
    const data = m.ctx.getImageData(ax, ay, aw, ah).data;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        if (regionEmpty(data, aw, ah, (tx - tx0) * T, (ty - ty0) * T, T, T)) tiles.delete(key);
        else tiles.set(key, cutTile(m.canvas, tx * T - m.x, ty * T - m.y));
      }
    }
  }
  const next = new Pix(tiles, pix, r || dirty);
  // the canvas now shows `next`, so it moves over
  next.mat = m; m.pix = next; pix.mat = null;
  touch(m);
  return next;
}

/** Copies a rect (pix-local) into a new canvas. */
export function pixToCanvas(pix, rect = pix.bounds) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, rect?.w || 1); c.height = Math.max(1, rect?.h || 1);
  if (rect) drawPix(c.getContext('2d'), pix, -rect.x, -rect.y, { x: 0, y: 0, w: rect.w, h: rect.h });
  return c;
}

export function intersect(a, b) {
  const x = Math.max(a.x, b.x); const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w); const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}
export function union(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export const roundRect = (r) => { if (!r) return r; const x = Math.floor(r.x); const y = Math.floor(r.y); return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y }; };
export const offsetRect = (r, dx, dy) => r && { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
export const padRect = (r, p) => r && { x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 };

/** A plain canvas (or reuse `c` if the size matches). */
export function makeCanvas(w, h, c) {
  if (c && c.width === w && c.height === h) return c;
  const n = document.createElement('canvas');
  n.width = Math.max(1, Math.round(w)); n.height = Math.max(1, Math.round(h));
  return n;
}

/** The exact area with visible pixels (pix-local), or null. Tiles are 256-aligned, this is tight. */
export function contentBounds(pix) {
  const b = pix.bounds;
  if (!b) return null;
  const c = pixToCanvas(pix, b);
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, b.w, b.h).data;
  let x0 = b.w; let y0 = b.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < b.h; y++) {
    let i = y * b.w * 4 + 3;
    for (let x = 0; x < b.w; x++, i += 4) if (d[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? null : { x: b.x + x0, y: b.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
