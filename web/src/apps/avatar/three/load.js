// Loading avatar files: VRM 0.x / 1.0 (three-vrm), glTF / GLB, FBX, and the code-built starter avatar. Every model goes
// through the same clean-up so the rest of the engine can treat them alike: unique, sanitised node and material names
// (the document refers to bones, meshes and materials by name, and names must survive a glTF round trip), MToon outlines
// folded back into one material (we draw outlines ourselves), and VRM's own runtime objects lifted out of the scene.
// What the file itself says about expressions, spring bones, humanoid bones, look-at and licence is returned as `file`,
// in document form, so an import can copy it into the project and the document stays the one source of truth.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { buildStarter } from './starter.js';
import { uid } from './model.js';

import { defaultAssetUrl } from './assetUrl.js';

export { defaultAssetUrl };

export function gltfLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

/** Loads doc.model. Returns { root, vrm, format, vrmVersion, scale, file, extraBinds, constraints }. */
export async function loadModel(model, { assetUrl = defaultAssetUrl } = {}) {
  if (!model) throw new Error('No model yet.');
  if (model.format === 'starter') return finish(buildStarter(model.starter), model);
  const manager = new THREE.LoadingManager();
  // .gltf / .fbx side files (buffers, textures) are separate assets: map their file names to asset URLs.
  const files = model.files || {};
  const lower = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  manager.setURLModifier((u) => {
    if (/^(data|blob):/.test(u)) return u;
    const name = decodeURIComponent(u.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
    const id = lower[name];
    return id ? assetUrl(id, /\.(png|jpe?g|webp|gif|bmp|tga)$/i.test(name) ? 'web' : 'file') : u;
  });
  const url = assetUrl(model.asset, 'file');
  if (model.format === 'fbx') {
    const root = await new FBXLoader(manager).loadAsync(url);
    return finish({ root, format: 'fbx', file: {} }, model);
  }
  const gltf = await gltfLoader(manager).loadAsync(url);
  return finish(fromGLTF(gltf), model);
}

/** Parses an already-fetched file (used to validate exports by re-importing them). */
export async function parseModel(buffer) {
  const gltf = await gltfLoader().parseAsync(buffer, '');
  return finish(fromGLTF(gltf), { format: 'glb' });
}

function fromGLTF(gltf) {
  const vrm = gltf.userData.vrm || null;
  const root = gltf.scene;
  if (!vrm) return { root, format: 'gltf', file: {}, animations: gltf.animations };
  const vrmVersion = vrm.meta?.metaVersion === '0' ? '0' : '1';
  if (vrmVersion === '0') VRMUtils.rotateVRM0(vrm); // VRM 0.x faces −Z; turn it to face +Z like VRM 1.0
  return { root, vrm, vrmVersion, format: 'vrm', file: {}, animations: gltf.animations };
}

function finish(loaded, model) {
  const { root, vrm } = loaded;
  uniqueNames(root);
  foldOutlines(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // skinned bounds don't follow the pose
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // some FBX / hand-made files have none
  });
  if (vrm) {
    loaded.file = { ...readVRM(vrm), ...loaded.file };
    loaded.extraBinds = loaded.extraBinds || {};
    for (const e of vrm.expressionManager?.expressions || []) {
      const extra = e.binds.filter((b) => !(b instanceof VRMExpressionMorphTargetBind));
      if (extra.length) loaded.extraBinds[e.expressionName] = extra;
    }
    loaded.constraints = vrm.nodeConstraintManager || null;
    // Our runtime builds its own humanoid, expressions and spring bones from the document: lift VRM's out.
    vrm.humanoid?.normalizedHumanBonesRoot?.removeFromParent();
    const strip = [];
    root.traverse((o) => { if (o.type === 'VRMExpression' || (o.shape && o.colliderMatrix)) strip.push(o); });
    strip.forEach((o) => o.removeFromParent());
  }
  // Scale: FBX files are often in centimetres. Aim for a person-sized avatar unless the document says otherwise.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  const scale = model.scale ?? (Number.isFinite(h) && (h > 5 || (h > 0 && h < 0.3)) ? 1.6 / h : 1);
  if (scale !== 1) { root.scale.multiplyScalar(scale); root.updateMatrixWorld(true); }
  return { ...loaded, scale };
}

