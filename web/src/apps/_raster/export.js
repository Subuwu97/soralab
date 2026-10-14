// Export: flattened PNG/JPEG/WebP, a layered PSD (simple writer: one pixel layer per top-level layer),
// and a ZIP with one PNG per layer.
import { zipSync } from 'fflate';
import { canvasBlob } from '../../lib/doc.js';
import { makeCanvas } from './pix.js';

/** The visible image as a canvas, optionally scaled, on an optional background colour. */
export function flatCanvas(renderer, doc, { scale = 1, background = null } = {}) {
  renderer.setDoc(doc); renderer.flush();
  const w = Math.max(1, Math.round(doc.width * scale)); const h = Math.max(1, Math.round(doc.height * scale));
  const c = makeCanvas(w, h); const ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(renderer.canvas, 0, 0, w, h);
  return c;
}

export async function exportImage(renderer, doc, format, { scale = 1, quality = 0.9, background } = {}) {
  const type = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const c = flatCanvas(renderer, doc, { scale, background: format === 'jpeg' ? background || '#ffffff' : background });
  return canvasBlob(c, type, format === 'png' ? undefined : quality);
}

/** Each top-level layer drawn alone (with its mask, effects and clipped layers) at full document size. */
function layerImages(renderer, doc) {
  const out = [];
  const r = { x: 0, y: 0, w: doc.width, h: doc.height };
  const list = doc.layers;
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (l.type === 'adjust') continue; // can't be represented as pixels on their own
    let j = i + 1; while (j < list.length && list[j].clip) j++;
    const clipped = list.slice(i + 1, j).filter((c) => c.visible);
    const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d');
    renderer.drawLayer({ ctx, ox: 0, oy: 0 }, { ...l, opacity: 1, blend: 'source-over', visible: true }, r, clipped);
    out.push({ layer: l, canvas: c });
    i = j - 1;
  }
  return out;
}

const PSD_BLEND = {
  'source-over': 'norm', 'pass-through': 'norm', darken: 'dark', multiply: 'mul ', 'color-burn': 'idiv', lighten: 'lite', screen: 'scrn', 'color-dodge': 'div ',
  lighter: 'lddg', overlay: 'over', 'soft-light': 'sLit', 'hard-light': 'hLit', difference: 'diff', exclusion: 'smud', hue: 'hue ', saturation: 'sat ', color: 'colr', luminosity: 'lum ',
};

/** A layered Photoshop file (8-bit RGB, uncompressed channels, layers trimmed to their content). */
export async function exportPsd(renderer, doc, { onProgress } = {}) {
  const imgs = layerImages(renderer, doc);
  const W = doc.width; const H = doc.height;
  const parts = []; let size = 0;
  const push = (u8) => { parts.push(u8); size += u8.length; };
  const u8 = (n) => new Uint8Array([n & 255]);
  const u16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
  const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const str = (s) => new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));

  // layer records + channel data
  const records = []; const channelData = [];
  imgs.forEach(({ layer, canvas }, k) => {
    onProgress?.(k / imgs.length * 0.8, 'Writing layers…');
    const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    if (x1 < 0) { x0 = y0 = 0; x1 = y1 = -1; }
    const w = x1 - x0 + 1; const h = y1 - y0 + 1;
    const chans = [-1, 0, 1, 2].map((id) => {
      const off = id === -1 ? 3 : id;
      const buf = new Uint8Array(2 + w * h);
      let p = 2;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) buf[p++] = d[(y * W + x) * 4 + off];
      return { id, buf };
    });
    const name = (layer.name || 'Layer').slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
    const nameLen = 1 + name.length; const namePad = (4 - (nameLen % 4)) % 4;
    const extra = [u32(0), u32(0), u8(name.length), str(name), new Uint8Array(namePad)];
    const extraLen = extra.reduce((n, a) => n + a.length, 0);
    records.push([u32(y0), u32(x0), u32(y1 + 1), u32(x1 + 1), u16(4),
      ...chans.flatMap((c) => [u16(c.id & 0xffff), u32(c.buf.length)]),
      str('8BIM'), str(PSD_BLEND[layer.blend] || 'norm'), u8(Math.round(layer.opacity * 255)), u8(0), u8(layer.visible ? 0 : 2), u8(0), u32(extraLen), ...extra]);
    channelData.push(...chans.map((c) => c.buf));
  });
  const recBytes = records.flat();
  let layerInfoLen = 2 + recBytes.reduce((n, a) => n + a.length, 0) + channelData.reduce((n, a) => n + a.length, 0);
  const padOdd = layerInfoLen % 2;
  layerInfoLen += padOdd;

  push(str('8BPS')); push(u16(1)); push(new Uint8Array(6)); push(u16(4)); push(u32(H)); push(u32(W)); push(u16(8)); push(u16(3));
  push(u32(0)); // colour mode data
  push(u32(0)); // image resources
  push(u32(4 + layerInfoLen + 4)); // layer & mask section
  push(u32(layerInfoLen));
  push(u16(imgs.length));
  recBytes.forEach(push);
  channelData.forEach(push);
  if (padOdd) push(new Uint8Array(1));
  push(u32(0)); // global layer mask info
  // merged image (planar, raw)
  onProgress?.(0.85, 'Writing the merged image…');
  renderer.setDoc(doc); renderer.flush();
  const md = renderer.ctx.getImageData(0, 0, W, H).data;
  push(u16(0));
  for (const off of [0, 1, 2, 3]) { const plane = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) plane[i] = md[i * 4 + off]; push(plane); }
  const out = new Uint8Array(size); let p = 0;
  for (const a of parts) { out.set(a, p); p += a.length; }
  return new Blob([out], { type: 'image/vnd.adobe.photoshop' });
}

/** ZIP with a PNG per top-level layer plus the flattened image. */
export async function exportLayerZip(renderer, doc, { onProgress } = {}) {
  const imgs = layerImages(renderer, doc);
  const files = {};
  const names = new Set();
  for (let i = 0; i < imgs.length; i++) {
    onProgress?.(i / (imgs.length + 1), 'Encoding layers…');
    let n = `${String(i + 1).padStart(2, '0')} ${imgs[i].layer.name}`.replace(/[\\/:*?"<>|]/g, '_');
    while (names.has(n)) n += '_';
    names.add(n);
    files[`${n}.png`] = new Uint8Array(await (await canvasBlob(imgs[i].canvas, 'image/png')).arrayBuffer());
  }
  files['flattened.png'] = new Uint8Array(await (await exportImage(renderer, doc, 'png')).arrayBuffer());
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
