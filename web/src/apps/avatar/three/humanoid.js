// Humanoid bone auto-mapping for models that aren't VRM yet: Mixamo ("mixamorig:LeftForeArm"), VRoid ("J_Bip_L_LowerArm"),
// Blender / Rigify ("DEF-upper_arm.L", "forearm.L"), Unity humanoid ("LeftLowerArm"), 3ds Max biped ("Bip01 L Forearm"),
// MMD ("左腕") and plenty of hand-made rigs. Limbs are matched by name; the torso (spine/chest/upperChest) and the
// finger joints are matched by their place in the chain, which is far more reliable than counting "Spine1/Spine2".
import { HUMAN_BONES } from './model.js';

// Split "mixamorig:LeftHandIndex1" / "J_Bip_L_UpperArm" / "upper_arm.L" into lower-case words.
export function tokens(name) {
  return String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9぀-ヿ一-鿿]+/).filter(Boolean);
}
const NOISE = new Set(['mixamorig', 'mixamo', 'def', 'org', 'mch', 'j', 'bip', 'bip01', 'bip001', 'c', 'sec', 'adj', 'armature', 'bone', 'jnt', 'joint', 'b', 'skel', 'cc', 'base', 'rig', 'ik', 'fk', 'grp', 'char', 'sk', 'jbip']);
const JP_SIDE = [['左', 'left'], ['右', 'right']];

/** { side: 'left'|'right'|null, core: 'upperarm', words } */
export function parseName(name) {
  let side = null;
  for (const [jp, s] of JP_SIDE) if (String(name).includes(jp)) side = s;
  const w = tokens(name);
  const rest = [];
  for (const t of w) {
    if (t === 'left' || t === 'l' || t === 'lft') side = side || 'left';
    else if (t === 'right' || t === 'r' || t === 'rgt' || t === 'rt') side = side || 'right';
    else if (!NOISE.has(t)) rest.push(t);
  }
  return { side, core: rest.join(''), words: rest };
}

// Name rules for the limb bones. Order matters: earlier rules win (e.g. "forearm" before "arm").
const RULES = [
  ['Eye', /^(eye|eyeball|目)$|^eye(ball)?(joint)?$/],
  ['Shoulder', /^(shoulder|clavicle|collar|collarbone|鎖骨|肩)$/],
  ['LowerArm', /^(forearm|lowerarm|elbow|ひじ|肘|forearmtwist)$/],
  ['UpperArm', /^(upperarm|arm|uparm|腕)$/],
  ['Hand', /^(hand|wrist|手首|手)$/],
  ['UpperLeg', /^(upperleg|upleg|thigh|leg|足|太もも)$/],
  ['LowerLeg', /^(lowerleg|calf|shin|knee|ひざ|膝)$/],
  ['Foot', /^(foot|ankle|足首)$/],
  ['Toes', /^(toes?|toebase|ball|つま先)$/],
];
// Mixamo calls the thigh "UpLeg" and the shin "Leg": when a rig has both, "leg" means the lower leg.
const FINGER_WORDS = [['Thumb', /thumb|親指/], ['Index', /index|pointer|人指|人差/], ['Middle', /middle|中指/], ['Ring', /ring|薬指/], ['Little', /little|pinky|pinkie|小指/]];
const SEGMENTS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] };

const isDesc = (node, anc) => { for (let n = node?.parent; n; n = n.parent) if (n === anc) return true; return false; };

/**
 * Suggests a humanoid mapping. bones: Object3D[] (the model's bones), preferred: Set of bones that skin something
 * (Rigify and friends have many control bones with the same names; deform bones win). Returns { hips: 'boneName', … }.
 */
