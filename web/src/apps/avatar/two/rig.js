// Rig assist: "Auto-rig face" builds a starting rig from the named parts (head angle X/Y/Z, eye blink, eyeballs,
// brows, mouth open and form, breathing, body sway, hair sway with physics, and arms when there are arm / hand parts),
// and keyform mirroring (left ↔ right).
// It's a first pass the person tweaks — everything it makes is ordinary deformers and keyforms.
import { uid, stdParam, paramById, formKey, mirrorName, warpRest, DEFAULT_BINDINGS, STD_PARAMS } from './model.js';
import { newChain } from './physics.js';

const box = (p) => [p.x, p.y, p.w, p.h];
function union(list) {
  if (!list.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y, w, h] of list) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  return [x0, y0, x1 - x0, y1 - y0];
}
const pad = ([x, y, w, h], f) => [x - w * f, y - h * f, w * (1 + 2 * f), h * (1 + 2 * f)];

/** Geometry form for a mesh: fn(x, y) → [dx, dy] for every rest vertex. */
const meshForm = (part, fn) => { const v = []; for (let i = 0; i < part.mesh.v.length; i += 2) { const [dx, dy] = fn(part.mesh.v[i], part.mesh.v[i + 1]); v.push(dx, dy); } return v; };
const warpForm = (d, fn) => { const rest = warpRest(d); const v = []; for (let i = 0; i < rest.length; i += 2) { const u = ((i / 2) % (d.cols + 1)) / d.cols; const w = Math.floor(i / 2 / (d.cols + 1)) / d.rows; const [dx, dy] = fn(u, w, rest[i], rest[i + 1]); v.push(dx, dy); } return v; };
const r2 = (a) => a.map((x) => Math.round(x * 100) / 100);

