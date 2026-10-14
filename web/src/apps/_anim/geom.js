// Geometry for the animation engine: parametric shapes → polylines, trim paths, resampling (shape tweens),
// simplification and hit testing. A "poly" is { pts: [[x, y], …], closed }.

export const TAU = Math.PI * 2;
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Rectangle centred on (cx, cy) with rounded corners. */
export function rectPoly(cx, cy, w, h, r = 0) {
  const hw = Math.abs(w) / 2; const hh = Math.abs(h) / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  if (r < 0.01) return { pts: [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]], closed: true };
  const pts = [];
  const corner = (x, y, a0) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i / 8) * (Math.PI / 2); pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); } };
  // start at the top edge middle-left so trim paths begin at the top-left like After Effects
  corner(cx + hw - r, cy - hh + r, -Math.PI / 2);
  corner(cx + hw - r, cy + hh - r, 0);
  corner(cx - hw + r, cy + hh - r, Math.PI / 2);
  corner(cx - hw + r, cy - hh + r, Math.PI);
  return { pts, closed: true };
}
/** Ellipse centred on (cx, cy); starts at the top and goes clockwise. */
export function ellipsePoly(cx, cy, w, h, n = 96) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * TAU; pts.push([cx + Math.cos(a) * w / 2, cy + Math.sin(a) * h / 2]); }
  return { pts, closed: true };
}
/** Star (inner radius given) or polygon (inner = null). rotation in degrees. */
export function starPoly(cx, cy, points, outer, inner = null, rotation = 0) {
  const n = Math.max(3, Math.round(points));
  const pts = [];
  const rot = (rotation * Math.PI) / 180 - Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push([cx + Math.cos(a) * outer, cy + Math.sin(a) * outer]);
    if (inner !== null && inner !== undefined) { const b = a + Math.PI / n; pts.push([cx + Math.cos(b) * inner, cy + Math.sin(b) * inner]); }
  }
  return { pts, closed: true };
}
/** Bezier pen path: nodes [{ p: [x, y], i: [dx, dy], o: [dx, dy] }] (handles relative to the node). */
export function penPoly(nodes, closed, steps = 16) {
  const pts = [];
  if (!nodes?.length) return { pts, closed };
  const segs = closed ? nodes.length : nodes.length - 1;
  pts.push(nodes[0].p.slice());
  for (let s = 0; s < segs; s++) {
    const a = nodes[s]; const b = nodes[(s + 1) % nodes.length];
    const p0 = a.p; const p1 = [a.p[0] + (a.o?.[0] || 0), a.p[1] + (a.o?.[1] || 0)]; const p2 = [b.p[0] + (b.i?.[0] || 0), b.p[1] + (b.i?.[1] || 0)]; const p3 = b.p;
    const straight = !a.o?.[0] && !a.o?.[1] && !b.i?.[0] && !b.i?.[1];
    const n = straight ? 1 : steps;
    for (let k = 1; k <= n; k++) {
      const t = k / n; const u = 1 - t;
      pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
  }
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  return { pts, closed };
}

export function polyLength(poly) {
  const { pts, closed } = poly;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

/** The sub-polyline between arc lengths a..b (a may be > b for closed paths: wraps around). */
function slice(poly, a, b) {
  const pts = poly.closed ? [...poly.pts, poly.pts[0]] : poly.pts;
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]; const q = pts[i]; const d = dist(p, q);
    const s0 = acc; const s1 = acc + d;
    if (s1 >= a && s0 <= b && d > 0) {
      const t0 = Math.max(0, (a - s0) / d); const t1 = Math.min(1, (b - s0) / d);
      const P0 = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0];
      if (!out.length) out.push(P0);
      out.push([p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1]);
    }
    acc = s1;
    if (acc > b) break;
  }
  return out;
}

/**
 * Trim paths: keeps start..end (percent) of each path, shifted by offset (degrees, 360 = once around).
 * Each sub-path is trimmed on its own ("simultaneously" in After Effects terms).
 */
