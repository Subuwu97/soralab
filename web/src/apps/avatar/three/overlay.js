// Editor overlays drawn over the avatar (never exported): the skeleton as clickable joints and lines (coloured by
// role: humanoid, spring bone, other, selected), spring collider and joint helpers, auto-rig joint markers, and the
// weight brush cursor.
import * as THREE from 'three';
import { VRMSpringBoneColliderHelper, VRMSpringBoneJointHelper } from '@pixiv/three-vrm';
import { MARKERS } from './autorig.js';

const COL = { human: new THREE.Color('#5ab4ff'), spring: new THREE.Color('#5ee3a1'), other: new THREE.Color('#9aa3b8'), selected: new THREE.Color('#ffd166'), marker: new THREE.Color('#ff7aa8'), markerSel: new THREE.Color('#ffd166') };
const onTop = (m) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };

export class Overlay {
  constructor(vp) {
    this.vp = vp; this.group = vp.helpers;
    this.opts = { skeleton: false, colliders: true, joints: false, selected: null };
    this.skel = null; this.springHelpers = []; this.markers = null; this.brush = null;
  }

  setAvatar(a) { this.avatar = a; this.buildSkeleton(); this.syncSprings(true); }
  setOptions(o) {
    const springsChanged = o.colliders !== this.opts.colliders || o.joints !== this.opts.joints;
    Object.assign(this.opts, o);
    if (this.skel) this.skel.group.visible = !!this.opts.skeleton;
    if (springsChanged) this.syncSprings(true);
  }

