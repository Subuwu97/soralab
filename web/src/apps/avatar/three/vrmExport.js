// VRM 1.0 / glTF export. @pixiv/three-vrm (3.5) only loads VRM, so we write it ourselves: three's GLTFExporter does the
// meshes, skins, morph targets and textures, and a plugin adds the VRM 1.0 extensions from the document —
//   VRMC_vrm            humanoid bones, expressions (morph target binds), look-at, first person, meta + thumbnail
//   VRMC_springBone     colliders, collider groups and springs (joint chains)
//   VRMC_materials_mtoon on every MToon material (exported as a glTF material with the MToon extension)
// following https://github.com/vrm-c/vrm-specification/tree/master/specification (VRMC_vrm-1.0 etc.).
// VRM 0.x export isn't offered: 1.0 is what current tools (VSeeFace 1.13.38+, VRoid Hub, Warudo, VNyan, UniVRM) read.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { PRESETS } from './model.js';

const arr = (v) => v.toArray().map((x) => +x.toFixed(6));

/** GLB / glTF of a model root. vrm: { avatar, doc, thumbnail? } adds the VRM extensions. Returns ArrayBuffer or JSON. */
export async function exportRoot(root, { vrm = null, binary = true } = {}) {
  const undo = [];
  // Lift out editor/runtime-only objects (outlines, colliders, helpers).
  const extras = [];
  root.traverse((o) => { if (o !== root && o.userData.slExtra) extras.push(o); });
  for (const o of extras) { const p = o.parent; p.remove(o); undo.push(() => p.add(o)); }
  // Spring chains that end without a tail node (VRM 0.x style) get one, 7 cm along the last bone, like UniVRM does.
  const tails = new Map();
  if (vrm) {
    for (const ch of vrm.doc.springs?.chains || []) {
      if (!(ch.openEnd || ch.bones.length === 1)) continue;
      const last = vrm.avatar.node(ch.bones[ch.bones.length - 1]);
      if (!last) continue;
      const t = new THREE.Object3D();
      t.name = `${last.name}_tail`;
      const dir = last.position.lengthSq() > 1e-10 ? last.position.clone().normalize() : new THREE.Vector3(0, -1, 0);
      t.position.copy(dir.multiplyScalar(0.07 / Math.max(1e-6, last.getWorldScale(new THREE.Vector3()).x)));
      last.add(t); undo.push(() => t.removeFromParent());
      tails.set(ch.id, t);
    }
  }
  // MToon is a ShaderMaterial, which glTF can't hold: export a standard material carrying the MToon extension.
  const proxies = new Map();
  const proxy = (m) => {
    if (!m?.isMToonMaterial) return m;
    if (!proxies.has(m)) {
      const p = new THREE.MeshStandardMaterial({ name: m.name, color: m.color.clone(), map: m.map || null, transparent: m.transparent, alphaTest: m.alphaTest, side: m.side,
        emissive: m.emissive?.clone() || new THREE.Color(0), emissiveIntensity: m.emissiveIntensity ?? 1, emissiveMap: m.emissiveMap || null, normalMap: m.normalMap || null, metalness: 0, roughness: 1 });
      p.userData.mtoon = m;
      proxies.set(m, p);
    }
    return proxies.get(m);
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const n = Array.isArray(m) ? m.map(proxy) : proxy(m);
    if (n !== m) { o.material = n; undo.push(() => { o.material = m; }); }
  });
  root.updateMatrixWorld(true);
  try {
    const exporter = new GLTFExporter();
    exporter.register((writer) => new VRMWriter(writer, vrm, tails));
    return await exporter.parseAsync(root, { binary, onlyVisible: false, trs: true });
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    for (const p of proxies.values()) p.dispose();
    root.updateMatrixWorld(true);
  }
}

class VRMWriter {
  constructor(writer, vrm, tails) { this.writer = writer; this.vrm = vrm; this.tails = tails; this.name = 'VRMC_vrm'; }

