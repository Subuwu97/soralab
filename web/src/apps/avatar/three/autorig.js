// Auto-rig for unrigged meshes: joint markers → humanoid skeleton → skin weights, plus the weight paint brush.
//
// How the weights are made (robust rather than perfect):
//   1. Weld the meshes' vertices by position so UV seams and separate parts that touch share neighbours.
//   2. For each vertex, find the nearest bone segments it can "see" — the straight line to the bone mustn't cross
//      another part of the surface (checked on a voxel grid). That's what stops an A-posed hand claiming the hip.
//   3. Start from inverse-distance weights over the visible bones, then run a few dozen Gauss–Seidel sweeps of the
//      bone-heat equation (Baran & Popović 2007): (−Δ + H) w = H p, with an edge-length weighted graph Laplacian
//      instead of the cotangent one, and H = κ / d² to the nearest visible bone. Few sweeps = local smoothing near
//      joints, which is what matters for bending; it's an approximation of true heat diffusion, not a full solve.
//   4. Keep the 4 strongest influences and normalise.
// Where it's approximate: voxel visibility at ~1% of the height (very thin parts can leak), fingers aren't rigged
// (the hand is one bone), and the heat solve isn't run to convergence on big meshes.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _ab = new THREE.Vector3();

/** Distance from p to segment a–b. */
export function segDist(p, a, b) {
  _ab.subVectors(b, a);
  const l2 = _ab.lengthSq();
  const t = l2 ? Math.max(0, Math.min(1, _a.subVectors(p, a).dot(_ab) / l2)) : 0;
  return _v.copy(a).addScaledVector(_ab, t).distanceTo(p);
}
const closestOnSeg = (p, a, b, out) => {
  _ab.subVectors(b, a);
  const l2 = _ab.lengthSq();
  const t = l2 ? Math.max(0, Math.min(1, _a.subVectors(p, a).dot(_ab) / l2)) : 0;
  return out.copy(a).addScaledVector(_ab, t);
};

/**
 * Inverse-distance skin weights to bone segments. pos: flat xyz array; segs: [{ a, b, bone }].
 * opts.allow(vertexIndex, segIndex) can veto a segment (visibility). Returns { skinIndex, skinWeight } (4 per vertex).
 */
export function segmentWeights(pos, segs, { power = 4, allow } = {}) {
  const n = pos.length / 3;
  const skinIndex = new Uint16Array(n * 4); const skinWeight = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const d = new Float32Array(segs.length);
  for (let i = 0; i < n; i++) {
    p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    let dmin = Infinity;
    for (let j = 0; j < segs.length; j++) {
      d[j] = allow && !allow(i, j) ? Infinity : segDist(p, segs[j].a, segs[j].b);
      if (d[j] < dmin) dmin = d[j];
    }
    if (!Number.isFinite(dmin)) for (let j = 0; j < segs.length; j++) { d[j] = segDist(p, segs[j].a, segs[j].b); dmin = Math.min(dmin, d[j]); }
    const best = [];
    for (let j = 0; j < segs.length; j++) {
      const w = Math.pow((dmin + 1e-4) / (d[j] + 1e-4), power);
      if (w > 0.02) best.push([segs[j].bone, w]);
    }
    writeTop4(best, skinIndex, skinWeight, i);
  }
  return { skinIndex, skinWeight };
}

// Merge duplicate bone entries, keep the 4 largest, normalise.
function writeTop4(list, skinIndex, skinWeight, i) {
  const m = new Map();
  for (const [b, w] of list) m.set(b, (m.get(b) || 0) + w);
  const top = [...m].sort((x, y) => y[1] - x[1]).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  for (let k = 0; k < 4; k++) { skinIndex[i * 4 + k] = top[k]?.[0] ?? 0; skinWeight[i * 4 + k] = top[k] ? top[k][1] / sum : 0; }
}

// ---------------------------------------------------------------- markers