export function autoMap(bones, preferred = new Set()) {
  const map = {};
  const parsed = bones.map((b) => ({ b, ...parseName(b.name) }));
  const score = (p) => (preferred.has(p.b) ? 2 : 0) + (/^def/i.test(p.b.name) ? 1 : 0) - (/(^|[^a-z])(ik|ctrl|control|mch|pole|target|helper|twist|roll|end|nub|tip|_end)([^a-z]|$)/i.test(p.b.name) ? 3 : 0);
  const pick = (list) => list.sort((a, b) => score(b) - score(a) || depth(a.b) - depth(b.b))[0]?.b;
  const depth = (n) => { let d = 0; for (let x = n.parent; x; x = x.parent) d++; return d; };

  // Body: hips, neck, head by name.
  const byCore = (re, side = null) => parsed.filter((p) => re.test(p.core) && (side === undefined || p.side === side));
  const hips = pick(byCore(/^(hips?|pelvis|腰|下半身|センター|center)$/)) || pick(byCore(/^(root)?hips?$/, undefined));
  const head = pick(byCore(/^(head|頭)$/));
  const neck = pick(byCore(/^(neck|首)$/));
  if (hips) map.hips = hips.name;
  if (neck) map.neck = neck.name;
  if (head) map.head = head.name;
  const jaw = pick(byCore(/^(jaw|あご)$/));
  if (jaw && head && isDesc(jaw, head)) map.jaw = jaw.name;

  // Limbs, by name and side. Remember which side words a rig uses for "leg" so Mixamo's UpLeg/Leg resolve.
  const hasUpLeg = parsed.some((p) => /^(upleg|thigh|upperleg)$/.test(p.core));
  for (const side of ['left', 'right']) {
    for (const [part, re] of RULES) {
      let list = parsed.filter((p) => p.side === side && re.test(p.core));
      if (part === 'UpperLeg' && hasUpLeg) list = list.filter((p) => p.core !== 'leg');
      if (part === 'LowerLeg' && hasUpLeg) list = list.concat(parsed.filter((p) => p.side === side && p.core === 'leg'));
      const b = pick(list);
      if (b) map[`${side}${part}`] = b.name;
    }
    // Fingers: find the first bone of each finger under the hand, then walk the chain.
    const hand = bones.find((b) => b.name === map[`${side}Hand`]);
    if (hand) {
      for (const [finger, re] of FINGER_WORDS) {
        const cands = parsed.filter((p) => isDesc(p.b, hand) && re.test(p.words.join(' ') || p.b.name.toLowerCase()) && (!p.side || p.side === side));
        const first = cands.sort((a, b) => depth(a.b) - depth(b.b))[0]?.b;
        if (!first) continue;
        const chain = [first];
        for (let n = first; ;) {
          const next = n.children.find((c) => cands.some((p) => p.b === c)) || null;
          if (!next || chain.length >= 3) break;
          chain.push(next); n = next;
        }
        const seg = finger === 'Thumb' ? SEGMENTS.Thumb : SEGMENTS.other;
        // A 3-bone thumb is metacarpal/proximal/distal in VRM 1.0; a 2-bone one skips the metacarpal.
        const names = finger === 'Thumb' && chain.length < 3 ? seg.slice(3 - chain.length) : seg;
        chain.forEach((b, i) => { if (names[i]) map[`${side}${finger}${names[i]}`] = b.name; });
      }
    }
  }

  // Torso: the bones between the hips and the neck (or the upper arms' common ancestor), in order.
  const hipsNode = bones.find((b) => b.name === map.hips);
  const top = bones.find((b) => b.name === map.neck) || bones.find((b) => b.name === map.head)
    || bones.find((b) => b.name === map.leftShoulder) || bones.find((b) => b.name === map.leftUpperArm);
  if (hipsNode && top) {
    const chain = [];
    for (let n = top.parent; n && n !== hipsNode; n = n.parent) chain.unshift(n);
    if (isDesc(top, hipsNode)) {
      // Drop the neck's own shoulder-level helpers (rare) and skip non-bones.
      const spine = chain.filter((n) => !map.neck || n.name !== map.neck);
      if (spine.length >= 1) map.spine = spine[0].name;
      if (spine.length === 2) map.chest = spine[1].name;
      if (spine.length >= 3) { map.chest = spine[1].name; map.upperChest = spine[spine.length - 1].name; }
      // Some rigs put the shoulder under the neck; that's fine, but neck must sit above the chest.
    }
  }
  // A "hips" with no spine above it is probably the armature root: try its first child with a spine-ish name.
  if (!map.spine && hipsNode) {
    const s = pick(parsed.filter((p) => /^(spine|背骨|上半身)/.test(p.core) && isDesc(p.b, hipsNode)));
    if (s) map.spine = s.name;
  }

  // Sanity: each limb bone must sit below its parent bone in the hierarchy; drop the ones that don't.
  const parentOf = { leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
    leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
    head: 'neck', leftEye: 'head', rightEye: 'head' };
  const node = (k) => bones.find((b) => b.name === map[k]);
  for (const [k, p] of Object.entries(parentOf)) if (map[k] && map[p] && !isDesc(node(k), node(p))) delete map[k];
  // Never map one bone twice.
  const seen = new Set();
  for (const k of HUMAN_BONES) { if (!map[k]) continue; if (seen.has(map[k])) delete map[k]; else seen.add(map[k]); }
  return map;
}

/** Bones the model has: skeleton bones, Bone objects, and anything else a mapping or spring already refers to. */
export function listBones(root) {
  const set = new Set();
  const skinned = new Set(); // bones that actually move vertices (weight > 0 somewhere)
  root.traverse((o) => {
    if (o.isBone) set.add(o);
    if (!o.isSkinnedMesh) return;
    for (const b of o.skeleton.bones) set.add(b);
    const si = o.geometry.attributes.skinIndex; const sw = o.geometry.attributes.skinWeight;
    if (!si || !sw) return;
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.001) { const b = o.skeleton.bones[si.getComponent(i, k)]; if (b) skinned.add(b); }
  });
  const list = [];
  root.traverse((o) => { if (set.has(o)) list.push(o); }); // tree order
  return { bones: list, deform: skinned };
}
