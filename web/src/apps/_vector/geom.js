// Geometry for the vector engine: 2D affine matrices, cubic béziers, live shapes as paths, bounds and path data.
//
// Matrices are [a, b, c, d, e, f] like SVG: x' = a·x + c·y + e, y' = b·x + d·y + f.
// Paths are lists of subpaths { closed, pts: [{ x, y, ix, iy, ox, oy }] } where (ix, iy) is the handle coming into the
// anchor and (ox, oy) the handle going out, both absolute. A handle equal to its anchor means "no handle" (a corner).

export const I = [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
export const applyVec = (m, x, y) => ({ x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y });
export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx, cx = 0, cy = 0) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
export function rotate(deg, cx = 0, cy = 0) {
  const r = (deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export const isIdentity = (m) => !m || (Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9);
const r6 = (v) => Math.round(v * 1e4) / 1e4;
export const matStr = (m) => `matrix(${m.map(r6).join(' ')})`;

/** Matrix → { x, y, rotation (deg), sx, sy, skew } (sy carries a flip). */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1]);
  const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const det = m[0] * m[3] - m[1] * m[2];
  const sy = det / (sx || 1);
  const skew = sx ? (m[0] * m[2] + m[1] * m[3]) / (sx * sx) : 0;
  return { x: m[4], y: m[5], rotation, sx, sy, skew };
}
export const compose = ({ x = 0, y = 0, rotation = 0, sx = 1, sy = 1 }) => mul(translate(x, y), mul(rotate(rotation), scale(sx, sy)));

// ---------------------------------------------------------------- béziers

export const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
const lerp = (a, b, t) => a + (b - a) * t;
export function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
/** Parameter values in (0,1) where a 1-D cubic has an extremum. */
function extrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3; const b = 2 * (p0 - 2 * p1 + p2); const c = p1 - p0;
  const out = [];
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); }
  else {
    const d = b * b - 4 * a * c;
    if (d >= 0) { const s = Math.sqrt(d); out.push((-b + s) / (2 * a), (-b - s) / (2 * a)); }
  }
  return out.filter((t) => t > 0 && t < 1);
}
/** Each segment of a subpath as [p0, c1, c2, p3] points. */
export function segments(sp) {
  const out = [];
  const n = sp.pts.length;
  for (let i = 0; i < n - 1 + (sp.closed && n > 1 ? 1 : 0); i++) {
    const a = sp.pts[i]; const b = sp.pts[(i + 1) % n];
    out.push([{ x: a.x, y: a.y }, { x: a.ox, y: a.oy }, { x: b.ix, y: b.iy }, { x: b.x, y: b.y }]);
  }
  return out;
}
export function segBounds([p0, p1, p2, p3], acc) {
  const add = (x, y) => { acc.x0 = Math.min(acc.x0, x); acc.y0 = Math.min(acc.y0, y); acc.x1 = Math.max(acc.x1, x); acc.y1 = Math.max(acc.y1, y); };
  add(p0.x, p0.y); add(p3.x, p3.y);
  for (const t of extrema(p0.x, p1.x, p2.x, p3.x)) add(cubicAt(p0.x, p1.x, p2.x, p3.x, t), cubicAt(p0.y, p1.y, p2.y, p3.y, t));
  for (const t of extrema(p0.y, p1.y, p2.y, p3.y)) add(cubicAt(p0.x, p1.x, p2.x, p3.x, t), cubicAt(p0.y, p1.y, p2.y, p3.y, t));
}
/** Splits a segment at t (de Casteljau) → [left, right] each [p0,c1,c2,p3]. */
export function splitSeg([p0, p1, p2, p3], t) {
  const L = (a, b) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
  const a = L(p0, p1); const b = L(p1, p2); const c = L(p2, p3); const d = L(a, b); const e = L(b, c); const f = L(d, e);
  return [[p0, a, d, f], [f, e, c, p3]];
}
/** Nearest point on a segment to (x, y): { t, x, y, dist }. */
export function nearestOnSeg(seg, x, y) {
  let best = { t: 0, dist: Infinity };
  const at = (t) => ({ x: cubicAt(seg[0].x, seg[1].x, seg[2].x, seg[3].x, t), y: cubicAt(seg[0].y, seg[1].y, seg[2].y, seg[3].y, t) });
  for (let i = 0; i <= 60; i++) { const t = i / 60; const p = at(t); const d = Math.hypot(p.x - x, p.y - y); if (d < best.dist) best = { t, ...p, dist: d }; }
  let step = 1 / 60;
  for (let k = 0; k < 12; k++) {
    step /= 2;
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) continue;
      const p = at(t); const d = Math.hypot(p.x - x, p.y - y);
      if (d < best.dist) best = { t, ...p, dist: d };
    }
  }
  return best;
}

