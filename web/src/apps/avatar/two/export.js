// Exports of the 2D rig:
//   .sora-avatar  — our own format: a zip with avatar.json (the whole rig) and textures/<part>.png. Opens again with
//                   File → Open .sora-avatar. Open and documented in this file and two/model.js.
//   Inochi2D .inp — the open Live2D-like format (BSD-2). The puppet JSON + PNG textures in Inochi2D's binary container.
//                   Parts, meshes, draw order, opacity, blend modes, clipping masks and parameters map; our deformers
//                   and keyforms are baked into per-parameter vertex offsets ("deform" bindings) at every key, so
//                   2-parameter keyforms become 2D parameters. Physics, expressions and the tracking table don't map.
//   PNG           — the current pose, transparent.
// Live2D's .moc3/.cmo3 are proprietary and undocumented, so we can't write those.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { uploadFiles } from '../../../lib/api.js';
import { loadTex } from './textures.js';
import { evaluate } from './deform.js';
import { defaults, normalize2D } from './model.js';
import { Renderer2D, fitView } from './render.js';

const pngOf = async (texId) => {
  const img = await loadTex(texId);
  const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
};

export async function exportSoraAvatar(doc, onProgress = () => {}) {
  const files = {}; const model = structuredClone(doc);
  delete model.perform;
  for (let i = 0; i < model.parts.length; i++) {
    const p = model.parts[i];
    onProgress(i / model.parts.length, `Packing ${p.name}…`);
    if (p.tex) { files[`textures/${p.id}.png`] = await pngOf(p.tex); p.tex = `textures/${p.id}.png`; }
  }
  files['avatar.json'] = strToU8(JSON.stringify({ format: 'sora-avatar', version: 1, generator: 'SoraLab Sora Ningyō', model }, null, 1));
  files['README.txt'] = strToU8('A Sora Ningyō 2D avatar (SoraLab\'s open format). avatar.json holds the rig: parts with meshes, warp/rotation deformers, parameters and their keyforms, physics, expressions and tracking bindings. Textures are in textures/. Open it in SoraLab: Sora Ningyō → File → Open .sora-avatar.\n');
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

/** Reads a .sora-avatar zip back: uploads its textures to the project and returns the rig. */
export async function importSoraAvatar(file, docId, onProgress = () => {}) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const meta = JSON.parse(strFromU8(z['avatar.json'] || new Uint8Array()));
  if (meta.format !== 'sora-avatar') throw new Error('That isn’t a .sora-avatar file.');
  const model = meta.model;
  const list = model.parts.filter((p) => typeof p.tex === 'string' && z[p.tex]);
  const assets = [];
  for (let i = 0; i < list.length; i += 12) {
    onProgress(i / list.length, 'Uploading textures…');
    assets.push(...await uploadFiles(list.slice(i, i + 12).map((p) => new File([z[p.tex]], `${p.name || 'part'}.png`, { type: 'image/png' })), { docId }));
  }
  const ids = new Map(list.map((p, i) => [p.id, assets[i].id]));
  model.parts = model.parts.map((p) => ({ ...p, tex: ids.get(p.id) || null }));
  return normalize2D(model);
}

// One offscreen renderer for PNG exports and thumbnails (browsers allow only a few WebGL contexts at a time, and
// autosave makes a thumbnail often, so we never make a new one per picture). Textures stay cached in it.
let shared = null;
function offscreen(w, h) {
  if (!shared || shared.r.lost) { const c = document.createElement('canvas'); shared = { c, r: new Renderer2D(c) }; }
  shared.c.width = w; shared.c.height = h;
  return shared;
}