export const MARKERS = [
  ['chin', 'Chin'], ['leftShoulder', 'Left shoulder'], ['rightShoulder', 'Right shoulder'], ['leftElbow', 'Left elbow'], ['rightElbow', 'Right elbow'],
  ['leftWrist', 'Left wrist'], ['rightWrist', 'Right wrist'], ['leftHip', 'Left hip'], ['rightHip', 'Right hip'],
  ['leftKnee', 'Left knee'], ['rightKnee', 'Right knee'], ['leftAnkle', 'Left ankle'], ['rightAnkle', 'Right ankle'],
];
export const mirrorKey = (k) => (k.startsWith('left') ? k.replace('left', 'right') : k.startsWith('right') ? k.replace('right', 'left') : null);

/** World-space vertex positions of every (non-skinned) mesh under root. Returns [{ mesh, pos: Float32Array }]. */
export function worldVertices(root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.slExtra) return;
    const a = o.geometry.attributes.position;
    const pos = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) { _v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z; }
    out.push({ mesh: o, pos });
  });
  return out;
}

/** A depth lookup: for an (x, y) in front view, the middle of the body's depth there. Keeps dragged markers inside. */
export function depthField(parts) {
  const all = parts.flatMap((p) => [p.pos]);
  const box = new THREE.Box3();
  for (const pos of all) for (let i = 0; i < pos.length; i += 3) box.expandByPoint(_v.set(pos[i], pos[i + 1], pos[i + 2]));
  const size = box.getSize(new THREE.Vector3());
  const cell = Math.max(size.x, size.y) / 64 || 0.01;
  const cells = new Map();
  for (const pos of all) for (let i = 0; i < pos.length; i += 3) {
    const k = `${Math.floor(pos[i] / cell)},${Math.floor(pos[i + 1] / cell)}`;
    const c = cells.get(k) || { min: Infinity, max: -Infinity };
    c.min = Math.min(c.min, pos[i + 2]); c.max = Math.max(c.max, pos[i + 2]);
    cells.set(k, c);
  }
  return (x, y) => {
    const cx = Math.floor(x / cell); const cy = Math.floor(y / cell);
    let lo = Infinity; let hi = -Infinity;
    for (let r = 0; r <= 2 && lo === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const c = cells.get(`${cx + dx},${cy + dy}`); if (c) { lo = Math.min(lo, c.min); hi = Math.max(hi, c.max); } }
    }
    return lo === Infinity ? (box.min.z + box.max.z) / 2 : (lo + hi) / 2;
  };
}

/** First guess for the joint markers, from the bounding box, a width profile and left/right symmetry. */
export function suggestMarkers(parts) {
  const box = new THREE.Box3();
  let n = 0;
  for (const { pos } of parts) for (let i = 0; i < pos.length; i += 3) { box.expandByPoint(_v.set(pos[i], pos[i + 1], pos[i + 2])); n++; }
  const H = box.max.y - box.min.y; const y0 = box.min.y;
  const cx = (box.min.x + box.max.x) / 2;
  const step = Math.max(1, Math.floor(n / 40000)); // sample big meshes
  const pts = [];
  for (const { pos } of parts) for (let i = 0; i < pos.length; i += 3 * step) pts.push([pos[i], pos[i + 1], pos[i + 2]]);
  const depth = depthField(parts);
  const slice = (ya, yb, fx = () => true) => pts.filter((p) => p[1] >= y0 + ya * H && p[1] <= y0 + yb * H && fx(p[0] - cx));
  // Neck: the narrowest slice of the central column in the upper body.
  let neckY = 0.84; let best = Infinity;
  for (let t = 0.7; t <= 0.93; t += 0.01) {
    const s = slice(t, t + 0.015, (dx) => Math.abs(dx) < 0.2 * H);
    if (s.length < 3) continue;
    const xs = s.map((p) => p[0]);
    const w = Math.max(...xs) - Math.min(...xs);
    if (w < best) { best = w; neckY = t; }
  }
  const chinY = Math.min(0.95, neckY + 0.025); const shY = neckY - 0.05;
  const M = {};
  const put = (k, x, y) => { M[k] = [x, y, depth(x, y)]; };
  put('chin', cx, y0 + chinY * H);
  for (const [side, s] of [['left', 1], ['right', -1]]) {
    // Shoulder at a typical width; hand tip = the vertex furthest out on that side in the upper body.
    const sx = cx + s * 0.105 * H; const sy = y0 + shY * H;
    const side_ = slice(0.3, neckY, (dx) => dx * s > 0.14 * H);
    let tip = null; let far = -1;
    for (const p of side_) { const dd = (p[0] - sx) ** 2 + (p[1] - sy) ** 2; if (dd > far) { far = dd; tip = p; } }
    if (!tip) tip = [sx + s * 0.35 * H, sy, 0];
    const lerp = (t) => [sx + (tip[0] - sx) * t, sy + (tip[1] - sy) * t];
    put(`${side}Shoulder`, sx, sy);
    put(`${side}Elbow`, ...lerp(0.46));
    put(`${side}Wrist`, ...lerp(0.86));
    // Legs: centre of each leg's vertices at thigh, knee and ankle height.
    const legX = (t) => { const s2 = slice(t - 0.02, t + 0.02, (dx) => dx * s > 0.005 * H && Math.abs(dx) < 0.18 * H); return s2.length ? s2.reduce((a, p) => a + p[0], 0) / s2.length : cx + s * 0.06 * H; };
    const thigh = legX(0.36);
    put(`${side}Hip`, cx + (thigh - cx) * 0.85, y0 + 0.5 * H);
    put(`${side}Knee`, legX(0.27), y0 + 0.27 * H);
    put(`${side}Ankle`, legX(0.06), y0 + 0.05 * H);
  }
  return { markers: M, box: { min: box.min.toArray(), max: box.max.toArray() } };
}

