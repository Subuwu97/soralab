// Hands: MediaPipe Hand Landmarker results → the contract's handL / handR objects and their flat keys (see
// ../contract.js HAND_KEYS). Runs on the main thread on the worker's landmarks; it's cheap (21 points per hand).
//
//   const hs = new HandShaper()
//   hs.update(hands, { landmarks, size: [w, h], faceZ }, settings, t)  each tracking result (t in seconds)
//   hs.shape(settings, t) → { handL, handR, handLX, armLA, … }         every frame (holds, then eases to rest when lost)
//   demoHand('peace', 'L') → a hand object for test poses (the editors' "Try a pose", tests)
//
// Where things are: the wrist is placed relative to the shoulders, which we don't see — they're estimated from the
// face (its width on screen sets the scale, about 14 cm; shoulders sit ~1.7 face widths below the cheekbones). Depth
// comes from how big the palm looks next to the face. Everything is in "arm lengths" (shoulder to wrist), so each
// renderer can scale it to its own avatar. Sides are the avatar's: with "mirror" on (the default) your right hand
// moves the avatar's left hand, like a reflection.
import { FilterBank } from './filter.js';

const DEG = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const c01 = (v) => clamp(v, 0, 1);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const angle = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1)) * DEG;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// Body proportions in face widths (cheek to cheek): good enough for most adults, and the per-avatar reach setting
// covers the rest.
const BODY = { shoulderDrop: 1.7, shoulderHalf: 1.35, arm: 4, palm: 0.66, faceCm: 14 };
// The avatar's left hand hanging at rest, in arm lengths from the middle of the shoulders (x toward the screen's right).
export const HAND_REST = { x: BODY.shoulderHalf / BODY.arm, y: -1, z: 0.05 };
const SHOULDER_X = BODY.shoulderHalf / BODY.arm;

// Landmark indices: 0 wrist; thumb 1–4; index 5–8; middle 9–12; ring 13–16; little 17–20.
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
export const GESTURES = ['open', 'fist', 'peace', 'thumbsUp', 'point', 'wave'];
export const GESTURE_LABELS = { open: 'Open hand', fist: 'Fist', peace: 'Peace sign', thumbsUp: 'Thumbs up', point: 'Pointing', wave: 'Wave' };

const HOLD = 0.3;          // seconds a lost hand keeps its last pose (the detector drops frames during fast moves);
                           // longer when tracking results come slowly (a busy CPU): 2.5 result intervals
const FADE_IN = 10;        // 1/s
const FADE_OUT = 3;        // 1/s: about 0.7 s back to rest
const SETTLE = 0.12;       // seconds a new gesture must hold before it counts

/** Per-finger curl (thumb..little, 0 straight .. 1 fully bent) and spread (0 together .. 1 wide) from 3D points. */
export function fingerShape(w) {
  const palm = len(sub(w[9], w[0])) || 1;
  const curl = FINGERS.map((f, i) => {
    if (i === 0) {
      // thumb: bend at its two outer joints, plus how close the tip comes to the palm (it folds across in a fist)
      const bend = angle(sub(w[2], w[1]), sub(w[3], w[2])) + angle(sub(w[3], w[2]), sub(w[4], w[3]));
      const close = c01((1.3 - len(sub(w[4], w[9])) / palm) / 0.8);
      return c01(0.55 * c01((bend - 15) / 90) + 0.45 * close);
    }
    const [m, p, d, t] = f.map((k) => w[k]);
    const bend = angle(sub(m, w[0]), sub(p, m)) + angle(sub(p, m), sub(d, p)) + angle(sub(d, p), sub(t, d));
    return c01((bend - 25) / 190);
  });
  // spread: angles between neighbouring fingers' first segments, counting only fingers that are fairly straight
  // (bent fingers point every which way)
  const dirs = [1, 2, 3, 4].map((i) => sub(w[FINGERS[i][1]], w[FINGERS[i][0]]));
  let sum = 0; let n = 0;
  for (let i = 0; i < 3; i++) { const k = (1 - curl[i + 1]) * (1 - curl[i + 2]); sum += angle(dirs[i], dirs[i + 1]) * k; n += k; }
  const spread = n > 0.2 ? c01((sum / n - 4) / 14) : 0;
  return { curl, spread };
}

