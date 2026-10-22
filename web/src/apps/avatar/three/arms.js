// Tracked hands → the 3D avatar's arms, wrists and fingers. The tracker gives each wrist's position in arm lengths from
// the middle of the shoulders (../contract.js, pose.handL / handR); here that becomes a target in the avatar's space, and
// a two-bone IK (upper arm, forearm) reaches for it, with the elbow pointing down, a little out and back (the pole), and
// the target kept out of the torso and head so arms don't pass through the body. The wrist turns to the tracked hand
// direction (limited to what a wrist can do), and finger bones curl and spread where the model has them.
//
// Works on three-vrm's normalized humanoid bones: their rest rotations are identity, so a bone's local offset is its
// rest direction in avatar space, which keeps the maths simple. The T-pose convention (VRM): arms out along ±X, palms
// down, thumbs forward (+Z); the avatar faces +Z, so the screen's right is the avatar's left (+X).
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const _v = [V(), V(), V(), V(), V(), V(), V(), V()];
const _q = new THREE.Quaternion(); const _q2 = new THREE.Quaternion(); const _qp = new THREE.Quaternion();
const _m = new THREE.Matrix4(); const _m0 = new THREE.Matrix4();
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const SEGS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] };
// How far each joint bends at full curl (degrees): knuckle, middle, tip. The thumb bends less and folds across the palm.
const BEND = { Thumb: [25, 45, 55], other: [75, 95, 65] };
const SPREAD = { Thumb: 0, Index: 1, Middle: 0.25, Ring: -0.45, Little: -1 }; // toward the thumb side, ×12° × spread
const RELAXED = [0.25, 0.22, 0.26, 0.3, 0.34]; // a resting hand isn't flat
const WRIST_MAX = 75 * THREE.MathUtils.DEG2RAD;

/** A rotation taking the frame (a0, b0) to (a1, b1), each pair at right angles. */
function frameRotation(a0, b0, a1, b1, out) {
  const c0 = _v[6].crossVectors(a0, b0); const c1 = _v[7].crossVectors(a1, b1);
  _m0.makeBasis(a0, b0, c0); _m.makeBasis(a1, b1, c1);
  _m.multiply(_m0.transpose());
  return out.setFromRotationMatrix(_m);
}
const ortho = (v, axis, fallback) => { v.addScaledVector(axis, -v.dot(axis)); if (v.lengthSq() < 1e-8) v.copy(fallback).addScaledVector(axis, -fallback.dot(axis)); return v.normalize(); };

export class ArmDriver {
  constructor(avatar) {
    this.a = avatar;
    this.w = { left: 0, right: 0 };        // how much each arm follows tracking (eased)
    this.curl = { left: RELAXED.slice(), right: RELAXED.slice() };
    this.spread = { left: 0.2, right: 0.2 };
  }

  /**
   * Call after the idle pose is set on the normalized bones (it's what we blend from). pose: the tracking pose (or {}),
   * live: tracking is fresh, s: doc.drive, mirror: −1 when "swap left and right" is on.
   */
  apply(h, pose, live, dt, s, mirror) {
    const k = 1 - Math.exp(-dt * 10);
    h.normalizedHumanBonesRoot.updateMatrixWorld(true);
    const L = h.getNormalizedBoneNode('leftUpperArm'); const R = h.getNormalizedBoneNode('rightUpperArm');
    const mid = L && R ? L.getWorldPosition(_v[0]).add(R.getWorldPosition(_v[1])).multiplyScalar(0.5).clone() : null;
    for (const side of ['left', 'right']) {
      // the avatar's left hand is handL; "swap" mirrors the tracked hands across once more
      let hand = pose?.[(side === 'left') === (mirror > 0) ? 'handL' : 'handR'];
      if (hand && mirror < 0) hand = { ...hand, x: -hand.x, dir: hand.dir && [-hand.dir[0], hand.dir[1], hand.dir[2]], side: hand.side && [-hand.side[0], hand.side[1], hand.side[2]] };
      const target = s.hands !== false && live && hand && Number.isFinite(hand.x) ? Math.min(1, Math.max(0, hand.visible ?? 1)) : 0;
      this.w[side] += (target - this.w[side]) * k;
      if (this.w[side] < 0.002) this.w[side] = 0;
      const w = this.w[side];
      const fs = s.fingers ?? 1;
      for (let i = 0; i < 5; i++) {
        const c = w > 0 && hand?.curl ? RELAXED[i] + (hand.curl[i] * fs - RELAXED[i]) * w : RELAXED[i];
        this.curl[side][i] += (c - this.curl[side][i]) * k;
      }
      this.spread[side] += ((w > 0 && Number.isFinite(hand?.spread) ? 0.2 + (hand.spread - 0.2) * w : 0.2) - this.spread[side]) * k;
      if (w > 0 && mid) this.reach(h, side, hand, w, mid, s);
      this.fingers(h, side);
    }
  }