// ---------------------------------------------------------------- skeleton

/** Humanoid bones from the markers. Returns { bones: { name: Bone }, segs: [[bone, child]], root }. Bones have no rotation. */
export function buildSkeleton(markers, box) {
  const P = (k) => new THREE.Vector3(...markers[k]);
  const top = box.max[1]; const floor = box.min[1];
  const H = top - floor;
  const hipL = P('leftHip'); const hipR = P('rightHip');
  const shL = P('leftShoulder'); const shR = P('rightShoulder');
  const chin = P('chin');
  const hips = hipL.clone().add(hipR).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.025 * H, 0));
  const shC = shL.clone().add(shR).multiplyScalar(0.5);
  const neckBase = new THREE.Vector3(chin.x, shC.y + 0.01 * H, (shC.z + chin.z) / 2);
  const L = (a, b, t) => a.clone().lerp(b, t);
  const pts = {
    hips, spine: L(hips, neckBase, 0.28), chest: L(hips, neckBase, 0.58), upperChest: L(hips, neckBase, 0.82),
    neck: L(neckBase, chin, 0.15), head: new THREE.Vector3(chin.x, chin.y + 0.01 * H, L(neckBase, chin, 0.5).z), head_end: new THREE.Vector3(chin.x, top, chin.z),
  };
  const parents = { spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', head_end: 'head' };
  for (const s of ['left', 'right']) {
    const S = (n) => `${s}${n}`;
    const sh = P(S('Shoulder')); const el = P(S('Elbow')); const wr = P(S('Wrist'));
    pts[S('Shoulder')] = L(neckBase, sh, 0.25).setY(L(neckBase, sh, 0.25).y - 0.01 * H);
    pts[S('UpperArm')] = sh; pts[S('LowerArm')] = el; pts[S('Hand')] = wr;
    pts[S('Hand_end')] = wr.clone().add(wr.clone().sub(el).multiplyScalar(0.45));
    const hp = P(S('Hip')); const kn = P(S('Knee')); const an = P(S('Ankle'));
    pts[S('UpperLeg')] = hp; pts[S('LowerLeg')] = kn; pts[S('Foot')] = an;
    pts[S('Toes')] = new THREE.Vector3(an.x, floor + 0.015 * H, an.z + 0.06 * H);
    pts[S('Toes_end')] = new THREE.Vector3(an.x, floor + 0.015 * H, an.z + 0.1 * H);
    Object.assign(parents, { [S('Shoulder')]: 'upperChest', [S('UpperArm')]: S('Shoulder'), [S('LowerArm')]: S('UpperArm'), [S('Hand')]: S('LowerArm'), [S('Hand_end')]: S('Hand'),
      [S('UpperLeg')]: 'hips', [S('LowerLeg')]: S('UpperLeg'), [S('Foot')]: S('LowerLeg'), [S('Toes')]: S('Foot'), [S('Toes_end')]: S('Toes') });
  }
  const bones = {};
  const order = Object.keys(pts);
  for (const name of order) {
    const b = new THREE.Bone();
    b.name = name; b.userData.world = pts[name].clone();
    bones[name] = b;
  }
  for (const name of order) {
    const p = parents[name];
    bones[name].position.copy(p ? pts[name].clone().sub(pts[p]) : pts[name]);
    if (p) bones[p].add(bones[name]);
  }
  const segs = Object.entries(parents).map(([child, parent]) => [parent, child])
    // A parent with several children (hips, upperChest) owns only its spine segment.
    .filter(([parent, child]) => !((parent === 'hips' && child !== 'spine') || (parent === 'upperChest' && child !== 'neck')));
  return { bones, segs, root: bones.hips };
}

