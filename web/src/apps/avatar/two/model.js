// Sora Ningyō's open 2D rig — the document. A Live2D-Cubism-style model: textured parts with meshes, warp and rotation
// deformers in a hierarchy, parameters whose key values hold "keyforms" (how things look at that value), physics,
// expressions, and the tracking → parameter bindings. Everything is plain JSON; textures are PNG assets.
//
//   doc = { version: 1, kind: '2d', width, height,                 canvas size (the PSD's)
//     parts: [ { id, name, role, tex: assetId, x, y, w, h,         texture placed at x,y (canvas px), w×h
//                visible, opacity, blend: normal|multiply|screen|add, clip: [partId], invertClip,
//                parent: deformerId|null, group: groupId|null,
//                mesh: { v: [x,y,…] canvas px at rest, t: [i,j,k,…] triangles, pins: [i], density }, kf: [binding] } ],
//              parts are in draw order: the first is drawn first (at the back)
//     groups: [ { id, name } ]                                     folders for the parts list (from PSD groups)
//     deformers: [ { id, name, type: 'warp', parent, rect: [x,y,w,h], cols, rows, opacity, kf }
//                | { id, name, type: 'rotation', parent, pivot: [x,y], opacity, kf } ]
//     params: [ { id: 'ParamAngleX', name, min, def, max, keys: [-30, 0, 30] } ]
//     physics: [ chain ] (see physics.js)   expressions: [ { id, name, params: [{ param, value, mode: add|set|mul }] } ]
//     bindings: [ { pose: 'headYaw', param: 'ParamAngleX', scale, offset } ]   tracking → parameters
//     tracking, perform                                            shared Perform settings (see ../tracking)
//   }
//   binding (a keyform set) = { params: [p1] | [p1, p2], forms: { 'v1' | 'v1|v2': form } }
//   form = { v?: [dx,dy,…] (mesh vertices or warp grid points), a?: degrees, x?, y?, s?: scale change, o?: opacity change, z?: draw order change }
//   Forms hold changes from the rest pose, so a key value without a form looks like rest.
export const uid = (p = 'p') => `${p}${Math.random().toString(36).slice(2, 9)}`;
export const formKey = (vals) => vals.map((v) => +(+v).toFixed(4)).join('|');

// Cubism's standard parameter IDs, so models and habits carry over.
export const STD_PARAMS = [
  ['ParamAngleX', 'Angle X', -30, 0, 30], ['ParamAngleY', 'Angle Y', -30, 0, 30], ['ParamAngleZ', 'Angle Z', -30, 0, 30],
  ['ParamEyeLOpen', 'Eye L Open', 0, 1, 1], ['ParamEyeLSmile', 'Eye L Smile', 0, 0, 1], ['ParamEyeROpen', 'Eye R Open', 0, 1, 1], ['ParamEyeRSmile', 'Eye R Smile', 0, 0, 1],
  ['ParamEyeBallX', 'Eyeball X', -1, 0, 1], ['ParamEyeBallY', 'Eyeball Y', -1, 0, 1],
  ['ParamBrowLY', 'Brow L Y', -1, 0, 1], ['ParamBrowRY', 'Brow R Y', -1, 0, 1],
  ['ParamMouthForm', 'Mouth Form', -1, 0, 1], ['ParamMouthOpenY', 'Mouth Open', 0, 0, 1],
  ['ParamCheek', 'Cheek', 0, 0, 1],
  ['ParamBodyAngleX', 'Body X', -10, 0, 10], ['ParamBodyAngleY', 'Body Y', -10, 0, 10], ['ParamBodyAngleZ', 'Body Z', -10, 0, 10],
  ['ParamBreath', 'Breath', 0, 0, 1],
  ['ParamHairFront', 'Hair Front', -1, 0, 1], ['ParamHairSide', 'Hair Side', -1, 0, 1], ['ParamHairBack', 'Hair Back', -1, 0, 1],
  // Arms and hands (driven by hand tracking; L is the avatar's left, on the screen's right). Angles in degrees,
  // "outward" positive on both sides: ArmA the upper arm from hanging down, ArmB the forearm from the upper arm's line,
  // Hand the wrist from the forearm's line. The gesture ones are 0..1 weights, X/Y follow the wrist's position.
  ...['L', 'R'].flatMap((S) => [
    [`ParamArm${S}A`, `Arm ${S} A (upper)`, -45, 0, 135], [`ParamArm${S}B`, `Arm ${S} B (forearm)`, -150, 0, 150], [`ParamHand${S}`, `Hand ${S} (wrist)`, -80, 0, 80],
    [`ParamHand${S}Fist`, `Hand ${S} Closed`, 0, 0, 1], [`ParamHand${S}Peace`, `Hand ${S} Peace`, 0, 0, 1], [`ParamHand${S}Point`, `Hand ${S} Point`, 0, 0, 1],
    [`ParamHand${S}ThumbUp`, `Hand ${S} Thumbs up`, 0, 0, 1], [`ParamHand${S}X`, `Hand ${S} X`, -1, 0, 1], [`ParamHand${S}Y`, `Hand ${S} Y`, -1, 0, 1],
  ]),
];
// The arm/hand parameters: new documents don't get them (most avatars are bust-ups); auto-rig adds them when it finds
// arm or hand parts, and the Parameters panel offers them.
export const HAND_PARAM_IDS = new Set(STD_PARAMS.filter(([id]) => /^Param(Arm|Hand)[LR]/.test(id)).map(([id]) => id));
export const stdParam = (id) => {
  const s = STD_PARAMS.find((p) => p[0] === id);
  if (!s) return null;
  const [, name, min, def, max] = s;
  return { id, name, min, def, max, keys: [...new Set([min, def, max])].sort((a, b) => a - b) };
};

