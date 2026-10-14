// Paint bucket and eraser for Sora ANI's vector drawings.
//   bucketFill: fills the enclosed area under a point — the layer's strokes are rasterised, flood-filled (small gaps
//               closed), and the region's outline traced back into a vector shape (holes included).
//   erase:      cuts strokes where the eraser passed, and subtracts the eraser's swath from filled shapes (paper.js).
import paper from 'paper';
import { drawTimeline, elMatrix } from '../_anim/stage.js';
import { simplify, apply, invert, resample, polyLength, dist } from '../_anim/geom.js';
import { shapeFrom, uid } from './model.js';

// ---------------------------------------------------------------- bucket

/** Rasterises a layer at frame f and returns the traced area around `pt` (stage coords), or null if it isn't closed. */
export function traceRegion(doc, layer, f, pt, { gap = 2, maxSide = 1600, origin = [0, 0] } = {}) {
  // origin: where the timeline's (0,0) sits on the stage (symbols are edited around the stage centre)
  const s = Math.min(1, maxSide / Math.max(doc.width, doc.height));
  const W = Math.ceil(doc.width * s) + 2; const H = Math.ceil(doc.height * s) + 2;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(s, 0, 0, s, 1 + origin[0] * s, 1 + origin[1] * s);
  drawTimeline(ctx, doc, { layers: [{ ...layer, visible: true, outline: false }] }, f, { doc });
  const data = ctx.getImageData(0, 0, W, H).data;
  let wall = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) wall[i] = data[i * 4 + 3] > 60 ? 1 : 0;
  if (gap > 0) wall = dilate(wall, W, H, Math.round(gap));
  const sx = Math.round((pt[0] + origin[0]) * s) + 1; const sy = Math.round((pt[1] + origin[1]) * s) + 1;
  if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1 || wall[sy * W + sx]) return null;
  // flood fill (scanline stack)
  const region = new Uint8Array(W * H);
  const stack = [sx, sy];
  let leaked = false;
  while (stack.length) {
    const y = stack.pop(); let x = stack.pop();
    while (x >= 0 && !wall[y * W + x] && !region[y * W + x]) x--;
    x++;
    let up = false; let down = false;
    while (x < W && !wall[y * W + x] && !region[y * W + x]) {
      region[y * W + x] = 1;
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) leaked = true;
      if (y > 0) { const o = !wall[(y - 1) * W + x] && !region[(y - 1) * W + x]; if (o && !up) { stack.push(x, y - 1); up = true; } else if (!o) up = false; }
      if (y < H - 1) { const o = !wall[(y + 1) * W + x] && !region[(y + 1) * W + x]; if (o && !down) { stack.push(x, y + 1); down = true; } else if (!o) down = false; }
      x++;
    }
    if (leaked) return null;
  }
  // grow under the strokes so no hairline shows between fill and line
  const grown = dilate(region, W, H, Math.round(gap) + 1);
  const loops = marchingSquares(grown, W, H).map((loop) => simplify(loop, 0.6).map(([x, y]) => [(x - 1) / s - origin[0], (y - 1) / s - origin[1]])).filter((l) => l.length >= 3);
  return loops.length ? loops : null;
}

function dilate(m, W, H, r) {
  if (r <= 0) return m;
  // separable max filter (square), fast enough for a few px
  const tmp = new Uint8Array(W * H); const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0; for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < W && m[y * W + xx]) v = 1; }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0; for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) v = 1; }
    out[y * W + x] = v;
  }
  return out;
}

/** Outline loops of a binary mask (outer edges and holes), as polygons in pixel coordinates. */
function marchingSquares(m, W, H) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? m[y * W + x] : 0);
  const next = new Map(); // "x,y" (edge midpoint ×2) → next point key
  const pt = new Map();
  const add = (a, b) => { const ka = `${a[0]},${a[1]}`; const kb = `${b[0]},${b[1]}`; next.set(ka, kb); pt.set(ka, a); pt.set(kb, b); };
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const tl = at(x, y); const tr = at(x + 1, y); const br = at(x + 1, y + 1); const bl = at(x, y + 1);
    const c = tl * 8 + tr * 4 + br * 2 + bl;
    if (c === 0 || c === 15) continue;
    // edge midpoints in doubled coordinates (integers): top, right, bottom, left
    const T = [2 * x + 1, 2 * y]; const R = [2 * x + 2, 2 * y + 1]; const B = [2 * x + 1, 2 * y + 2]; const L = [2 * x, 2 * y + 1];
    // segments oriented with the inside on the left
    switch (c) {
      case 1: add(L, B); break; case 2: add(B, R); break; case 3: add(L, R); break; case 4: add(R, T); break;
      case 5: add(L, T); add(R, B); break; case 6: add(B, T); break; case 7: add(L, T); break; case 8: add(T, L); break;
      case 9: add(T, B); break; case 10: add(T, R); add(B, L); break; case 11: add(T, R); break; case 12: add(R, L); break;
      case 13: add(R, B); break; case 14: add(B, L); break;
      default:
    }
  }
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let k = start;
    while (k && !seen.has(k)) { seen.add(k); const p = pt.get(k); loop.push([p[0] / 2, p[1] / 2]); k = next.get(k); }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

