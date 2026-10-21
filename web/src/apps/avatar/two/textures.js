// Part textures: loading (cached by asset id), reading their pixels, and the layer-separation tools —
// auto-crop to content, split with a lasso, and "fill behind" (extend colours into hidden areas, e.g. skin under the
// hair, so nothing shows through when parts move). Edited textures are saved as new PNG assets of the project.
import { saveBlob } from '../../../lib/api.js';

const images = new Map();   // asset id → Promise<HTMLImageElement | ImageBitmap>
const pixels = new Map();   // asset id → ImageData

export const assetFileUrl = (id) => `/api/assets/${id}/file`;
/** Loads a texture image. urlOf(id) → URL (the output page passes its key-based URLs). */
export function loadTex(id, urlOf = assetFileUrl) {
  if (!id) return Promise.resolve(null);
  if (!images.has(id)) {
    images.set(id, fetch(urlOf(id), { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(`texture ${id}: ${r.status}`); return r.blob(); })
      .then((b) => createImageBitmap(b, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' })) // premultiplied: what WebGL blends with
      .catch((e) => { images.delete(id); throw e; }));
  }
  return images.get(id);
}
/** Seeds the cache with an image made here (so a just-saved texture shows at once). */
export function putTex(id, bitmap, data) { images.set(id, Promise.resolve(bitmap)); if (data) pixels.set(id, data); }
export async function texPixels(id, urlOf) {
  if (pixels.has(id)) return pixels.get(id);
  const img = await loadTex(id, urlOf);
  const c = new OffscreenCanvas(img.width, img.height); const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  pixels.set(id, d);
  return d;
}
export const cachedPixels = (id) => pixels.get(id) || null;

/** Saves pixels as a PNG asset of the project; returns the new asset id (and caches the image). */
export async function saveTex(imageData, name, docId) {
  const c = new OffscreenCanvas(imageData.width, imageData.height);
  c.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const a = await saveBlob(blob, `${name || 'part'}.png`, { docId, isExport: false });
  putTex(a.id, await createImageBitmap(c, { premultiplyAlpha: 'premultiply' }), imageData);
  return a.id;
}

/** Bounding box of the visible pixels: [x, y, w, h], or null when empty. */
export function contentBox(d, threshold = 2) {
  const { data, width: w, height: h } = d;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
export function cropData(d, [x, y, w, h]) {
  const out = new ImageData(w, h);
  for (let j = 0; j < h; j++) out.data.set(d.data.subarray(((y + j) * d.width + x) * 4, ((y + j) * d.width + x + w) * 4), j * w * 4);
  return out;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Splits pixels by a polygon (texture coordinates): { inside: ImageData, outside: ImageData } (same size). */
export function splitByPolygon(d, poly) {
  const a = new ImageData(d.width, d.height); const b = new ImageData(d.width, d.height);
  // rasterise the polygon once (scanline-ish via point test per pixel inside its bounds)
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  b.data.set(d.data);
  const W = d.width; const inside = new Uint8Array(W * d.height);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(d.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
    if (!pointInPoly(x + 0.5, y + 0.5, poly)) continue;
    inside[y * W + x] = 1; b.data[(y * W + x) * 4 + 3] = 0;
  }
  // the split-off part overlaps the rest by a pixel, so no hairline seam shows between them
  for (let y = 0; y < d.height; y++) for (let x = 0; x < W; x++) {
    let on = inside[y * W + x];
    for (let k = -1; k <= 1 && !on; k++) for (let l = -1; l <= 1 && !on; l++) { const xx = x + l; const yy = y + k; if (xx >= 0 && yy >= 0 && xx < W && yy < d.height && inside[yy * W + xx]) on = 1; }
    if (!on) continue;
    const i = (y * W + x) * 4;
    a.data[i] = d.data[i]; a.data[i + 1] = d.data[i + 1]; a.data[i + 2] = d.data[i + 2]; a.data[i + 3] = d.data[i + 3];
  }
  return { inside: a, outside: b };
}

/**
 * "Fill behind": grows the texture's colours outward into transparent pixels under a brush stroke (edge extend), so
 * hidden areas get plausible colour. Returns new ImageData, possibly larger (the canvas grows to fit the stroke) and
 * the offset of the old texture inside it: { data, dx, dy }.
 *   points: brush centres in texture coordinates; radius in px.
 */
export function fillBehind(d, points, radius) {
  // grow the texture to hold the stroke
  let x0 = 0; let y0 = 0; let x1 = d.width; let y1 = d.height;
  for (const [x, y] of points) { x0 = Math.min(x0, Math.floor(x - radius)); y0 = Math.min(y0, Math.floor(y - radius)); x1 = Math.max(x1, Math.ceil(x + radius)); y1 = Math.max(y1, Math.ceil(y + radius)); }
  const W = x1 - x0; const H = y1 - y0; const dx = -x0; const dy = -y0;
  const out = new ImageData(W, H);
  for (let j = 0; j < d.height; j++) out.data.set(d.data.subarray(j * d.width * 4, (j + 1) * d.width * 4), ((j + dy) * W + dx) * 4);
  // the brush area
  const brush = new Uint8Array(W * H);
  for (const [px, py] of points) {
    const cx = px + dx; const cy = py + dy;
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(H, Math.ceil(cy + radius)); y++) for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(W, Math.ceil(cx + radius)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) brush[y * W + x] = 1;
  }
  // iterative edge extension: each pass, empty brushed pixels next to solid ones take their neighbours' average
  const px = out.data; const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = px[i * 4 + 3] > 200 ? 1 : 0;
  for (let pass = 0; pass < radius * 2 + 4; pass++) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!brush[i] || solid[i]) continue;
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let k = -1; k <= 1; k++) for (let l = -1; l <= 1; l++) {
        const xx = x + l; const yy = y + k; if ((!k && !l) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx; if (!solid[q]) continue;
        r += px[q * 4]; g += px[q * 4 + 1]; b += px[q * 4 + 2]; n++;
      }
      if (n) add.push(i, r / n, g / n, b / n);
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      // keep any partial alpha's colour where it was antialiased: blend toward the extended colour
      const a = px[i * 4 + 3] / 255;
      px[i * 4] = px[i * 4] * a + add[k + 1] * (1 - a); px[i * 4 + 1] = px[i * 4 + 1] * a + add[k + 2] * (1 - a); px[i * 4 + 2] = px[i * 4 + 2] * a + add[k + 3] * (1 - a);
      px[i * 4 + 3] = 255; solid[i] = 1;
    }
  }
  return { data: out, dx, dy };
}

/** Converts a canvas-space polygon/point into a part's texture coordinates. */
export const toTex = (part, [x, y]) => [x - part.x, y - part.y];
