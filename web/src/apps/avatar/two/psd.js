// Bringing artwork in: a layered PSD (ag-psd, MIT) or loose PNGs. Every visible bitmap layer becomes a part at its
// position on the canvas, cropped to its content, uploaded as a PNG asset of the project, named after the layer (and
// given a role from common layer names), meshed automatically. PSD groups become part groups; clipping layers clip
// to the layer below; multiply / screen / linear dodge carry over as blend modes.
import { readPsd } from 'ag-psd';
import { uploadFiles } from '../../../lib/api.js';
import { uid, guessRole, roleId } from './model.js';
import { contentBox, cropData, putTex } from './textures.js';
import { autoMesh } from './mesh.js';

const BLEND = { multiply: 'multiply', screen: 'screen', 'linear dodge': 'add', 'color dodge': 'add', lighten: 'screen', darken: 'multiply' };

/** Reads a PSD into layers: [{ name, path, data: ImageData (cropped), x, y, visible, opacity, blend, clipping }], width, height. */
export function readLayers(buffer) {
  const psd = readPsd(buffer, { skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, useImageData: true });
  const layers = []; const groups = [];
  const walk = (children, path, groupId) => {
    for (const l of children || []) {
      if (l.children) {
        const id = uid('g'); const name = l.name || 'Group';
        groups.push({ id, name: [...path, name].join(' / '), hidden: !!l.hidden });
        walk(l.children, [...path, name], id);
        continue;
      }
      const img = l.imageData;
      if (!img || !img.width || !img.height) continue;
      const d = new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height);
      const box = contentBox(d);
      if (!box) continue;
      const hiddenByGroup = path.length && groups.some((g) => g.hidden && [...path].join(' / ').startsWith(g.name));
      layers.push({
        name: l.name || 'Layer', path: path.join(' / '), group: groupId, data: cropData(d, box), x: (l.left || 0) + box[0], y: (l.top || 0) + box[1],
        visible: !l.hidden && !hiddenByGroup, opacity: l.opacity ?? 1, blend: BLEND[l.blendMode] || 'normal', clipping: !!l.clipping,
      });
    }
  };
  walk(psd.children, [], null);
  return { width: psd.width, height: psd.height, layers, groups: groups.map(({ id, name }) => ({ id, name })) };
}

/**
 * Turns layers into parts: uploads their textures (in batches), meshes them, guesses roles and clipping.
 * onProgress(0..1, label). Returns { parts, groups }.
 */
export async function layersToParts(layers, { docId, density = 48, onProgress = () => {} }) {
  const parts = [];
  const blobs = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const c = new OffscreenCanvas(l.data.width, l.data.height); c.getContext('2d').putImageData(l.data, 0, 0);
    blobs.push(c.convertToBlob({ type: 'image/png' }).then((b) => new File([b], `${l.name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'part'}.png`, { type: 'image/png' })));
  }
  const files = await Promise.all(blobs);
  const assets = [];
  for (let i = 0; i < files.length; i += 12) {
    onProgress(i / files.length * 0.8, `Uploading layers ${i + 1}–${Math.min(files.length, i + 12)} of ${files.length}…`);
    assets.push(...await uploadFiles(files.slice(i, i + 12), { docId }));
  }
  let base = null; // the layer clipping layers clip to
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]; const a = assets[i];
    onProgress(0.8 + (i / layers.length) * 0.2, `Meshing ${l.name}…`);
    const m = autoMesh(l.data, { density });
    const { role, side } = guessRole(l.name, l.path);
    const id = uid('p');
    putTex(a.id, await createImageBitmap(l.data, { premultiplyAlpha: 'premultiply' }), l.data);
    const part = {
      id, name: l.name, role: roleId(role, side), tex: a.id, x: l.x, y: l.y, w: l.data.width, h: l.data.height,
      visible: l.visible, opacity: l.opacity, blend: l.blend, clip: l.clipping && base ? [base] : [], parent: null, group: l.group || null,
      mesh: { v: m.v.map((v, k) => Math.round((v + (k % 2 ? l.y : l.x)) * 10) / 10), t: m.t, pins: [], density }, kf: [],
    };
    if (!l.clipping) base = id;
    parts.push(part);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  onProgress(1, 'Done');
  return parts;
}

/** Loose PNGs: each becomes a part. Full-canvas PNGs (all the same size) keep their placement after cropping. */
export async function readPngs(files) {
  const imgs = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f, { premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    imgs.push({ name: f.name.replace(/\.[^.]+$/, ''), d: ctx.getImageData(0, 0, bmp.width, bmp.height) });
  }
  const W = Math.max(...imgs.map((i) => i.d.width)); const H = Math.max(...imgs.map((i) => i.d.height));
  const layers = [];
  for (const { name, d } of imgs) {
    const box = contentBox(d); if (!box) continue;
    // smaller images are centred on the canvas
    const ox = Math.round((W - d.width) / 2); const oy = Math.round((H - d.height) / 2);
    layers.push({ name, path: '', group: null, data: cropData(d, box), x: ox + box[0], y: oy + box[1], visible: true, opacity: 1, blend: 'normal', clipping: false });
  }
  return { width: W, height: H, layers, groups: [] };
}