// ---------------------------------------------------------------- welding, adjacency, visibility

function weld(parts, tol) {
  const map = new Map();
  const welded = []; // xyz
  const remap = parts.map(({ pos }) => {
    const r = new Uint32Array(pos.length / 3);
    for (let i = 0; i < r.length; i++) {
      const k = `${Math.round(pos[i * 3] / tol)},${Math.round(pos[i * 3 + 1] / tol)},${Math.round(pos[i * 3 + 2] / tol)}`;
      let w = map.get(k);
      if (w === undefined) { w = welded.length / 3; welded.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); map.set(k, w); }
      r[i] = w;
    }
    return r;
  });
  return { pos: new Float32Array(welded), remap };
}
function triangles(mesh) {
  const g = mesh.geometry; const idx = g.index;
  const n = idx ? idx.count : g.attributes.position.count;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = idx ? idx.getX(i) : i;
  return out;
}
function adjacency(nv, tris) {
  const sets = Array.from({ length: nv }, () => new Set());
  for (const t of tris) for (let i = 0; i < t.length; i += 3) {
    const a = t[i]; const b = t[i + 1]; const c = t[i + 2];
    if (a === b || b === c || a === c) continue;
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  const off = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) off[i + 1] = off[i] + sets[i].size;
  const nb = new Uint32Array(off[nv]);
  for (let i = 0; i < nv; i++) { let k = off[i]; for (const j of sets[i]) nb[k++] = j; }
  return { off, nb };
}
// Surface voxels: a triangle marks every voxel its sample points fall in.
function voxelize(pos, tris, box, res) {
  const size = new THREE.Vector3().subVectors(box.max, box.min);
  const vs = Math.max(size.x, size.y, size.z) / res;
  const dims = [Math.ceil(size.x / vs) + 3, Math.ceil(size.y / vs) + 3, Math.ceil(size.z / vs) + 3];
  const grid = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const o = box.min.clone().subScalar(vs);
  const mark = (x, y, z) => {
    const i = Math.floor((x - o.x) / vs); const j = Math.floor((y - o.y) / vs); const k = Math.floor((z - o.z) / vs);
    if (i >= 0 && j >= 0 && k >= 0 && i < dims[0] && j < dims[1] && k < dims[2]) grid[i + dims[0] * (j + dims[1] * k)] = 1;
  };
  const A = new THREE.Vector3(); const B = new THREE.Vector3(); const C = new THREE.Vector3();
  for (const t of tris) for (let q = 0; q < t.length; q += 3) {
    A.fromArray(pos, t[q] * 3); B.fromArray(pos, t[q + 1] * 3); C.fromArray(pos, t[q + 2] * 3);
    const m = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
    const s = Math.max(1, Math.ceil((m / vs) * 2));
    for (let u = 0; u <= s; u++) for (let v = 0; v <= s - u; v++) {
      const a = u / s; const b = v / s; const c = 1 - a - b;
      mark(A.x * c + B.x * a + C.x * b, A.y * c + B.y * a + C.y * b, A.z * c + B.z * a + C.z * b);
    }
  }
  const occupied = (x, y, z) => {
    const i = Math.floor((x - o.x) / vs); const j = Math.floor((y - o.y) / vs); const k = Math.floor((z - o.z) / vs);
    return i >= 0 && j >= 0 && k >= 0 && i < dims[0] && j < dims[1] && k < dims[2] && grid[i + dims[0] * (j + dims[1] * k)] === 1;
  };
  return { occupied, vs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Rigs the static meshes under `root` with a skeleton from the markers. Returns { root: Group, bones, humanoid }.
 * opts: { smooth: 0..1 (heat strength), onProgress(p, label) }
 */
export async function autoRig(root, markers, box, { smooth = 0.5, onProgress } = {}) {
  const parts = worldVertices(root).filter((p) => !p.mesh.isSkinnedMesh && p.pos.length);
  if (!parts.length) throw new Error('There’s no mesh to rig.');
  const bbox = new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
  const H = bbox.max.y - bbox.min.y;
  const { bones, segs: segNames, root: hips } = buildSkeleton(markers, box);
  const allBones = []; hips.traverse((b) => allBones.push(b));
  const segs = segNames.map(([a, b]) => ({ a: bones[a].userData.world, b: bones[b].userData.world, bone: allBones.indexOf(bones[a]) }));

  onProgress?.(0.05, 'Joining the mesh…'); await tick();
  const { pos, remap } = weld(parts, H * 1e-4);
  const nv = pos.length / 3;
  const tris = parts.map((p, i) => { const t = triangles(p.mesh); const r = remap[i]; for (let k = 0; k < t.length; k++) t[k] = r[t[k]]; return t; });
  const adj = adjacency(nv, tris);

  onProgress?.(0.15, 'Checking which bones each part can see…'); await tick();
  const vox = voxelize(pos, tris, bbox, 110);
  const P = new THREE.Vector3(); const Q = new THREE.Vector3(); const dir = new THREE.Vector3();
  const visible = (i, j) => {
    P.fromArray(pos, i * 3);
    closestOnSeg(P, segs[j].a, segs[j].b, Q);
    const len = P.distanceTo(Q);
    const skip = vox.vs * 1.6;
    if (len < skip * 1.5) return true;
    dir.subVectors(Q, P).divideScalar(len);
    for (let t = skip; t < len - vox.vs * 0.6; t += vox.vs * 0.5) {
      if (vox.occupied(P.x + dir.x * t, P.y + dir.y * t, P.z + dir.z * t)) return false;
    }
    return true;
  };
  // Only test the few nearest segments for visibility; far ones never win anyway.
  const near = new Array(nv);
  const d = new Float32Array(segs.length);
  for (let i = 0; i < nv; i++) {
    P.fromArray(pos, i * 3);
    for (let j = 0; j < segs.length; j++) d[j] = segDist(P, segs[j].a, segs[j].b);
    const order = [...d.keys()].sort((x, y) => d[x] - d[y]).slice(0, 5);
    const vis = order.filter((j) => visible(i, j));
    near[i] = { vis: vis.length ? vis : [order[0]], d: Float32Array.from(order.map((j) => d[j])), order };
    if (i % 4000 === 0) { onProgress?.(0.15 + 0.35 * (i / nv), 'Checking which bones each part can see…'); await tick(); }
  }

  onProgress?.(0.5, 'Spreading weights…'); await tick();
  const B = segs.length;
  const W = new Float32Array(nv * B);
  const Hh = new Float32Array(nv); const pi = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const { vis } = near[i];
    P.fromArray(pos, i * 3);
    let dmin = Infinity; let jmin = vis[0];
    const ds = vis.map((j) => segDist(P, segs[j].a, segs[j].b));
    ds.forEach((x, k) => { if (x < dmin) { dmin = x; jmin = vis[k]; } });
    let sum = 0;
    vis.forEach((j, k) => { const w = Math.pow((dmin + 1e-4) / (ds[k] + 1e-4), 4); if (w > 0.02) { W[i * B + j] = w; sum += w; } });
    for (const j of vis) W[i * B + j] /= sum || 1;
    pi[i] = jmin;
    Hh[i] = (0.3 + 2 * (1 - smooth)) / Math.max(dmin, H * 0.004) ** 2;
  }
  // Edge weights 1/len² (so the Laplacian and H share units).
  const ew = new Float32Array(adj.nb.length);
  for (let i = 0; i < nv; i++) for (let k = adj.off[i]; k < adj.off[i + 1]; k++) {
    const j = adj.nb[k];
    const l2 = (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
    ew[k] = 1 / Math.max(l2, (H * 1e-4) ** 2);
  }
  const iters = Math.round(10 + smooth * 50);
  const acc = new Float32Array(B);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < nv; i++) {
      const a = adj.off[i]; const b = adj.off[i + 1];
      if (a === b) continue;
      acc.fill(0);
      let wsum = 0;
      for (let k = a; k < b; k++) { const j = adj.nb[k]; const e = ew[k]; wsum += e; const o = j * B; for (let s = 0; s < B; s++) acc[s] += e * W[o + s]; }
      const h = Hh[i]; const o = i * B; const den = wsum + h;
      for (let s = 0; s < B; s++) {
        // Heat only flows along the surface graph, so it can't jump the air gap between an arm and the body.
        W[o + s] = (acc[s] + (pi[i] === s ? h : 0)) / den;
      }
    }
    if (it % 4 === 0) { onProgress?.(0.5 + 0.4 * (it / iters), 'Spreading weights…'); await tick(); }
  }

  onProgress?.(0.92, 'Binding the skin…'); await tick();
  const out = new THREE.Group();
  out.name = root.name || 'AutoRigged';
  out.add(hips);
  out.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(allBones);
  parts.forEach((p, pi_) => {
    const src = p.mesh;
    const g = src.geometry.clone();
    g.applyMatrix4(src.matrixWorld);
    // applyMatrix4 leaves morph targets alone: move absolute ones with the mesh, rotate/scale relative deltas.
    const lin = new THREE.Matrix4().extractRotation(src.matrixWorld).scale(src.getWorldScale(new THREE.Vector3()));
    for (const a of g.morphAttributes.position || []) a.applyMatrix4(g.morphTargetsRelative ? lin : src.matrixWorld);
    const n = g.attributes.position.count;
    const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4);
    const r = remap[pi_];
    for (let i = 0; i < n; i++) {
      const o = r[i] * B;
      const list = [];
      for (let s = 0; s < B; s++) if (W[o + s] > 0.01) list.push([segs[s].bone, W[o + s]]);
      if (!list.length) list.push([segs[pi[r[i]]].bone, 1]);
      writeTop4(list, si, sw, i);
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const m = new THREE.SkinnedMesh(g, src.material);
    m.name = src.name;
    m.morphTargetDictionary = src.morphTargetDictionary; m.morphTargetInfluences = src.morphTargetInfluences?.slice();
    out.add(m);
    m.bind(skeleton, new THREE.Matrix4());
  });
  const humanoid = Object.fromEntries(Object.keys(bones).filter((n) => !/_end$/.test(n)).map((n) => [n, n]));
  onProgress?.(1, 'Done');
  return { root: out, bones, humanoid };
}