  async writeMaterialAsync(material, def) {
    const m = material.userData.mtoon;
    if (!m) return;
    const w = this.writer;
    const tex = async (t) => (t ? { index: await w.processTextureAsync(t) } : undefined);
    const ext = {
      specVersion: '1.0', transparentWithZWrite: !!m.transparentWithZWrite, renderQueueOffsetNumber: 0,
      shadeColorFactor: arr(m.shadeColorFactor), shadeMultiplyTexture: await tex(m.shadeMultiplyTexture),
      shadingShiftFactor: m.shadingShiftFactor, shadingToonyFactor: m.shadingToonyFactor, giEqualizationFactor: m.giEqualizationFactor,
      matcapFactor: arr(m.matcapFactor), matcapTexture: await tex(m.matcapTexture),
      parametricRimColorFactor: arr(m.parametricRimColorFactor), rimMultiplyTexture: await tex(m.rimMultiplyTexture), rimLightingMixFactor: m.rimLightingMixFactor,
      parametricRimFresnelPowerFactor: m.parametricRimFresnelPowerFactor, parametricRimLiftFactor: m.parametricRimLiftFactor,
      outlineWidthMode: m.outlineWidthMode || 'none', outlineWidthFactor: m.outlineWidthFactor, outlineWidthMultiplyTexture: await tex(m.outlineWidthMultiplyTexture),
      outlineColorFactor: arr(m.outlineColorFactor), outlineLightingMixFactor: m.outlineLightingMixFactor,
      uvAnimationMaskTexture: await tex(m.uvAnimationMaskTexture), uvAnimationScrollXSpeedFactor: m.uvAnimationScrollXSpeedFactor,
      uvAnimationScrollYSpeedFactor: m.uvAnimationScrollYSpeedFactor, uvAnimationRotationSpeedFactor: m.uvAnimationRotationSpeedFactor,
    };
    for (const k of Object.keys(ext)) if (ext[k] === undefined) delete ext[k];
    def.extensions = def.extensions || {};
    def.extensions.VRMC_materials_mtoon = ext;
    this.writer.extensionsUsed.VRMC_materials_mtoon = true;
  }

