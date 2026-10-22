// The "Starter avatar": a small stylised humanoid built from primitives in code, so people can try the whole pipeline
// (expressions, spring bones, tracking, VRM export) without bringing a model. It's T-posed and faces +Z like VRM 1.0
// (palms down, thumbs forward), has a humanoid skeleton with finger bones (so hand tracking can curl them), a face with ARKit-named shapes (blink, squint, wide, jaw, pucker, funnel, smile, frown,
// stretch, brows) mapped to the VRM presets, MToon materials with outlines, and hair strands on spring bones.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MToonMaterial } from '@pixiv/three-vrm';
import { segmentWeights } from './autorig.js';
import { uid } from './model.js';

export const STARTER_DEFAULTS = { skin: '#ffe2d2', hair: '#7b6cff', eyes: '#3a2b63', outfit: '#3d4a8f', accent: '#ff7aa8', hairLength: 1 };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const mtoon = (name, color, shade, { outline = 0.0022, toony = 0.92, shift = -0.05, rim = null } = {}) => {
  const m = new MToonMaterial({
    color: new THREE.Color(color), shadeColorFactor: new THREE.Color(shade), shadingToonyFactor: toony, shadingShiftFactor: shift,
    outlineWidthMode: outline ? 'worldCoordinates' : 'none', outlineWidthFactor: outline, outlineColorFactor: new THREE.Color(shade).multiplyScalar(0.45),
    parametricRimColorFactor: new THREE.Color(rim || '#000000'), parametricRimFresnelPowerFactor: 3, rimLightingMixFactor: 1,
  });
  m.name = name;
  return m;
};
const shade = (hex, k = 0.72, hue = 0.02) => { const c = new THREE.Color(hex); const hsl = {}; c.getHSL(hsl); return `#${new THREE.Color().setHSL((hsl.h + hue + 1) % 1, Math.min(1, hsl.s * 1.15), hsl.l * k).getHexString()}`; };

// Fingers (left hand; x is mirrored for the right): name, segments, joint positions (the last one is the tip).
const FINGER_BONES = [
  ['Thumb', ['Metacarpal', 'Proximal', 'Distal'], [[0.552, 1.204, 0.024], [0.574, 1.2, 0.043], [0.593, 1.197, 0.056], [0.61, 1.195, 0.066]]],
  ...[['Index', 0.021, 1], ['Middle', 0.007, 1.08], ['Ring', -0.007, 1], ['Little', -0.02, 0.8]].map(([f, z, s]) => [f, ['Proximal', 'Intermediate', 'Distal'],
    [0.6, 0.6 + 0.026 * s, 0.6 + 0.045 * s, 0.6 + 0.06 * s].map((x) => [x, 1.209, z])]),
];
const FINGER_SEGS = FINGER_BONES.flatMap(([f, segs]) => segs.map((g, i) => [f + g, i < segs.length - 1 ? f + segs[i + 1] : `${f}_end`]));
// Skeleton (world positions, metres). Bones have no rest rotation, which keeps VRM export trivial.
const SKELETON = [
  ['hips', null, V(0, 0.84, 0)], ['spine', 'hips', V(0, 0.94, 0)], ['chest', 'spine', V(0, 1.06, 0)], ['upperChest', 'chest', V(0, 1.15, 0)],
  ['neck', 'upperChest', V(0, 1.25, 0)], ['head', 'neck', V(0, 1.31, 0)], ['head_end', 'head', V(0, 1.62, 0)],
  ...['left', 'right'].flatMap((s) => {
    const k = s === 'left' ? 1 : -1; const S = (n) => `${s}${n}`;
    return [
      [S('Shoulder'), 'upperChest', V(0.03 * k, 1.21, 0)], [S('UpperArm'), S('Shoulder'), V(0.13 * k, 1.21, 0)], [S('LowerArm'), S('UpperArm'), V(0.34 * k, 1.21, 0)],
      [S('Hand'), S('LowerArm'), V(0.54 * k, 1.21, 0)], [S('Hand_end'), S('Hand'), V(0.6 * k, 1.21, 0)],
      ...FINGER_BONES.flatMap(([f, segs, pts]) => pts.map((p, i) => [i < segs.length ? S(f + segs[i]) : S(`${f}_end`), i ? S(f + segs[i - 1]) : S('Hand'), V(p[0] * k, p[1], p[2])])),
      [S('UpperLeg'), 'hips', V(0.08 * k, 0.8, 0)], [S('LowerLeg'), S('UpperLeg'), V(0.08 * k, 0.45, 0)], [S('Foot'), S('LowerLeg'), V(0.08 * k, 0.08, 0)],
      [S('Toes'), S('Foot'), V(0.08 * k, 0.025, 0.09)], [S('Toes_end'), S('Toes'), V(0.08 * k, 0.025, 0.15)],
    ];
  }),
];
// Each deforming bone and the point its segment runs to (for skin weights).
const SEGMENTS = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['neck', 'head'],
  ...['left', 'right'].flatMap((s) => [['Shoulder', 'UpperArm'], ['UpperArm', 'LowerArm'], ['LowerArm', 'Hand'], ['Hand', 'Hand_end'], ['UpperLeg', 'LowerLeg'], ['LowerLeg', 'Foot'], ['Foot', 'Toes'], ['Toes', 'Toes_end'], ...FINGER_SEGS].map(([a, b]) => [s + a, s + b]))];