/** The gesture of one frame, from curls and the thumb's direction (screen space, y up). */
export function classify(curl, thumbDir) {
  const ext = (i) => curl[i] < 0.4; const folded = (i) => curl[i] > 0.5;
  const fingersFolded = folded(1) && folded(2) && folded(3) && folded(4);
  if (fingersFolded && curl[0] < 0.45 && thumbDir[1] > 0.55) return 'thumbsUp';
  if (fingersFolded) return 'fist';
  // (the little finger rarely straightens all the way in an open hand)
  if (ext(1) && ext(2) && ext(3) && curl[4] < 0.6) return 'open';
  if (ext(1) && ext(2) && folded(3) && folded(4)) return 'peace';
  if (ext(1) && folded(2) && folded(3) && folded(4)) return 'point';
  return 'none';
}

/**
 * The 2D arm: two-bone IK in the screen plane, shoulder at (±0.34, 0), upper arm and forearm half an arm length each.
 * Returns degrees with "outward" positive for both sides: armA = upper arm from hanging straight down, armB = the
 * forearm's turn from the upper arm's line, wrist = the hand's turn from the forearm's line. Elbows bend downward.
 */
export function arm2D(side, x, y, fingerDir) {
  const out = side === 'L' ? 1 : -1;
  const sx = out * SHOULDER_X;
  let dx = x - sx; let dy = y;
  const d0 = Math.hypot(dx, dy) || 1e-6;
  const d = clamp(d0, 0.05, 0.999);
  dx = (dx / d0) * d; dy = (dy / d0) * d;
  const a = Math.acos(clamp(d, -1, 1)); // law of cosines with two halves: cos = d / (2 · 0.5)
  const base = Math.atan2(dy, dx);
  const e1 = [Math.cos(base + a) * 0.5, Math.sin(base + a) * 0.5]; const e2 = [Math.cos(base - a) * 0.5, Math.sin(base - a) * 0.5];
  const e = e1[1] < e2[1] ? e1 : e2; // the elbow that hangs lower
  const fa = [dx - e[0], dy - e[1]];
  const angA = Math.atan2(out * e[0], -e[1]) * DEG;
  const angF = Math.atan2(out * fa[0], -fa[1]) * DEG;
  let wrist = 0;
  if (fingerDir) wrist = clamp(wrap(Math.atan2(out * fingerDir[0], -fingerDir[1]) * DEG - angF), -80, 80);
  return { armA: angA, armB: wrap(angF - angA), wrist };
}

const blankTrack = () => ({ seenAt: -1e9, vis: 0, v: null, gesture: 'none', cand: 'none', candAt: 0, gw: Object.fromEntries(GESTURES.map((g) => [g, 0])), wave: { ext: null, dir: 0, flips: [], until: -1, extR: null, dirR: 0 }, filters: new FilterBank() });

export class HandShaper {
  constructor() { this.tracks = { L: blankTrack(), R: blankTrack() }; this.ref = null; this.lastT = null; this.raw = []; this.gap = 1 / 30; this.updT = null; }
  /** How long a lost hand holds: longer when results arrive slowly. */
  get hold() { return Math.max(HOLD, Math.min(1.5, this.gap * 2.5)); }
  reset() { this.tracks = { L: blankTrack(), R: blankTrack() }; this.raw = []; }

  /** The face as the reference frame: centre, width (in image-height units) and distance (cm). Kept when the face is lost. */
  setFace(landmarks, aspect, faceZ) {
    if (landmarks && landmarks.length >= 455 * 3) {
      const ax = landmarks[234 * 3] * aspect; const ay = landmarks[234 * 3 + 1];
      const bx = landmarks[454 * 3] * aspect; const by = landmarks[454 * 3 + 1];
      const fw = Math.hypot(bx - ax, by - ay);
      if (fw > 0.02) {
        const r = { cx: (ax + bx) / 2, cy: (ay + by) / 2, fw, dist: Number.isFinite(faceZ) && faceZ < -10 ? -faceZ : this.ref?.dist || 50 };
        // ease, so a jittery face doesn't shake the arms
        this.ref = this.ref ? { cx: this.ref.cx + (r.cx - this.ref.cx) * 0.3, cy: this.ref.cy + (r.cy - this.ref.cy) * 0.3, fw: this.ref.fw + (r.fw - this.ref.fw) * 0.2, dist: this.ref.dist + (r.dist - this.ref.dist) * 0.2 } : r;
      }
    }
    // no face yet: assume someone sitting centred, face a fifth of the frame's height wide
    if (!this.ref) this.ref = { cx: aspect / 2, cy: 0.38, fw: 0.2, dist: 50, guess: true };
  }