// ---------------------------------------------------------------- live shapes → subpaths (local coordinates)

const K = 0.5522847498;
export function rectPath(w, h, r = 0) {
  r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  if (!r) return [{ closed: true, pts: [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)] }];
  const k = r * K;
  const P = (x, y, ix, iy, ox, oy) => ({ x, y, ix, iy, ox, oy });
  return [{ closed: true, pts: [
    P(r, 0, r - k, 0, r, 0), P(w - r, 0, w - r, 0, w - r + k, 0),
    P(w, r, w, r - k, w, r), P(w, h - r, w, h - r, w, h - r + k),
    P(w - r, h, w - r + k, h, w - r, h), P(r, h, r, h, r - k, h),
    P(0, h - r, 0, h - r + k, 0, h - r), P(0, r, 0, r, 0, r - k),
  ] }];
}
export function ellipsePath(w, h) {
  const rx = w / 2; const ry = h / 2; const kx = rx * K; const ky = ry * K;
  const P = (x, y, ix, iy, ox, oy) => ({ x, y, ix, iy, ox, oy });
  return [{ closed: true, pts: [
    P(rx, 0, rx - kx, 0, rx + kx, 0), P(w, ry, w, ry - ky, w, ry + ky),
    P(rx, h, rx + kx, h, rx - kx, h), P(0, ry, 0, ry + ky, 0, ry - ky),
  ] }];
}
export function polygonPath(w, h, sides = 6) {
  const n = Math.max(3, Math.round(sides));
  const pts = [];
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; pts.push(pt(w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a))); }
  return [{ closed: true, pts }];
}
export function starPath(w, h, points = 5, inner = 0.5) {
  const n = Math.max(3, Math.round(points));
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? inner : 1;
    pts.push(pt(w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)));
  }
  return [{ closed: true, pts }];
}

/** Local (untransformed) subpaths of a shape or path node; null for other kinds. */
export function localSubpaths(n) {
  switch (n.type) {
    case 'path': return n.subpaths;
    case 'rect': return rectPath(n.w, n.h, n.r);
    case 'ellipse': return ellipsePath(n.w, n.h);
    case 'polygon': return polygonPath(n.w, n.h, n.sides);
    case 'star': return starPath(n.w, n.h, n.points, n.inner);
    case 'image': return rectPath(n.w, n.h);
    default: return null;
  }
}
export const mapSubpaths = (sps, m) => sps.map((sp) => ({
  closed: sp.closed,
  pts: sp.pts.map((p) => { const a = apply(m, p.x, p.y); const i = apply(m, p.ix, p.iy); const o = apply(m, p.ox, p.oy); return { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y }; }),
}));