/** Sanitised (glTF-safe) and unique names for every node and material, assigned in tree order, so they're stable. */
export function uniqueNames(root) {
  const seen = new Set();
  let i = 0;
  root.traverse((o) => {
    let n = THREE.PropertyBinding.sanitizeNodeName(o.name || '') || `${o.isBone ? 'Bone' : o.isMesh ? 'Mesh' : 'Node'}${i}`;
    i++;
    if (seen.has(n)) { let k = 2; while (seen.has(`${n}_${k}`)) k++; n = `${n}_${k}`; }
    seen.add(n); o.name = n;
  });
  const mats = new Map();
  const mseen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) {
      if (!m || mats.has(m)) continue;
      let n = (m.name || 'Material').replace(/\s*\(Outline\)$/, '');
      if (m.isOutline) { mats.set(m, n); continue; }
      if (mseen.has(n)) { let k = 2; while (mseen.has(`${n} ${k}`)) k++; n = `${n} ${k}`; }
      mseen.add(n); mats.set(m, n); m.name = n;
    }
  });
}

// three-vrm draws MToon outlines as a second material on the same geometry; we draw them as a sibling mesh instead
// (see runtime.js), so fold them back here.
function foldOutlines(root) {
  root.traverse((o) => {
    if (!o.isMesh || !Array.isArray(o.material)) return;
    const surf = o.material.filter((m) => !m.isOutline);
    if (surf.length === 1 && o.material.length === 2) { o.material = surf[0]; o.geometry.clearGroups(); }
  });
}

/** The name a document uses for a mesh: a glTF mesh with several primitives loads as a group of meshes, named as one. */
export const meshName = (m) => (m.parent && !m.parent.isBone && m.parent.children.length > 1 && m.parent.children.every((c) => c.isMesh && c.morphTargetDictionary
  && Object.keys(c.morphTargetDictionary).join() === Object.keys(m.morphTargetDictionary || {}).join()) ? m.parent.name : m.name);

export const morphName = (mesh, index) => {
  for (const [k, v] of Object.entries(mesh.morphTargetDictionary || {})) if (v === index) return k;
  return String(index);
};

// ---------------------------------------------------------------- reading a VRM's own settings into document form

