// Export renders (loaded only when someone exports): VRM 1.0, GLB, glTF and a PNG snapshot, made from the document in
// an off-screen view so the result doesn't depend on what the editor happens to show. VRM files are checked by
// re-importing them with three-vrm and comparing humanoid bones, expressions and spring joints with the project.
import { Viewport } from './viewport.js';
import { Avatar } from './runtime.js';
import { defaultAssetUrl, parseModel, disposeModel } from './load.js';
import { exportVRM, exportGLTF } from './vrmExport.js';
import { loadImage } from '../../../lib/doc.js';
import { toast } from '../../../components/ui.jsx';

async function offscreen(doc, assetUrl, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const vp = new Viewport(canvas, { alpha: true });
  vp.resize(w, h, 1);
  vp.setLook(doc.look || {});
  const avatar = await Avatar.load(doc, { assetUrl });
  vp.scene.add(avatar.holder);
  for (let i = 0; i < 20; i++) avatar.update(1 / 30); // let springs settle and arms come down
  return { vp, avatar, canvas };
}

/** A square bust-up picture for the VRM thumbnail (or the chosen image). Returns a canvas. */
async function thumbnail(doc, vp, avatar, assetUrl) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  if (doc.meta?.thumbnail) {
    try {
      const img = await loadImage(assetUrl(doc.meta.thumbnail, 'web'));
      const s = Math.max(512 / img.width, 512 / img.height);
      g.drawImage(img, (512 - img.width * s) / 2, (512 - img.height * s) / 2, img.width * s, img.height * s);
      return c;
    } catch { /* fall back to a snapshot */ }
  }
  g.fillStyle = doc.look?.background || '#2b2f3a'; g.fillRect(0, 0, 512, 512);
  vp.resize(512, 512, 1);
  vp.frame(avatar, { ...doc.camera, framing: 'bust', zoom: 1, x: 0, y: 0, turn: 0 });
  vp.render();
  g.drawImage(vp.canvas, 0, 0, 512, 512);
  return c;
}

/** Re-imports a VRM and compares it with the project. Returns { ok, notes }. */
export async function checkVRM(buffer, avatar, doc) {
  const back = await parseModel(buffer);
  const notes = [];
  try {
    if (!back.vrm) return { ok: false, notes: ['The file didn’t load as a VRM.'] };
    if (back.vrmVersion !== '1') notes.push('It loaded as VRM 0.x, not 1.0.');
    const want = Object.keys(doc.humanoid?.bones || {}).filter((b) => avatar.node(doc.humanoid.bones[b])).length;
    const got = Object.keys(back.file.humanoid?.bones || {}).length;
    if (got < want) notes.push(`Humanoid bones: ${got} of ${want} came back.`);
    for (const [name, e] of Object.entries(doc.expressions || {})) {
      const n = (e.binds || []).filter((b) => avatar.meshesFor(b.mesh).some((m) => m.morphTargetDictionary?.[b.morph] !== undefined)).length;
      const r = back.file.expressions?.[name];
      if (!r) notes.push(`Expression “${name}” is missing.`);
      else if (r.binds.length < n) notes.push(`Expression “${name}” lost shapes (${r.binds.length} of ${n}).`);
    }
    const joints = avatar.springs ? avatar.springs.joints.size : 0;
    const backJoints = back.vrm.springBoneManager ? back.vrm.springBoneManager.joints.size : 0;
    if (backJoints !== joints) notes.push(`Spring joints: ${backJoints} came back, the project has ${joints}.`);
    const cols = avatar.colliderObjects.length; const backCols = back.vrm.springBoneManager?.colliders.length || 0;
    if (backCols !== cols) notes.push(`Colliders: ${backCols} came back, the project has ${cols}.`);
    return { ok: !notes.length, notes, stats: { bones: got, expressions: Object.keys(back.file.expressions || {}).length, joints: backJoints, colliders: backCols, meta: back.file.meta } };
  } finally { disposeModel(back.root); }
}

export async function render3D(doc, fid, o = {}, { assetUrl = defaultAssetUrl, onProgress } = {}) {
  if (!doc?.model) throw new Error('There’s no avatar to export yet — import a model or use the starter avatar first.');
  onProgress?.(null, 'Loading the avatar…');
  const size = fid === 'png' ? Number(o.size) || 1024 : 512;
  const w = fid === 'png' ? Math.round(size * (o.aspect === 'wide' ? 16 / 9 : o.aspect === 'tall' ? 9 / 16 : 1)) : 512;
  const { vp, avatar } = await offscreen(doc, assetUrl, w, size);
  try {
    if (fid === 'png') {
      vp.setBackground(o.transparent ? null : doc.look?.background || '#2b2f3a');
      vp.frame(avatar, o.framing && o.framing !== 'stage' ? { ...doc.camera, framing: o.framing } : doc.camera);
      return await vp.snapshot();
    }
    if (fid === 'vrm') {
      onProgress?.(0.3, 'Making the thumbnail…');
      const thumb = await thumbnail(doc, vp, avatar, assetUrl);
      onProgress?.(0.5, 'Writing VRM 1.0…');
      const buf = await exportVRM(avatar, doc, { thumbnail: thumb });
      if (o.check !== false) {
        onProgress?.(0.85, 'Checking the file by loading it back…');
        const r = await checkVRM(buf, avatar, doc);
        if (r.ok) toast(`Checked: the VRM loads back with ${r.stats.bones} bones, ${r.stats.expressions} expressions and ${r.stats.joints} spring joints.`, { type: 'success' });
        else toast(`The VRM was saved, but loading it back showed: ${r.notes.slice(0, 3).join(' ')}`, { type: 'error' });
      }
      return new Blob([buf], { type: 'model/gltf-binary' });
    }
    onProgress?.(0.5, 'Writing glTF…');
    const out = await exportGLTF(avatar, { binary: fid === 'glb' });
    return fid === 'glb' ? new Blob([out], { type: 'model/gltf-binary' }) : new Blob([JSON.stringify(out)], { type: 'model/gltf+json' });
  } finally {
    avatar.dispose(); vp.dispose({ loseContext: true });
  }
}