  async afterParse() {
    if (!this.vrm) return;
    const { avatar, doc, thumbnail } = this.vrm;
    const w = this.writer; const json = w.json;
    const idx = (o) => (o ? w.nodeMap.get(o) : undefined);
    const nodeOf = (name) => idx(avatar.node(name));

    // ---- humanoid
    const humanBones = {};
    for (const [bone, name] of Object.entries(doc.humanoid?.bones || {})) { const i = nodeOf(name); if (i !== undefined) humanBones[bone] = { node: i }; }

    // ---- expressions
    const preset = {}; const custom = {};
    for (const [name, e] of Object.entries(doc.expressions || {})) {
      const morphTargetBinds = [];
      for (const b of e.binds || []) {
        for (const mesh of avatar.meshesFor(b.mesh)) {
          const i = idx(mesh); const index = mesh.morphTargetDictionary?.[b.morph];
          if (i !== undefined && index !== undefined) morphTargetBinds.push({ node: i, index, weight: Math.max(0, Math.min(1, Number(b.weight) || 0)) });
        }
      }
      const out = { morphTargetBinds, isBinary: !!e.isBinary, overrideBlink: e.overrideBlink || 'none', overrideLookAt: e.overrideLookAt || 'none', overrideMouth: e.overrideMouth || 'none' };
      (PRESETS.includes(name) ? preset : custom)[name] = out;
    }

    // ---- look-at (runtime maps ±30° of input; the file uses the spec's usual 90° input range)
    const lookType = avatar.lookAt?.applier?.expressions ? 'expression' : 'bone';
    const range = lookType === 'expression' ? 1 : Number(doc.lookAt?.range) || 10;
    const rm = { inputMaxValue: 90, outputScale: range };
    const head = avatar.humanoid?.getRawBoneNode('head');
    let offset = [0, 0.06, 0];
    if (head) {
      // Between the eyes when there are eye bones, else a little above the head bone.
      const eyes = ['leftEye', 'rightEye'].map((b) => avatar.humanoid.getRawBoneNode(b)).filter(Boolean);
      if (eyes.length) {
        const c = eyes.reduce((s, e) => s.add(e.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).divideScalar(eyes.length);
        offset = arr(head.worldToLocal(c));
      }
    }

    // ---- meta
    const m = doc.meta || {};
    const meta = {
      name: m.name || doc.name || 'Avatar', version: m.version || undefined,
      authors: String(m.authors || '').split(',').map((s) => s.trim()).filter(Boolean),
      copyrightInformation: m.copyright || undefined, contactInformation: m.contact || undefined,
      references: String(m.references || '').split(',').map((s) => s.trim()).filter(Boolean),
      licenseUrl: 'https://vrm.dev/licenses/1.0/',
      avatarPermission: m.avatarPermission || 'onlyAuthor', allowExcessivelyViolentUsage: !!m.allowExcessivelyViolentUsage,
      allowExcessivelySexualUsage: !!m.allowExcessivelySexualUsage, commercialUsage: m.commercialUsage || 'personalNonProfit',
      allowPoliticalOrReligiousUsage: !!m.allowPoliticalOrReligiousUsage, allowAntisocialOrHateUsage: !!m.allowAntisocialOrHateUsage,
      creditNotation: m.creditNotation || 'required', allowRedistribution: !!m.allowRedistribution, modification: m.modification || 'prohibited',
      otherLicenseUrl: m.otherLicenseUrl || undefined,
    };
    if (!meta.authors.length) meta.authors = ['Unknown'];
    if (!meta.references.length) delete meta.references;
    if (thumbnail) {
      const t = new THREE.CanvasTexture(thumbnail);
      t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
      const ti = await w.processTextureAsync(t);
      meta.thumbnailImage = json.textures[ti].source;
    }
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];

    json.extensions = json.extensions || {};
    json.extensions.VRMC_vrm = {
      specVersion: '1.0', meta, humanoid: { humanBones },
      firstPerson: { meshAnnotations: [] },
      lookAt: { offsetFromHeadBone: offset, type: lookType, rangeMapHorizontalInner: rm, rangeMapHorizontalOuter: rm, rangeMapVerticalDown: rm, rangeMapVerticalUp: rm },
      expressions: { preset, custom },
    };
    w.extensionsUsed.VRMC_vrm = true;

    // ---- spring bones
    const sp = doc.springs || {};
    const colliders = []; const groupIdx = new Map(); const groups = [];
    for (const c of sp.colliders || []) {
      const node = nodeOf(c.bone);
      if (node === undefined) continue;
      const shape = c.shape === 'capsule' ? { capsule: { offset: c.offset || [0, 0, 0], radius: c.radius, tail: c.tail || [0, 0, 0] } } : { sphere: { offset: c.offset || [0, 0, 0], radius: c.radius } };
      const ci = colliders.push({ node, shape }) - 1;
      const g = c.group || 'Body';
      if (!groupIdx.has(g)) groupIdx.set(g, groups.push({ name: g, colliders: [] }) - 1);
      groups[groupIdx.get(g)].colliders.push(ci);
    }
    const springs = [];
    for (const ch of sp.chains || []) {
      const nodes = (ch.bones || []).map(nodeOf).filter((i) => i !== undefined);
      const tail = this.tails.get(ch.id);
      if (tail && idx(tail) !== undefined) nodes.push(idx(tail));
      if (nodes.length < 2) continue;
      const joint = { hitRadius: ch.radius ?? 0.02, stiffness: ch.stiffness ?? 1, gravityPower: ch.gravity ?? 0, gravityDir: ch.gravityDir || [0, -1, 0], dragForce: ch.drag ?? 0.4 };
      springs.push({ name: ch.name || 'Spring', joints: nodes.map((node) => ({ node, ...joint })), colliderGroups: (ch.groups || []).map((g) => groupIdx.get(g)).filter((i) => i !== undefined) });
    }
    if (springs.length || colliders.length) {
      json.extensions.VRMC_springBone = { specVersion: '1.0', colliders, colliderGroups: groups, springs };
      w.extensionsUsed.VRMC_springBone = true;
    }
  }
}

/** A VRM 1.0 file (ArrayBuffer) of a live avatar, at rest. */
export async function exportVRM(avatar, doc, { thumbnail } = {}) {
  avatar.toRest();
  try {
    return await exportRoot(avatar.root, { vrm: { avatar, doc, thumbnail }, binary: true });
  } finally {
    avatar.restore();
  }
}

/** Plain glTF (no VRM extensions, MToon kept as an extension). binary: GLB (ArrayBuffer) or .gltf JSON. */
export async function exportGLTF(avatar, { binary = true } = {}) {
  avatar.toRest();
  try {
    return await exportRoot(avatar.root, { binary });
  } finally {
    avatar.restore();
  }
}
