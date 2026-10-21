// The live avatar: a loaded model plus everything the document layers on top — a VRM humanoid (normalized bones that
// tracking rotates), expressions, look-at, spring bones with colliders, and materials. apply(doc) rebuilds only the
// parts whose section of the document changed, so slider drags stay cheap. Used by the editor, the stage and export.
import * as THREE from 'three';
import {
  VRMHumanoid, VRMExpressionManager, VRMExpression, VRMExpressionMorphTargetBind, VRMLookAt, VRMLookAtBoneApplier, VRMLookAtExpressionApplier,
  VRMLookAtRangeMap, VRMSpringBoneManager, VRMSpringBoneJoint, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere, VRMSpringBoneColliderShapeCapsule, MToonMaterial,
} from '@pixiv/three-vrm';
import { loadModel, disposeModel, morphName, meshName, defaultAssetUrl } from './load.js';
import { listBones } from './humanoid.js';
import { Driver } from './tracking.js';
import { ARKIT, DEFAULT_DRIVE, HUMAN_BONES } from './model.js';

const ARKIT_KEYS = new Map(ARKIT.map((k) => [k.toLowerCase(), k]));
const arkitKey = (name) => {
  const n = String(name).toLowerCase().replace(/^.*[.:|]/, '').replace(/^(blendshape\d*|bs|arkit|ar)[_-]?/, '').replace(/[^a-z]/g, '');
  return ARKIT_KEYS.get(n) || ARKIT_KEYS.get(n.replace(/_?l$/, 'left').replace(/_?r$/, 'right')) || null;
};
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
const hex = (c) => (c ? `#${c.getHexString()}` : null);

export class Avatar {
  static async load(doc, opts = {}) {
    const loaded = await loadModel(doc.model, opts);
    const a = new Avatar(loaded, opts);
    await a.apply(doc);
    return a;
  }