/** A transparent PNG of the rig at these parameter values (canvas size × scale). */
export async function exportPng(doc, values, scale = 1) {
  const { r } = offscreen(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
  await r.preload(doc);
  for (let i = 0; i < 20 && !r.ready(doc); i++) await new Promise((res) => setTimeout(res, 25)); // textures reach the GPU
  r.prune(doc);
  r.draw(doc, evaluate(doc, values), { s: scale, tx: 0, ty: 0 }, { bg: null });
  return r.snapshotBlob();
}

// ---------------------------------------------------------------- Inochi2D

const NONE = 4294967295; // Inochi2D's "no texture"
const BLEND_I2D = { normal: 'Normal', multiply: 'Multiply', screen: 'Screen', add: 'LinearDodge' };

/** Final vertex positions of every part at these values (deformers applied). */
const shapes = (doc, values) => { const ev = evaluate(doc, values); return new Map([...ev.parts].map(([id, s]) => [id, Array.from(s.verts)])); };

export async function exportInochi2D(doc, name = 'Avatar', onProgress = () => {}) {
  let n = 1; const uuid = () => n++;
  const cx = doc.width / 2; const cy = doc.height / 2;
  const base = defaults(doc);
  const rest = shapes(doc, base);
  const ids = new Map(doc.parts.map((p) => [p.id, uuid()]));
  const textures = [];
  const children = [];
  for (let i = 0; i < doc.parts.length; i++) {
    const p = doc.parts[i];
    onProgress((i / doc.parts.length) * 0.5, `Packing ${p.name}…`);
    if (!p.mesh?.v?.length || !p.tex) continue;
    const ti = textures.length; textures.push(await pngOf(p.tex));
    const v = rest.get(p.id); const ox = p.x + p.w / 2; const oy = p.y + p.h / 2;
    const verts = []; const uvs = [];
    for (let k = 0; k < p.mesh.v.length; k += 2) {
      verts.push(+(v[k] - ox).toFixed(2), +(v[k + 1] - oy).toFixed(2));
      uvs.push(+((p.mesh.v[k] - p.x) / p.w).toFixed(5), +((p.mesh.v[k + 1] - p.y) / p.h).toFixed(5));
    }
    children.push({
      uuid: ids.get(p.id), name: p.name, type: 'Part', enabled: p.visible !== false, zsort: -i, // lower draws in front
      transform: { trans: [+(ox - cx).toFixed(2), +(oy - cy).toFixed(2), 0], rot: [0, 0, 0], scale: [1, 1] }, lockToRoot: false,
      mesh: { verts, uvs, indices: p.mesh.t.slice(), origin: [0, 0] },
      textures: [ti, NONE, NONE], blend_mode: BLEND_I2D[p.blend] || 'Normal', tint: [1, 1, 1], screenTint: [0, 0, 0], emissionStrength: 1,
      mask_threshold: 0.5, opacity: p.opacity ?? 1, psdLayerPath: '',
      masks: (p.clip || []).filter((c) => ids.has(c)).map((c) => ({ source: ids.get(c), mode: p.invertClip ? 'DodgeMask' : 'Mask' })),
      children: [],
    });
  }
  // Parameters: 2-parameter keyforms become one 2D parameter; the rest are 1D. Each key is baked from the whole rig.
  const pairs = []; const inPair = new Set();
  for (const o of [...doc.parts, ...doc.deformers]) for (const b of o.kf || []) if (b.params.length === 2) {
    const k = b.params.join('|'); if (!pairs.some((x) => x.join('|') === k)) { pairs.push(b.params); b.params.forEach((x) => inPair.add(x)); }
  }
  const used = new Set([...doc.parts, ...doc.deformers].flatMap((o) => (o.kf || []).flatMap((b) => b.params)));
  const axes = [...pairs.map((pp) => pp.map((id) => doc.params.find((x) => x.id === id))), ...doc.params.filter((p) => used.has(p.id) && !inPair.has(p.id)).map((p) => [p])].filter((a) => a.every(Boolean));
  const params = [];
  for (let ai = 0; ai < axes.length; ai++) {
    const ax = axes[ai]; const [px, py] = ax;
    onProgress(0.5 + (ai / axes.length) * 0.5, `Baking ${ax.map((p) => p.name).join(' × ')}…`);
    const xs = px.keys; const ys = py ? py.keys : [0];
    const deform = new Map(); const opac = new Map(); // part id → [x][y]
    for (const p of doc.parts) { if (ids.has(p.id)) { deform.set(p.id, xs.map(() => ys.map(() => []))); opac.set(p.id, xs.map(() => ys.map(() => 1))); } }
    let anyOpacity = new Set();
    for (let xi = 0; xi < xs.length; xi++) for (let yi = 0; yi < ys.length; yi++) {
      const vals = { ...base, [px.id]: xs[xi], ...(py ? { [py.id]: ys[yi] } : {}) };
      const ev = evaluate(doc, vals); const ev0 = evaluate(doc, base);
      for (const p of doc.parts) {
        if (!ids.has(p.id)) continue;
        const a = ev.parts.get(p.id).verts; const b = rest.get(p.id); const off = [];
        for (let k = 0; k < a.length; k += 2) off.push([+(a[k] - b[k]).toFixed(2), +(a[k + 1] - b[k + 1]).toFixed(2)]);
        deform.get(p.id)[xi][yi] = off;
        const o = ev.parts.get(p.id).opacity; const o0 = ev0.parts.get(p.id).opacity;
        opac.get(p.id)[xi][yi] = +o.toFixed(3);
        if (Math.abs(o - o0) > 1e-3) anyOpacity.add(p.id);
      }
    }
    const span = (p) => p.max - p.min || 1;
    const bindings = [];
    for (const [pid, values] of deform) {
      if (!values.some((row) => row.some((offs) => offs.some(([x, y]) => x || y)))) continue;
      bindings.push({ node: ids.get(pid), param_name: 'deform', values, isSet: values.map((row) => row.map(() => true)), interpolate_mode: 'Linear' });
    }
    for (const pid of anyOpacity) bindings.push({ node: ids.get(pid), param_name: 'opacity', values: opac.get(pid), isSet: xs.map(() => ys.map(() => true)), interpolate_mode: 'Linear' });
    params.push({
      uuid: uuid(), name: ax.map((p) => p.name).join(' × '), is_vec2: !!py,
      min: [px.min, py ? py.min : 0], max: [px.max, py ? py.max : 0], defaults: [px.def, py ? py.def : 0],
      axis_points: [xs.map((k) => +((k - px.min) / span(px)).toFixed(5)), py ? ys.map((k) => +((k - py.min) / span(py)).toFixed(5)) : [0]],
      merge_mode: 'Additive', bindings,
    });
  }
  const puppet = {
    meta: { name, version: '1.0-alpha', rigger: null, artist: null, rights: null, copyright: null, licenseURL: null, contact: null, reference: null, thumbnailId: NONE, preservePixels: false },
    physics: { pixelsPerMeter: 1000, gravity: 9.8 },
    nodes: { uuid: uuid(), name: 'Root', type: 'Node', enabled: true, zsort: 0, transform: { trans: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1] }, lockToRoot: false, children },
    param: params, automation: [], animations: {},
  };
  return new Blob([inpContainer(puppet, textures)], { type: 'application/octet-stream' });
}