/** Builds (or rebuilds) the automatic face rig. Returns { doc, report: [lines] }. */
export function autoRig(input) {
  let doc = structuredClone(input);
  const report = [];
  // remove what a previous auto-rig made, keep everything the person made
  doc.deformers = doc.deformers.filter((d) => !d.auto);
  const autoIds = new Set(input.deformers.filter((d) => d.auto).map((d) => d.id));
  doc.parts = doc.parts.map((p) => ({ ...p, parent: autoIds.has(p.parent) ? null : p.parent, kf: (p.kf || []).filter((b) => !b.auto) }));
  doc.deformers = doc.deformers.map((d) => ({ ...d, parent: autoIds.has(d.parent) ? null : d.parent }));
  doc.physics = (doc.physics || []).filter((c) => !c.auto);
  for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamBodyAngleX', 'ParamBreath', 'ParamHairFront', 'ParamHairSide', 'ParamHairBack']) {
    if (!paramById(doc, id)) doc.params.push(stdParam(id));
  }
  if (!doc.bindings?.length) doc.bindings = DEFAULT_BINDINGS.map((b) => ({ ...b }));

  const by = (role) => doc.parts.filter((p) => p.role === role && p.mesh?.v?.length);
  const one = (role) => by(role)[0];
  const faceParts = ['face', 'nose', 'mouthUpper', 'mouthLower', 'mouthInside', 'hairFront', 'hairSide', ...['eyeWhite', 'iris', 'lash', 'lowerLash', 'brow'].flatMap((r) => [`${r}L`, `${r}R`])].flatMap(by);
  const face = one('face');
  const faceBox = face ? box(face) : union(faceParts.map(box));
  if (!faceBox) return { doc: input, report: ['No face parts found. Name your layers (Face, Eye L white, Iris L, Mouth…) or set roles in the Parts checklist first.'] };
  const [fx, fy, fw, fh] = faceBox;
  const hairBack = by('hairBack');
  const bodyParts = [...by('body'), ...by('neck')];
  const all = union(doc.parts.filter((p) => p.mesh?.v?.length).map(box));

  // --- deformers: Body (warp) ← Head (rotation, pivot at the chin) ← Face (warp) and Hair back (warp)
  const body = { id: uid('d'), name: 'Body', type: 'warp', auto: true, parent: null, rect: pad(all, 0.03), cols: 4, rows: 4, opacity: 1, kf: [] };
  const head = { id: uid('d'), name: 'Head rotation', type: 'rotation', auto: true, parent: body.id, pivot: [fx + fw / 2, fy + fh * 0.97], opacity: 1, kf: [] };
  const faceW = { id: uid('d'), name: 'Face', type: 'warp', auto: true, parent: head.id, rect: pad(union([faceBox, ...faceParts.map(box)]), 0.06), cols: 5, rows: 5, opacity: 1, kf: [] };
  const hairW = hairBack.length ? { id: uid('d'), name: 'Hair back', type: 'warp', auto: true, parent: head.id, rect: pad(union(hairBack.map(box)), 0.04), cols: 3, rows: 3, opacity: 1, kf: [] } : null;

  // Head turn: features slide toward the turn and bulge, the outline moves less (a fake 3D turn); look up/down likewise.
  const fForms = {};
  for (const ax of [-30, 0, 30]) for (const ay of [-30, 0, 30]) {
    if (!ax && !ay) continue;
    const kx = ax / 30; const ky = ay / 30;
    fForms[formKey([ax, ay])] = { v: r2(warpForm(faceW, (u, v) => {
      const bulge = (1 - (2 * u - 1) ** 2) * (1 - 0.6 * (2 * v - 1) ** 2);
      const bulgeY = (1 - (2 * v - 1) ** 2) * (1 - 0.6 * (2 * u - 1) ** 2);
      return [kx * faceW.rect[2] * (0.09 * bulge + 0.025), -ky * faceW.rect[3] * (0.07 * bulgeY + 0.02)];
    })) };
  }
  faceW.kf.push({ auto: true, params: ['ParamAngleX', 'ParamAngleY'], forms: fForms });
  if (hairW) {
    const hForms = {};
    // back hair slides the other way a little (parallax)
    for (const ax of [-30, 30]) hForms[formKey([ax])] = { v: r2(warpForm(hairW, (u, v) => [-(ax / 30) * hairW.rect[2] * 0.03 * (0.5 + 0.5 * (1 - v)), 0])) };
    hairW.kf.push({ auto: true, params: ['ParamAngleX'], forms: hForms });
  }
  head.kf.push({ auto: true, params: ['ParamAngleZ'], forms: { [formKey([-30])]: { a: -12 }, [formKey([30])]: { a: 12 } } });
  // Body: sway with body angle X (top moves, hips stay), breathe (shoulders rise a little)
  body.kf.push({ auto: true, params: ['ParamBodyAngleX'], forms: {
    [formKey([-10])]: { v: r2(warpForm(body, (u, v) => [-body.rect[2] * 0.035 * (1 - v) ** 1.5, 0])) },
    [formKey([10])]: { v: r2(warpForm(body, (u, v) => [body.rect[2] * 0.035 * (1 - v) ** 1.5, 0])) },
  } });
  body.kf.push({ auto: true, params: ['ParamBreath'], forms: { [formKey([1])]: { v: r2(warpForm(body, (u, v) => [(u - 0.5) * body.rect[2] * 0.006 * (v < 0.7 ? 1 : 0), -body.rect[3] * 0.012 * Math.max(0, 1 - v / 0.7)])) } } });
  doc.deformers.push(body, head, faceW, ...(hairW ? [hairW] : []));
  report.push(`Deformers: Body (breath, body angle), Head rotation (Angle Z), Face (Angle X/Y)${hairW ? ', Hair back' : ''}.`);

  // parenting
  const faceIds = new Set(faceParts.map((p) => p.id));
  doc.parts = doc.parts.map((p) => {
    if (faceIds.has(p.id)) return { ...p, parent: faceW.id };
    if (hairW && p.role === 'hairBack') return { ...p, parent: hairW.id };
    if (!p.parent) return { ...p, parent: p.role === 'neck' || p.role === 'body' || !p.role ? body.id : head.id };
    return p;
  });

  const edit = (id, fn) => { doc.parts = doc.parts.map((p) => (p.id === id ? fn(p) : p)); };
  const bind = (p, params, forms) => edit(p.id, (q) => ({ ...q, kf: [...(q.kf || []), { auto: true, params, forms }] }));
  arms(doc, by, body, report, bind);

  // --- eyes
  for (const side of ['L', 'R']) {
    const white = one(`eyeWhite${side}`); const iris = by(`iris${side}`); const lash = by(`lash${side}`); const lower = by(`lowerLash${side}`);
    const eyeAll = [white, ...iris, ...lash, ...lower].filter(Boolean);
    if (!eyeAll.length) continue;
    const eb = white ? box(white) : union(eyeAll.map(box));
    const yc = eb[1] + eb[3] * 0.66; // where the lids meet
    const P = `ParamEye${side}Open`;
    // closing squashes the white and iris onto the lid line (the iris is clipped by the white, so it vanishes with it)
    const close = (p) => bind(p, [P], { [formKey([0])]: { v: r2(meshForm(p, (x, y) => [0, yc - y])) } });
    if (white) close(white);
    for (const p of iris) close(p);
    for (const p of lash) { const bot = p.y + p.h; bind(p, [P], { [formKey([0])]: { v: r2(meshForm(p, (x, y) => [0, yc + (y - bot) * 0.5 + p.h * 0.15 - y])) } }); }
    for (const p of lower) bind(p, [P], { [formKey([0])]: { v: r2(meshForm(p, (x, y) => [0, (yc - p.y) * 0.35])) } });
    // eyeballs: the iris moves within the white (and is clipped by it)
    for (const p of iris) {
      bind(p, ['ParamEyeBallX'], { [formKey([-1])]: { v: r2(meshForm(p, () => [-eb[2] * 0.2, 0])) }, [formKey([1])]: { v: r2(meshForm(p, () => [eb[2] * 0.2, 0])) } });
      bind(p, ['ParamEyeBallY'], { [formKey([-1])]: { v: r2(meshForm(p, () => [0, eb[3] * 0.16])) }, [formKey([1])]: { v: r2(meshForm(p, () => [0, -eb[3] * 0.16])) } });
      if (white && !(p.clip || []).length) edit(p.id, (q) => ({ ...q, clip: [white.id] }));
    }
    for (const b of by(`brow${side}`)) bind(b, [`ParamBrow${side}Y`], { [formKey([-1])]: { v: r2(meshForm(b, () => [0, fh * 0.025])) }, [formKey([1])]: { v: r2(meshForm(b, () => [0, -fh * 0.035])) } });
    report.push(`Eye ${side}: blink on ${P}${iris.length ? ', eyeball X/Y, iris clipped by the eye white' : ''}.`);
  }

  // --- mouth
  const up = by('mouthUpper'); const lo = by('mouthLower'); const ins = by('mouthInside');
  const mb = union([...up, ...lo, ...ins].map(box));
  if (mb) {
    const open = Math.max(mb[3] * 1.1, fh * 0.07); const cx = mb[0] + mb[2] / 2;
    for (const p of lo) bind(p, ['ParamMouthOpenY'], { [formKey([1])]: { v: r2(meshForm(p, () => [0, open])) } });
    for (const p of up) bind(p, ['ParamMouthOpenY'], { [formKey([1])]: { v: r2(meshForm(p, () => [0, -open * 0.12])) } });
    for (const p of ins) bind(p, ['ParamMouthOpenY'], { [formKey([1])]: { v: r2(meshForm(p, (x, y) => [0, -open * 0.12 + (open * 1.12 * (y - p.y)) / Math.max(1, p.h)])) } });
    // smile: corners up, middle down a touch; frown the other way
    const form = (k) => (p) => r2(meshForm(p, (x) => { const u = (x - cx) / (mb[2] / 2); return [0, -k * mb[3] * 0.45 * (u * u - 0.35)]; }));
    for (const p of [...up, ...lo, ...ins]) bind(p, ['ParamMouthForm'], { [formKey([-1])]: { v: form(-1)(p) }, [formKey([1])]: { v: form(1)(p) } });
    report.push('Mouth: open (ParamMouthOpenY) and smile/frown (ParamMouthForm).');
  } else report.push('No mouth parts found (name them Mouth upper / lower / inside).');

  // --- hair sway + physics
  for (const [role, param, name] of [['hairFront', 'ParamHairFront', 'Hair front'], ['hairSide', 'ParamHairSide', 'Hair side'], ['hairBack', 'ParamHairBack', 'Hair back']]) {
    const ps = by(role); if (!ps.length) continue;
    for (const p of ps) {
      const sway = (k) => r2(meshForm(p, (x, y) => { const t = Math.max(0, (y - p.y) / Math.max(1, p.h)); return [k * p.w * 0.1 * t ** 1.6, -Math.abs(k) * p.h * 0.01 * t]; }));
      bind(p, [param], { [formKey([-1])]: { v: sway(-1) }, [formKey([1])]: { v: sway(1) } });
    }
    doc.physics.push(newChain(name, { auto: true, length: Math.max(60, union(ps.map(box))[3] * 0.6), outputs: [{ param, weight: role === 'hairBack' ? 0.7 : 1, segment: -1 }] }));
    report.push(`${name}: sway on ${param}, driven by physics.`);
  }
  return { doc, report };
}