// Tracking → parameter defaults (VTube Studio-like).
export const DEFAULT_BINDINGS = [
  ['headYaw', 'ParamAngleX'], ['headPitch', 'ParamAngleY'], ['headRoll', 'ParamAngleZ'],
  ['bodyYaw', 'ParamBodyAngleX'], ['bodyPitch', 'ParamBodyAngleY'], ['bodyRoll', 'ParamBodyAngleZ'],
  ['eyeLOpen', 'ParamEyeLOpen'], ['eyeROpen', 'ParamEyeROpen'], ['eyeX', 'ParamEyeBallX'], ['eyeY', 'ParamEyeBallY'],
  ['browL', 'ParamBrowLY'], ['browR', 'ParamBrowRY'], ['mouthOpen', 'ParamMouthOpenY'], ['mouthForm', 'ParamMouthForm'],
  ['cheek', 'ParamCheek'], ['breath', 'ParamBreath'],
  // hands (only when Perform tracks them; the keys are already back at 0 when a hand isn't seen)
  ...['L', 'R'].flatMap((S) => [[`arm${S}A`, `ParamArm${S}A`], [`arm${S}B`, `ParamArm${S}B`], [`hand${S}Angle`, `ParamHand${S}`], [`hand${S}Fist`, `ParamHand${S}Fist`],
    [`hand${S}Peace`, `ParamHand${S}Peace`], [`hand${S}Point`, `ParamHand${S}Point`], [`hand${S}ThumbUp`, `ParamHand${S}ThumbUp`], [`hand${S}X`, `ParamHand${S}X`], [`hand${S}Y`, `ParamHand${S}Y`]]),
].map(([pose, param]) => ({ pose, param, scale: 1, offset: 0 }));