const HEAD_C = V(0, 1.45, 0); const HEAD_R = V(0.15, 0.16, 0.145);
const onHead = (x, y) => HEAD_R.z * Math.sqrt(Math.max(0, 1 - (x / HEAD_R.x) ** 2 - ((y - HEAD_C.y) / HEAD_R.y) ** 2));

// Geometry helpers: a limb between two points, an ellipsoid, a box — all indexed with normals and UVs so they merge.
function limb(a, b, r1, r2 = r1, seg = 14) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r1, len, 16, seg, false);
  // Round the ends a little so joints don't show gaps when they bend.
  const cap1 = new THREE.SphereGeometry(r1, 16, 8); cap1.translate(0, -len / 2, 0);
  const cap2 = new THREE.SphereGeometry(r2, 16, 8); cap2.translate(0, len / 2, 0);
  const m = mergeGeometries([g, cap1, cap2]);
  m.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()));
  m.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return m;
}
function ellipsoid(c, r, ws = 20, hs = 14, opts = {}) {
  const g = new THREE.SphereGeometry(1, ws, hs, opts.phi0 ?? 0, opts.phiLen ?? Math.PI * 2, opts.theta0 ?? 0, opts.thetaLen ?? Math.PI);
  g.scale(r.x, r.y, r.z); g.translate(c.x, c.y, c.z);
  return g;
}
function box(c, s, rotZ = 0) {
  const g = new THREE.BoxGeometry(s.x, s.y, s.z, 4, 1, 1);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(c.x, c.y, c.z);
  return g;
}
// Merge parts into one geometry with a material group per part list, remembering each part's vertex range.
function assemble(parts) {
  const geos = parts.map((p) => p.geo.index ? p.geo : p.geo);
  const merged = mergeGeometries(geos, true);
  let start = 0;
  const ranges = {};
  parts.forEach((p, i) => { const n = geos[i].attributes.position.count; ranges[p.name || `p${i}`] = { start, count: n, center: p.center }; start += n; });
  // Collapse groups that share a material index so the mesh has one draw per material.
  merged.clearGroups();
  let gi = 0; let s0 = 0;
  const idxCounts = geos.map((g) => g.index.count);
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1 || parts[i + 1].mat !== parts[i].mat) {
      const count = idxCounts.slice(gi, i + 1).reduce((a, b) => a + b, 0);
      merged.addGroup(s0, count, parts[i].mat);
      s0 += count; gi = i + 1;
    }
  }
  return { geo: merged, ranges };
}

function skinned(geo, materials, skeleton, bones, segs, name) {
  const pos = geo.attributes.position.array;
  const { skinIndex, skinWeight } = segmentWeights(pos, segs.map(([a, b]) => ({ a: bones[a].userData.world, b: bones[b].userData.world, bone: skeleton.bones.indexOf(bones[a]) })));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  const mesh = new THREE.SkinnedMesh(geo, materials);
  mesh.name = name;
  mesh.bind(skeleton, new THREE.Matrix4());
  return mesh;
}

