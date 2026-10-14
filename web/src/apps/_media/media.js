// Shared helpers for media apps (Cut, Encoder…): waveform peaks and video frame thumbnails from the server, cached.
import { api } from '../../lib/api.js';

const peakCache = new Map();
/** Waveform of an audio/video asset: { duration, peaks: [[min, max], …] } (n pairs across the whole file). */
export function getPeaks(assetId, n = 4000) {
  const key = `${assetId}:${n}`;
  if (!peakCache.has(key)) peakCache.set(key, api.get(`/api/assets/${assetId}/peaks?n=${n}`).catch(() => ({ duration: 0, peaks: [] })));
  return peakCache.get(key);
}

/** URL of one video frame (JPEG) — t is rounded so neighbouring requests share the browser cache. */
export const frameUrl = (assetId, t, w = 160, step = 0.5) => `/api/assets/${assetId}/frame?t=${Math.max(0, Math.round(t / step) * step).toFixed(2)}&w=${w}`;

/**
 * Draws peaks for the source range [from, to] (seconds) across a canvas.
 * gain scales the bars (clip volume), color is the fill.
 */
export function drawPeaks(canvas, data, from, to, { color = 'rgba(255,255,255,.75)', gain = 1 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data?.peaks?.length || !data.duration || to <= from) return;
  const n = data.peaks.length;
  const per = data.duration / n;
  ctx.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const a = from + ((to - from) * x) / w; const b = from + ((to - from) * (x + 1)) / w;
    let i0 = Math.floor(a / per); let i1 = Math.max(i0 + 1, Math.ceil(b / per));
    i0 = Math.max(0, i0); i1 = Math.min(n, i1);
    let lo = 0; let hi = 0;
    for (let i = i0; i < i1; i++) { const p = data.peaks[i]; if (p[0] < lo) lo = p[0]; if (p[1] > hi) hi = p[1]; }
    const y0 = mid - Math.min(1, hi * gain) * mid; const y1 = mid - Math.max(-1, lo * gain) * mid;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

/** "1:02:03" / "2:03.4" style durations for lists. */
export function fmtDur(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}` : `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}