  // ---------------------------------------------------------------- skeleton
  buildSkeleton() {
    if (this.skel) { this.group.remove(this.skel.group); this.skel.inst.geometry.dispose(); this.skel.inst.material.dispose(); this.skel.lines.geometry.dispose(); this.skel.lines.material.dispose(); }
    this.skel = null;
    const a = this.avatar;
    if (!a || !a.bones.length) return;
    const bones = a.bones;
    const r = a.height * 0.0075;
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 10, 8), onTop(new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.95 })), bones.length);
    inst.renderOrder = 1000; inst.frustumCulled = false;
    const idx = new Map(bones.map((b, i) => [b, i]));
    const pairs = bones.map((b, i) => [i, idx.get(b.parent)]).filter(([, p]) => p !== undefined);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pairs.length * 6), 3));
    const lines = new THREE.LineSegments(lg, onTop(new THREE.LineBasicMaterial({ color: '#cfd6ea', opacity: 0.55 })));
    lines.renderOrder = 999; lines.frustumCulled = false;
    const group = new THREE.Group(); group.add(lines, inst); group.visible = !!this.opts.skeleton;
    this.group.add(group);
    this.skel = { group, inst, lines, bones, pairs };
  }
  roles() {
    const a = this.avatar; const human = new Set(); const spring = new Set();
    if (a?.humanoid) for (const hb of Object.values(a.humanoid.humanBones)) if (hb?.node) human.add(hb.node);
    if (a?.springs) for (const j of a.springs.joints) { spring.add(j.bone); if (j.child) spring.add(j.child); }
    return { human, spring };
  }

  update() {
    const s = this.skel;
    if (s && s.group.visible) {
      const { human, spring } = this.roles();
      const m = new THREE.Matrix4(); const p = new THREE.Vector3(); const pos = s.lines.geometry.attributes.position;
      const sel = this.opts.selected;
      // Keep joints about the same size on screen whatever the zoom.
      const k = Math.min(1, this.vp.camera.position.distanceTo(this.vp.target) / (this.avatar.height * 2.2));
      s.bones.forEach((b, i) => {
        b.getWorldPosition(p);
        const big = (b.name === sel ? 1.8 : human.has(b) ? 1.2 : 1) * Math.max(0.25, k);
        m.makeScale(big, big, big).setPosition(p);
        s.inst.setMatrixAt(i, m);
        s.inst.setColorAt(i, b.name === sel ? COL.selected : human.has(b) ? COL.human : spring.has(b) ? COL.spring : COL.other);
      });
      s.pairs.forEach(([i, j], k) => {
        s.bones[i].getWorldPosition(p); pos.setXYZ(k * 2, p.x, p.y, p.z);
        s.bones[j].getWorldPosition(p); pos.setXYZ(k * 2 + 1, p.x, p.y, p.z);
      });
      s.inst.instanceMatrix.needsUpdate = true; if (s.inst.instanceColor) s.inst.instanceColor.needsUpdate = true;
      pos.needsUpdate = true;
    }
    if (this.springSig !== this.avatar?.springs) this.syncSprings();
  }
  pickBone(ray) {
    const s = this.skel;
    if (!s || !s.group.visible) return null;
    const hit = ray.intersectObject(s.inst, false)[0];
    return hit ? s.bones[hit.instanceId] : null;
  }

  // ---------------------------------------------------------------- spring helpers
  syncSprings(force) {
    const a = this.avatar;
    if (!force && this.springSig === a?.springs) return;
    this.springSig = a?.springs;
    for (const h of this.springHelpers) { h.removeFromParent(); h.dispose?.(); }
    this.springHelpers = [];
    if (!a?.springs) return;
    if (this.opts.colliders) for (const c of a.colliderObjects) this.springHelpers.push(new VRMSpringBoneColliderHelper(c));
    if (this.opts.joints) for (const j of a.springs.joints) this.springHelpers.push(new VRMSpringBoneJointHelper(j));
    for (const h of this.springHelpers) { h.renderOrder = 998; h.traverse((o) => { if (o.material) onTop(o.material); }); this.group.add(h); }
  }

  // ---------------------------------------------------------------- auto-rig markers
  setMarkers(markers, selected) {
    if (!markers) { if (this.markers) { this.group.remove(this.markers.group); this.markers = null; } return; }
    if (!this.markers) {
      const group = new THREE.Group();
      const H = this.avatar?.height || 1.6;
      const geo = new THREE.SphereGeometry(H * 0.016, 16, 12);
      const spheres = {};
      for (const [k] of MARKERS) { const m = new THREE.Mesh(geo, onTop(new THREE.MeshBasicMaterial({ color: COL.marker }))); m.renderOrder = 1001; m.userData.key = k; spheres[k] = m; group.add(m); }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(LINKS.length * 6), 3));
      const lines = new THREE.LineSegments(lg, onTop(new THREE.LineBasicMaterial({ color: '#ffb3cc', opacity: 0.8 })));
      lines.renderOrder = 1000; group.add(lines);
      this.group.add(group);
      this.markers = { group, spheres, lines };
    }
    const { spheres, lines } = this.markers;
    for (const [k, m] of Object.entries(spheres)) { if (markers[k]) m.position.fromArray(markers[k]); m.material.color.copy(k === selected ? COL.markerSel : COL.marker); }
    const pos = lines.geometry.attributes.position;
    LINKS.forEach(([a, b], i) => {
      const pa = linkPoint(markers, a); const pb = linkPoint(markers, b);
      pos.setXYZ(i * 2, ...pa); pos.setXYZ(i * 2 + 1, ...pb);
    });
    pos.needsUpdate = true;
  }
  pickMarker(ray) {
    if (!this.markers) return null;
    const hit = ray.intersectObjects(Object.values(this.markers.spheres), false)[0];
    return hit ? hit.object.userData.key : null;
  }

  // ---------------------------------------------------------------- weight brush cursor
  setBrush(point, radius) {
    if (!point) { if (this.brush) this.brush.visible = false; return; }
    if (!this.brush) {
      this.brush = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), onTop(new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, opacity: 0.35 })));
      this.brush.renderOrder = 1002; this.group.add(this.brush);
    }
    this.brush.visible = true; this.brush.position.copy(point); this.brush.scale.setScalar(radius);
  }

  dispose() {
    this.setMarkers(null);
    for (const h of this.springHelpers) h.dispose?.();
    this.group.clear();
  }
}

// Stick-figure lines between markers (a "mid" point joins the two shoulders / hips).
const LINKS = [['chin', 'midShoulder'], ['midShoulder', 'leftShoulder'], ['midShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['midShoulder', 'midHip'], ['midHip', 'leftHip'], ['midHip', 'rightHip'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle']];
function linkPoint(m, k) {
  const mid = (a, b) => (m[a] && m[b] ? m[a].map((v, i) => (v + m[b][i]) / 2) : [0, 0, 0]);
  if (k === 'midShoulder') return mid('leftShoulder', 'rightShoulder');
  if (k === 'midHip') return mid('leftHip', 'rightHip');
  return m[k] || [0, 0, 0];
}