export function trimPolys(polys, start, end, offset = 0) {
  let s = Math.min(start, end) / 100; let e = Math.max(start, end) / 100;
  if (e - s >= 0.99999) return polys;
  const out = [];
  if (e - s <= 1e-5) return out;
  const off = (((offset / 360) % 1) + 1) % 1;
  s += off; e += off;
  for (const poly of polys) {
    const L = polyLength(poly);
    if (L <= 0) continue;
    // segments may wrap past 1: split into [s,1] + [0,e-1]
    const ranges = e <= 1 ? [[s, e]] : s >= 1 ? [[s - 1, e - 1]] : [[s, 1], [0, e - 1]];
    for (const [a, b] of ranges) {
      const pts = slice(poly, a * L, b * L);
      if (pts.length > 1) out.push({ pts, closed: false });
    }
    // join the wrapped pieces of a closed path so the stroke stays continuous
    if (ranges.length === 2 && poly.closed && out.length >= 2) {
      const b2 = out.pop(); const a2 = out.pop();
      out.push({ pts: [...a2.pts, ...b2.pts.slice(1)], closed: false });
    }
  }
  return out;
}

/** Adds the polys to the current canvas path. */
export function tracePolys(ctx, polys) {
  for (const { pts, closed } of polys) {
    if (pts.length < 2) continue;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (closed) ctx.closePath();
  }
}
/** Smooth trace through points (quadratic curves via midpoints) — for hand-drawn strokes. */
export function traceSmooth(ctx, pts, closed) {
  if (pts.length < 3) { if (pts.length) { ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); } return; }
  const n = pts.length;
  if (closed) {
    const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = m(pts[n - 1], pts[0]);
    ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const p = pts[i]; const q = m(p, pts[(i + 1) % n]); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
    ctx.closePath();
    return;
  }
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n - 1; i++) { const p = pts[i]; const q = pts[i + 1]; ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); }
  ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
}

/** n points evenly spaced along the path (for shape tweens). */
export function resample(pts, n, closed) {
  if (pts.length === 0) return Array.from({ length: n }, () => [0, 0]);
  if (pts.length === 1) return Array.from({ length: n }, () => pts[0].slice());
  const poly = { pts, closed };
  const L = polyLength(poly);
  const ring = closed ? [...pts, pts[0]] : pts;
  const out = [];
  const step = closed ? L / n : L / Math.max(1, n - 1);
  let seg = 1; let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (seg < ring.length - 1 && acc + dist(ring[seg - 1], ring[seg]) < target) { acc += dist(ring[seg - 1], ring[seg]); seg++; }
    const a = ring[seg - 1]; const b = ring[seg]; const d = dist(a, b) || 1;
    const t = Math.max(0, Math.min(1, (target - acc) / d));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Rotates a closed ring so it starts at the point closest to `to[0]` — makes morphs twist less. */
export function alignRing(pts, to) {
  let best = 0; let bd = Infinity;
  for (let s = 0; s < pts.length; s++) {
    let d = 0;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 16))) { const p = pts[(i + s) % pts.length]; const q = to[i]; d += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; }
    if (d < bd) { bd = d; best = s; }
  }
  return pts.map((_, i) => pts[(i + best) % pts.length]);
}
export const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/** Ramer–Douglas–Peucker simplification. */
export function simplify(pts, tol = 1) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0; let mi = -1;
    const A = pts[a]; const B = pts[b]; const L = dist(A, B) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const d = Math.abs((B[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (B[1] - A[1])) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function bbox(ptsList) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const pts of ptsList) for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export function pointInPoly(pt, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
export function distToSeg(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function distToPolyline(p, pts, closed) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(p, pts[i - 1], pts[i]));
  if (closed && pts.length > 2) d = Math.min(d, distToSeg(p, pts[pts.length - 1], pts[0]));
  if (pts.length === 1) d = dist(p, pts[0]);
  return d;
}

// ---------------------------------------------------------------- 2-D affine matrices [a, b, c, d, e, f] (like DOMMatrix)

export const I = () => [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
/** translate(pos) · rotate(rot°) · scale(sx, sy) · translate(-anchor) */
export function trs(pos, rot, sx, sy, anchor = [0, 0]) {
  const r = (rot * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  const a = c * sx; const b = s * sx; const cc = -s * sy; const d = c * sy;
  return [a, b, cc, d, pos[0] - (a * anchor[0] + cc * anchor[1]), pos[1] - (b * anchor[0] + d * anchor[1])];
}