// ---------------------------------------------------------------- weight painting

/** Paints a heat-map colour per vertex for one bone (blue = 0 → red = 1). */
export function showWeights(mesh, bone) {
  const g = mesh.geometry;
  const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight;
  const bi = mesh.skeleton.bones.indexOf(bone);
  let col = g.attributes.color;
  if (!col || col.count !== si.count || !g.userData.slWeightColor) { col = new THREE.Float32BufferAttribute(new Float32Array(si.count * 3), 3); g.setAttribute('color', col); g.userData.slWeightColor = true; }
  const c = new THREE.Color();
  for (let i = 0; i < si.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
    c.setHSL((1 - w) * 0.66, 0.9, 0.35 + 0.2 * w);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}
export function hideWeights(mesh) {
  const g = mesh.geometry;
  if (g.userData.slWeightColor) { g.deleteAttribute('color'); delete g.userData.slWeightColor; }
}

const neighbours = new WeakMap();
function meshAdjacency(mesh) {
  if (!neighbours.has(mesh.geometry)) {
    const g = mesh.geometry;
    // Weld by position so seams smooth across.
    const { pos, remap } = weld([{ pos: g.attributes.position.array }], 1e-5);
    const t = triangles(mesh); for (let k = 0; k < t.length; k++) t[k] = remap[0][t[k]];
    const adj = adjacency(pos.length / 3, [t]);
    const members = Array.from({ length: pos.length / 3 }, () => []);
    remap[0].forEach((w, i) => members[w].push(i));
    neighbours.set(mesh.geometry, { adj, remap: remap[0], members });
  }
  return neighbours.get(mesh.geometry);
}

/** Rest-pose world position of the point a ray hit on a skinned mesh (so painting works while posed). */
export function restPoint(hit) {
  const m = hit.object; const f = hit.face;
  const A = new THREE.Vector3(); const Bv = new THREE.Vector3(); const C = new THREE.Vector3();
  m.getVertexPosition(f.a, A).applyMatrix4(m.matrixWorld); m.getVertexPosition(f.b, Bv).applyMatrix4(m.matrixWorld); m.getVertexPosition(f.c, C).applyMatrix4(m.matrixWorld);
  const bary = THREE.Triangle.getBarycoord(hit.point, A, Bv, C, new THREE.Vector3());
  if (!bary) return hit.point.clone();
  const p = m.geometry.attributes.position;
  const R = (i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.bindMatrix).applyMatrix4(m.matrixWorld);
  return R(f.a).multiplyScalar(bary.x).add(R(f.b).multiplyScalar(bary.y)).add(R(f.c).multiplyScalar(bary.z));
}

/** One brush dab. mode: 'add' | 'remove' | 'smooth'. Returns true if anything changed. */
export function paintWeights(meshes, bone, center, { radius, strength, mode }) {
  let changed = false;
  for (const mesh of meshes) {
    const bi = mesh.skeleton.bones.indexOf(bone);
    if (bi < 0) continue;
    const g = mesh.geometry;
    const pa = g.attributes.position; const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight;
    const toWorld = mesh.bindMatrix.clone().premultiply(mesh.matrixWorld);
    const P = new THREE.Vector3();
    const hits = [];
    for (let i = 0; i < pa.count; i++) {
      P.fromBufferAttribute(pa, i).applyMatrix4(toWorld);
      const dd = P.distanceTo(center);
      if (dd < radius) hits.push([i, 1 - (dd / radius) ** 2]);
    }
    if (!hits.length) continue;
    const get = (i) => { const w = new Map(); for (let k = 0; k < 4; k++) { const b = si.getComponent(i, k); const x = sw.getComponent(i, k); if (x > 0) w.set(b, (w.get(b) || 0) + x); } return w; };
    const put = (i, w) => {
      const top = [...w].filter(([, x]) => x > 0.001).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, x]) => s + x, 0) || 1;
      for (let k = 0; k < 4; k++) { si.setComponent(i, k, top[k]?.[0] ?? 0); sw.setComponent(i, k, top[k] ? top[k][1] / sum : 0); }
    };
    let smoothFrom = null;
    if (mode === 'smooth') {
      const { adj, remap, members } = meshAdjacency(mesh);
      smoothFrom = (i) => {
        const avg = new Map(); let n = 0;
        const wi = remap[i];
        for (let k = adj.off[wi]; k < adj.off[wi + 1]; k++) {
          const j = members[adj.nb[k]][0];
          for (const [b, x] of get(j)) avg.set(b, (avg.get(b) || 0) + x);
          n++;
        }
        if (n) for (const [b, x] of avg) avg.set(b, x / n);
        return avg;
      };
    }
    const updates = hits.map(([i, f]) => {
      const w = get(i);
      const s = strength * f;
      if (mode === 'add') {
        const cur = w.get(bi) || 0;
        const add = (1 - cur) * s;
        // Take the added weight from the other bones in proportion.
        const others = [...w].filter(([b]) => b !== bi); const osum = others.reduce((a, [, x]) => a + x, 0) || 1;
        for (const [b, x] of others) w.set(b, x - add * (x / osum));
        w.set(bi, cur + add);
      } else if (mode === 'remove') {
        const cur = w.get(bi) || 0;
        if (cur >= 0.999 && w.size === 1) return null; // nothing to give it to
        w.set(bi, cur * (1 - s));
      } else if (smoothFrom) {
        const avg = smoothFrom(i);
        for (const b of new Set([...w.keys(), ...avg.keys()])) w.set(b, (w.get(b) || 0) * (1 - s) + (avg.get(b) || 0) * s);
      }
      return [i, w];
    }).filter(Boolean);
    for (const [i, w] of updates) put(i, w);
    if (updates.length) { si.needsUpdate = true; sw.needsUpdate = true; changed = true; showWeights(mesh, bone); }
  }
  return changed;
}
