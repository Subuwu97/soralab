// From MediaPipe Face Landmarker results to the shared pose (see ../contract.js POSE_KEYS), and the per-key tuning
// people adjust in Perform → Tracking (sensitivity, dead zone, range, invert, smoothing), all saved in doc.tracking.
//
//   rawPose(face)                          → pose straight from the blendshapes and the face's transformation matrix
//   new PoseShaper().shape(raw, settings, t) → filtered, calibrated, tuned pose (adds body follow and breathing)
//   setNeutral(raw)                        → the "Set neutral" calibration (stored in settings.neutral)
import { POSE_KEYS } from '../contract.js';
import { FilterBank } from './filter.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const c01 = (v) => clamp(v, 0, 1);
const DEG = 180 / Math.PI;

// What each key looks like by default: its range, and whether calibration subtracts a resting value.
//   kind: 'angle' (degrees, neutral subtracted), 'signed' (−1..1, neutral subtracted), 'open' (0..1, divided by the
//   resting value so "eyes normally open" reads as 1), 'amount' (0..1 as is)
export const KEY_INFO = {
  headYaw: { label: 'Head turn (left/right)', kind: 'angle', min: -30, max: 30 },
  headPitch: { label: 'Head nod (up/down)', kind: 'angle', min: -30, max: 30 },
  headRoll: { label: 'Head tilt', kind: 'angle', min: -30, max: 30 },
  bodyYaw: { label: 'Body turn', kind: 'angle', min: -10, max: 10 },
  bodyPitch: { label: 'Body lean (fwd/back)', kind: 'angle', min: -10, max: 10 },
  bodyRoll: { label: 'Body tilt', kind: 'angle', min: -10, max: 10 },
  headX: { label: 'Head position X', kind: 'signed', min: -1, max: 1 },
  headY: { label: 'Head position Y', kind: 'signed', min: -1, max: 1 },
  headZ: { label: 'Head distance', kind: 'signed', min: -1, max: 1 },
  eyeLOpen: { label: 'Left eye open', kind: 'open', min: 0, max: 1 },
  eyeROpen: { label: 'Right eye open', kind: 'open', min: 0, max: 1 },
  eyeX: { label: 'Gaze left/right', kind: 'signed', min: -1, max: 1 },
  eyeY: { label: 'Gaze up/down', kind: 'signed', min: -1, max: 1 },
  browL: { label: 'Left brow', kind: 'signed', min: -1, max: 1 },
  browR: { label: 'Right brow', kind: 'signed', min: -1, max: 1 },
  mouthOpen: { label: 'Mouth open', kind: 'amount', min: 0, max: 1 },
  mouthForm: { label: 'Mouth smile/frown', kind: 'signed', min: -1, max: 1 },
  mouthA: { label: 'Viseme A', kind: 'amount', min: 0, max: 1 },
  mouthI: { label: 'Viseme I', kind: 'amount', min: 0, max: 1 },
  mouthU: { label: 'Viseme U', kind: 'amount', min: 0, max: 1 },
  mouthE: { label: 'Viseme E', kind: 'amount', min: 0, max: 1 },
  mouthO: { label: 'Viseme O', kind: 'amount', min: 0, max: 1 },
  cheek: { label: 'Cheek puff', kind: 'amount', min: 0, max: 1 },
  tongue: { label: 'Tongue out', kind: 'amount', min: 0, max: 1 },
  breath: { label: 'Breathing', kind: 'amount', min: 0, max: 1 },
};

export const defaultTracking = () => ({
  mirror: true,               // act like a mirror: turn your head left, the avatar turns to the screen's left (like your reflection)
  smoothing: { minCutoff: 1.6, beta: 0.4 },
  bodyFollow: 0.35,           // how much the body turns with the head (when nothing tracks the body)
  breathRate: 14,             // breaths per minute (0 = off)
  autoBlink: true,            // blink now and then in puppet mode
  keys: Object.fromEntries(POSE_KEYS.map((k) => [k, { sens: 1, dead: 0, min: KEY_INFO[k].min, max: KEY_INFO[k].max, invert: false, smooth: 1 }])),
  neutral: {},                // resting values from "Set neutral"
  mic: { on: false, gain: 1, threshold: 0.02, visemes: true },
  hands: false,
});
/** Fills in anything missing (older documents, new keys). */
export function withTrackingDefaults(t) {
  const d = defaultTracking();
  if (!t) return d;
  return { ...d, ...t, smoothing: { ...d.smoothing, ...t.smoothing }, mic: { ...d.mic, ...t.mic }, keys: Object.fromEntries(POSE_KEYS.map((k) => [k, { ...d.keys[k], ...t.keys?.[k] }])), neutral: { ...t.neutral } };
}

const bs = (b, n) => b[n] || 0;
/** Row-major 3×3 rotation from MediaPipe's column-major 4×4. */
const rot = (m) => [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];