const f2 = (v) => String(Math.round(v * 100) / 100);
/** Subpaths → SVG path data. */
export function pathData(sps) {
  let d = '';
  for (const sp of sps) {
    if (!sp.pts.length) continue;
    const p0 = sp.pts[0];
    d += `M${f2(p0.x)} ${f2(p0.y)}`;
    for (const [a, b, c, e] of segments(sp)) {
      const line = Math.abs(b.x - a.x) < 1e-6 && Math.abs(b.y - a.y) < 1e-6 && Math.abs(c.x - e.x) < 1e-6 && Math.abs(c.y - e.y) < 1e-6;
      d += line ? `L${f2(e.x)} ${f2(e.y)}` : `C${f2(b.x)} ${f2(b.y)} ${f2(c.x)} ${f2(c.y)} ${f2(e.x)} ${f2(e.y)}`;
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}
/** Bounding box { x, y, w, h } of subpaths (optionally through a matrix). */
export function subpathBounds(sps, m) {
  const acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const sp of m ? mapSubpaths(sps, m) : sps) {
    if (sp.pts.length === 1) segBounds([sp.pts[0], sp.pts[0], sp.pts[0], sp.pts[0]], acc);
    for (const s of segments(sp)) segBounds(s, acc);
  }
  return acc.x0 === Infinity ? null : { x: acc.x0, y: acc.y0, w: acc.x1 - acc.x0, h: acc.y1 - acc.y0 };
}

// ---------------------------------------------------------------- rectangles

export const rectCorners = (r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
export function pointsBounds(ps) {
  if (!ps.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of ps) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const transformRect = (r, m) => pointsBounds(rectCorners(r).map((p) => apply(m, p.x, p.y)));
export function unionRects(list) {
  const rs = list.filter(Boolean);
  if (!rs.length) return null;
  return pointsBounds(rs.flatMap(rectCorners));
}
export const intersects = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const containsRect = (outer, r) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
export const normRect = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

// ---------------------------------------------------------------- SVG path data parser (for text-on-path, imports)

/** Parses SVG path data into subpaths (handles M L H V C S Q T Z; arcs become line segments approximated by béziers). */
export function parsePathData(d) {
  const toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) || [];
  const sps = []; let cur = null; let x = 0; let y = 0; let sx = 0; let sy = 0; let cmd = ''; let i = 0; let lc = null;
  const num = () => parseFloat(toks[i++]);
  const start = (nx, ny) => { cur = { closed: false, pts: [pt(nx, ny)] }; sps.push(cur); sx = nx; sy = ny; };
  const curve = (c1x, c1y, c2x, c2y, nx, ny) => {
    if (!cur) start(x, y);
    const last = cur.pts[cur.pts.length - 1]; last.ox = c1x; last.oy = c1y;
    cur.pts.push({ x: nx, y: ny, ix: c2x, iy: c2y, ox: nx, oy: ny }); lc = { x: c2x, y: c2y };
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    if (C === 'Z') { if (cur) { cur.closed = true; const f = cur.pts[0]; const l = cur.pts[cur.pts.length - 1]; if (cur.pts.length > 1 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) { f.ix = l.ix; f.iy = l.iy; cur.pts.pop(); } } x = sx; y = sy; cur = null; lc = null; continue; }
    if (C === 'M') { x = ox + num(); y = oy + num(); start(x, y); cmd = rel ? 'l' : 'L'; lc = null; continue; }
    if (C === 'L') { const nx = ox + num(); const ny = oy + num(); if (!cur) start(x, y); cur.pts.push(pt(nx, ny)); x = nx; y = ny; lc = null; continue; }
    if (C === 'H') { const nx = (rel ? x : 0) + num(); if (!cur) start(x, y); cur.pts.push(pt(nx, y)); x = nx; lc = null; continue; }
    if (C === 'V') { const ny = (rel ? y : 0) + num(); if (!cur) start(x, y); cur.pts.push(pt(x, ny)); y = ny; lc = null; continue; }
    if (C === 'C') { const a = ox + num(); const b = oy + num(); const c = ox + num(); const e = oy + num(); const nx = ox + num(); const ny = oy + num(); curve(a, b, c, e, nx, ny); x = nx; y = ny; continue; }
    if (C === 'S') { const a = lc ? 2 * x - lc.x : x; const b = lc ? 2 * y - lc.y : y; const c = ox + num(); const e = oy + num(); const nx = ox + num(); const ny = oy + num(); curve(a, b, c, e, nx, ny); x = nx; y = ny; continue; }
    if (C === 'Q' || C === 'T') {
      let qx; let qy;
      if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else { qx = lc?.q ? 2 * x - lc.qx : x; qy = lc?.q ? 2 * y - lc.qy : y; }
      const nx = ox + num(); const ny = oy + num();
      curve(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
      lc = { q: true, qx, qy }; x = nx; y = ny; continue;
    }
    if (C === 'A') { // rough: straight segment to the end point (imports use paper.js, which handles arcs properly)
      num(); num(); num(); num(); num(); const nx = ox + num(); const ny = oy + num(); if (!cur) start(x, y); cur.pts.push(pt(nx, ny)); x = nx; y = ny; lc = null; continue;
    }
    i++; // unknown token
  }
  return sps;
}

/** Points along subpaths sampled into a polyline with cumulative lengths (text on a path). */
export function samplePath(sps, step = 2) {
  const out = []; let len = 0; let prev = null;
  for (const sp of sps) {
    for (const s of segments(sp)) {
      const n = Math.max(4, Math.ceil(Math.hypot(s[3].x - s[0].x, s[3].y - s[0].y) / step) * 2);
      for (let i = 0; i <= n; i++) {
        const t = i / n; const p = { x: cubicAt(s[0].x, s[1].x, s[2].x, s[3].x, t), y: cubicAt(s[0].y, s[1].y, s[2].y, s[3].y, t) };
        if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y);
        out.push({ ...p, len }); prev = p;
      }
    }
    break; // text follows the first subpath only
  }
  return out;
}
export function pointAtLength(samples, l) {
  if (!samples.length) return { x: 0, y: 0, angle: 0 };
  let i = samples.findIndex((s) => s.len >= l);
  if (i < 0) i = samples.length - 1; if (i === 0) i = 1;
  const a = samples[i - 1]; const b = samples[i] || a;
  const t = b.len > a.len ? (l - a.len) / (b.len - a.len) : 0;
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}
