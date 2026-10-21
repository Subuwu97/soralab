// The '3d' document of Sora Ningyō: which model file to load (an asset id), plus everything we change on top of it —
// humanoid bone mapping, expressions, spring bones, materials, lighting, tracking sensitivity, stage camera and the
// VRM licence fields. No three.js here, so the app shell can import it without pulling in the 3D engine.

export const uid = (p = 'x') => `${p}${Math.random().toString(36).slice(2, 9)}`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// VRM 1.0 expression presets, in the order the Expressions panel lists them.
export const PRESETS = [
  'happy', 'angry', 'sad', 'relaxed', 'surprised',
  'aa', 'ih', 'ou', 'ee', 'oh',
  'blink', 'blinkLeft', 'blinkRight',
  'lookUp', 'lookDown', 'lookLeft', 'lookRight',
  'neutral',
];
export const PRESET_GROUPS = [
  ['Emotions', ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral']],
  ['Mouth', ['aa', 'ih', 'ou', 'ee', 'oh']],
  ['Eyes', ['blink', 'blinkLeft', 'blinkRight']],
  ['Look (no eye bones)', ['lookUp', 'lookDown', 'lookLeft', 'lookRight']],
];
export const PRESET_LABELS = {
  happy: 'Happy', angry: 'Angry', sad: 'Sad', relaxed: 'Relaxed', surprised: 'Surprised', neutral: 'Neutral',
  aa: 'Mouth “aa”', ih: 'Mouth “ih”', ou: 'Mouth “ou”', ee: 'Mouth “ee”', oh: 'Mouth “oh”',
  blink: 'Blink', blinkLeft: 'Blink left', blinkRight: 'Blink right',
  lookUp: 'Look up', lookDown: 'Look down', lookLeft: 'Look left', lookRight: 'Look right',
};

// The 52 ARKit face blendshapes (MediaPipe uses the same names). Models that have them get "perfect sync".
export const ARKIT = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

// VRM humanoid bones (same names as three-vrm's VRMHumanBoneList), grouped for the mapping table.
const FINGERS = (s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) => (f === 'Thumb'
  ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((p) => `${s}${f}${p}`));
export const BONE_GROUPS = [
  ['Body', ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw', 'leftEye', 'rightEye']],
  ['Left arm', ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand']],
  ['Right arm', ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']],
  ['Left leg', ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes']],
  ['Right leg', ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']],
  ['Left fingers', FINGERS('left')],
  ['Right fingers', FINGERS('right')],
];
export const HUMAN_BONES = BONE_GROUPS.flatMap(([, b]) => b);
export const REQUIRED_BONES = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
export const boneLabel = (b) => b.replace(/^(left|right)/, (m) => `${m[0].toUpperCase()}${m.slice(1)} `).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

// VRM 1.0 licence options (VRMC_vrm meta), with plain-language labels.
export const LICENSE = {
  avatarPermission: [['onlyAuthor', 'Only the author'], ['onlySeparatelyLicensedPerson', 'People the author licenses separately'], ['everyone', 'Everyone']],
  commercialUsage: [['personalNonProfit', 'Personal, non-profit'], ['personalProfit', 'Personal, for profit'], ['corporation', 'Companies too']],
  creditNotation: [['required', 'Credit required'], ['unnecessary', 'No credit needed']],
  modification: [['prohibited', 'Not allowed'], ['allowModification', 'Allowed'], ['allowModificationRedistribution', 'Allowed, and modified versions may be shared']],
};
export const LICENSE_FLAGS = [
  ['allowExcessivelyViolentUsage', 'Allow violent content'],
  ['allowExcessivelySexualUsage', 'Allow sexual content'],
  ['allowPoliticalOrReligiousUsage', 'Allow political or religious use'],
  ['allowAntisocialOrHateUsage', 'Allow antisocial or hateful use'],
  ['allowRedistribution', 'Allow redistributing the model file'],
];

export const LIGHTS = [
  { value: 'studio', label: 'Studio' }, { value: 'soft', label: 'Soft' }, { value: 'sunset', label: 'Sunset' },
  { value: 'night', label: 'Night' }, { value: 'flat', label: 'Flat (toon)' },
];
export const FRAMINGS = [
  { value: 'face', label: 'Face' }, { value: 'bust', label: 'Bust-up' }, { value: 'waist', label: 'Waist-up' },
  { value: 'full', label: 'Full body' }, { value: 'custom', label: 'Custom' },
];

// Spring bone presets: what VSeeFace / UniVRM users usually start from.
export const SPRING_PRESETS = {
  hair: { label: 'Hair', stiffness: 1.0, gravity: 0.08, drag: 0.4, radius: 0.02 },
  skirt: { label: 'Skirt / cloth', stiffness: 1.6, gravity: 0.25, drag: 0.5, radius: 0.03 },
  ears: { label: 'Ears', stiffness: 3.0, gravity: 0, drag: 0.6, radius: 0.02 },
  tail: { label: 'Tail', stiffness: 0.8, gravity: 0.15, drag: 0.3, radius: 0.03 },
  soft: { label: 'Soft / bouncy', stiffness: 0.5, gravity: 0.05, drag: 0.2, radius: 0.02 },
};

// How tracking drives the 3D avatar (doc.drive). doc.tracking belongs to the app's tracker (per-key tuning, mirroring).
export const DEFAULT_DRIVE = {
  mirror: false,            // swap left and right once more (the tracker already mirrors by default)
  head: 1,                  // head rotation sensitivity
  split: { head: 0.6, neck: 0.3, spine: 0.1 }, // how a head turn is shared out
  body: 0.6,                // body lean (bodyYaw/Pitch/Roll)
  move: 0.5,                // head position → leaning the hips
  eyes: 1, eyeRange: 12,    // gaze sensitivity, and how far eye bones turn (degrees)
  blink: 1, blinkClosed: 0.2, blinkOpen: 0.7, linkEyes: false,
  mouth: 1, smile: 0.6, brows: 0.5,
  perfectSync: 'auto',      // 'auto' | 'on' | 'off' — drive ARKit shapes straight from tracking
  idle: true,               // breathe and sway when tracking is lost
  armAngle: null,           // degrees to lower T-posed arms by; null = automatic
};
export const DEFAULT_CAMERA = { framing: 'bust', fov: 30, zoom: 1, x: 0, y: 0, turn: 0, custom: null };
export const DEFAULT_LOOK = { light: 'studio', env: true, background: '#2b2f3a', exposure: 1 };
export const DEFAULT_META = {
  name: '', version: '1.0', authors: '', copyright: '', contact: '', references: '', otherLicenseUrl: '',
  avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', creditNotation: 'required', modification: 'prohibited',
  allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false, allowRedistribution: false, thumbnail: null,
};

/** A new, empty '3d' document (no model yet — the editor offers import or the starter avatar). */
export function empty3D(projectDoc = {}) {
  return {
    version: 1, kind: '3d', name: projectDoc?.name || 'Avatar',
    model: null, humanoid: { bones: {} }, autorig: null,
    expressions: {}, lookAt: { type: 'auto', range: 10 },
    springs: { chains: [], colliders: [] },
    materials: {}, look: { ...DEFAULT_LOOK }, drive: { ...DEFAULT_DRIVE, split: { ...DEFAULT_DRIVE.split } },
    camera: { ...DEFAULT_CAMERA }, meta: { ...DEFAULT_META, name: projectDoc?.name || '' },
  };
}

/** Fills in anything missing from a saved document (older saves, hand-made docs). */
export function from3D(data, projectDoc) {
  const e = empty3D(projectDoc);
  if (!data || typeof data !== 'object' || data.kind !== '3d') return { ...e, ...(data && typeof data === 'object' ? data : {}), kind: '3d' };
  return {
    ...e, ...data,
    humanoid: { bones: {}, ...(data.humanoid || {}) },
    springs: { chains: [], colliders: [], ...(data.springs || {}) },
    lookAt: { ...e.lookAt, ...(data.lookAt || {}) },
    look: { ...e.look, ...(data.look || {}) },
    drive: { ...e.drive, ...(data.drive || {}), split: { ...e.drive.split, ...(data.drive?.split || {}) } },
    camera: { ...e.camera, ...(data.camera || {}) },
    meta: { ...e.meta, ...(data.meta || {}) },
    expressions: data.expressions || {}, materials: data.materials || {},
  };
}

/** The asset id the model loads from (and every side file), for "where does this project's data live". */
export const modelAssets = (doc) => [doc?.model?.asset, ...Object.values(doc?.model?.files || {}), doc?.meta?.thumbnail,
  ...Object.values(doc?.materials || {}).map((m) => m.map)].filter(Boolean);

export const fileFormat = (name = '') => {
  const ext = name.split('.').pop().toLowerCase();
  return ['vrm', 'glb', 'gltf', 'fbx'].includes(ext) ? ext : null;
};