/** Inochi2D's binary container: "TRNSRTS\0", JSON length + JSON, "TEX_SECT", count, then each texture (length, encoding 0 = PNG, data). */
export function inpContainer(puppet, textures) {
  const json = strToU8(JSON.stringify(puppet));
  const size = 8 + 4 + json.length + 8 + 4 + textures.reduce((s, t) => s + 5 + t.length, 0);
  const out = new Uint8Array(size); const dv = new DataView(out.buffer); let o = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) out[o++] = s.charCodeAt(i); };
  str('TRNSRTS\0'); dv.setUint32(o, json.length); o += 4; out.set(json, o); o += json.length;
  str('TEX_SECT'); dv.setUint32(o, textures.length); o += 4;
  for (const t of textures) { dv.setUint32(o, t.length); o += 4; out[o++] = 0; out.set(t, o); o += t.length; }
  return out;
}
/** Reads an .inp back (used by tests to check the file). */
export function readInp(buf) {
  const u = new Uint8Array(buf); const dv = new DataView(u.buffer, u.byteOffset); let o = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u[o++]); return s; };
  if (str(8) !== 'TRNSRTS\0') throw new Error('not an Inochi2D puppet');
  const jl = dv.getUint32(o); o += 4; const puppet = JSON.parse(strFromU8(u.subarray(o, o + jl))); o += jl;
  if (str(8) !== 'TEX_SECT') throw new Error('no texture section');
  const count = dv.getUint32(o); o += 4; const tex = [];
  for (let i = 0; i < count; i++) { const l = dv.getUint32(o); o += 4; const enc = u[o++]; tex.push({ enc, data: u.subarray(o, o + l) }); o += l; }
  return { puppet, textures: tex };
}
export { fitView };