// ---------------------------------------------------------------- arms

// Hand drawings for a gesture ("Hand L peace", "手R グー"…): shown while hand tracking sees that gesture.
const HAND_VARIANTS = [['Peace', /(peace|victory|v\s*sign|ピース|チョキ)/i], ['Fist', /(fist|grip|closed|グー|握)/i], ['Point', /(point|指差|指さし)/i], ['ThumbUp', /(thumb|good|いいね|グッド)/i]];

/**
 * Arms: a rotation deformer at the shoulder (ParamArmLA), one at the elbow (ParamArmLB) and one at the wrist
 * (ParamHandL), for parts with the upper arm / forearm / hand roles. Arms are assumed to hang down as drawn; the angles
 * turn them outward (L is the avatar's left, on the screen's right). Hand parts named for a gesture swap in when it's seen.
 */
function arms(doc, by, body, report, bind) {
  for (const S of ['L', 'R']) {
    const ups = by(`upperArm${S}`); const lows = by(`lowerArm${S}`); const hands = by(`hand${S}`);
    if (!ups.length && !lows.length && !hands.length) continue;
    for (const [id] of STD_PARAMS) if (new RegExp(`^Param(Arm|Hand)${S}`).test(id) && !paramById(doc, id)) doc.params.push(stdParam(id));
    for (const b of DEFAULT_BINDINGS) if (new RegExp(`^Param(Arm|Hand)${S}`).test(b.param) && !doc.bindings.some((x) => x.param === b.param)) doc.bindings.push({ ...b });
    const out = S === 'L' ? 1 : -1;
    // rotation forms: a positive (outward) angle turns the arm toward the screen's right for L, left for R
    const rot = (param, lo, hi) => ({ auto: true, params: [param], forms: { [formKey([lo])]: { a: -out * lo }, [formKey([hi])]: { a: -out * hi } } });
    const topMid = (b, f = 0.2) => [b[0] + b[2] / 2, b[1] + Math.min(b[2], b[3]) * f];
    const made = [];
    let parent = body.id;
    const ub = union(ups.map(box)); const lb = union(lows.map(box)); const hb = union(hands.map(box));
    // the shoulder joint: top of the upper arm (or of whatever the arm is drawn as)
    const first = ub || lb || hb;
    const upper = { id: uid('d'), name: `Arm ${S} (shoulder)`, type: 'rotation', auto: true, parent, pivot: topMid(first, 0.25), opacity: 1, kf: [rot(`ParamArm${S}A`, -45, 135)], armParts: ups.map((p) => p.id) };
    made.push(upper); parent = upper.id;
    if (lb && ub) {
      const fore = { id: uid('d'), name: `Arm ${S} (elbow)`, type: 'rotation', auto: true, parent, pivot: topMid(lb, 0.2), opacity: 1, kf: [rot(`ParamArm${S}B`, -150, 150)], armParts: lows.map((p) => p.id) };
      made.push(fore); parent = fore.id;
    } else upper.armParts.push(...lows.map((p) => p.id));
    if (hb && first !== hb) {
      const wrist = { id: uid('d'), name: `Hand ${S} (wrist)`, type: 'rotation', auto: true, parent, pivot: topMid(hb, 0.15), opacity: 1, kf: [rot(`ParamHand${S}`, -80, 80)], armParts: hands.map((p) => p.id) };
      made.push(wrist);
    } else made[made.length - 1].armParts.push(...hands.map((p) => p.id));
    // the arm's parts hang from its deformers (arms() runs after the face parenting, so this wins)
    const armOf = new Map(made.flatMap((d) => d.armParts.map((id) => [id, d.id])));
    for (const d of made) delete d.armParts;
    doc.parts = doc.parts.map((p) => (armOf.has(p.id) ? { ...p, parent: armOf.get(p.id) } : p));
    doc.deformers.push(...made);
    // gesture hands: a variant shows at its gesture's weight and hides the plain hand
    const variants = hands.map((p) => [p, HAND_VARIANTS.find(([, re]) => re.test(p.name))?.[0]]);
    const used = [...new Set(variants.map(([, v]) => v).filter(Boolean))];
    for (const [p, v] of variants) {
      if (v) bind(p, [`ParamHand${S}${v}`], { [formKey([0])]: { o: -1 }, [formKey([1])]: {} });
      else for (const u of used) bind(p, [`ParamHand${S}${u}`], { [formKey([1])]: { o: -1 } });
    }
    report.push(`Arm ${S}: ${made.map((d) => d.name.replace(/^.*\((.*)\)$/, '$1')).join(', ')} rotation (ParamArm${S}A${made.length > 1 ? `/B` : ''}${made.length > 2 ? `, ParamHand${S}` : ''})${used.length ? `; gesture hands: ${used.join(', ')}` : ''}.`);
  }
}

