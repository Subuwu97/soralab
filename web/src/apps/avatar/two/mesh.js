// Meshes for parts: generated from the texture's alpha (outline + inner grid, Delaunay-triangulated, triangles outside
// the shape dropped), re-triangulated after adding or removing vertices, and keyform data carried over when a mesh
// changes (each new vertex takes the movement of the old mesh around it).

/** Alpha of a part texture as a mask (1 = something there), plus its size. From an ImageData or {data,width,height}. */
export function alphaMask(img, threshold = 8) {
  const { data, width: w, height: h } = img;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = data[i * 4 + 3] > threshold ? 1 : 0;
  return { m, w, h };
}

function dilate(m, W, H, r) {
  if (r <= 0) return m;
  const tmp = new Uint8Array(W * H); const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (m[y * W + x]) run = x; tmp[y * W + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) run = x; if (run - x <= r) tmp[y * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let run = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; out[y * W + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) out[y * W + x] = 1; } }
  return out;
}

/** Outline loops of a binary mask (marching squares), in pixel coordinates. */
export function outlines(m, W, H) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? m[y * W + x] : 0);
  const next = new Map(); const pt = new Map();
  const add = (a, b) => { const ka = a[0] * 100003 + a[1]; const kb = b[0] * 100003 + b[1]; next.set(ka, kb); pt.set(ka, a); pt.set(kb, b); };
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const c = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1);
    if (c === 0 || c === 15) continue;
    const T = [2 * x + 1, 2 * y]; const R = [2 * x + 2, 2 * y + 1]; const B = [2 * x + 1, 2 * y + 2]; const L = [2 * x, 2 * y + 1];
    switch (c) {
      case 1: add(L, B); break; case 2: add(B, R); break; case 3: add(L, R); break; case 4: add(R, T); break;
      case 5: add(L, T); add(R, B); break; case 6: add(B, T); break; case 7: add(L, T); break; case 8: add(T, L); break;
      case 9: add(T, B); break; case 10: add(T, R); add(B, L); break; case 11: add(T, R); break; case 12: add(R, L); break;
      case 13: add(R, B); break; case 14: add(B, L); break; default:
    }
  }
  const loops = []; const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let k = start;
    while (k !== undefined && !seen.has(k)) { seen.add(k); const p = pt.get(k); loop.push([p[0] / 2 + 0.5, p[1] / 2 + 0.5]); k = next.get(k); }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