  /**
   * One Hand Landmarker result: hands = [{ label: 'Left'|'Right', score, pts: [[x,y,z]×21] (normalized image),
   * world: [[x,y,z]×21] (metres) }]. ctx = { landmarks (face, flat), size: [w, h], faceZ (cm, from the face matrix) }.
   */
  update(hands, ctx, s, t) {
    const aspect = ctx.size?.[0] && ctx.size?.[1] ? ctx.size[0] / ctx.size[1] : 4 / 3;
    if (this.updT !== null) this.gap += (Math.min(2, Math.max(0, t - this.updT)) - this.gap) * 0.2;
    this.updT = t;
    this.setFace(ctx.landmarks, aspect, ctx.faceZ);
    const minScore = s.handConfidence ?? 0.5;
    const list = (hands || []).filter((h) => h?.pts?.length === 21 && (h.score ?? 1) >= minScore);
    this.raw = list;
    // MediaPipe labels handedness as if the picture were mirrored (a selfie); our frames aren't, so "Left" is the
    // person's right hand. Two hands with the same label: the less sure one is the other hand.
    const person = list.map((h) => (h.label === 'Left' ? 'right' : h.label === 'Right' ? 'left' : null));
    if (list.length === 2 && person[0] === person[1]) {
      const weaker = (list[0].score ?? 1) < (list[1].score ?? 1) ? 0 : 1;
      person[weaker] = person[weaker] === 'right' ? 'left' : 'right';
    }
    list.forEach((h, i) => {
      // no label at all: guess from where it is (the person's right hand is on the picture's left)
      const who = person[i] || (h.pts[0][0] * aspect < this.ref.cx ? 'right' : 'left');
      const side = (who === 'right') === !!s.mirror ? 'L' : 'R';
      this.measure(side, h, aspect, s, t);
    });
  }

  measure(side, h, aspect, s, t) {
    const tr = this.tracks[side];
    const mx = s.mirror ? -1 : 1;
    const ref = this.ref;
    // to screen space: x toward the screen's right, y up, z toward the viewer
    const scr = (v) => [mx * v[0], -v[1], -v[2]];
    const world = (h.world?.length === 21 ? h.world : h.pts.map((p) => [p[0] * aspect, p[1], p[2] * aspect])).map(scr);
    const F = norm(sub(world[9], world[0]));
    let T = sub(world[5], world[17]); T = norm(sub(T, F.map((c) => c * dot(T, F))));
    // depth from the palm's size next to the face's (undoing the foreshortening the 3D points tell us about)
    const p0 = [h.pts[0][0] * aspect, h.pts[0][1]]; const p9 = [h.pts[9][0] * aspect, h.pts[9][1]];
    const palmImg = Math.hypot(p9[0] - p0[0], p9[1] - p0[1]) / Math.max(0.35, Math.hypot(F[0], F[1]));
    const r = clamp(palmImg / ref.fw / BODY.palm, 0.4, 3);
    // position: wrist offset from the shoulders' middle, corrected for the hand's own depth (see the comment above)
    const cx = aspect / 2; const cy = 0.5;
    const shX = ref.cx; const shY = ref.cy + BODY.shoulderDrop * ref.fw;
    const unit = ref.fw * BODY.arm;
    const relX = ((p0[0] - cx) / r - (shX - cx)) / unit;
    const relY = ((p0[1] - cy) / r - (shY - cy)) / unit;
    const z = clamp((ref.dist * (1 - 1 / r)) / (BODY.arm * BODY.faceCm), -0.5, 1);
    const { curl, spread } = fingerShape(world);
    const thumbDir = norm(sub(world[4], world[2]));
    const raw = { x: clamp(mx * relX, -1.6, 1.6), y: clamp(-relY, -1.6, 1.6), z, F, T, curl, spread, thumbDir };

    // smoothing: the same One Euro filters as the face; a hand that comes back starts fresh
    if (t - tr.seenAt > this.hold + 0.5) tr.filters.reset();
    const sm = Math.max(0.1, s.handSmooth ?? 1.5);
    const mc = (s.smoothing?.minCutoff ?? 1.6) / sm; const beta = s.smoothing?.beta ?? 0.4;
    const f = (k, v, k2 = 1) => tr.filters.run(k, v, t, mc / k2, beta);
    const v = {
      x: f('x', raw.x), y: f('y', raw.y), z: f('z', raw.z, 2), // depth is the noisiest: smooth it more
      F: norm(raw.F.map((c, i) => f(`F${i}`, c))), T: norm(raw.T.map((c, i) => f(`T${i}`, c))),
      curl: raw.curl.map((c, i) => c01(f(`c${i}`, c))), spread: c01(f('sp', raw.spread)), thumbDir: raw.thumbDir,
    };
    tr.v = v; tr.seenAt = t;
    // gesture: the frame's guess must hold for a moment before it counts
    const g = classify(v.curl, v.thumbDir);
    if (g !== tr.cand) { tr.cand = g; tr.candAt = t; }
    if (t - tr.candAt >= SETTLE) tr.gesture = tr.cand;
    this.waveStep(tr, v, t);
  }

