// Saving and loading raster documents.
//
// Saved JSON: { v: 1, width, height, guides, layers: [...] } where each layer is the in-memory layer minus pixels;
// pixels become { asset, x, y } — a PNG asset (uploaded with saveBlob, marked autosave) placed at x,y in the layer.
// A Pix remembers its asset id, so only layers whose pixels changed since the last save are uploaded again. The old
// PNGs of a changed layer are freed by the server's storage cleanup once no version of the project uses them.
import { Pix, pixToCanvas, makeCanvas } from './pix.js';
import { newDoc, newBitmap, uid } from './model.js';
import { saveBlob, api } from '../../lib/api.js';
import { assetSrc, loadImage, canvasBlob } from '../../lib/doc.js';

const uploads = new WeakMap(); // Pix → Promise<asset id> (so two quick saves don't upload twice)

async function savePix(pix, docId, name) {
  if (!pix || pix.empty) return null;
  const b = pix.bounds;
  if (!pix.asset) {
    let p = uploads.get(pix);
    if (!p) {
      p = (async () => {
        const blob = await canvasBlob(pixToCanvas(pix, b), 'image/png');
        const a = await saveBlob(blob, `${name || 'layer'}.png`, { docId, isExport: false, autosave: true });
        pix.asset = a.id;
        return a.id;
      })();
      uploads.set(pix, p);
      p.catch(() => uploads.delete(pix));
    }
    await p;
  }
  return { asset: pix.asset, x: b.x, y: b.y };
}

/** In-memory document → JSON (uploads changed pixels first). */
export async function toSaved(doc, docId) {
  const layer = async (l) => {
    const { pix, children, mask, ...rest } = l;
    const out = { ...rest };
    if (l.type === 'bitmap') out.pix = await savePix(pix, docId, l.name);
    if (l.type === 'group') out.children = await Promise.all(children.map(layer));
    if (mask) out.mask = { ...mask, pix: await savePix(mask.pix, docId, `${l.name} mask`) };
    return out;
  };
  return { v: 1, width: doc.width, height: doc.height, guides: doc.guides || [], layers: await Promise.all(doc.layers.map(layer)) };
}

async function loadPix(ref) {
  if (!ref?.asset) return Pix.empty();
  const img = await loadImage(assetSrc(ref.asset));
  const c = makeCanvas(img.naturalWidth, img.naturalHeight); c.getContext('2d').drawImage(img, 0, 0);
  const p = Pix.fromCanvas(c, ref.x || 0, ref.y || 0);
  p.asset = ref.asset;
  return p;
}

/** JSON → in-memory document. Missing pixel files load as empty layers (and say so). */
export async function fromSaved(data, { onMissing } = {}) {
  const layer = async (l) => {
    const out = { ...l };
    if (l.type === 'bitmap') out.pix = await loadPix(l.pix).catch((e) => { onMissing?.(l, e); return Pix.empty(); });
    if (l.type === 'group') out.children = await Promise.all((l.children || []).map(layer));
    if (l.mask) out.mask = { x: 0, y: 0, ...l.mask, pix: await loadPix(l.mask.pix).catch(() => Pix.empty()) };
    return out;
  };
  const d = newDoc(data.width, data.height, await Promise.all((data.layers || []).map(layer)));
  d.guides = data.guides || [];
  return d;
}

/** A filled bitmap layer the size of the document. */
export function solidLayer(name, w, h, color) {
  const c = makeCanvas(w, h); const ctx = c.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
  return newBitmap(name, { pix: Pix.fromCanvas(c, 0, 0, { checkEmpty: false }) });
}

/** A layer from an image asset, scaled down to fit inside w×h if bigger, centred. */
export async function imageLayer(asset, w, h, { fit = true, name } = {}) {
  const img = await loadImage(assetSrc(asset));
  let iw = img.naturalWidth; let ih = img.naturalHeight;
  if (fit && w && h && (iw > w || ih > h)) { const s = Math.min(w / iw, h / ih); iw = Math.max(1, Math.round(iw * s)); ih = Math.max(1, Math.round(ih * s)); }
  const c = makeCanvas(iw, ih); const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, iw, ih);
  const x = w ? Math.round((w - iw) / 2) : 0; const y = h ? Math.round((h - ih) / 2) : 0;
  const l = newBitmap(name || (typeof asset === 'object' ? asset.name?.replace(/\.[^.]+$/, '') : null) || 'Image', { pix: Pix.fromCanvas(c, x, y) });
  return { layer: l, width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Opens a project: saved layers if there are any; otherwise a new document from project.doc (width/height),
 * with a background layer and any images listed in doc.meta.import (from "Open in …" on the Files page).
 * Returns { doc, fresh } — fresh = built here, so it should be saved.
 */
export async function openDocument(project, { background = '#ffffff', backgroundName = 'Background', defaultSize = [1920, 1080], onMissing } = {}) {
  const data = project.data && typeof project.data === 'object' && !(project.data instanceof Blob) ? project.data : {};
  if (Array.isArray(data.layers) && data.layers.length && data.width && data.height) return { doc: await fromSaved(data, { onMissing }), fresh: false };
  const meta = project.doc?.meta || {};
  const imports = Array.isArray(meta.import) ? meta.import : [];
  let w = Number(project.doc?.width) || Number(data.width) || 0; let h = Number(project.doc?.height) || Number(data.height) || 0;
  const placed = [];
  for (const id of imports) {
    try {
      const info = await api.get(`/api/assets/${id}`).catch(() => ({ id }));
      if (!w || !h) { const first = await loadImage(assetSrc(id)); w = first.naturalWidth; h = first.naturalHeight; }
      placed.push((await imageLayer(info, w, h, { name: info.name?.replace(/\.[^.]+$/, '') })).layer);
    } catch (e) { onMissing?.({ name: String(id) }, e); }
  }
  if (!w || !h) [w, h] = defaultSize;
  const layers = [];
  if (background) layers.push(solidLayer(backgroundName, w, h, background));
  layers.push(...placed);
  return { doc: newDoc(w, h, layers), fresh: true };
}

export { uid };
