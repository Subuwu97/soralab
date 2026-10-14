// Loading photos, brush-mask rasters, LUT profiles, edited thumbnails and full-resolution export.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { loadImage, canvasBlob } from '../../lib/doc.js';
import { Renderer, parseCube } from './engine.js';
import { frameOf, compact } from './model.js';

// ---------------------------------------------------------------- assets

const assetCache = new Map(); // id → Promise<asset>
/** Asset info (polls while the server is still making a browser-friendly copy). */
export function getAsset(id, { fresh = false } = {}) {
  if (fresh || !assetCache.has(id)) assetCache.set(id, api.get(`/api/assets/${id}`).catch((e) => { assetCache.delete(id); throw e; }));
  return assetCache.get(id);
}
export async function waitReady(id, onUpdate) {
  for (let i = 0; i < 600; i++) {
    const a = await getAsset(id, { fresh: i > 0 });
    onUpdate?.(a);
    if (a.web_status !== 'processing') return a;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Still processing — try again in a moment.');
}
const srcUrl = (a) => a.web_url || `/api/assets/${a.id}/web`;

const imgCache = new Map(); // asset id → Promise<HTMLImageElement> (the last few only — they're big)
export function loadPhotoImage(assetId) {
  if (imgCache.has(assetId)) { const p = imgCache.get(assetId); imgCache.delete(assetId); imgCache.set(assetId, p); return p; }
  const p = waitReady(assetId).then((a) => {
    if (a.web_status === 'failed') throw new Error('The server couldn’t convert this file for the browser.');
    return loadImage(srcUrl(a));
  }).then(async (img) => { await img.decode?.().catch(() => {}); return img; });
  p.catch(() => imgCache.delete(assetId));
  imgCache.set(assetId, p);
  while (imgCache.size > 4) imgCache.delete(imgCache.keys().next().value);
  return p;
}

// ---------------------------------------------------------------- brush masks

export const BRUSH_EDGE = 1024;
/** A greyscale canvas (white = masked) for a brush mask, in source space. */
export function brushCanvas(mask, srcW, srcH, edge = BRUSH_EDGE, canvas = null) {
  const s = edge / Math.max(srcW, srcH);
  const w = Math.max(1, Math.round(srcW * s)); const h = Math.max(1, Math.round(srcH * s));
  const c = canvas || document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  for (const st of mask.strokes || []) drawStroke(ctx, st, w, h, 0);
  return c;
}
/** Draws a stroke's dabs from point index `from` (for live painting). */
export function drawStroke(ctx, st, w, h, from = 0) {
  const L = Math.max(w, h);
  const r = Math.max(0.5, st.size * L);
  const hard = 1 - (st.feather ?? 50) / 100;
  const pts = st.pts;
  const spacing = Math.max(0.5, r * 0.2);
  ctx.save();
  const dab = (x, y) => {
    const g = ctx.createRadialGradient(x, y, r * hard * 0.98, x, y, r);
    const col = st.erase ? '0,0,0' : '255,255,255';
    const a = (st.flow ?? 100) / 100;
    g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  let px = null; let py = null;
  const start = Math.max(0, from - 2);
  for (let i = start; i < pts.length; i += 2) {
    const x = pts[i] * w; const y = pts[i + 1] * h;
    if (px === null) { if (i >= from) dab(x, y); px = x; py = y; continue; }
    const d = Math.hypot(x - px, y - py);
    const n = Math.floor(d / spacing);
    for (let k = 1; k <= n; k++) dab(px + ((x - px) * k) / n, py + ((y - py) * k) / n);
    if (n) { px = x; py = y; }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- LUT profiles

const lutCache = new Map();
export function loadLut(assetId) {
  if (!lutCache.has(assetId)) {
    const p = fetch(`/api/assets/${assetId}/file`, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('Couldn’t load the LUT.'); return r.text(); }).then(parseCube);
    p.catch(() => lutCache.delete(assetId));
    lutCache.set(assetId, p);
  }
  return lutCache.get(assetId);
}

// ---------------------------------------------------------------- an off-screen renderer (thumbnails, export)

let offscreen = null;
function off() {
  if (!offscreen) offscreen = new Renderer(document.createElement('canvas'));
  return offscreen;
}
let chain = Promise.resolve();
/** Runs jobs on the shared off-screen renderer one at a time. */
const queued = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

/** Prepares the off-screen renderer for a photo's settings (brush masks, LUT). */
async function prepare(r, settings, edge) {
  const brushes = (settings.masks || []).filter((m) => m.type === 'brush' && m.visible !== false);
  for (let i = 0; i < 4; i++) r.setBrush(i, null);
  brushes.slice(0, 4).forEach((m) => r.setBrush(m.channel ?? 0, brushCanvas(m, r.w, r.h, edge)));
  if (settings.lut?.asset_id) { const lut = await loadLut(settings.lut.asset_id).catch(() => null); r.setLut(lut, lut ? settings.lut.asset_id : null); return !!lut; }
  return false;
}

/**
 * Renders a photo with its settings. size: { long } long edge px, or { mp } megapixels, or null for full size.
 * Returns a canvas.
 */
export function renderPhoto(photo, { size = null, onProgress } = {}) {
  return queued(async () => {
    const img = await loadPhotoImage(photo.asset_id);
    const r = off();
    if (r.srcKey !== photo.asset_id) { await r.setSource(img); r.srcKey = photo.asset_id; }
    const s = photo.settings;
    const lutOn = await prepare(r, s, 2048);
    const frame = frameOf(r.w, r.h, s);
    let scale = 1;
    if (size?.long) scale = Math.min(1, size.long / Math.max(frame.outW, frame.outH));
    if (size?.mp) scale = Math.min(1, Math.sqrt((size.mp * 1e6) / (frame.outW * frame.outH)));
    const w = Math.max(1, Math.round(frame.outW * scale)); const h = Math.max(1, Math.round(frame.outH * scale));
    const px = await r.renderFull(s, frame, w, h, { onProgress, lutOn });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    return c;
  });
}

export async function encode(canvas, format, quality = 0.9) {
  const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] || 'image/jpeg';
  if (type === 'image/jpeg') {
    // JPEG has no alpha: flatten onto white so transparent edges don't turn black.
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
    return canvasBlob(c, type, quality);
  }
  return canvasBlob(canvas, type, type === 'image/png' ? undefined : quality);
}

// ---------------------------------------------------------------- edited thumbnails

const thumbCache = new Map(); // key → Promise<url>
const thumbKey = (p) => `${p.asset_id}|${JSON.stringify(compact(p.settings))}`;
const thumbImgCache = new Map();
function thumbImage(assetId) {
  if (!thumbImgCache.has(assetId)) {
    const p = waitReady(assetId).then(() => loadImage(`/api/assets/${assetId}/thumb`));
    p.catch(() => thumbImgCache.delete(assetId));
    thumbImgCache.set(assetId, p);
  }
  return thumbImgCache.get(assetId);
}

/** URL of a small preview with the photo's edits applied (unedited photos use the server thumbnail as-is). */
export function editedThumb(photo) {
  const key = thumbKey(photo);
  if (!thumbCache.has(key)) {
    const p = queued(async () => {
      const img = await thumbImage(photo.asset_id);
      const r = off();
      // Thumbnails are rendered from the small server preview; geometry is relative so it lines up.
      await r.setSource(img); r.srcKey = null;
      const s = photo.settings;
      const lutOn = await prepare(r, s, 256);
      const frame = frameOf(r.w, r.h, s);
      const sc = Math.min(1, 320 / Math.max(frame.outW, frame.outH));
      const w = Math.max(1, Math.round(frame.outW * sc)); const h = Math.max(1, Math.round(frame.outH * sc));
      const px = await r.renderFull(s, frame, w, h, { lutOn });
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      const blob = await canvasBlob(c, 'image/jpeg', 0.85);
      return URL.createObjectURL(blob);
    });
    p.catch(() => thumbCache.delete(key));
    thumbCache.set(key, p);
    if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
  }
  return thumbCache.get(key);
}

/** React hook: the photo's thumbnail URL (edited when it has edits), plus processing state. */
export function usePhotoThumb(photo, edited) {
  const [state, setState] = useState({ url: null, processing: false, failed: false });
  const key = edited ? thumbKey(photo) : photo.asset_id;
  useEffect(() => {
    let off2 = false;
    // While someone is dragging a slider the key changes constantly; wait until it settles.
    const t = setTimeout(async () => {
      try {
        const a = await getAsset(photo.asset_id);
        if (a.web_status === 'processing') {
          if (!off2) setState((s) => ({ ...s, processing: true }));
          await waitReady(photo.asset_id);
        }
        if (a.web_status === 'failed') { if (!off2) setState({ url: null, processing: false, failed: true }); return; }
        const url = edited ? await editedThumb(photo) : `/api/assets/${photo.asset_id}/thumb`;
        if (!off2) setState({ url, processing: false, failed: false });
      } catch { if (!off2) setState({ url: null, processing: false, failed: true }); }
    }, state.url && edited ? 700 : 0);
    return () => { off2 = true; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