  /** Wave: the open hand swinging side to side (or the wrist wagging) at least three times in about 1.5 s. */
  waveStep(tr, v, t) {
    const w = tr.wave;
    const open = v.curl[1] < 0.5 && v.curl[2] < 0.5 && v.curl[3] < 0.55;
    const flip = (val, extKey, dirKey, thresh) => {
      if (w[extKey] === null) { w[extKey] = val; return false; }
      const dd = val - w[extKey];
      // still swinging the same way: that's the new turning point
      if (w[dirKey] !== 0 && Math.sign(dd) === w[dirKey]) { w[extKey] = val; return false; }
      // came back far enough from the last turning point: a swing (the first one only sets the direction)
      if (Math.abs(dd) > thresh) { const was = w[dirKey]; w[dirKey] = Math.sign(dd); w[extKey] = val; return was !== 0; }
      return false;
    };
    const rz = Math.atan2(v.F[0], v.F[1]) * DEG;
    const f1 = flip(v.x, 'ext', 'dir', 0.06); const f2 = flip(rz, 'extR', 'dirR', 14);
    if (open && (f1 || f2)) w.flips.push(t);
    w.flips = w.flips.filter((x) => t - x < 1.5);
    if (!open) w.flips = [];
    // a wave is a raised hand (above the lower chest)
    if (w.flips.length >= 3 && v.y > -0.7) w.until = t + 0.5;
  }

  /** The hands for this frame: hold a lost hand briefly, then ease it back to rest. */
  shape(s, t) {
    const dt = this.lastT === null ? 1 / 60 : clamp(t - this.lastT, 0, 0.25); this.lastT = t;
    const out = {};
    for (const side of ['L', 'R']) {
      const tr = this.tracks[side];
      const seen = t - tr.seenAt < this.hold && tr.v;
      tr.vis += ((seen ? 1 : 0) - tr.vis) * (1 - Math.exp(-dt * (seen ? FADE_IN : FADE_OUT)));
      if (tr.vis < 0.002 && !seen) tr.vis = 0;
      const gesture = !tr.v || tr.vis < 0.5 ? 'none' : t < tr.wave.until ? 'wave' : tr.gesture;
      for (const g of GESTURES) tr.gw[g] += ((g === gesture ? 1 : 0) - tr.gw[g]) * (1 - Math.exp(-dt * 12));
      const v = tr.v || { x: (side === 'L' ? 1 : -1) * HAND_REST.x, y: HAND_REST.y, z: HAND_REST.z, F: [0, -1, 0], T: [0, 0, 1], curl: [0.2, 0.2, 0.2, 0.2, 0.2], spread: 0.2 };
      const vis = tr.vis;
      const ik = arm2D(side, v.x, v.y, v.F);
      const rotZ = Math.atan2(v.F[0], v.F[1]) * DEG; const rotX = Math.asin(clamp(v.F[2], -1, 1)) * DEG; const rotY = Math.asin(clamp(v.T[2], -1, 1)) * DEG;
      const r3 = (x) => Math.round(x * 1000) / 1000;
      out[`hand${side}`] = {
        visible: r3(vis), tracked: !!seen, x: r3(v.x), y: r3(v.y), z: r3(v.z), rotX: r3(rotX), rotY: r3(rotY), rotZ: r3(rotZ),
        dir: v.F.map(r3), side: v.T.map(r3), curl: v.curl.map(r3), spread: r3(v.spread), gesture,
        armA: r3(ik.armA), armB: r3(ik.armB), wrist: r3(ik.wrist),
      };
      // flat keys for parameter bindings, already eased toward rest by "visible"
      const rx = (side === 'L' ? 1 : -1) * HAND_REST.x;
      const fist = (v.curl[1] + v.curl[2] + v.curl[3] + v.curl[4]) / 4;
      Object.assign(out, {
        [`hand${side}Visible`]: vis,
        [`hand${side}X`]: clamp((v.x - rx) * vis, -1.5, 1.5), [`hand${side}Y`]: clamp((v.y - HAND_REST.y) * vis, -1.5, 2.5), [`hand${side}Z`]: v.z * vis,
        [`arm${side}A`]: ik.armA * vis, [`arm${side}B`]: ik.armB * vis, [`hand${side}Angle`]: ik.wrist * vis,
        [`hand${side}Fist`]: fist * vis, [`hand${side}Spread`]: v.spread * vis,
        [`hand${side}Peace`]: tr.gw.peace * vis, [`hand${side}Point`]: tr.gw.point * vis, [`hand${side}ThumbUp`]: tr.gw.thumbsUp * vis, [`hand${side}Wave`]: tr.gw.wave * vis,
      });
    }
    return out;
  }
}