// ---------------------------------------------------------------- mirroring

const centerX = (obj) => (obj.mesh ? obj.x + obj.w / 2 : obj.type === 'warp' ? obj.rect[0] + obj.rect[2] / 2 : obj.pivot[0]);
/** Index of the vertex nearest each vertex's mirror image (across the object's own centre). */
function mirrorIndex(obj) {
  if (obj.type === 'warp') { const W = obj.cols + 1; const out = []; for (let j = 0; j <= obj.rows; j++) for (let i = 0; i <= obj.cols; i++) out.push(j * W + (obj.cols - i)); return out; }
  const v = obj.mesh.v; const cx = centerX(obj); const n = v.length / 2; const out = [];
  for (let i = 0; i < n; i++) {
    const mx = 2 * cx - v[i * 2]; const my = v[i * 2 + 1]; let best = 0; let bd = Infinity;
    for (let j = 0; j < n; j++) { const d = (v[j * 2] - mx) ** 2 + (v[j * 2 + 1] - my) ** 2; if (d < bd) { bd = d; best = j; } }
    out.push(best);
  }
  return out;
}
const flipForm = (f, idx) => {
  const o = { ...f };
  if (f.v) { o.v = new Array(f.v.length).fill(0); idx.forEach((j, i) => { o.v[i * 2] = -(f.v[j * 2] || 0); o.v[i * 2 + 1] = f.v[j * 2 + 1] || 0; }); }
  if (f.a) o.a = -f.a; if (f.x) o.x = -f.x;
  return o;
};