// The parts a face rig needs, and the names people usually give those layers (English and Japanese).
//   side: L/R means one per side; the PSD name's side words (L, R, left, 左…) decide which.
//   Order matters for guessing: mouth before eyes ("mouth upper" isn't an upper lash), lower lash before lash.
export const ROLES = [
  { id: 'face', label: 'Face', re: /^(face|skin|head|顔|輪郭|かお)/i },
  { id: 'neck', label: 'Neck', re: /(neck|首)/i },
  // arms and hands (optional: auto-rig adds arm rotation when it finds them). Forearm before upper arm: "arm" alone
  // (or 腕) means the whole arm, which auto-rig turns at the shoulder.
  { id: 'lowerArm', label: 'Forearm', side: true, optional: true, re: /(fore\s*arm|lower\s*arm|arm\s*low|前腕)/i },
  { id: 'upperArm', label: 'Upper arm', side: true, optional: true, re: /(upper\s*arm|(^|[^a-z])arms?([^a-z]|$)|sleeve|上腕|二の腕|腕|袖)/i },
  { id: 'hand', label: 'Hand', side: true, optional: true, re: /((^|[^a-z])hands?([^a-z]|$)|palm|fist|手(?!首)|てのひら)/i },
  { id: 'body', label: 'Body', re: /(body|torso|chest|clothes|体|胴|服|からだ)/i },
  { id: 'mouthUpper', label: 'Mouth (upper lip)', re: /(upper\s*lip|mouth\s*up|lip\s*top|上唇|口上)/i },
  { id: 'mouthLower', label: 'Mouth (lower lip)', re: /(lower\s*lip|mouth\s*(low|bottom)|lip\s*bottom|下唇|口下)/i },
  { id: 'mouthInside', label: 'Mouth (inside)', re: /(mouth\s*in|inside|口内|口の中|teeth|tongue|歯|舌)/i },
  { id: 'nose', label: 'Nose', optional: true, re: /(nose|鼻)/i },
  { id: 'eyeWhite', label: 'Eye white', side: true, re: /(eye\s*white|white|sclera|白目)/i },
  { id: 'iris', label: 'Iris', side: true, re: /(iris|pupil|eyeball|黒目|瞳|目玉)/i },
  { id: 'lowerLash', label: 'Lower lash', side: true, optional: true, re: /(lower|下まぶた|下まつげ)/i },
  { id: 'lash', label: 'Upper lash / lid', side: true, re: /(lash|lid|eyeline|upper|まつげ|まつ毛|睫毛|上まぶた|アイライン)/i },
  { id: 'brow', label: 'Brow', side: true, re: /(brow|眉|まゆ)/i },
  { id: 'hairFront', label: 'Hair (front)', re: /(front\s*hair|hair\s*front|bangs|fringe|前髪)/i },
  { id: 'hairSide', label: 'Hair (side)', optional: true, re: /(side\s*hair|hair\s*side|横髪|サイド)/i },
  { id: 'hairBack', label: 'Hair (back)', re: /(back\s*hair|hair\s*back|後ろ髪|後髪)/i },
];
const SIDE_L = /(^|[\s_.\-(])(l|left)($|[\s_.\-)])|左|\bleft\b/i;
const SIDE_R = /(^|[\s_.\-(])(r|right)($|[\s_.\-)])|右|\bright\b/i;
/** Guesses a part's role ('iris', 'eyeWhite'…) and side ('L' / 'R' / '') from its layer name and group path. */
export function guessRole(name, path = '') {
  const full = `${path} ${name}`;
  // try the layer's own name first, then with its folders ("Eye L / white")
  for (const text of [name, full]) {
    for (const r of ROLES) {
      if (!r.re.test(text)) continue;
      // "mouth" alone means the whole mouth: call it the upper lip, the person can change it
      const side = r.side ? (SIDE_L.test(full) ? 'L' : SIDE_R.test(full) ? 'R' : '') : '';
      return { role: r.id, side };
    }
  }
  if (/(mouth|口)/i.test(full)) return { role: 'mouthUpper', side: '' };
  if (/(hair|髪)/i.test(full)) return { role: 'hairFront', side: '' };
  if (/(eye|目)/i.test(full)) return { role: 'eyeWhite', side: SIDE_L.test(full) ? 'L' : SIDE_R.test(full) ? 'R' : '' };
  return { role: '', side: '' };
}
export const roleId = (role, side) => (role ? `${role}${side || ''}` : '');
/** The checklist: every role (per side) and the parts that fill it. */
export function checklist(doc) {
  const out = [];
  for (const r of ROLES) for (const side of r.side ? ['L', 'R'] : ['']) {
    const id = roleId(r.id, side);
    out.push({ id, label: `${r.label}${side ? ` ${side}` : ''}`, optional: !!r.optional, parts: doc.parts.filter((p) => p.role === id) });
  }
  return out;
}

export function emptyDoc2D(meta = {}) {
  return {
    version: 1, kind: '2d', width: meta.width || 2048, height: meta.height || 2048,
    parts: [], groups: [], deformers: [],
    params: STD_PARAMS.filter(([id]) => !HAND_PARAM_IDS.has(id)).map(([id]) => stdParam(id)),
    physics: [], expressions: [], bindings: DEFAULT_BINDINGS.map((b) => ({ ...b })),
  };
}
/** Fills in anything an older or hand-made document lacks. */
export function normalize2D(d) {
  const e = emptyDoc2D(d);
  const out = { ...e, ...d };
  for (const k of ['parts', 'groups', 'deformers', 'physics', 'expressions']) out[k] = Array.isArray(d[k]) ? d[k] : [];
  out.params = Array.isArray(d.params) && d.params.length ? d.params : e.params;
  out.bindings = Array.isArray(d.bindings) ? d.bindings : e.bindings;
  out.parts = out.parts.map((p) => ({ visible: true, opacity: 1, blend: 'normal', clip: [], parent: null, group: null, kf: [], ...p }));
  out.deformers = out.deformers.map((x) => ({ opacity: 1, parent: null, kf: [], ...x }));
  return out;
}

