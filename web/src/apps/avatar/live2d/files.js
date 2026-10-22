// A Live2D model's files: .model3.json + .moc3 + textures + motions / expressions / physics, brought in as a zip or
// as loose files, each stored as an asset of the project. The document keeps a map from the path the model3.json
// uses to the asset id:  doc.model = { name, entry: 'hiyori.model3.json', files: { 'hiyori.moc3': assetId, … } }
import { unzipSync } from 'fflate';
import { uploadFiles } from '../../../lib/api.js';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
const base = (p) => norm(p).split('/').pop().toLowerCase();
const MIME = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * Reads picked files (a zip, or the loose files of a model folder) and uploads what the model needs.
 * Returns doc.model. onProgress(0..1, label).
 */
export async function importModel(fileList, { docId, onProgress = () => {} }) {
  let entries = []; // { path, blob }
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [p, data] of Object.entries(z)) if (data.length && !p.endsWith('/') && !/__MACOSX|\.DS_Store/.test(p)) entries.push({ path: norm(p), blob: new Blob([data], { type: MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream' }) });
    } else entries.push({ path: norm(f.webkitRelativePath || f.name), blob: f });
  }
  const entry = entries.find((e) => /\.model3\.json$/i.test(e.path));
  if (!entry) throw new Error('No .model3.json found. Pick the model’s folder as a zip, or select all of its files (model3.json, .moc3, textures…).');
  const root = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
  const model3 = JSON.parse(await entry.blob.text());
  const refs = referencedFiles(model3);
  if (!refs.some((r) => /\.moc3$/i.test(r))) throw new Error('That model3.json doesn’t name a .moc3 file.');
  // find each referenced file: by its path next to the model3.json, else by file name
  const want = [norm(entry.path.slice(root.length)), ...refs];
  const found = []; const missing = [];
  for (const r of want) {
    const e = entries.find((x) => x.path === root + r) || entries.find((x) => x.path === r) || entries.find((x) => base(x.path) === base(r));
    if (e) found.push([r, e]); else missing.push(r);
  }
  if (missing.some((m) => /\.moc3$/i.test(m) || /\.(png|jpe?g|webp)$/i.test(m))) throw new Error(`Missing files: ${missing.join(', ')}`);
  const files = {};
  for (let i = 0; i < found.length; i += 10) {
    onProgress(i / found.length, `Uploading ${i + 1}–${Math.min(found.length, i + 10)} of ${found.length}…`);
    const batch = found.slice(i, i + 10);
    const assets = await uploadFiles(batch.map(([r, e]) => new File([e.blob], base(r) || 'file', { type: e.blob.type || 'application/octet-stream' })), { docId });
    batch.forEach(([r], k) => { files[r] = assets[k].id; });
  }
  onProgress(1, 'Done');
  return { name: (entry.path.split('/').pop() || 'model').replace(/\.model3\.json$/i, ''), entry: norm(entry.path.slice(root.length)), files, missing };
}

/** Every file a model3.json points at. */
export function referencedFiles(m) {
  const f = m.FileReferences || {};
  const out = [f.Moc, ...(f.Textures || []), f.Physics, f.Pose, f.DisplayInfo, f.UserData, ...(f.Expressions || []).map((e) => e.File), ...Object.values(f.Motions || {}).flat().map((x) => x.File)];
  return [...new Set(out.filter(Boolean).map(norm))];
}

/** Loads the model's files from their assets. urlOf(assetId) → URL. */
export async function loadModelFiles(model, urlOf) {
  const get = async (path, as) => {
    const id = model.files[norm(path)] ?? Object.entries(model.files).find(([p]) => base(p) === base(path))?.[1];
    if (!id) return null;
    const r = await fetch(urlOf(id), { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`Couldn’t load ${path} (${r.status})`);
    return as === 'json' ? r.json() : as === 'image' ? createImageBitmap(await r.blob(), { premultiplyAlpha: 'premultiply', imageOrientation: 'flipY' }) : r.arrayBuffer();
  };
  const m3 = await get(model.entry, 'json');
  const f = m3.FileReferences || {};
  const [moc, textures, physics, pose, expressions] = await Promise.all([
    get(f.Moc, 'buf'),
    Promise.all((f.Textures || []).map((t) => get(t, 'image'))),
    f.Physics ? get(f.Physics, 'json').catch(() => null) : null,
    f.Pose ? get(f.Pose, 'json').catch(() => null) : null,
    Promise.all((f.Expressions || []).map(async (e) => ({ name: e.Name || base(e.File).replace(/\.exp3\.json$/i, ''), data: await get(e.File, 'json').catch(() => null) }))),
  ]);
  const motions = {};
  for (const [group, list] of Object.entries(f.Motions || {})) motions[group] = list.map((x) => ({ file: x.File, fadeIn: x.FadeInTime, fadeOut: x.FadeOutTime, load: () => get(x.File, 'json') }));
  return { model3: m3, moc, textures, physics, pose, expressions: expressions.filter((e) => e.data), motions, groups: m3.Groups || [] };
}