function simplifyDP(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = -1; let bi = -1;
    const [ax, ay] = pts[a]; const [bx, by] = pts[b]; const dx = bx - ax; const dy = by - ay; const L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Douglas–Peucker on a closed loop: split at the point farthest from the start, simplify both halves. */
function simplifyLoop(l, tol) {
  if (l.length < 6) return l;
  let far = 0; let fd = -1;
  for (let i = 1; i < l.length; i++) { const d = (l[i][0] - l[0][0]) ** 2 + (l[i][1] - l[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = simplifyDP(l.slice(0, far + 1), tol); const b = simplifyDP([...l.slice(far), l[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
function resampleLoop(loop, step) {
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]; const b = loop[(i + 1) % loop.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
const area = (l) => { let s = 0; for (let i = 0; i < l.length; i++) { const a = l[i]; const b = l[(i + 1) % l.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

/** Delaunay triangulation (Bowyer–Watson). pts: [[x,y]…] → flat triangle indices. */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 10; const mx = (minX + maxX) / 2; const my = (minY + maxY) / 2;
  const P = pts.map((p) => [p[0], p[1]]); P.push([mx - d, my - d], [mx + d, my - d], [mx, my + d]);
  const circ = (a, b, c) => {
    const [ax, ay] = P[a]; const [bx, by] = P[b]; const [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return { x: 0, y: 0, r: Infinity };
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { x: ux, y: uy, r: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  // insert points in a spatially coherent order (faster in practice)
  const order = [...Array(n).keys()].sort((a, b) => (Math.floor(P[a][1] / 32) - Math.floor(P[b][1] / 32)) || (P[a][0] - P[b][0]));
  for (const i of order) {
    const [x, y] = P[i];
    const bad = []; const keep = [];
    for (const t of tris) ((x - t.c.x) ** 2 + (y - t.c.y) ** 2 < t.c.r - 1e-9 ? bad : keep).push(t);
    const edges = new Map();
    for (const t of bad) for (let e = 0; e < 3; e++) {
      const a = t.v[e]; const b = t.v[(e + 1) % 3]; const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (edges.has(k)) edges.delete(k); else edges.set(k, [a, b]);
    }
    for (const [a, b] of edges.values()) keep.push({ v: [a, b, i], c: circ(a, b, i) });
    tris = keep;
  }
  const out = [];
  for (const t of tris) if (t.v.every((v) => v < n)) out.push(...t.v);
  return out;
}

/**
 * A mesh for a texture: { v: [x,y…] in texture pixels, t: triangles }. density = spacing of inner points in px.
 * The outline sits a few px outside the visible pixels so edges never get cut off.
 */
export function autoMesh(img, { density = 48, margin = 3 } = {}) {
  const { m: m0, w: W0, h: H0 } = alphaMask(img);
  // work on a reduced copy for big textures (outlines don't need every pixel)
  const sc = Math.min(1, 384 / Math.max(W0, H0));
  const W = Math.max(1, Math.round(W0 * sc)); const H = Math.max(1, Math.round(H0 * sc));
  let m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // any opaque pixel in the source block counts
    const x0 = Math.floor(x / sc); const y0 = Math.floor(y / sc); const x1 = Math.min(W0, Math.ceil((x + 1) / sc)); const y1 = Math.min(H0, Math.ceil((y + 1) / sc));
    let v = 0; for (let yy = y0; yy < y1 && !v; yy++) for (let xx = x0; xx < x1; xx++) if (m0[yy * W0 + xx]) { v = 1; break; }
    m[y * W + x] = v;
  }
  if (!m.some((v) => v)) return rectMesh(W0, H0);
  m = dilate(m, W, H, Math.max(1, Math.round(margin * sc) + 1));
  // thin parts (lashes, brows, lips) get a finer mesh so it hugs them
  const step = Math.max(4, Math.min(density, Math.max(8, Math.min(W0, H0) / 3.5)) * sc);
  let loops = outlines(m, W, H).filter((l) => Math.abs(area(l)) > step * step * 0.15);
  loops = loops.map((l) => resampleLoop(simplifyLoop(l, Math.max(0.5, step / 14)), step * 0.7));
  const pts = [];
  for (const l of loops) for (const p of l) pts.push(p);
  // inner points on a staggered grid, not too close to the outline
  const near = (x, y, r) => pts.some((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r);
  const inside = (x, y) => { const xi = Math.floor(x); const yi = Math.floor(y); return xi >= 0 && yi >= 0 && xi < W && yi < H && m[yi * W + xi]; };
  for (let y = step / 2, row = 0; y < H; y += step * 0.87, row++) for (let x = (row % 2 ? step / 2 : 0) + step / 4; x < W; x += step) {
    if (inside(x, y) && !near(x, y, step * 0.55)) pts.push([x, y]);
  }
  const tris = delaunay(pts);
  // drop triangles that bridge across empty space (concave outlines, holes): keep one when its middle is on the
  // shape, or enough of its inside is
  const t = [];
  const W3 = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.45, 0.45, 0.1], [0.1, 0.45, 0.45], [0.45, 0.1, 0.45], [0.7, 0.15, 0.15], [0.15, 0.7, 0.15], [0.15, 0.15, 0.7]];
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]]];
    let n = 0;
    for (const [u, v, w] of W3) if (inside(a[0] * u + b[0] * v + c[0] * w, a[1] * u + b[1] * v + c[1] * w)) n++;
    if (n >= 4 || inside((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)) t.push(tris[i], tris[i + 1], tris[i + 2]);
  }
  // keep only vertices that are used, scaled back to texture pixels (clamped to the texture)
  const used = new Map(); const v = [];
  const idx = (i) => { if (!used.has(i)) { used.set(i, v.length / 2); v.push(Math.max(0, Math.min(W0, pts[i][0] / sc)), Math.max(0, Math.min(H0, pts[i][1] / sc))); } return used.get(i); };
  const tt = t.map(idx);
  if (tt.length < 3) return rectMesh(W0, H0);
  return { v: v.map((x) => Math.round(x * 10) / 10), t: tt };
}
/** The simplest mesh: the texture's rectangle as two triangles (split into a small grid so it can bend). */
export function rectMesh(w, h, cols = 2, rows = 2) {
  const v = []; const t = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) v.push((w * i) / cols, (h * j) / rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const a = j * (cols + 1) + i; t.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1); }
  return { v, t };
}

/** Re-triangulates a part's vertices (after adding/removing), dropping triangles over empty texture. */
export function retriangulate(v, img, ox, oy) {
  const pts = []; for (let i = 0; i < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  const tris = delaunay(pts);
  if (!img) return tris;
  const { m, w, h } = alphaMask(img);
  const mm = dilate(m, w, h, 4);
  const inside = (x, y) => { const xi = Math.floor(x - ox); const yi = Math.floor(y - oy); return xi >= 0 && yi >= 0 && xi < w && yi < h && mm[yi * w + xi]; };
  const out = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]]; const b = pts[tris[i + 1]]; const c = pts[tris[i + 2]];
    if (inside((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)) out.push(tris[i], tris[i + 1], tris[i + 2]);
  }
  return out.length ? out : tris;
}

/** Barycentric weights of point p in triangle (a, b, c), or null if it's outside. */
export function bary(p, a, b, c) {
  const v0x = b[0] - a[0]; const v0y = b[1] - a[1]; const v1x = c[0] - a[0]; const v1y = c[1] - a[1]; const v2x = p[0] - a[0]; const v2y = p[1] - a[1];
  const d = v0x * v1y - v1x * v0y; if (Math.abs(d) < 1e-9) return null;
  const v = (v2x * v1y - v1x * v2y) / d; const w = (v0x * v2y - v2x * v0y) / d; const u = 1 - v - w;
  return u >= -1e-4 && v >= -1e-4 && w >= -1e-4 ? [u, v, w] : null;
}

/**
 * Carries vertex movements from an old mesh to a new one: each new vertex takes the barycentric blend of the old
 * triangle it falls in (or the nearest old vertices'). Returns a function mapping an old [dx,dy,…] to the new mesh.
 */
export function remapper(oldV, oldT, newV) {
  const P = (arr, i) => [arr[i * 2], arr[i * 2 + 1]];
  const plan = [];
  for (let i = 0; i < newV.length / 2; i++) {
    const p = P(newV, i); let found = null;
    for (let k = 0; k < oldT.length && !found; k += 3) {
      const w = bary(p, P(oldV, oldT[k]), P(oldV, oldT[k + 1]), P(oldV, oldT[k + 2]));
      if (w) found = [[oldT[k], w[0]], [oldT[k + 1], w[1]], [oldT[k + 2], w[2]]];
    }
    if (!found) {
      // outside the old mesh: inverse-distance blend of the 3 nearest old vertices
      const d = []; for (let j = 0; j < oldV.length / 2; j++) d.push([j, Math.hypot(oldV[j * 2] - p[0], oldV[j * 2 + 1] - p[1])]);
      d.sort((a, b) => a[1] - b[1]);
      const near = d.slice(0, 3); const ws = near.map(([, x]) => 1 / Math.max(1e-3, x)); const s = ws.reduce((a, b) => a + b, 0);
      found = near.map(([j], k) => [j, ws[k] / s]);
    }
    plan.push(found);
  }
  return (dv) => {
    const out = new Array(newV.length).fill(0);
    plan.forEach((ws, i) => { for (const [j, w] of ws) { out[i * 2] += (dv[j * 2] || 0) * w; out[i * 2 + 1] += (dv[j * 2 + 1] || 0) * w; } });
    return out.map((x) => Math.round(x * 100) / 100);
  };
}
/** A part with a new mesh, its keyform vertex changes carried over. */
export function withMesh(part, mesh) {
  const old = part.mesh;
  if (!old?.v?.length || !part.kf?.some((b) => Object.values(b.forms).some((f) => f.v))) return { ...part, mesh };
  const map = remapper(old.v, old.t, mesh.v);
  return { ...part, mesh, kf: part.kf.map((b) => ({ ...b, forms: Object.fromEntries(Object.entries(b.forms).map(([k, f]) => [k, f.v ? { ...f, v: map(f.v) } : f])) })) };
}