// ---------------------------------------------------------------- parameters and keyforms

export const paramById = (doc, id) => doc.params.find((p) => p.id === id);
export const defaults = (doc) => Object.fromEntries(doc.params.map((p) => [p.id, p.def]));
export const objById = (doc, id) => doc.parts.find((p) => p.id === id) || doc.deformers.find((x) => x.id === id);

/** Where value v sits among a parameter's keys: [i, j, t] — between keys[i] and keys[j] at t (0..1). */
export function bracket(keys, v) {
  const n = keys.length;
  if (n === 1 || v <= keys[0]) return [0, 0, 0];
  if (v >= keys[n - 1]) return [n - 1, n - 1, 0];
  let i = 0; while (i < n - 2 && v > keys[i + 1]) i++;
  const span = keys[i + 1] - keys[i];
  return [i, i + 1, span > 0 ? (v - keys[i]) / span : 0];
}

/** The weighted forms of a binding at the current values: [[form, weight], …] (missing forms count as rest). */
export function formsAt(doc, binding, values) {
  const ps = binding.params.map((id) => paramById(doc, id)).filter(Boolean);
  if (!ps.length) return [];
  const br = ps.map((p) => { const v = values[p.id] ?? p.def; const [i, j, t] = bracket(p.keys, v); return [[p.keys[i], 1 - t], [p.keys[j], t]]; });
  const out = [];
  if (ps.length === 1) {
    for (const [k, w] of br[0]) { const f = binding.forms[formKey([k])]; if (f && w > 1e-6) out.push([f, w]); }
  } else {
    for (const [k1, w1] of br[0]) for (const [k2, w2] of br[1]) { const f = binding.forms[formKey([k1, k2])]; const w = w1 * w2; if (f && w > 1e-6) out.push([f, w]); }
  }
  return out;
}

/** The key combination the values sit exactly on for this binding (for editing), or null when between keys. */
export function exactKey(doc, binding, values) {
  const vals = [];
  for (const id of binding.params) {
    const p = paramById(doc, id); if (!p) return null;
    const v = values[id] ?? p.def;
    const k = p.keys.find((x) => Math.abs(x - v) < 1e-4 * Math.max(1, Math.abs(p.max - p.min)));
    if (k === undefined) return null;
    vals.push(k);
  }
  return formKey(vals);
}

/** Interpolated form of a binding at the given key values (used when adding a key between existing ones). */
export function blendForm(list, len) {
  const out = {};
  for (const [f, w] of list) {
    for (const k of ['a', 'x', 'y', 's', 'o', 'z']) if (f[k]) out[k] = (out[k] || 0) + f[k] * w;
    if (f.v) { out.v ||= new Array(len || f.v.length).fill(0); for (let i = 0; i < f.v.length; i++) out.v[i] += f.v[i] * w; }
  }
  return out;
}