  constructor(loaded, { assetUrl = defaultAssetUrl } = {}) {
    this.loaded = loaded;
    this.root = loaded.root;
    this.assetUrl = assetUrl;
    this.holder = new THREE.Group(); // identity frame: the model plus the normalized humanoid rig
    this.holder.name = 'AvatarHolder';
    this.holder.add(this.root);
    this.nodes = new Map();
    this.root.traverse((o) => this.nodes.set(o.name, o));
    this.meshes = [];
    this.root.traverse((o) => { if (o.isMesh) this.meshes.push(o); });
    this.orig = new Map(this.meshes.map((m) => [m, m.material]));
    this.rest = new Map();
    this.root.traverse((o) => this.rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
    const { bones, deform } = listBones(this.root);
    this.bones = bones; this.deform = deform;
    const box = new THREE.Box3().setFromObject(this.root);
    this.box = box; this.height = Math.max(0.1, box.max.y - box.min.y);
    this.sig = {};
    this.preview = {};
    this.tracking = { ...DEFAULT_DRIVE }; // doc.drive
    this.textures = new Map();
    this.created = [];
    this.outlines = [];
    this.colliderObjects = [];
    this.armAngle = 0;
    this.driver = new Driver(this);
    // ARKit-named morphs, for perfect sync.
    this.arkit = [];
    for (const m of this.meshes) for (const [name, i] of Object.entries(m.morphTargetDictionary || {})) { const k = arkitKey(name); if (k) this.arkit.push({ mesh: m, index: i, key: k }); }
    this.arkitCount = new Set(this.arkit.map((x) => x.key)).size;
  }

  node(name) { return name ? this.nodes.get(name) || null : null; }
  /** Meshes a document name refers to (a glTF mesh with several primitives is a group of meshes). */
  meshesFor(name) {
    const n = this.node(name);
    if (!n) return [];
    if (n.isMesh) return [n];
    const out = []; n.traverse((o) => { if (o.isMesh && !o.userData.slExtra) out.push(o); });
    return out;
  }
  /** [{ mesh: name, morphs: [names] }] */
  morphList() {
    const seen = new Set();
    return this.meshes.filter((m) => m.morphTargetDictionary && Object.keys(m.morphTargetDictionary).length)
      .map((m) => ({ mesh: meshName(m), morphs: Object.keys(m.morphTargetDictionary).sort((a, b) => m.morphTargetDictionary[a] - m.morphTargetDictionary[b]) }))
      .filter((x) => !seen.has(x.mesh) && seen.add(x.mesh));
  }
  hasExpr(name) { return !!this.expressions?.getExpression(name); }
  perfectSyncActive(pose) {
    const mode = this.tracking.perfectSync;
    return !!pose?.blend && this.arkitCount > 0 && (mode === 'on' || (mode === 'auto' && this.arkitCount >= 40));
  }
  stats() {
    let tris = 0;
    for (const m of this.meshes) { const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
    return { meshes: this.meshes.length, tris: Math.round(tris), bones: this.bones.length, morphs: this.morphList().reduce((s, m) => s + m.morphs.length, 0), arkit: this.arkitCount, skinned: this.meshes.some((m) => m.isSkinnedMesh) };
  }

  /** Puts every node back in its rest transform. */
  restore() {
    for (const [o, [p, q, s]] of this.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
    this.root.updateMatrixWorld(true);
  }

  async apply(doc) {
    const s = (k) => JSON.stringify(doc[k] ?? null);
    const changed = (k) => { const v = s(k); if (this.sig[k] === v) return false; this.sig[k] = v; return true; };
    this.tracking = { ...DEFAULT_DRIVE, ...(doc.drive || {}) };
    const hum = changed('humanoid'); const exp = changed('expressions'); const spr = changed('springs'); const look = changed('lookAt');
    if (hum || spr) this.restore();
    if (hum) this.buildHumanoid(doc.humanoid?.bones || {});
    if (exp) this.buildExpressions(doc.expressions || {});
    if (hum || exp || look) this.buildLookAt(doc.lookAt || {});
    if (hum || spr) this.buildSprings(doc.springs || {});
    this.armAngle = this.tracking.armAngle ?? this.autoArm ?? 0;
    if (changed('materials')) await this.buildMaterials(doc.materials || {});
  }

  // ---------------------------------------------------------------- humanoid
  buildHumanoid(map) {
    this.humanoid?.normalizedHumanBonesRoot?.removeFromParent();
    this.humanoid = null;
    const bones = {};
    for (const b of HUMAN_BONES) { const n = this.node(map[b]); if (n) bones[b] = { node: n }; }
    if (!bones.hips || !bones.head) { this.autoArm = 0; return; }
    this.root.updateMatrixWorld(true);
    this.humanoid = new VRMHumanoid(bones, { autoUpdateHumanBones: true });
    this.holder.add(this.humanoid.normalizedHumanBonesRoot);
    // Automatic "arms down": T-posed arms point sideways; lower them to about 70° below horizontal.
    const ua = bones.leftUpperArm?.node; const la = bones.leftLowerArm?.node;
    if (ua && la) {
      const d = la.getWorldPosition(new THREE.Vector3()).sub(ua.getWorldPosition(new THREE.Vector3()));
      const below = Math.atan2(-d.y, Math.hypot(d.x, d.z)) * THREE.MathUtils.RAD2DEG;
      this.autoArm = Math.max(0, 68 - below);
    } else this.autoArm = 0;
  }

  // ---------------------------------------------------------------- expressions
  buildExpressions(exprs) {
    this.expressions?.resetValues?.();
    this.expressions?.update?.();
    const m = new VRMExpressionManager();
    for (const [name, e] of Object.entries(exprs)) {
      const x = new VRMExpression(name);
      x.isBinary = !!e.isBinary;
      x.overrideBlink = e.overrideBlink || 'none'; x.overrideMouth = e.overrideMouth || 'none'; x.overrideLookAt = e.overrideLookAt || 'none';
      for (const b of e.binds || []) {
        for (const mesh of this.meshesFor(b.mesh)) {
          const index = mesh.morphTargetDictionary?.[b.morph] ?? (/^\d+$/.test(b.morph) ? Number(b.morph) : undefined);
          if (index === undefined || index >= (mesh.morphTargetInfluences?.length || 0)) continue;
          x.addBind(new VRMExpressionMorphTargetBind({ primitives: [mesh], index, weight: Number(b.weight) || 0 }));
        }
      }
      for (const b of this.loaded.extraBinds?.[name] || []) x.addBind(b); // material colour / UV binds from the VRM file
      m.registerExpression(x);
    }
    this.expressions = m;
  }

  // ---------------------------------------------------------------- look-at
  buildLookAt(cfg) {
    this.lookAt = null;
    const h = this.humanoid;
    if (!h) return;
    const range = Number(cfg.range) || 10;
    const hasEyes = h.getRawBoneNode('leftEye') || h.getRawBoneNode('rightEye');
    const hasLookExpr = ['lookUp', 'lookDown', 'lookLeft', 'lookRight'].some((n) => this.expressions?.getExpression(n)?.binds.length);
    const type = cfg.type === 'bone' || cfg.type === 'expression' ? cfg.type : hasEyes ? 'bone' : hasLookExpr ? 'expression' : null;
    if (type === 'bone' && hasEyes) {
      const r = () => new VRMLookAtRangeMap(30, range);
      this.lookAt = new VRMLookAt(h, new VRMLookAtBoneApplier(h, r(), r(), r(), r()));
    } else if (type === 'expression' && this.expressions) {
      const r = () => new VRMLookAtRangeMap(30, 1);
      this.lookAt = new VRMLookAt(h, new VRMLookAtExpressionApplier(this.expressions, r(), r(), r(), r()));
    }
    if (this.lookAt) this.lookAt.autoUpdate = true;
  }

  // ---------------------------------------------------------------- spring bones
  buildSprings(cfg) {
    for (const c of this.colliderObjects) c.removeFromParent();
    this.colliderObjects = [];
    const groups = new Map();
    for (const c of cfg.colliders || []) {
      const bone = this.node(c.bone);
      if (!bone) continue;
      const offset = new THREE.Vector3(...(c.offset || [0, 0, 0]));
      const shape = c.shape === 'capsule'
        ? new VRMSpringBoneColliderShapeCapsule({ offset, tail: new THREE.Vector3(...(c.tail || [0, 0, 0])), radius: c.radius })
        : new VRMSpringBoneColliderShapeSphere({ offset, radius: c.radius });
      const col = new VRMSpringBoneCollider(shape);
      col.name = `Collider_${c.id}`; col.userData.slExtra = true; col.userData.id = c.id;
      bone.add(col);
      this.colliderObjects.push(col);
      const g = c.group || 'Body';
      if (!groups.has(g)) groups.set(g, { name: g, colliders: [] });
      groups.get(g).colliders.push(col);
    }
    const sm = new VRMSpringBoneManager();
    for (const ch of cfg.chains || []) {
      const nodes = (ch.bones || []).map((n) => this.node(n)).filter(Boolean);
      if (!nodes.length) continue;
      const set = { hitRadius: ch.radius ?? 0.02, stiffness: ch.stiffness ?? 1, gravityPower: ch.gravity ?? 0, gravityDir: new THREE.Vector3(...(ch.gravityDir || [0, -1, 0])), dragForce: ch.drag ?? 0.4 };
      const cg = (ch.groups || []).map((g) => groups.get(g)).filter(Boolean);
      for (let i = 0; i < nodes.length - 1; i++) sm.addJoint(new VRMSpringBoneJoint(nodes[i], nodes[i + 1], { ...set, gravityDir: set.gravityDir.clone() }, cg));
      if (ch.openEnd || nodes.length === 1) sm.addJoint(new VRMSpringBoneJoint(nodes[nodes.length - 1], null, { ...set, gravityDir: set.gravityDir.clone() }, cg));
    }
    this.root.updateMatrixWorld(true);
    sm.setInitState();
    this.springs = sm;
    this.colliderGroups = groups;
  }

  // ---------------------------------------------------------------- materials
  texture(id, like) {
    if (!this.textures.has(id)) {
      this.textures.set(id, new THREE.TextureLoader().loadAsync(this.assetUrl(id, 'web')).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }).catch(() => null));
    }
    return this.textures.get(id).then((t) => {
      if (!t) return null;
      // Match the original texture's orientation and wrapping (glTF textures aren't flipped; FBX ones are).
      t.flipY = like ? like.flipY : false;
      if (like) { t.wrapS = like.wrapS; t.wrapT = like.wrapT; t.repeat.copy(like.repeat); t.offset.copy(like.offset); }
      t.needsUpdate = true;
      return t;
    });
  }

  /** Material slots as the Look panel shows them: name, original type and current values. */
  materialList() {
    const seen = new Map();
    for (const [, mat] of this.orig) for (const m of [mat].flat()) if (m && !seen.has(m.name)) seen.set(m.name, m);
    return [...seen.values()].map((m) => ({
      name: m.name, type: m.isMToonMaterial ? 'MToon' : m.isMeshBasicMaterial ? 'Unlit' : m.isMeshStandardMaterial ? 'Standard' : m.type.replace(/^Mesh|Material$/g, ''),
      color: hex(m.color) || '#ffffff', shade: hex(m.shadeColorFactor), outline: m.isMToonMaterial && m.outlineWidthMode !== 'none' ? m.outlineWidthFactor : 0,
      outlineColor: hex(m.outlineColorFactor), rim: hex(m.parametricRimColorFactor), rimPower: m.parametricRimFresnelPowerFactor, emission: hex(m.emissive) || '#000000',
      emissionStrength: m.emissiveIntensity ?? 1, hasMap: !!m.map, toony: m.shadingToonyFactor, shadeShift: m.shadingShiftFactor,
    }));
  }

  async buildMaterials(cfgs) {
    const token = (this.matToken = (this.matToken || 0) + 1);
    // Load swapped textures first so the change lands in one frame.
    const maps = {};
    await Promise.all(Object.entries(cfgs).filter(([, c]) => c?.map).map(async ([name, c]) => {
      const like = [...this.orig.values()].flat().find((m) => m?.name === name)?.map || null;
      maps[name] = await this.texture(c.map, like);
    }));
    if (token !== this.matToken) return;
    for (const o of this.outlines) o.removeFromParent();
    this.outlines = [];
    const old = this.created; this.created = [];
    const made = new Map();
    const make = (orig) => {
      if (!orig) return orig;
      if (!made.has(orig)) made.set(orig, this.makeMaterial(orig, cfgs[orig.name], maps[orig.name]));
      return made.get(orig);
    };
    for (const mesh of this.meshes) {
      const orig = this.orig.get(mesh);
      const list = [orig].flat().map(make);
      mesh.material = Array.isArray(orig) ? list : list[0];
      // Outlines: a back-face copy of the mesh sharing geometry, skeleton and morph weights.
      const outl = list.map((m) => (m?.isMToonMaterial && m.outlineWidthMode !== 'none' && m.outlineWidthFactor > 0 ? m : null));
      if (!outl.some(Boolean)) continue;
      const mats = outl.map((m) => {
        if (!m) return HIDDEN;
        const o = m.clone(); o.isOutline = true; o.side = THREE.BackSide; o.name = `${m.name} (Outline)`;
        this.created.push(o);
        return o;
      });
      const o = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, Array.isArray(orig) ? mats : mats[0]) : new THREE.Mesh(mesh.geometry, Array.isArray(orig) ? mats : mats[0]);
      o.name = `${mesh.name}__outline`; o.userData.slExtra = true; o.frustumCulled = false; o.renderOrder = mesh.renderOrder;
      o.position.copy(mesh.position); o.quaternion.copy(mesh.quaternion); o.scale.copy(mesh.scale);
      if (mesh.isSkinnedMesh) { o.bindMode = mesh.bindMode; o.bind(mesh.skeleton, mesh.bindMatrix); }
      if (mesh.morphTargetInfluences) { o.morphTargetInfluences = mesh.morphTargetInfluences; o.morphTargetDictionary = mesh.morphTargetDictionary; }
      mesh.parent.add(o);
      this.outlines.push(o);
    }
    for (const m of old) if (!this.created.includes(m)) m.dispose();
    this.mtoon = [...new Set(this.meshes.flatMap((m) => [m.material].flat()).concat(this.created))].filter((m) => m?.isMToonMaterial);
  }