  /** Two-bone IK for one arm toward the tracked wrist, blended over the idle pose by w. */
  reach(h, side, hand, w, mid, s) {
    const ua = h.getNormalizedBoneNode(`${side}UpperArm`); const la = h.getNormalizedBoneNode(`${side}LowerArm`); const hd = h.getNormalizedBoneNode(`${side}Hand`);
    if (!ua || !la || !hd) return;
    const out = side === 'left' ? 1 : -1;
    const l1 = la.position.length(); const l2 = hd.position.length(); const reach = l1 + l2;
    if (l1 < 1e-4 || l2 < 1e-4) return;
    const S = ua.getWorldPosition(V());
    // the target, in avatar space (the tracker's screen space is the avatar's: x = its left, y up, z forward)
    const k = reach * (s.handReach ?? 1);
    const T = V().set(mid.x + hand.x * k, mid.y + hand.y * k, mid.z + (hand.z || 0) * k);
    this.keepOutOfBody(h, T, mid, Math.abs(S.x - mid.x), reach);
    // never fully straight (the solve gets twitchy) and never folded into the shoulder
    const D = V().subVectors(T, S); let d = D.length();
    const dir = d > 1e-6 ? D.divideScalar(d) : V().set(0, -1, 0);
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + reach * 0.15), reach * 0.995);
    T.copy(S).addScaledVector(dir, d);
    // pole: elbows hang down, a little out and back
    const P = V().set(out * 0.35, -1, -0.45).normalize();
    const pp = ortho(P.clone(), dir, V().set(0, -1, 0));
    const a = (l1 * l1 + d * d - l2 * l2) / (2 * d);
    const E = V().copy(S).addScaledVector(dir, a).addScaledVector(pp, Math.sqrt(Math.max(0, l1 * l1 - a * a)));

    // upper arm: rest (along its child, forearm bending forward) → (shoulder→elbow, toward the target)
    const u0 = la.position.clone().normalize(); const b0 = ortho(V().set(0, 0, 1), u0, V().set(0, 1, 0));
    const u = V().subVectors(E, S).normalize();
    const fdir = V().subVectors(T, E).normalize();
    const b = ortho(fdir.clone(), u, pp.clone().negate());
    const R1 = frameRotation(u0, b0, u, b, new THREE.Quaternion());
    // forearm: in the upper arm's frame, from its rest direction to the target's
    const f0 = hd.position.clone().normalize();
    const q2 = new THREE.Quaternion().setFromUnitVectors(f0, fdir.clone().applyQuaternion(_q.copy(R1).invert()));
    const R2 = R1.clone().multiply(q2);

    // blend over the idle pose (the bones hold it now)
    const q1 = ua.parent.getWorldQuaternion(_qp).invert().multiply(R1);
    ua.quaternion.slerp(q1, w);
    la.quaternion.slerp(q2, w);
    // wrist: rest hand frame (fingers along the forearm, thumb forward) → the tracked one, limited
    if (hand.dir && hand.side) {
      const F = V().fromArray(hand.dir).normalize(); const Ts = ortho(V().fromArray(hand.side), F, V().set(0, 0, 1));
      const Rh = frameRotation(f0, ortho(V().set(0, 0, 1), f0, V().set(0, 1, 0)), F, Ts, new THREE.Quaternion());
      const q3 = R2.clone().invert().multiply(Rh);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q3.w)));
      if (ang > WRIST_MAX) q3.slerp(_q2.identity(), 1 - WRIST_MAX / ang);
      hd.quaternion.slerp(q3, w);
    }
  }

  /** Pushes a target that's inside the torso or head out to the front. */
  keepOutOfBody(h, T, mid, shoulderHalf, reach) {
    const hips = h.getNormalizedBoneNode('hips')?.getWorldPosition(_v[2]);
    const bottom = hips ? hips.y - reach * 0.15 : mid.y - reach * 1.2;
    const front = mid.z + reach * 0.22;
    if (Math.abs(T.x - mid.x) < shoulderHalf * 0.95 && T.y < mid.y + reach * 0.05 && T.y > bottom && T.z < front) T.z = front;
    const head = h.getNormalizedBoneNode('head');
    if (head) {
      const c = head.getWorldPosition(_v[3]); c.y += reach * 0.15;
      const r = reach * 0.3;
      if (T.distanceTo(c) < r && T.z < c.z + r) T.z = c.z + Math.sqrt(Math.max(0, r * r - (T.x - c.x) ** 2 - (T.y - c.y) ** 2));
    }
  }

  /** Curls and spreads the finger bones the model has (in the hand's own frame: fingers bend toward the palm). */
  fingers(h, side) {
    const hd = h.getNormalizedBoneNode(`${side}Hand`); const la = h.getNormalizedBoneNode(`${side}LowerArm`);
    if (!hd || !la) return;
    const F0 = hd.position.clone().normalize(); // fingers' rest direction ≈ the forearm's
    const T0 = ortho(V().set(0, 0, 1), F0, V().set(0, 1, 0));
    const palm = side === 'left' ? V().crossVectors(F0, T0) : V().crossVectors(T0, F0);
    const curl = this.curl[side]; const sp = this.spread[side];
    FINGERS.forEach((f, fi) => {
      const segs = f === 'Thumb' ? SEGS.Thumb : SEGS.other;
      const bend = f === 'Thumb' ? BEND.Thumb : BEND.other;
      // the thumb folds toward the palm and across it (toward the little finger)
      const toward = f === 'Thumb' ? palm.clone().addScaledVector(T0, -0.8).normalize() : palm;
      segs.forEach((seg, si) => {
        const n = h.getNormalizedBoneNode(`${side}${f}${seg}`);
        if (!n) return;
        const child = h.getNormalizedBoneNode(`${side}${f}${segs[si + 1]}`);
        const rest = child ? child.position.clone().normalize() : n.position.clone().normalize();
        if (rest.lengthSq() < 1e-8) return;
        const axis = V().crossVectors(rest, toward);
        if (axis.lengthSq() < 1e-8) return;
        n.quaternion.multiply(_q.setFromAxisAngle(axis.normalize(), curl[fi] * bend[si] * THREE.MathUtils.DEG2RAD));
        if (si === 0 && SPREAD[f]) {
          const ax = V().crossVectors(rest, T0);
          if (ax.lengthSq() > 1e-8) n.quaternion.multiply(_q.setFromAxisAngle(ax.normalize(), (sp - 0.2) * SPREAD[f] * 14 * THREE.MathUtils.DEG2RAD));
        }
      });
    });
  }
}