/** Adds a key value to a parameter, filling every binding that uses it with the in-between form so nothing jumps. */
export function addParamKey(doc, pid, value) {
  const p = paramById(doc, pid);
  if (!p || p.keys.some((k) => Math.abs(k - value) < 1e-6)) return doc;
  const keys = [...p.keys, value].sort((a, b) => a - b);
  const fill = (obj) => {
    if (!obj.kf?.some((b) => b.params.includes(pid))) return obj;
    return { ...obj, kf: obj.kf.map((b) => {
      if (!b.params.includes(pid)) return b;
      const forms = { ...b.forms };
      const idx = b.params.indexOf(pid);
      const other = b.params.length === 2 ? paramById(doc, b.params[1 - idx]) : null;
      for (const ok of other ? other.keys : [null]) {
        const vals = {}; vals[pid] = value; if (other) vals[other.id] = ok;
        const f = blendForm(formsAt(doc, b, vals));
        const kv = b.params.map((id) => vals[id]);
        if (Object.keys(f).length) forms[formKey(kv)] = round(f);
      }
      return { ...b, forms };
    }) };
  };
  return { ...doc, params: doc.params.map((x) => (x.id === pid ? { ...x, keys } : x)), parts: doc.parts.map(fill), deformers: doc.deformers.map(fill) };
}
export function removeParamKey(doc, pid, value) {
  const p = paramById(doc, pid);
  if (!p || p.keys.length <= 1) return doc;
  const kill = (obj) => (!obj.kf?.length ? obj : { ...obj, kf: obj.kf.map((b) => {
    const idx = b.params.indexOf(pid); if (idx < 0) return b;
    return { ...b, forms: Object.fromEntries(Object.entries(b.forms).filter(([k]) => Math.abs(+k.split('|')[idx] - value) > 1e-6)) };
  }) });
  return { ...doc, params: doc.params.map((x) => (x.id === pid ? { ...x, keys: x.keys.filter((k) => Math.abs(k - value) > 1e-6) } : x)), parts: doc.parts.map(kill), deformers: doc.deformers.map(kill) };
}

/** Rounds a form's numbers (keeps documents small). */
export function round(f) {
  const o = {};
  for (const [k, v] of Object.entries(f)) o[k] = Array.isArray(v) ? v.map((x) => Math.round(x * 100) / 100) : Math.round(v * 1000) / 1000;
  return o;
}

/** Number of geometry values an object's forms carry (mesh vertices or warp grid points, ×2). */
export const geomLen = (obj) => (obj.mesh ? obj.mesh.v.length : obj.type === 'warp' ? (obj.cols + 1) * (obj.rows + 1) * 2 : 0);
/** Rest positions of a warp deformer's grid points. */
export function warpRest(d) {
  const [x, y, w, h] = d.rect; const out = new Float32Array((d.cols + 1) * (d.rows + 1) * 2);
  let k = 0;
  for (let j = 0; j <= d.rows; j++) for (let i = 0; i <= d.cols; i++) { out[k++] = x + (w * i) / d.cols; out[k++] = y + (h * j) / d.rows; }
  return out;
}

/** Changes one form of an object (creating the binding / form as needed). fn(form) → form. */
export function editForm(obj, params, key, fn) {
  const kf = obj.kf ? obj.kf.slice() : [];
  let bi = kf.findIndex((b) => b.params.length === params.length && b.params.every((p, i) => p === params[i]));
  if (bi < 0) { kf.push({ params: [...params], forms: {} }); bi = kf.length - 1; }
  const b = kf[bi];
  const next = fn(b.forms[key] ? { ...b.forms[key] } : {});
  kf[bi] = { ...b, forms: { ...b.forms, [key]: round(next) } };
  return { ...obj, kf };
}

/** The ancestors of a deformer (or a part's parent deformer), nearest first. Guards against loops. */
export function chainOf(doc, parentId) {
  const out = []; let id = parentId; const seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); const d = doc.deformers.find((x) => x.id === id); if (!d) break; out.push(d); id = d.parent; }
  return out;
}
/** Would making `parent` the parent of deformer `id` create a loop? */
export const wouldLoop = (doc, id, parent) => chainOf(doc, parent).some((d) => d.id === id) || id === parent;

/** Swaps L/R in a name or role: "Eye L" ↔ "Eye R", "eyeWhiteL" ↔ "eyeWhiteR", ParamEyeLOpen ↔ ParamEyeROpen. */
export function mirrorName(s) {
  return String(s || '')
    .replace(/(Param(?:Eye|Brow|Arm|Hand|Leg)?)(L|R)(?=[A-Z]|$)/g, (m, a, b) => a + (b === 'L' ? 'R' : 'L'))
    .replace(/(^|[\s_.\-(])(L|R)($|[\s_.\-)])/g, (m, a, b, c) => a + (b === 'L' ? 'R' : 'L') + c)
    .replace(/([a-z])(L|R)$/g, (m, a, b) => a + (b === 'L' ? 'R' : 'L'))
    .replace(/(left|Left|right|Right)/g, (m) => ({ left: 'right', Left: 'Right', right: 'left', Right: 'Left' }[m]))
    .replace(/左|右/g, (m) => (m === '左' ? '右' : '左'));
}