/**
 * The raw pose from one face result: { blend: { eyeBlinkLeft: … }, matrix: Float32Array(16) } (matrix may be missing).
 * Raw values are in camera-image terms (as the camera sees the person, not mirrored): yaw > 0 = face turned toward the
 * image's right, pitch > 0 = looking up, roll > 0 = tilted clockwise, eyeX > 0 = looking toward the image's right,
 * eyeLOpen = the person's left eye. "Mirror" (on by default) flips these so the avatar moves like your reflection.
 * After shaping, the avatar's conventions match Cubism's: headYaw > 0 turns it toward the screen's right, and so on.
 */
export function rawPose({ blend = {}, matrix } = {}) {
  const p = {};
  if (matrix && matrix.length >= 16) {
    // R = Ry(yaw) · Rx(pitch) · Rz(roll) in MediaPipe's face space (x right, y up, z toward the camera)
    const r = rot(matrix);
    p.headPitch = Math.asin(clamp(r[1][2], -1, 1)) * DEG;    // … toward +y (up)
    p.headYaw = Math.atan2(r[0][2], r[2][2]) * DEG;         // forward vector swings toward +x
    p.headRoll = -Math.atan2(r[1][0], r[1][1]) * DEG;       // clockwise in the image is a negative z rotation
    // translation in cm; the face is usually ~40–60 cm away (z negative)
    p.headX = clamp(matrix[12] / 15, -1, 1); p.headY = clamp(matrix[13] / 12, -1, 1); p.headZ = clamp((matrix[14] + 45) / 20, -1, 1);
  }
  const blinkL = bs(blend, 'eyeBlinkLeft'); const blinkR = bs(blend, 'eyeBlinkRight');
  // blink scores sit near 0.05 open and rise past 0.5 closed; wide-open adds a little
  p.eyeLOpen = c01(1 - (blinkL - 0.08) / 0.5 + bs(blend, 'eyeWideLeft') * 0.3);
  p.eyeROpen = c01(1 - (blinkR - 0.08) / 0.5 + bs(blend, 'eyeWideRight') * 0.3);
  // gaze: toward the image's right (the person's left) = left eye looks out, right eye looks in
  p.eyeX = clamp(((bs(blend, 'eyeLookOutLeft') - bs(blend, 'eyeLookInLeft')) + (bs(blend, 'eyeLookInRight') - bs(blend, 'eyeLookOutRight'))) * 0.9, -1, 1);
  p.eyeY = clamp(((bs(blend, 'eyeLookUpLeft') + bs(blend, 'eyeLookUpRight')) - (bs(blend, 'eyeLookDownLeft') + bs(blend, 'eyeLookDownRight'))) * 0.9, -1, 1);
  const inner = bs(blend, 'browInnerUp');
  p.browL = clamp((bs(blend, 'browOuterUpLeft') * 0.6 + inner * 0.6 - bs(blend, 'browDownLeft')) * 1.6, -1, 1);
  p.browR = clamp((bs(blend, 'browOuterUpRight') * 0.6 + inner * 0.6 - bs(blend, 'browDownRight')) * 1.6, -1, 1);
  const jaw = bs(blend, 'jawOpen');
  p.mouthOpen = c01((jaw - bs(blend, 'mouthClose') * 0.6) * 1.9);
  const smile = (bs(blend, 'mouthSmileLeft') + bs(blend, 'mouthSmileRight')) / 2;
  const frown = (bs(blend, 'mouthFrownLeft') + bs(blend, 'mouthFrownRight')) / 2;
  p.mouthForm = clamp((smile - frown * 1.2 - bs(blend, 'mouthPucker') * 0.3) * 1.8, -1, 1);
  // visemes from the mouth shape (the mic adds its own when it's on)
  const pucker = bs(blend, 'mouthPucker'); const funnel = bs(blend, 'mouthFunnel');
  const stretch = (bs(blend, 'mouthStretchLeft') + bs(blend, 'mouthStretchRight')) / 2 + smile * 0.6;
  const open = p.mouthOpen;
  p.mouthA = c01(open * 1.2 - funnel - pucker * 0.5);
  p.mouthI = c01(stretch * 1.5 * (1 - open) - pucker);
  p.mouthU = c01(pucker * 1.4 * (1 - open * 0.7));
  p.mouthE = c01(stretch * open * 2.2);
  p.mouthO = c01(funnel * 1.6 * Math.max(0.3, open));
  p.cheek = c01(bs(blend, 'cheekPuff') * 1.5);
  p.tongue = c01(bs(blend, 'tongueOut') * 1.5);
  p.blend = { ...blend };
  return p;
}

