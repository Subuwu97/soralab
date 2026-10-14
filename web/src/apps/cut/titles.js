// Titles and captions: drawn on a canvas the size of the sequence (transparent around the text). The preview draws the
// canvas directly; for the server render the same canvas is saved as a PNG asset (once per distinct look — keyed by a
// hash of the title and the frame size) and placed like any still.
import { ensureFont } from '../../lib/fonts.js';
import { saveBlob } from '../../lib/api.js';
import { canvasBlob } from '../../lib/doc.js';

export function titleKey(title, W, H) {
  const s = JSON.stringify([title, W, H]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

/** Draws a title onto a new canvas of W×H × scale. Make sure the font is loaded first (loadTitleFont). */
export function drawTitle(t, W, H, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(W * scale)); c.height = Math.max(2, Math.round(H * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  const size = t.size || 72;
  ctx.font = `${t.italic ? 'italic ' : ''}${t.weight || 400} ${size}px "${t.font || 'Inter'}", sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${t.tracking || 0}px`;
  ctx.textBaseline = 'middle';
  const lines = String(t.text || '').split('\n');
  const lh = size * (t.line || 1.15);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths); const bh = lh * lines.length;
  const cx = (t.x ?? 0.5) * W; const cy = (t.y ?? 0.5) * H;
  const left = t.align === 'left' ? cx - bw / 2 : t.align === 'right' ? cx + bw / 2 : cx;
  if (t.box) {
    const p = t.boxPad ?? 20;
    ctx.fillStyle = t.boxColor || '#000000b3';
    roundRect(ctx, cx - bw / 2 - p, cy - bh / 2 - p * 0.6, bw + p * 2, bh + p * 1.2, t.boxRadius ?? 8);
    ctx.fill();
  }
  ctx.textAlign = t.align === 'left' ? 'left' : t.align === 'right' ? 'right' : 'center';
  lines.forEach((l, i) => {
    const y = cy - bh / 2 + lh * (i + 0.5);
    const x = t.align === 'left' ? cx - bw / 2 : t.align === 'right' ? cx + bw / 2 : left;
    if (t.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.04; }
    if (t.stroke > 0) { ctx.lineWidth = t.stroke * 2; ctx.strokeStyle = t.strokeColor || '#000'; ctx.lineJoin = 'round'; ctx.strokeText(l, x, y); }
    ctx.fillStyle = t.color || '#ffffff';
    ctx.fillText(l, x, y);
    ctx.shadowColor = 'transparent';
  });
  return c;
}

export const loadTitleFont = (t) => ensureFont(t.font || 'Inter', t.weight || 400, t.italic ? 'italic' : 'normal');

/**
 * PNG assets for the server render. cache = { [key]: assetId } (kept with the project). Returns the asset id,
 * uploading the PNG if this look hasn't been saved yet.
 */
const pending = new Map();
export async function titleAsset(title, W, H, cache, docId) {
  const key = titleKey(title, W, H);
  if (cache[key]) return cache[key];
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      await loadTitleFont(title);
      const blob = await canvasBlob(drawTitle(title, W, H, 1), 'image/png');
      const a = await saveBlob(blob, `Title ${key}.png`, { docId, isExport: false });
      cache[key] = a.id;
      return a.id;
    })().finally(() => pending.delete(key)));
  }
  return pending.get(key);
}