  makeMaterial(orig, cfg, map) {
    if (!cfg || !Object.keys(cfg).some((k) => cfg[k] !== undefined && cfg[k] !== null && !(k === 'type' && cfg[k] === 'keep'))) return orig;
    const type = cfg.type || 'keep';
    const base = { map: map || orig.map || null, transparent: orig.transparent, alphaTest: orig.alphaTest, side: orig.side, opacity: orig.opacity ?? 1 };
    const color = orig.color?.clone() || new THREE.Color(1, 1, 1);
    let m;
    if (type === 'keep' || (type === 'mtoon' && orig.isMToonMaterial)) m = orig.clone();
    else if (type === 'mtoon') {
      m = new MToonMaterial({ ...base, color, normalMap: orig.normalMap || null, shadeColorFactor: color.clone().multiplyScalar(0.62), shadingToonyFactor: 0.9, shadingShiftFactor: -0.05, outlineWidthMode: 'none', outlineWidthFactor: 0 });
      if (orig.emissive) { m.emissive.copy(orig.emissive); m.emissiveMap = orig.emissiveMap || null; }
    } else if (type === 'unlit') m = new THREE.MeshBasicMaterial({ ...base, color });
    else m = new THREE.MeshStandardMaterial({ ...base, color, roughness: 0.75, metalness: 0, normalMap: orig.normalMap || null, emissive: orig.emissive?.clone() || new THREE.Color(0), emissiveMap: orig.emissiveMap || null });
    m.name = orig.name;
    if (map) m.map = map;
    if (cfg.color) m.color?.set(cfg.color);
    if (m.isMToonMaterial) {
      if (cfg.shade) m.shadeColorFactor.set(cfg.shade);
      if (cfg.outline !== undefined && cfg.outline !== null) { m.outlineWidthFactor = cfg.outline; m.outlineWidthMode = cfg.outline > 0 ? 'worldCoordinates' : 'none'; }
      if (cfg.outlineColor) m.outlineColorFactor.set(cfg.outlineColor);
      if (cfg.rim) m.parametricRimColorFactor.set(cfg.rim);
      if (cfg.rimPower !== undefined && cfg.rimPower !== null) m.parametricRimFresnelPowerFactor = cfg.rimPower;
      if (cfg.toony !== undefined && cfg.toony !== null) m.shadingToonyFactor = cfg.toony;
      if (cfg.shadeShift !== undefined && cfg.shadeShift !== null) m.shadingShiftFactor = cfg.shadeShift;
    }
    if (cfg.emission && m.emissive) m.emissive.set(cfg.emission);
    if (cfg.emissionStrength !== undefined && cfg.emissionStrength !== null && 'emissiveIntensity' in m) m.emissiveIntensity = cfg.emissionStrength;
    m.needsUpdate = true;
    this.created.push(m);
    return m;
  }