/** Builds the starter avatar. Returns { root, format: 'starter', file } like loadModel(). */
export function buildStarter(opts = {}) {
  const o = { ...STARTER_DEFAULTS, ...(opts || {}) };
  const root = new THREE.Group();
  root.name = 'StarterAvatar';

  // ---- skeleton
  const bones = {};
  for (const [name, parent, at] of SKELETON) {
    const b = new THREE.Bone();
    b.name = name; b.userData.world = at.clone();
    b.position.copy(parent ? at.clone().sub(bones[parent].userData.world) : at);
    (parent ? bones[parent] : root).add(b);
    bones[name] = b;
  }
  // Hair strands: 7 down the back, 2 side locks. Each strand is a chain of 4 bones under the head.
  const L = o.hairLength;
  const strands = [];
  const back = [-0.11, -0.065, -0.022, 0.022, 0.065, 0.11];
  back.forEach((x, i) => {
    const z = -Math.sqrt(Math.max(0, 1 - (x / 0.165) ** 2)) * 0.158 - 0.006;
    strands.push({ name: `HairBack${i + 1}`, top: V(x * 1.05, 1.5, z), dir: V(x * 0.25, -1, -0.12).normalize(), len: (0.34 + 0.05 * Math.cos(i)) * L, r: 0.032 });
  });
  strands.push({ name: 'HairSideL', top: V(0.145, 1.44, 0.035), dir: V(0.12, -1, 0.05).normalize(), len: 0.26 * L, r: 0.026 });
  strands.push({ name: 'HairSideR', top: V(-0.145, 1.44, 0.035), dir: V(-0.12, -1, 0.05).normalize(), len: 0.26 * L, r: 0.026 });
  const N = 4;
  for (const s of strands) {
    s.bones = [];
    let parent = bones.head;
    for (let k = 0; k < N; k++) {
      const at = s.top.clone().addScaledVector(s.dir, (s.len * k) / (N - 1));
      const b = new THREE.Bone();
      b.name = `${s.name}_${k}`; b.userData.world = at;
      b.position.copy(at.clone().sub(parent.userData.world));
      parent.add(b); parent = b; s.bones.push(b);
      bones[b.name] = b;
    }
  }
  root.updateMatrixWorld(true);
  const all = []; root.traverse((x) => { if (x.isBone) all.push(x); });
  const skeleton = new THREE.Skeleton(all);

  // ---- materials
  const M = {
    skin: mtoon('Skin', o.skin, shade(o.skin, 0.86, -0.01), { outline: 0.0018 }),
    outfit: mtoon('Outfit', o.outfit, shade(o.outfit, 0.62)),
    accent: mtoon('Accent', o.accent, shade(o.accent, 0.7)),
    shoes: mtoon('Shoes', '#2e2a3a', '#16131d'),
    hair: mtoon('Hair', o.hair, shade(o.hair, 0.62, 0.03), { rim: shade(o.hair, 1.25), outline: 0.002 }),
    eyes: mtoon('Eyes', o.eyes, shade(o.eyes, 0.6), { outline: 0 }),
    white: mtoon('Highlight', '#ffffff', '#ffffff', { outline: 0, toony: 1, shift: 1 }),
    mouth: mtoon('Mouth', '#8a2b3f', '#5d1a2a', { outline: 0 }),
  };

  // ---- body (skinned)
  const W = (n) => bones[n].userData.world;
  const bodyParts = [
    { geo: limb(W('hips').clone().add(V(0, -0.04, 0)), W('upperChest').clone().add(V(0, 0.04, 0)), 0.115, 0.1, 20), mat: 0 },          // torso (outfit)
    { geo: ellipsoid(V(0, 0.8, 0), V(0.14, 0.1, 0.105)), mat: 0 },                                                                       // pelvis
    { geo: limb(W('leftUpperArm'), W('leftLowerArm'), 0.045, 0.04), mat: 0 }, { geo: limb(W('rightUpperArm'), W('rightLowerArm'), 0.045, 0.04), mat: 0 }, // sleeves
    { geo: limb(W('leftUpperLeg'), W('leftLowerLeg').clone().add(V(0, 0.1, 0)), 0.068, 0.058), mat: 0 }, { geo: limb(W('rightUpperLeg'), W('rightLowerLeg').clone().add(V(0, 0.1, 0)), 0.068, 0.058), mat: 0 }, // shorts
    { geo: limb(W('upperChest').clone().add(V(0, 0.06, 0)), W('head').clone().add(V(0, 0.04, 0)), 0.04), mat: 1 },                        // neck (skin)
    { geo: limb(W('leftLowerArm'), W('leftHand'), 0.036, 0.03), mat: 1 }, { geo: limb(W('rightLowerArm'), W('rightHand'), 0.036, 0.03), mat: 1 },
    { geo: ellipsoid(W('leftHand').clone().add(V(0.031, 0, 0.002)), V(0.04, 0.019, 0.034)), mat: 1 }, { geo: ellipsoid(W('rightHand').clone().add(V(-0.031, 0, 0.002)), V(0.04, 0.019, 0.034)), mat: 1 },
    // fingers: a little capsule per segment
    ...['left', 'right'].flatMap((s) => FINGER_SEGS.map(([a, b]) => ({ geo: limb(W(s + a), W(s + b), /Thumb/.test(a) ? 0.0105 : 0.0085, /Thumb/.test(a) ? 0.009 : 0.0075, 4), mat: 1 }))),
    { geo: limb(W('leftLowerLeg').clone().add(V(0, 0.12, 0)), W('leftFoot'), 0.05, 0.04), mat: 1 }, { geo: limb(W('rightLowerLeg').clone().add(V(0, 0.12, 0)), W('rightFoot'), 0.05, 0.04), mat: 1 },
    { geo: ellipsoid(V(0.08, 0.05, 0.04), V(0.055, 0.045, 0.1)), mat: 2 }, { geo: ellipsoid(V(-0.08, 0.05, 0.04), V(0.055, 0.045, 0.1)), mat: 2 }, // shoes
    { geo: new THREE.TorusGeometry(0.052, 0.013, 10, 32).rotateX(Math.PI / 2).translate(0, 1.255, 0.004), mat: 3 },                      // collar trim
  ];
  const body = skinned(assemble(bodyParts).geo, [M.outfit, M.skin, M.shoes, M.accent], skeleton, bones, SEGMENTS, 'Body');
  root.add(body);

  // ---- head and face: rigid children of the head bone (no skinning needed)
  const hp = W('head');
  const head = new THREE.Mesh(mergeGeometries([ellipsoid(HEAD_C, HEAD_R, 32, 24), ellipsoid(V(0.15, 1.43, 0), V(0.02, 0.035, 0.025)), ellipsoid(V(-0.15, 1.43, 0), V(0.02, 0.035, 0.025))]), M.skin);
  head.name = 'Head';
  head.geometry.translate(-hp.x, -hp.y, -hp.z);
  bones.head.add(head);

  const ex = 0.056; const ey = 1.43;
  const eyeZ = (x) => onHead(x, ey) - 0.002;
  const faceParts = [
    { name: 'eyeL', geo: ellipsoid(V(ex, ey, eyeZ(ex)), V(0.024, 0.033, 0.009)), mat: 0, center: V(ex, ey, eyeZ(ex)) },
    { name: 'eyeR', geo: ellipsoid(V(-ex, ey, eyeZ(ex)), V(0.024, 0.033, 0.009)), mat: 0, center: V(-ex, ey, eyeZ(ex)) },
    { name: 'hiL', geo: ellipsoid(V(ex + 0.008, ey + 0.012, eyeZ(ex) + 0.008), V(0.008, 0.009, 0.003), 10, 8), mat: 1, center: V(ex, ey, eyeZ(ex)) },
    { name: 'hiR', geo: ellipsoid(V(-ex + 0.008, ey + 0.012, eyeZ(ex) + 0.008), V(0.008, 0.009, 0.003), 10, 8), mat: 1, center: V(-ex, ey, eyeZ(ex)) },
    { name: 'mouth', geo: ellipsoid(V(0, 1.352, onHead(0, 1.352) - 0.002), V(0.022, 0.0045, 0.006), 24, 12), mat: 2, center: V(0, 1.352, onHead(0, 1.352)) },
    { name: 'browL', geo: box(V(ex, 1.49, onHead(ex, 1.49) + 0.001), V(0.042, 0.007, 0.006), 0.08), mat: 3, center: V(ex, 1.49, 0) },
    { name: 'browR', geo: box(V(-ex, 1.49, onHead(ex, 1.49) + 0.001), V(0.042, 0.007, 0.006), -0.08), mat: 3, center: V(-ex, 1.49, 0) },
  ];
  // Box and sphere attributes differ only in being indexed; all are, so this merges.
  const { geo: fgeo, ranges } = assemble(faceParts);
  const base = fgeo.attributes.position.array.slice();
  // Morph targets as per-vertex functions of the original position, part by part.
  const morphs = [];
  const morph = (name, ops) => {
    const d = new Float32Array(base.length);
    for (const [part, fn] of ops) {
      const r = ranges[part];
      const v = new THREE.Vector3();
      for (let i = r.start; i < r.start + r.count; i++) {
        v.set(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
        const w = fn(v.clone(), r.center);
        d[i * 3] = w.x - v.x; d[i * 3 + 1] = w.y - v.y; d[i * 3 + 2] = w.z - v.z;
      }
    }
    morphs.push([name, d]);
  };
  const scaleY = (k, dy = 0) => (v, c) => v.setY(c.y + dy + (v.y - c.y) * k);
  const blink = (v, c) => v.set(c.x + (v.x - c.x) * 1.12, c.y - 0.012 + (v.y - c.y) * 0.08, v.z);
  const squint = (v, c) => { const t = (v.x - c.x) / 0.024; return v.setY(c.y - 0.006 + (v.y - c.y) * 0.4 + 0.008 * (1 - t * t)); };
  const wide = (v, c) => v.set(c.x + (v.x - c.x) * 1.15, c.y + (v.y - c.y) * 1.25, v.z);
  const shift = (dx, dy) => (v) => v.set(v.x + dx, v.y + dy, v.z);
  const side = (s, fn) => (v, c) => ((v.x - c.x) * s >= 0 ? fn(v, c) : v);
  const brow = (s, dyInner, dyAll) => (v, c) => { const inner = Math.max(0, Math.min(1, 1 - (Math.abs(v.x) - (Math.abs(c.x) - 0.021)) / 0.042)); return v.setY(v.y + dyAll + dyInner * inner); };
  morph('eyeBlinkLeft', [['eyeL', blink], ['hiL', blink]]);
  morph('eyeBlinkRight', [['eyeR', blink], ['hiR', blink]]);
  morph('eyeSquintLeft', [['eyeL', squint], ['hiL', scaleY(0, -0.004)]]);
  morph('eyeSquintRight', [['eyeR', squint], ['hiR', scaleY(0, -0.004)]]);
  morph('eyeWideLeft', [['eyeL', wide], ['hiL', wide]]);
  morph('eyeWideRight', [['eyeR', wide], ['hiR', wide]]);
  for (const [n, dx, dy] of [['eyeLookLeft', 0.007, 0], ['eyeLookRight', -0.007, 0], ['eyeLookUp', 0, 0.007], ['eyeLookDown', 0, -0.006]]) {
    morph(n, ['eyeL', 'eyeR', 'hiL', 'hiR'].map((p) => [p, shift(dx, dy)]));
  }
  morph('jawOpen', [['mouth', (v, c) => v.set(c.x + (v.x - c.x) * 1.05, c.y - 0.012 + (v.y - c.y) * 5.5, v.z)]]);
  morph('mouthPucker', [['mouth', (v, c) => v.set(c.x + (v.x - c.x) * 0.5, c.y - 0.004 + (v.y - c.y) * 3, v.z)]]);
  morph('mouthFunnel', [['mouth', (v, c) => v.set(c.x + (v.x - c.x) * 0.75, c.y - 0.008 + (v.y - c.y) * 4.2, v.z)]]);
  morph('mouthStretchLeft', [['mouth', side(1, (v, c) => v.set(v.x + (v.x - c.x) * 0.5, c.y + (v.y - c.y) * 1.6, v.z))]]);
  morph('mouthStretchRight', [['mouth', side(-1, (v, c) => v.set(v.x + (v.x - c.x) * 0.5, c.y + (v.y - c.y) * 1.6, v.z))]]);
  morph('mouthSmileLeft', [['mouth', side(1, (v, c) => v.setY(v.y + 0.011 * ((v.x - c.x) / 0.022) ** 2))]]);
  morph('mouthSmileRight', [['mouth', side(-1, (v, c) => v.setY(v.y + 0.011 * ((v.x - c.x) / 0.022) ** 2))]]);
  morph('mouthFrownLeft', [['mouth', side(1, (v, c) => v.setY(v.y - 0.009 * ((v.x - c.x) / 0.022) ** 2))]]);
  morph('mouthFrownRight', [['mouth', side(-1, (v, c) => v.setY(v.y - 0.009 * ((v.x - c.x) / 0.022) ** 2))]]);
  morph('browInnerUp', [['browL', brow(1, 0.012, 0.002)], ['browR', brow(-1, 0.012, 0.002)]]);
  morph('browDownLeft', [['browL', brow(1, -0.01, -0.003)]]);
  morph('browDownRight', [['browR', brow(-1, -0.01, -0.003)]]);
  morph('browOuterUpLeft', [['browL', (v, c) => v.setY(v.y + 0.012 * Math.max(0, (Math.abs(v.x) - Math.abs(c.x) + 0.021) / 0.042))]]);
  morph('browOuterUpRight', [['browR', (v, c) => v.setY(v.y + 0.012 * Math.max(0, (Math.abs(v.x) - Math.abs(c.x) + 0.021) / 0.042))]]);
  fgeo.morphTargetsRelative = true;
  fgeo.morphAttributes.position = morphs.map(([, d]) => new THREE.Float32BufferAttribute(d, 3));
  fgeo.translate(-hp.x, -hp.y, -hp.z); // (doesn't touch relative morph deltas)
  const face = new THREE.Mesh(fgeo, [M.eyes, M.white, M.mouth, M.hair]);
  face.name = 'Face';
  face.updateMorphTargets();
  face.morphTargetDictionary = Object.fromEntries(morphs.map(([n], i) => [n, i]));
  face.morphTargetInfluences = morphs.map(() => 0);
  bones.head.add(face);

  // ---- hair: a cap and bangs on the head, plus skinned strands on spring bones
  const cap = mergeGeometries([
    ellipsoid(HEAD_C.clone().add(V(0, 0.012, -0.006)), V(0.162, 0.17, 0.158), 32, 20, { thetaLen: Math.PI * 0.5 }),
    ellipsoid(HEAD_C.clone().add(V(0, 0.0, -0.012)), V(0.163, 0.172, 0.158), 32, 20, { phi0: Math.PI * 1.1, phiLen: Math.PI * 0.8, theta0: Math.PI * 0.45, thetaLen: Math.PI * 0.3 }),
    // Bangs: flattened locks hanging over the forehead, tilted outwards a little.
    ...[-0.105, -0.05, 0, 0.05, 0.105].map((x, i) => {
      const g = new THREE.SphereGeometry(1, 16, 12);
      g.scale(0.042, 0.075 - (i % 2) * 0.012, 0.018);
      g.rotateZ(x * 2.2); g.rotateX(-0.35);
      g.translate(x, 1.515 - (i % 2) * 0.006, onHead(x, 1.51) + 0.006);
      return g;
    }),
  ].map((g) => g.toNonIndexed()));
  const capMesh = new THREE.Mesh(cap, M.hair);
  capMesh.name = 'HairCap';
  capMesh.geometry.translate(-hp.x, -hp.y, -hp.z);
  bones.head.add(capMesh);

  const strandGeos = []; const strandSegs = [];
  for (const s of strands) {
    const a = s.bones[0].userData.world; const b = s.bones[N - 1].userData.world;
    strandGeos.push(limb(a, b, s.r, s.r * 0.25, 16));
    for (let k = 0; k < N - 1; k++) strandSegs.push([s.bones[k].name, s.bones[k + 1].name]);
  }
  const hair = skinned(mergeGeometries(strandGeos), M.hair, skeleton, bones, strandSegs, 'HairStrands');
  root.add(hair);

  // ---- what a VRM file would carry, in document form
  const humanoid = { bones: Object.fromEntries(SKELETON.map(([n]) => n).filter((n) => !/_end$/.test(n)).map((n) => [n, n])) };
  const E = (binds, extra = {}) => ({ binds: binds.map(([morph, weight = 1]) => ({ mesh: 'Face', morph, weight })), isBinary: false, overrideBlink: 'none', overrideMouth: 'none', overrideLookAt: 'none', ...extra });
  const expressions = {
    happy: E([['mouthSmileLeft'], ['mouthSmileRight'], ['eyeSquintLeft'], ['eyeSquintRight'], ['browInnerUp', 0.3]], { overrideBlink: 'block' }),
    angry: E([['browDownLeft'], ['browDownRight'], ['mouthFrownLeft', 0.6], ['mouthFrownRight', 0.6]]),
    sad: E([['browInnerUp'], ['mouthFrownLeft'], ['mouthFrownRight'], ['eyeSquintLeft', 0.25], ['eyeSquintRight', 0.25]]),
    relaxed: E([['eyeSquintLeft', 0.6], ['eyeSquintRight', 0.6], ['mouthSmileLeft', 0.4], ['mouthSmileRight', 0.4]], { overrideBlink: 'blend' }),
    surprised: E([['eyeWideLeft'], ['eyeWideRight'], ['browInnerUp'], ['browOuterUpLeft'], ['browOuterUpRight'], ['mouthFunnel', 0.5]], { overrideBlink: 'block' }),
    aa: E([['jawOpen']]), ih: E([['mouthStretchLeft'], ['mouthStretchRight'], ['jawOpen', 0.25]]), ou: E([['mouthPucker']]),
    ee: E([['mouthStretchLeft', 0.8], ['mouthStretchRight', 0.8], ['jawOpen', 0.45]]), oh: E([['mouthFunnel']]),
    blink: E([['eyeBlinkLeft'], ['eyeBlinkRight']]), blinkLeft: E([['eyeBlinkLeft']]), blinkRight: E([['eyeBlinkRight']]),
    lookUp: E([['eyeLookUp']]), lookDown: E([['eyeLookDown']]), lookLeft: E([['eyeLookLeft']]), lookRight: E([['eyeLookRight']]),
    neutral: E([]),
  };
  const P = (x, y, z) => [x, y, z];
  const headLocal = (w) => w.clone().sub(hp).toArray().map((v) => +v.toFixed(4));
  const colliders = [
    { id: uid('c'), name: 'Head', bone: 'head', shape: 'sphere', offset: headLocal(HEAD_C.clone().add(V(0, 0.005, -0.005))), tail: P(0, 0, 0), radius: 0.145, group: 'Head' },
    { id: uid('c'), name: 'Upper chest', bone: 'upperChest', shape: 'capsule', offset: P(0, -0.12, -0.01), tail: P(0, 0.06, -0.01), radius: 0.11, group: 'Body' },
    { id: uid('c'), name: 'Left shoulder', bone: 'leftUpperArm', shape: 'sphere', offset: P(0, 0, 0), tail: P(0, 0, 0), radius: 0.055, group: 'Body' },
    { id: uid('c'), name: 'Right shoulder', bone: 'rightUpperArm', shape: 'sphere', offset: P(0, 0, 0), tail: P(0, 0, 0), radius: 0.055, group: 'Body' },
  ];
  const chains = strands.map((s) => ({
    id: uid('s'), name: s.name, bones: s.bones.map((b) => b.name), preset: 'hair',
    stiffness: 1.1, gravity: 0.08, gravityDir: [0, -1, 0], drag: 0.4, radius: 0.025, groups: ['Head', 'Body'],
  }));
  const file = {
    humanoid, expressions, springs: { chains, colliders }, lookAt: { type: 'expression', range: 1 },
    meta: { name: 'Starter avatar', authors: 'SoraLab', avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary', modification: 'allowModificationRedistribution', allowRedistribution: true },
  };
  return { root, format: 'starter', file };
}