// Labels for the flat keys (the 2D rig's tracking → parameter table).
export const HAND_KEY_INFO = Object.fromEntries(['L', 'R'].flatMap((S) => {
  const n = S === 'L' ? 'Left' : 'Right';
  return [
    [`arm${S}A`, { label: `${n} upper arm angle`, min: -45, max: 135 }], [`arm${S}B`, { label: `${n} forearm angle`, min: -150, max: 150 }],
    [`hand${S}Angle`, { label: `${n} wrist angle`, min: -80, max: 80 }], [`hand${S}X`, { label: `${n} hand X`, min: -1, max: 1 }], [`hand${S}Y`, { label: `${n} hand Y`, min: -1, max: 1 }],
    [`hand${S}Z`, { label: `${n} hand distance`, min: -1, max: 1 }], [`hand${S}Fist`, { label: `${n} hand closed`, min: 0, max: 1 }], [`hand${S}Spread`, { label: `${n} finger spread`, min: 0, max: 1 }],
    [`hand${S}Peace`, { label: `${n} peace sign`, min: 0, max: 1 }], [`hand${S}Point`, { label: `${n} pointing`, min: 0, max: 1 }], [`hand${S}ThumbUp`, { label: `${n} thumbs up`, min: 0, max: 1 }],
    [`hand${S}Wave`, { label: `${n} wave`, min: 0, max: 1 }], [`hand${S}Visible`, { label: `${n} hand seen`, min: 0, max: 1 }],
  ];
}));

// Example hands for test poses: where the hand is and how the fingers sit for each gesture (avatar's left hand; the
// right is mirrored).
const DEMO = {
  open: { x: 0.45, y: -0.15, z: 0.35, curl: [0.1, 0.05, 0.05, 0.05, 0.05], spread: 0.6, dir: [0.1, 1, 0.1] },
  fist: { x: 0.35, y: -0.3, z: 0.35, curl: [0.85, 0.95, 0.95, 0.95, 0.95], spread: 0.1, dir: [0, 1, 0.3] },
  peace: { x: 0.4, y: 0.05, z: 0.3, curl: [0.8, 0.05, 0.05, 0.9, 0.9], spread: 0.7, dir: [0.15, 1, 0] },
  point: { x: 0.25, y: -0.1, z: 0.55, curl: [0.7, 0.05, 0.9, 0.9, 0.9], spread: 0.1, dir: [-0.2, 0.4, 1] },
  thumbsUp: { x: 0.35, y: -0.3, z: 0.4, curl: [0.1, 0.95, 0.95, 0.95, 0.95], spread: 0.1, dir: [-1, 0.1, 0.2], up: [0, 1, 0] },
  wave: { x: 0.55, y: 0.25, z: 0.15, curl: [0.1, 0.05, 0.05, 0.05, 0.05], spread: 0.6, dir: [0.15, 1, 0] },
};
/** A hand object (contract shape) showing a gesture, for test poses. t (seconds) animates the wave. */
export function demoHand(gesture, side = 'L', t = 0) {
  const d = DEMO[gesture] || DEMO.open; const k = side === 'L' ? 1 : -1;
  const sw = gesture === 'wave' ? Math.sin(t * 9) * 0.3 : 0;
  const F = norm([(d.dir[0] + sw) * k, d.dir[1], d.dir[2]]);
  const up = d.up || [0, 0, 1];
  const T = norm(sub(up, F.map((c) => c * dot(up, F))));
  const x = (d.x + sw * 0.15) * k; const ik = arm2D(side, x, d.y, F);
  return { visible: 1, tracked: true, x, y: d.y, z: d.z, rotX: Math.asin(F[2]) * DEG, rotY: 0, rotZ: Math.atan2(F[0], F[1]) * DEG, dir: F, side: T, curl: d.curl.slice(), spread: d.spread, gesture, armA: ik.armA, armB: ik.armB, wrist: ik.wrist };
}