const MIRROR_SWAP = [['eyeLOpen', 'eyeROpen'], ['browL', 'browR']];
const MIRROR_NEG = ['headYaw', 'headRoll', 'headX', 'eyeX', 'bodyYaw', 'bodyRoll'];
const BLEND_SWAP = (n) => (n.endsWith('Left') ? `${n.slice(0, -4)}Right` : n.endsWith('Right') ? `${n.slice(0, -5)}Left` : n);

/** Records the current raw values as "neutral" (the person sitting normally, looking at the screen). */
export function setNeutral(raw) {
  const n = {};
  for (const k of POSE_KEYS) {
    const v = raw[k];
    if (!Number.isFinite(v)) continue;
    const kind = KEY_INFO[k].kind;
    if (kind === 'angle' || kind === 'signed') n[k] = +v.toFixed(3);
    else if (kind === 'open') n[k] = +clamp(v, 0.4, 1).toFixed(3);
  }
  return n;
}

/** Turns raw poses into what the avatar uses. Keeps the filters (one per key) between frames. */
export class PoseShaper {
  constructor() { this.filters = new FilterBank(); this.t0 = performance.now() / 1000; }
  reset() { this.filters.reset(); }
  shape(raw, s, t = performance.now() / 1000) {
    const out = {};
    const src = { ...raw };
    if (s.mirror) {
      for (const [a, b] of MIRROR_SWAP) { const x = src[a]; src[a] = src[b]; src[b] = x; }
      for (const k of MIRROR_NEG) if (Number.isFinite(src[k])) src[k] = -src[k];
    }
    for (const k of POSE_KEYS) {
      let v = src[k];
      if (!Number.isFinite(v)) continue;
      const ks = s.keys[k]; const info = KEY_INFO[k];
      // smoothing: per-key "smooth" scales the global cut-off (higher smooth → lower cut-off → steadier)
      const sm = Math.max(0.05, ks.smooth ?? 1);
      v = this.filters.run(k, v, t, s.smoothing.minCutoff / sm, s.smoothing.beta);
      const n = s.neutral?.[s.mirror ? mirrorKey(k) : k];
      if (Number.isFinite(n)) {
        if (info.kind === 'angle' || info.kind === 'signed') v -= (s.mirror && MIRROR_NEG.includes(k) ? -n : n);
        else if (info.kind === 'open') v = v / Math.max(0.3, n);
      }
      if (info.kind === 'open') v = 1 - applyDead(1 - v, ks.dead) * ks.sens;   // eyes: tune how far they close
      else v = applyDead(v, ks.dead) * ks.sens;
      if (ks.invert) v = info.kind === 'open' || info.kind === 'amount' ? 1 - v : -v;
      out[k] = clamp(v, Math.min(ks.min, ks.max), Math.max(ks.min, ks.max));
    }
    // the body follows the head a little when nothing tracks it
    if (s.bodyFollow > 0) {
      for (const [b, hk] of [['bodyYaw', 'headYaw'], ['bodyPitch', 'headPitch'], ['bodyRoll', 'headRoll']]) {
        if (!Number.isFinite(out[b]) && Number.isFinite(out[hk])) { const ks = s.keys[b]; out[b] = clamp(out[hk] * s.bodyFollow * (ks.sens ?? 1) * (ks.invert ? -1 : 1), Math.min(ks.min, ks.max), Math.max(ks.min, ks.max)); }
      }
    }
    if (s.breathRate > 0) out.breath = breathAt(t - this.t0, s.breathRate);
    if (raw.blend) out.blend = s.mirror ? Object.fromEntries(Object.entries(raw.blend).map(([n, v]) => [BLEND_SWAP(n), v])) : raw.blend;
    if (raw.hands) out.hands = raw.hands;
    return out;
  }
}
const mirrorKey = (k) => { for (const [a, b] of MIRROR_SWAP) { if (k === a) return b; if (k === b) return a; } return k; };
// dead zone in the key's own units (degrees for angles): small movements around neutral read as none
const applyDead = (v, dead) => (!dead ? v : Math.abs(v) <= dead ? 0 : Math.sign(v) * (Math.abs(v) - dead));

/** Idle breathing: a soft in-out wave, 0..1 (breathe in a little faster than out). */
export function breathAt(t, perMinute = 14) {
  const ph = ((t * perMinute) / 60) % 1;
  return ph < 0.42 ? 0.5 - 0.5 * Math.cos((ph / 0.42) * Math.PI) : 0.5 + 0.5 * Math.cos(((ph - 0.42) / 0.58) * Math.PI);
}

/** Rounds a pose for sending over the relay (keeps messages small). */
export function packPose(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number') o[k] = Math.round(v * 1000) / 1000;
    else if (k === 'blend' && v) o.blend = Object.fromEntries(Object.entries(v).filter(([, x]) => x > 0.005).map(([n, x]) => [n, Math.round(x * 1000) / 1000]));
    else if (v !== undefined) o[k] = v;
  }
  return o;
}