export function bucketShape(doc, layer, f, pt, color, gap, origin) {
  const loops = traceRegion(doc, layer, f, pt, { gap, origin });
  if (!loops) return null;
  return shapeFrom(loops.map((l) => ({ pts: l, closed: true })), { fill: color, stroke: null, sw: 0, smooth: false });
}

// ---------------------------------------------------------------- eraser

let scope = null;
function ps() {
  if (!scope) { scope = new paper.PaperScope(); scope.setup(new scope.Size(1, 1)); scope.settings.insertItems = false; }
  scope.activate();
  return scope;
}

/** Erases along stage-space points with radius r from the shape elements in els. Returns the new element list. */
export function erase(els, points, r) {
  if (!points.length) return els;
  const out = [];
  for (const e of els) {
    if (e.type !== 'shape') { out.push(e); continue; }
    const inv = invert(elMatrix(e)); const sc = Math.hypot(inv[0], inv[1]);
    const lp = points.map((p) => apply(inv, p)); const lr = r * sc;
    // quick reject: nothing near
    const near = (p, extra = 0) => lp.some((q) => dist(p, q) <= lr + extra);
    if (!e.subs.some((s) => s.pts.some((p) => near(p, (e.sw || 0) / 2 + lr * 2)))) { out.push(e); continue; }
    const subs = [];
    for (const s of e.subs) {
      if (s.closed && e.fill) { subs.push(...subtractFill(s, lp, lr)); continue; }
      // a stroke: densify, then keep the runs of points the eraser didn't touch
      const n = Math.max(2, Math.ceil(polyLength(s) / Math.max(1, lr / 3)));
      const pts = s.pts.length > 1 ? resample(s.pts, n, s.closed) : s.pts;
      let run = [];
      const flush = () => { if (run.length > 1) subs.push({ pts: simplify(run, 0.3), closed: false }); run = []; };
      for (const p of pts) { if (near(p, (e.sw || 0) / 2)) flush(); else run.push(p); }
      if (s.closed && run.length && subs.length && !near(pts[0], (e.sw || 0) / 2)) {
        // the closing segment joins the last run with the first
        const first = subs.shift(); run = [...run, ...first.pts];
      } else if (s.closed && run.length === pts.length) { subs.push({ pts: s.pts, closed: true }); run = []; }
      flush();
    }
    if (subs.length) out.push({ ...e, subs });
  }
  return out;
}

function subtractFill(sub, lp, lr) {
  const P = ps();
  let shape = new P.Path({ insert: false, closed: true, segments: sub.pts.map((p) => new P.Point(p[0], p[1])) });
  // eraser swath: circles along the drag, densified so there are no gaps between dabs
  const dabs = [];
  for (let i = 0; i < lp.length; i++) {
    dabs.push(lp[i]);
    if (i) { const a = lp[i - 1]; const b = lp[i]; const d = dist(a, b); const steps = Math.floor(d / Math.max(1, lr / 2)); for (let k = 1; k < steps; k++) dabs.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]); }
  }
  let swath = null;
  for (const d of dabs) {
    const c = new P.Path.Circle({ center: new P.Point(d[0], d[1]), radius: lr, insert: false });
    swath = swath ? swath.unite(c, { insert: false }) : c;
  }
  if (!swath) return [sub];
  shape = shape.subtract(swath, { insert: false });
  const paths = shape.className === 'CompoundPath' ? shape.children : [shape];
  return paths.filter((p) => p.segments?.length > 2).map((p) => {
    const q = p.clone({ insert: false }); q.flatten(0.75);
    return { pts: q.segments.map((s) => [+s.point.x.toFixed(2), +s.point.y.toFixed(2)]), closed: true };
  });
}

/** Colour of the topmost pixel at pt in a rendered stage canvas (for the eyedropper on bitmaps). */
export function pixelAt(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
export { uid };
