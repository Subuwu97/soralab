// Media for the animation engine: images, video elements (seeked frame-accurately) and decoded audio, cached per tab.
// Rendering is split in two: prepare (async — load images, seek videos, load fonts) then draw (sync, deterministic).
import { assetSrc, loadImage } from '../../lib/doc.js';

const images = new Map(); // assetId → { img, promise }
const videos = new Map(); // key → HTMLVideoElement
const audio = new Map();  // assetId → Promise<AudioBuffer|null>
const listeners = new Set();
/** Called when something finishes loading, so viewers can redraw. */
export const onMediaLoaded = (f) => { listeners.add(f); return () => listeners.delete(f); };
const loaded = () => listeners.forEach((f) => f());

/** The loaded image, or null while it loads (a redraw follows). */
export function getImage(assetId) {
  if (!assetId) return null;
  let e = images.get(assetId);
  if (!e) {
    e = { img: null };
    e.promise = loadImage(assetSrc(assetId)).then((img) => { e.img = img; loaded(); return img; }).catch(() => null);
    images.set(assetId, e);
  }
  return e.img;
}
export const loadImageAsset = async (assetId) => { getImage(assetId); return images.get(assetId).promise; };

/** One <video> element per key (a layer), so two layers can show the same file at different times. */
export function getVideo(key, assetId) {
  let v = videos.get(key);
  if (!v || v.dataset.asset !== assetId) {
    v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.dataset.asset = assetId;
    v.src = assetSrc(assetId);
    v.addEventListener('loadeddata', loaded);
    v.addEventListener('seeked', loaded);
    videos.set(key, v);
  }
  return v;
}

/** Seeks a video and waits for the frame (the 'seeked' event). Resolves quickly if it's already there. */
export function seekVideo(v, t, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const go = () => {
      const target = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.001));
      if (Math.abs(v.currentTime - target) < 0.0005 && !v.seeking && v.readyState >= 2) { resolve(true); return; }
      const done = () => { clearTimeout(tm); v.removeEventListener('seeked', done); resolve(true); };
      const tm = setTimeout(() => { v.removeEventListener('seeked', done); resolve(false); }, timeout);
      v.addEventListener('seeked', done);
      v.currentTime = target;
    };
    if (v.readyState >= 1) go();
    else {
      const ready = () => { v.removeEventListener('loadedmetadata', ready); go(); };
      v.addEventListener('loadedmetadata', ready);
      setTimeout(() => { v.removeEventListener('loadedmetadata', ready); resolve(false); }, timeout);
    }
  });
}
/** Non-blocking seek for interactive preview: asks for the frame and redraws when it arrives. */
export function nudgeVideo(v, t) {
  const target = Math.max(0, t);
  if (v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - target) > 0.0005) v.currentTime = Math.min(target, (v.duration || target + 1) - 0.001);
}
export const videoReady = (v) => v && v.readyState >= 2;

let ac = null;
const audioCtx = () => (ac ||= new (window.AudioContext || window.webkitAudioContext)());
/** Decoded audio of an asset (audio file or a video's soundtrack), or null if it has none. */
export function getAudioBuffer(assetId) {
  if (!audio.has(assetId)) {
    audio.set(assetId, (async () => {
      try {
        const r = await fetch(assetSrc(assetId), { credentials: 'same-origin' });
        if (!r.ok) return null;
        return await audioCtx().decodeAudioData(await r.arrayBuffer());
      } catch { return null; }
    })());
  }
  return audio.get(assetId);
}

/**
 * Mixes clips into one AudioBuffer with OfflineAudioContext.
 * clips: [{ asset, at (comp time where media time 0 sits), from, to (comp-time range that plays), gain (linear), fadeIn?, fadeOut? }]
 */
export async function mixAudio(clips, duration, { sampleRate = 48000, channels = 2 } = {}) {
  const usable = clips.filter((c) => c.to > c.from && c.gain > 0);
  if (!usable.length || duration <= 0) return null;
  const buffers = await Promise.all(usable.map((c) => getAudioBuffer(c.asset)));
  if (!buffers.some(Boolean)) return null;
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  usable.forEach((c, i) => {
    const buf = buffers[i];
    if (!buf) return;
    const from = Math.max(0, c.from); const to = Math.min(duration, c.to);
    const offset = from - c.at;
    if (to <= from || offset >= buf.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = c.gain;
    src.connect(g).connect(ctx.destination);
    src.start(from, Math.max(0, offset), to - from);
  });
  return ctx.startRendering();
}

/** Plays an AudioBuffer from `offset` seconds; returns stop(). For preview playback in sync with the viewer clock. */
export function playBuffer(buffer, offset) {
  if (!buffer) return () => {};
  const ctx = audioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  try { src.start(0, Math.max(0, Math.min(offset, buffer.duration))); } catch { return () => {}; }
  return () => { try { src.stop(); } catch { /* already stopped */ } };
}