/**
 * Copies the form at `value` of parameter `pid` to the opposite key (−value around the default), mirrored left↔right.
 * Works on every binding of the object that uses the parameter. Returns the new object (or null if nothing to do).
 */
export function mirrorToOpposite(doc, obj, pid, value) {
  const p = paramById(doc, pid); if (!p) return null;
  const target = 2 * p.def - value;
  if (!p.keys.some((k) => Math.abs(k - target) < 1e-6) || Math.abs(target - value) < 1e-6) return null;
  const idx = obj.mesh || obj.type === 'warp' ? mirrorIndex(obj) : [];
  let changed = false;
  const kf = (obj.kf || []).map((b) => {
    const i = b.params.indexOf(pid); if (i < 0) return b;
    const forms = { ...b.forms };
    for (const [k, f] of Object.entries(b.forms)) {
      const parts = k.split('|').map(Number);
      if (Math.abs(parts[i] - value) > 1e-6) continue;
      parts[i] = target; forms[formKey(parts)] = flipForm(f, idx); changed = true;
    }
    return { ...b, forms };
  });
  return changed ? { ...obj, kf } : null;
}

/** The part on the other side (Eye L white ↔ Eye R white), by role or name. */
export function counterpart(doc, part) {
  if (part.role && /[LR]$/.test(part.role)) { const r = part.role.slice(0, -1) + (part.role.endsWith('L') ? 'R' : 'L'); const q = doc.parts.find((x) => x.role === r); if (q) return q; }
  const n = mirrorName(part.name);
  return n !== part.name ? doc.parts.find((x) => x.name === n) || null : null;
}
/**
 * Copies every keyform of a part to its counterpart on the other side, mirrored: parameters swap L↔R
 * (ParamEyeLOpen → ParamEyeROpen), movements flip horizontally and scale to the other part's size.
 */
export function mirrorToCounterpart(doc, part) {
  const other = counterpart(doc, part);
  if (!other || !part.mesh || !other.mesh) return null;
  // map each vertex of the other part to the mirrored relative spot in this part
  const pv = part.mesh.v; const ov = other.mesh.v; const n = ov.length / 2; const map = [];
  for (let i = 0; i < n; i++) {
    const u = 1 - (ov[i * 2] - other.x) / other.w; const v = (ov[i * 2 + 1] - other.y) / other.h;
    const tx = part.x + u * part.w; const ty = part.y + v * part.h; let best = 0; let bd = Infinity;
    for (let j = 0; j < pv.length / 2; j++) { const d = (pv[j * 2] - tx) ** 2 + (pv[j * 2 + 1] - ty) ** 2; if (d < bd) { bd = d; best = j; } }
    map.push(best);
  }
  const sx = other.w / part.w; const sy = other.h / part.h;
  const kf = (part.kf || []).map((b) => ({ params: b.params.map((id) => (paramById(doc, mirrorName(id)) ? mirrorName(id) : id)), forms: Object.fromEntries(Object.entries(b.forms).map(([k, f]) => {
    const o = { ...f };
    if (f.v) { o.v = []; map.forEach((j) => o.v.push(Math.round(-(f.v[j * 2] || 0) * sx * 100) / 100, Math.round((f.v[j * 2 + 1] || 0) * sy * 100) / 100)); }
    if (f.a) o.a = -f.a; if (f.x) o.x = -f.x;
    return [k, o];
  })) }));
  return { ...other, kf };
}