function readVRM(vrm) {
  const out = {};
  // Humanoid
  const bones = {};
  for (const [name, hb] of Object.entries(vrm.humanoid?.humanBones || {})) if (hb?.node) bones[name] = hb.node.name;
  out.humanoid = { bones };
  // Expressions (morph binds; material colour / UV binds are kept on the side as extraBinds)
  const ex = {};
  for (const e of vrm.expressionManager?.expressions || []) {
    const binds = [];
    for (const b of e.binds) {
      if (!(b instanceof VRMExpressionMorphTargetBind)) continue;
      for (const m of b.primitives) {
        const bind = { mesh: meshName(m), morph: morphName(m, b.index), weight: +b.weight.toFixed(3) };
        if (!binds.some((x) => x.mesh === bind.mesh && x.morph === bind.morph)) binds.push(bind);
      }
    }
    ex[e.expressionName] = { binds, isBinary: !!e.isBinary, overrideBlink: e.overrideBlink || 'none', overrideMouth: e.overrideMouth || 'none', overrideLookAt: e.overrideLookAt || 'none' };
  }
  out.expressions = ex;
  // Look-at
  const ap = vrm.lookAt?.applier;
  if (ap) out.lookAt = { type: ap.constructor?.type === 'expression' || ap.expressions ? 'expression' : 'bone', range: +(ap.rangeMapHorizontalOuter?.outputScale ?? 10).toFixed(2) };
  // Spring bones: joints → chains (a chain follows bone → child while the child is itself a joint).
  const sm = vrm.springBoneManager;
  if (sm) {
    const colliders = [];
    const colId = new Map();
    const groupName = new Map();
    (sm.colliderGroups || []).forEach((g, gi) => {
      const gname = g.name || `Group ${gi + 1}`;
      for (const c of g.colliders) groupName.set(c, groupName.get(c) || gname);
    });
    for (const c of sm.colliders || []) {
      const s = c.shape;
      const id = uid('c');
      colId.set(c, id);
      colliders.push({ id, name: `${c.parent?.name || 'Collider'}`, bone: c.parent?.name || '', shape: s.type === 'capsule' ? 'capsule' : 'sphere',
        offset: s.offset.toArray().map((v) => +v.toFixed(4)), tail: s.tail ? s.tail.toArray().map((v) => +v.toFixed(4)) : [0, 0, 0], radius: +s.radius.toFixed(4), group: groupName.get(c) || 'Body' });
    }
    const joints = [...sm.joints];
    const byBone = new Map(joints.map((j) => [j.bone, j]));
    const isChild = new Set(joints.map((j) => j.child).filter(Boolean));
    const chains = [];
    for (const j of joints) {
      if (isChild.has(j.bone)) continue; // continues another chain
      const bones = [j.bone.name];
      let cur = j; let openEnd = false;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        if (cur.child) bones.push(cur.child.name); else openEnd = true; // VRM 0.x: the last bone swings with no tail node
        cur = cur.child ? byBone.get(cur.child) : null;
      }
      const s = j.settings;
      const groups = [...new Set((j.colliderGroups || []).flatMap((g) => g.colliders.map((c) => groupName.get(c))).filter(Boolean))];
      chains.push({ id: uid('s'), name: j.bone.name, bones, openEnd, stiffness: +s.stiffness.toFixed(3), gravity: +s.gravityPower.toFixed(3),
        gravityDir: s.gravityDir.toArray().map((v) => +v.toFixed(3)), drag: +s.dragForce.toFixed(3), radius: +s.hitRadius.toFixed(4), groups });
    }
    out.springs = { chains, colliders };
  }
  // Meta
  const m = vrm.meta;
  if (m) {
    if (m.metaVersion === '0') {
      const perm = { OnlyAuthor: 'onlyAuthor', ExplicitlyLicensedPerson: 'onlySeparatelyLicensedPerson', Everyone: 'everyone' };
      out.meta = {
        name: m.title || '', version: m.version || '', authors: m.author || '', contact: m.contactInformation || '', references: m.reference || '',
        avatarPermission: perm[m.allowedUserName] || 'onlyAuthor', allowExcessivelyViolentUsage: m.violentUsageName === 'Allow' || m.violentUssageName === 'Allow',
        allowExcessivelySexualUsage: m.sexualUsageName === 'Allow' || m.sexualUssageName === 'Allow',
        commercialUsage: (m.commercialUsageName || m.commercialUssageName) === 'Allow' ? 'personalProfit' : 'personalNonProfit',
        otherLicenseUrl: m.otherLicenseUrl || m.otherPermissionUrl || '', allowRedistribution: /CC0|CC_BY(?!.*ND)/.test(m.licenseName || ''),
        modification: /CC0|CC_BY$|CC_BY_SA/.test(m.licenseName || '') ? 'allowModificationRedistribution' : 'prohibited',
        creditNotation: /CC0/.test(m.licenseName || '') ? 'unnecessary' : 'required',
      };
    } else {
      out.meta = {
        name: m.name || '', version: m.version || '', authors: (m.authors || []).join(', '), copyright: m.copyrightInformation || '', contact: m.contactInformation || '',
        references: (m.references || []).join(', '), otherLicenseUrl: m.otherLicenseUrl || '',
        avatarPermission: m.avatarPermission || 'onlyAuthor', commercialUsage: m.commercialUsage || 'personalNonProfit', creditNotation: m.creditNotation || 'required',
        modification: m.modification || 'prohibited', allowExcessivelyViolentUsage: !!m.allowExcessivelyViolentUsage, allowExcessivelySexualUsage: !!m.allowExcessivelySexualUsage,
        allowPoliticalOrReligiousUsage: !!m.allowPoliticalOrReligiousUsage, allowAntisocialOrHateUsage: !!m.allowAntisocialOrHateUsage, allowRedistribution: !!m.allowRedistribution,
      };
    }
  }
  return out;
}

/** Frees GPU memory held by a loaded model. */
export function disposeModel(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of [o.material].flat()) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      for (const v of Object.values(m)) if (v?.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture && !seen.has(u.value)) { seen.add(u.value); u.value.dispose(); }
      m.dispose();
    }
    if (o.skeleton?.boneTexture) o.skeleton.dispose();
  });
}
