// Tracking → avatar. Turns the contract's pose (POSE_KEYS + pose.blend) into humanoid bone rotations, look-at and
// expression weights, with the per-mapping sensitivity saved in the document (doc.tracking). When tracking goes quiet,
// it fades into an idle loop (breathing, a little sway, blinking) so the avatar never freezes.
//
// Directions (with "mirror" off): positive headYaw turns the head towards the viewer's right, positive headPitch looks
// up, positive headRoll tilts the top of the head towards the viewer's right; eyeX/eyeY follow the same sides.
// Turn "mirror" on to swap left and right (move like a reflection).
import * as THREE from 'three';
import { clamp } from './model.js';

const D = THREE.MathUtils.DEG2RAD;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export class Driver {
  constructor(avatar) {
    this.a = avatar;
    this.pose = null;       // latest pose from tracking
    this.poseAt = -1e9;     // when it arrived (performance.now)
    this.presence = 0;      // 0 = idle, 1 = tracking
    this.t = Math.random() * 100;
    this.nextBlink = 2; this.blinkT = -1;
    this.wiggle = 0;        // seconds left of the spring-bone test shake
    this.manual = null;     // test pose from the editor (wins over tracking)
  }
  setPose(pose) { this.pose = pose; this.poseAt = performance.now(); }

  /** Sets normalized bones and expression values for this frame. Call before humanoid/lookAt/expression updates. */
  apply(dt) {
    const a = this.a; const s = a.tracking;
    this.t += dt;
    const live = this.manual || (performance.now() - this.poseAt < 700 ? this.pose : null);
    this.presence += ((live ? 1 : 0) - this.presence) * (1 - Math.exp(-dt * (live ? 8 : 2.5)));
    const P = this.presence; const I = s.idle ? 1 - P : 0;
    const p = live || this.pose || {};
    const m = s.mirror ? -1 : 1;
    const t = this.t;

    // ---- idle loop (blended out as tracking comes in)
    const breath = live && Number.isFinite(p.breath) ? p.breath : 0.5 + 0.5 * Math.sin(t * 1.6);
    const idle = { yaw: 3.5 * Math.sin(t * 0.37) + 1.5 * Math.sin(t * 0.91), pitch: 2 * Math.sin(t * 0.29 + 1) - 1, roll: 2.2 * Math.sin(t * 0.33 + 2), sway: 1.4 * Math.sin(t * 0.41) };
    // Wiggle: a quick head shake to test spring bones.
    let wig = 0;
    if (this.wiggle > 0) { this.wiggle = Math.max(0, this.wiggle - dt); wig = Math.sin(this.wiggle * 18) * 28 * Math.min(1, this.wiggle); }

    const yaw = (num(p.headYaw) * s.head * m) * P + idle.yaw * I + wig;
    const pitch = (num(p.headPitch) * s.head) * P + idle.pitch * I;
    const roll = (num(p.headRoll) * s.head * m) * P + idle.roll * I;
    const by = num(p.bodyYaw) * s.body * m * P + idle.sway * I * 0.5;
    const bp = num(p.bodyPitch) * s.body * P;
    const br = num(p.bodyRoll) * s.body * m * P + idle.sway * I * 0.4;

    const h = a.humanoid;
    if (h) {
      const sp = s.split; const tot = (sp.head + sp.neck + sp.spine) || 1;
      const set = (bone, y, x, z) => { const n = h.getNormalizedBoneNode(bone); if (!n) return false; n.quaternion.multiply(_q.setFromEuler(_e.set(-x * D, y * D, -z * D, 'YXZ'))); return true; };
      h.resetNormalizedPose();
      const neckOk = !!h.getNormalizedBoneNode('neck');
      const chestBone = h.getNormalizedBoneNode('upperChest') ? 'upperChest' : h.getNormalizedBoneNode('chest') ? 'chest' : 'spine';
      const fh = sp.head / tot + (neckOk ? 0 : sp.neck / tot); const fn = neckOk ? sp.neck / tot : 0; const fs = sp.spine / tot;
      set('head', yaw * fh, pitch * fh, roll * fh);
      if (neckOk) set('neck', yaw * fn, pitch * fn, roll * fn);
      set(chestBone, yaw * fs + by * 0.5, pitch * fs + bp * 0.5 + (breath - 0.5) * 1.6, roll * fs + br * 0.5);
      if (chestBone !== 'spine') set('spine', by * 0.5, bp * 0.5, br * 0.5);
      // Lean with head position.
      const hips = h.getNormalizedBoneNode('hips');
      if (hips && P > 0 && s.move) {
        const k = s.move * P * a.height * 0.035;
        hips.position.x += num(p.headX) * k * m; hips.position.z += num(p.headZ) * k * 0.6;
        hips.position.y += num(p.headY) * k * 0.3;
      }
      // Arms down from the T-pose (and a breath in the shoulders).
      const arm = a.armAngle;
      for (const [side, k] of [['left', 1], ['right', -1]]) {
        const ua = h.getNormalizedBoneNode(`${side}UpperArm`);
        if (ua) ua.quaternion.multiply(_q.setFromEuler(_e.set(0, 0, -k * arm * D)));
        const la = h.getNormalizedBoneNode(`${side}LowerArm`);
        if (la && arm) la.quaternion.multiply(_q.setFromEuler(_e.set(0, -k * 8 * D, 0)));
        const sh = h.getNormalizedBoneNode(`${side}Shoulder`);
        if (sh) sh.quaternion.multiply(_q.setFromEuler(_e.set(0, 0, k * (breath - 0.5) * 1.2 * D)));
      }
    }

    // ---- expressions
    const ex = a.expressions;
    const vals = {};
    const add = (k, v) => { if (v > 0) vals[k] = Math.max(vals[k] || 0, v); };
    const sync = a.perfectSyncActive(p);
    // Blink: from eye openness while tracked, else the idle auto-blink.
    let bl = 0; let br_ = 0;
    if (live && !sync && (Number.isFinite(p.eyeLOpen) || Number.isFinite(p.eyeROpen))) {
      const conv = (o) => 1 - smoothstep(s.blinkClosed, s.blinkOpen, num(o, 1));
      let l = conv(p.eyeLOpen ?? p.eyeROpen) * s.blink; let r = conv(p.eyeROpen ?? p.eyeLOpen) * s.blink;
      if (s.linkEyes) { const v = Math.max(l, r); l = v; r = v; }
      [bl, br_] = s.mirror ? [r, l] : [l, r];
    }
    if (I > 0.01 || (!live && !this.manual)) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkT < 0) { this.blinkT = 0; this.nextBlink = 2.5 + Math.random() * 3.5; }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const v = this.blinkT < 0.07 ? this.blinkT / 0.07 : Math.max(0, 1 - (this.blinkT - 0.07) / 0.1);
        if (this.blinkT > 0.18) this.blinkT = -1;
        bl = Math.max(bl, v * I); br_ = Math.max(br_, v * I);
      }
    }
    if (ex) {
      if (a.hasExpr('blinkLeft') && a.hasExpr('blinkRight')) { add('blinkLeft', bl); add('blinkRight', br_); } else add('blink', Math.max(bl, br_));
      if (live && !sync) {
        // Mouth: visemes when given (mic or face), otherwise the open amount drives "aa".
        const vis = { aa: p.mouthA, ih: p.mouthI, ou: p.mouthU, ee: p.mouthE, oh: p.mouthO };
        const anyVis = Object.values(vis).some((v) => Number.isFinite(v) && v > 0.02);
        if (anyVis) for (const [k, v] of Object.entries(vis)) add(k, clamp(num(v) * s.mouth, 0, 1));
        else add('aa', clamp(num(p.mouthOpen) * s.mouth, 0, 1));
        const form = num(p.mouthForm);
        if (form > 0) add('happy', clamp(form * s.smile, 0, 1)); else add('sad', clamp(-form * s.smile * 0.7, 0, 1));
        // Brows: custom "browUp"/"browDown" expressions if the model has them, else a touch of surprised/angry.
        const brow = (num(p.browL) + num(p.browR)) / 2;
        if (brow > 0) add(a.hasExpr('browUp') ? 'browUp' : 'surprised', clamp(brow * s.brows, 0, 1) * (a.hasExpr('browUp') ? 1 : 0.6));
        else add(a.hasExpr('browDown') ? 'browDown' : 'angry', clamp(-brow * s.brows, 0, 1) * (a.hasExpr('browDown') ? 1 : 0.5));
      }
      // Expression hotkeys from Perform (pose.expr = { name: weight }), then the editor's preview sliders.
      for (const [k, v] of Object.entries(p.expr || {})) if (v > 0) vals[k] = Math.max(vals[k] || 0, Math.min(1, v));
      for (const [k, v] of Object.entries(a.preview || {})) if (v > 0) vals[k] = v;
      for (const e of ex.expressions) ex.setValue(e.expressionName, vals[e.expressionName] || 0);
    }

    // ---- gaze
    if (a.lookAt) {
      const gx = (live ? num(p.eyeX) * s.eyes * m : 0) * P;
      const gy = (live ? num(p.eyeY) * s.eyes : 0) * P;
      a.lookAt.yaw = clamp(gx, -1, 1) * 30; a.lookAt.pitch = clamp(gy, -1, 1) * 30;
    }
    this.sync = sync ? p.blend : null;
  }
}