  // ---------------------------------------------------------------- per frame
  setPose(pose) { this.driver.setPose(pose); }
  setPreview(map) { this.preview = map || {}; }

  update(dt) {
    dt = Math.min(Math.max(dt, 0), 1 / 15);
    this.driver.apply(dt);
    this.humanoid?.update();
    this.lookAt?.update(dt);
    this.expressions?.update();
    // Perfect sync: ARKit-named shapes straight from tracking, on top of the expressions.
    const blend = this.driver.sync;
    if (blend) {
      const m = this.tracking.mirror;
      for (const { mesh, index, key } of this.arkit) {
        const k = m ? key.replace(/Left|Right/, (x) => (x === 'Left' ? 'Right' : 'Left')) : key;
        const v = blend[k];
        if (Number.isFinite(v)) mesh.morphTargetInfluences[index] = Math.max(mesh.morphTargetInfluences[index], Math.min(1, v));
      }
    }
    this.holder.updateMatrixWorld(true);
    this.loaded.constraints?.update?.();
    this.springs?.update(dt);
    if (this.mtoon) for (const m of this.mtoon) m.update?.(dt);
  }

  /** Rest pose, no expressions, springs settled: for export, weight painting and auto-rig. */
  toRest() {
    this.humanoid?.resetNormalizedPose();
    this.humanoid?.update();
    this.expressions?.resetValues();
    this.expressions?.update();
    this.restore();
    this.springs?.reset();
    this.holder.updateMatrixWorld(true);
  }

  dispose() {
    this.holder.removeFromParent();
    for (const m of this.created) m.dispose();
    for (const p of this.textures.values()) p.then((t) => t?.dispose());
    disposeModel(this.root);
  }
}

export { morphName };
