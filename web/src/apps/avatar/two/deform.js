// Evaluating the 2D rig at a set of parameter values: keyforms → deformers → deformed mesh vertices, opacity and
// draw order for every part. Pure functions over the document; the renderer and the editor both use them.
//
// Deformers work like functions on canvas points, applied innermost first: a part's vertices go through its parent
// deformer, then that one's parent, and so on. A warp deformer maps a point by where it sits in the rest grid
// (bilinear within a cell, extended linearly outside the grid); a rotation deformer turns points about its pivot.
import { formsAt, warpRest, chainOf } from './model.js';

/** Deformed state of every deformer: Map id → { type, pts (warp), rest (warp), pivot, angle, scale, dx, dy, opacity }. */
export function evalDeformers(doc, values) {
  const out = new Map();
  for (const d of doc.deformers) {
    const forms = (d.kf || []).flatMap((b) => formsAt(doc, b, values));
    let opacity = d.opacity ?? 1; let a = 0; let dx = 0; let dy = 0; let s = 0;
    for (const [f, w] of forms) { if (f.o) opacity += f.o * w; if (f.a) a += f.a * w; if (f.x) dx += f.x * w; if (f.y) dy += f.y * w; if (f.s) s += f.s * w; }
    const st = { id: d.id, type: d.type, parent: d.parent, opacity: Math.max(0, Math.min(1, opacity)) };
    if (d.type === 'warp') {
      const rest = warpRest(d); const pts = Float32Array.from(rest);
      for (const [f, w] of forms) if (f.v) { const n = Math.min(f.v.length, pts.length); for (let i = 0; i < n; i++) pts[i] += f.v[i] * w; }
      // whole-grid moves (x/y) apply to warps too
      if (dx || dy) for (let i = 0; i < pts.length; i += 2) { pts[i] += dx; pts[i + 1] += dy; }
      Object.assign(st, { rest, pts, rect: d.rect, cols: d.cols, rows: d.rows });
    } else {
      const ang = ((d.angle || 0) + a) * (Math.PI / 180);
      Object.assign(st, { pivot: d.pivot, angle: ang, cos: Math.cos(ang), sin: Math.sin(ang), scale: 1 + s, dx, dy });
    }
    out.set(d.id, st);
  }
  return out;
}

/** Maps one point through one deformer (not its parents). Writes into o[k], o[k+1]. */
export function mapPoint(st, x, y, o, k) {
  if (st.type === 'warp') {
    const [rx, ry, rw, rh] = st.rect;
    const u = rw ? ((x - rx) / rw) * st.cols : 0; const v = rh ? ((y - ry) / rh) * st.rows : 0;
    const i = Math.max(0, Math.min(st.cols - 1, Math.floor(u))); const j = Math.max(0, Math.min(st.rows - 1, Math.floor(v)));
    const fu = u - i; const fv = v - j; // outside the grid these go past 0..1, extending the edge cells
    const W = st.cols + 1; const p = st.pts;
    const a = (j * W + i) * 2; const b = a + 2; const c = a + W * 2; const d = c + 2;
    const top0 = p[a] + (p[b] - p[a]) * fu; const top1 = p[a + 1] + (p[b + 1] - p[a + 1]) * fu;
    const bot0 = p[c] + (p[d] - p[c]) * fu; const bot1 = p[c + 1] + (p[d + 1] - p[c + 1]) * fu;
    o[k] = top0 + (bot0 - top0) * fv; o[k + 1] = top1 + (bot1 - top1) * fv;
  } else {
    const px = st.pivot[0]; const py = st.pivot[1];
    const lx = (x - px) * st.scale; const ly = (y - py) * st.scale;
    o[k] = px + st.dx + lx * st.cos - ly * st.sin; o[k + 1] = py + st.dy + lx * st.sin + ly * st.cos;
  }
}

/** Maps a point through a deformer and all its ancestors. */
export function mapThrough(states, parentId, x, y) {
  const o = [x, y]; let id = parentId; let guard = 0;
  while (id && guard++ < 64) { const st = states.get(id); if (!st) break; mapPoint(st, o[0], o[1], o, 0); id = st.parent; }
  return o;
}

/**
 * The whole rig at these values: { deformers: Map, parts: Map id → { verts: Float32Array, opacity, z } , order: [part ids back→front] }.
 * `prev` (the last result) lets us reuse vertex buffers between frames.
 */
export function evaluate(doc, values, prev) {
  const states = evalDeformers(doc, values);
  const parts = new Map();
  doc.parts.forEach((p, idx) => {
    const n = p.mesh?.v?.length || 0;
    const old = prev?.parts.get(p.id);
    const verts = old && old.verts.length === n ? old.verts : new Float32Array(n);
    const rest = p.mesh?.v || [];
    for (let i = 0; i < n; i++) verts[i] = rest[i];
    let opacity = p.opacity ?? 1; let z = 0;
    for (const b of p.kf || []) for (const [f, w] of formsAt(doc, b, values)) {
      if (f.v) { const m = Math.min(n, f.v.length); for (let i = 0; i < m; i++) verts[i] += f.v[i] * w; }
      if (f.o) opacity += f.o * w;
      if (f.z) z += f.z * w;
    }
    // through the deformer chain, innermost first; opacity multiplies down the chain
    let id = p.parent; let guard = 0;
    while (id && guard++ < 64) {
      const st = states.get(id); if (!st) break;
      for (let i = 0; i < n; i += 2) mapPoint(st, verts[i], verts[i + 1], verts, i);
      opacity *= st.opacity; id = st.parent;
    }
    parts.set(p.id, { verts, opacity: Math.max(0, Math.min(1, opacity)), z: idx + z, visible: p.visible !== false });
  });
  const order = doc.parts.map((p) => p.id).sort((a, b) => parts.get(a).z - parts.get(b).z);
  return { deformers: states, parts, order };
}

/**
 * The 2×2 Jacobian of a deformer chain at a point (how a small move before the chain shows up after it), by finite
 * differences. The editor uses its inverse to turn a mouse drag on screen into a change in rest space.
 */
export function jacobian(states, parentId, x, y, eps = 0.5) {
  const a = mapThrough(states, parentId, x, y);
  const bx = mapThrough(states, parentId, x + eps, y); const by = mapThrough(states, parentId, x, y + eps);
  return [(bx[0] - a[0]) / eps, (by[0] - a[0]) / eps, (bx[1] - a[1]) / eps, (by[1] - a[1]) / eps];
}
export function invMap(J, dx, dy) {
  const det = J[0] * J[3] - J[1] * J[2];
  if (Math.abs(det) < 1e-6) return [dx, dy];
  return [(J[3] * dx - J[1] * dy) / det, (-J[2] * dx + J[0] * dy) / det];
}

/** Deformed grid points of a warp deformer (in final canvas space, through its parents) for drawing handles. */
export function warpScreenPts(states, d) {
  const st = states.get(d.id); if (!st) return [];
  const out = [];
  for (let i = 0; i < st.pts.length; i += 2) out.push(mapThrough(states, d.parent, st.pts[i], st.pts[i + 1]));
  return out;
}
/** A rotation deformer's pivot and a handle point along its angle, in final canvas space. */
export function rotationHandles(states, d, len = 120) {
  const st = states.get(d.id); if (!st) return null;
  const p = mapThrough(states, d.parent, st.pivot[0] + st.dx, st.pivot[1] + st.dy);
  const q = mapThrough(states, d.parent, st.pivot[0] + st.dx + Math.sin(st.angle) * len, st.pivot[1] + st.dy - Math.cos(st.angle) * len);
  return { pivot: p, handle: q };
}
export { chainOf };
