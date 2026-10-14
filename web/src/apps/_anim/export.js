// Export for the animation engine, all in the browser:
//   video  — WebCodecs VideoEncoder → mp4-muxer (H.264, or VP9-in-MP4 when this browser has no H.264) or webm-muxer (VP9/VP8),
//            with the audio mix encoded by AudioEncoder (AAC or Opus). Without WebCodecs: real-time MediaRecorder capture.
//   GIF    — gifenc (per-frame palette).   PNG sequence — ZIP via fflate.   PNG still.   Sprite sheet — PNG + JSON (zipped).
//
// Every exporter takes draw(ctx, t, frameIndex): an async function that renders time t into a width×height 2-D context.
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { zipSync, strToU8 } from 'fflate';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const makeCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
const toBlob = (c, type = 'image/png', q) => (c.convertToBlob ? c.convertToBlob({ type, quality: q }) : new Promise((r) => c.toBlob(r, type, q)));
const tick = () => new Promise((r) => setTimeout(r, 0));

const H264 = ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
const VP9 = 'vp09.00.10.08';

let support = null;
/** What this browser can encode: { webcodecs, h264, vp9, vp8, aac, opus, recorder }. */
export async function videoSupport(width = 1920, height = 1080) {
  if (support) return support;
  const s = { webcodecs: typeof VideoEncoder !== 'undefined', h264: null, vp9: false, vp8: false, aac: false, opus: false, recorder: typeof MediaRecorder !== 'undefined' };
  const ok = async (codec) => { try { return (await VideoEncoder.isConfigSupported({ codec, width: even(width), height: even(height), bitrate: 8e6, framerate: 30 })).supported; } catch { return false; } };
  const aok = async (codec) => { try { return typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported; } catch { return false; } };
  if (s.webcodecs) {
    for (const c of H264) if (await ok(c)) { s.h264 = c; break; }
    s.vp9 = await ok(VP9); s.vp8 = await ok('vp8');
    s.aac = await aok('mp4a.40.2'); s.opus = await aok('opus');
  }
  support = s;
  return s;
}

/** Rough bitrate for a size/frame rate and quality (high | medium | low). */
export const bitrateFor = (w, h, fps, quality = 'high') => Math.round(w * h * fps * ({ high: 0.2, medium: 0.11, low: 0.06 }[quality] || 0.15));

/**
 * Renders frames to a video file. container: 'mp4' | 'webm'. audio(): Promise<AudioBuffer|null>.
 * onProgress(0..1, label). Returns a Blob.
 */
export async function exportVideo({ width, height, fps, start = 0, duration, draw, audio, container = 'webm', quality = 'high', codec: wantCodec, onProgress = () => {}, signal }) {
  const W = even(width); const H = even(height);
  const s = await videoSupport(W, H);
  if (!s.webcodecs) return recordRealtime({ width: W, height: H, fps, start, duration, draw, audio, onProgress, signal });

  let vcodec; let muxCodec;
  if (container === 'mp4') {
    if (s.h264 && wantCodec !== 'vp9') { vcodec = s.h264; muxCodec = 'avc'; } else if (s.vp9) { vcodec = VP9; muxCodec = 'vp9'; } else throw new Error('This browser can’t encode MP4 video. Choose WebM.');
  } else if (s.vp9 && wantCodec !== 'vp8') { vcodec = VP9; muxCodec = 'V_VP9'; } else if (s.vp8) { vcodec = 'vp8'; muxCodec = 'V_VP8'; } else throw new Error('This browser can’t encode WebM video.');

  onProgress(0, 'Mixing audio…');
  const mix = audio ? await audio() : null;
  const acodec = mix ? (container === 'mp4' ? (s.aac ? 'aac' : s.opus ? 'opus' : null) : (s.opus ? 'opus' : null)) : null;

  const target = container === 'mp4' ? new Mp4Target() : new WebmTarget();
  const muxer = container === 'mp4'
    ? new Mp4Muxer({ target, fastStart: 'in-memory', firstTimestampBehavior: 'offset', video: { codec: muxCodec, width: W, height: H, frameRate: fps }, ...(acodec ? { audio: { codec: acodec, numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate } } : {}) })
    : new WebmMuxer({ target, firstTimestampBehavior: 'offset', video: { codec: muxCodec, width: W, height: H, frameRate: fps }, ...(acodec ? { audio: { codec: 'A_OPUS', numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate } } : {}) });

  let failure = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  venc.configure({ codec: vcodec, width: W, height: H, bitrate: bitrateFor(W, H, fps, quality), framerate: fps, ...(muxCodec === 'avc' ? { avc: { format: 'avc' } } : {}) });

  // Audio first (it's quick), so muxing interleaves sensibly.
  if (acodec) {
    onProgress(0, 'Encoding audio…');
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
    aenc.configure({ codec: acodec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: mix.sampleRate, numberOfChannels: mix.numberOfChannels, bitrate: 160000 });
    const ch = mix.numberOfChannels; const sr = mix.sampleRate;
    const total = Math.min(mix.length, Math.ceil(duration * sr));
    const block = sr / 10;
    const chans = Array.from({ length: ch }, (_, c) => mix.getChannelData(c));
    for (let off = 0; off < total; off += block) {
      const n = Math.min(block, total - off);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(chans[c].subarray(off, off + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((off / sr) * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }

  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const frames = Math.max(1, Math.round(duration * fps));
  const frameUs = 1e6 / fps;
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (failure) throw failure;
    const t = start + i / fps;
    ctx.save();
    await draw(ctx, t, i);
    ctx.restore();
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    venc.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4)); // don't let frames pile up in memory
    onProgress((i + 1) / frames, `Rendering frame ${i + 1} of ${frames}…`);
    if (i % 4 === 0) await tick();
  }
  await venc.flush(); venc.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
}

/** Fallback without WebCodecs: plays the frames in real time into a canvas stream and records it. */
export async function recordRealtime({ width, height, fps, start = 0, duration, draw, audio, onProgress = () => {}, signal }) {
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser can’t record video.');
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  const mix = audio ? await audio() : null;
  let stopAudio = () => {};
  if (mix) {
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource(); src.buffer = mix; src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    stopAudio = () => { try { src.stop(); ac.close(); } catch { /* done */ } };
    src.start(0, start);
  }
  const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrateFor(width, height, fps) });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now();
  const frames = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) break;
    ctx.save(); await draw(ctx, start + i / fps, i); ctx.restore();
    onProgress((i + 1) / frames, 'Recording in real time…');
    const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  rec.stop(); stopAudio();
  await done;
  return new Blob(parts, { type: (type || 'video/webm').split(';')[0] });
}

/** Animated GIF. scale shrinks the frame; fps is usually lower than the project's. */
export async function exportGif({ width, height, fps, start = 0, duration, draw, scale = 1, loop = true, transparent = false, onProgress = () => {}, signal }) {
  const W = Math.max(1, Math.round(width * scale)); const H = Math.max(1, Math.round(height * scale));
  const full = makeCanvas(width, height); const fctx = full.getContext('2d', { willReadFrequently: false });
  const small = makeCanvas(W, H); const sctx = small.getContext('2d', { willReadFrequently: true });
  const gif = GIFEncoder();
  const frames = Math.max(1, Math.round(duration * fps));
  const delay = Math.round(1000 / fps);
  const format = transparent ? 'rgba4444' : 'rgb565';
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    fctx.clearRect(0, 0, width, height);
    fctx.save(); await draw(fctx, start + i / fps, i); fctx.restore();
    sctx.clearRect(0, 0, W, H);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(full, 0, 0, W, H);
    const { data } = sctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256, { format, oneBitAlpha: transparent });
    const index = applyPalette(data, palette, format);
    const ti = transparent ? palette.findIndex((p) => p[3] === 0) : -1;
    gif.writeFrame(index, W, H, { palette, delay, repeat: loop ? 0 : -1, ...(ti >= 0 ? { transparent: true, transparentIndex: ti } : {}) });
    onProgress((i + 1) / frames, `Frame ${i + 1} of ${frames}…`);
    if (i % 2 === 0) await tick();
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

/** One PNG at time t. */
export async function exportPng({ width, height, t = 0, draw, scale = 1 }) {
  const c = makeCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  await draw(ctx, t, 0);
  return toBlob(c);
}

/** PNG sequence in a ZIP: name_00001.png … */
export async function exportPngSequence({ width, height, fps, start = 0, duration, draw, name = 'frame', scale = 1, onProgress = () => {}, signal }) {
  const W = Math.round(width * scale); const H = Math.round(height * scale);
  const c = makeCanvas(W, H); const ctx = c.getContext('2d');
  const files = {};
  const frames = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.scale(scale, scale); await draw(ctx, start + i / fps, i); ctx.restore();
    files[`${name}_${String(i + 1).padStart(5, '0')}.png`] = [new Uint8Array(await (await toBlob(c)).arrayBuffer()), { level: 0 }];
    onProgress((i + 1) / frames, `Frame ${i + 1} of ${frames}…`);
  }
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

/**
 * Sprite sheet: every frame in a grid on one PNG, plus a JSON atlas (TexturePacker "hash" style), zipped together.
 * cols: 0 = as square as possible.
 */
export async function exportSpriteSheet({ width, height, fps, start = 0, duration, draw, name = 'sheet', scale = 1, cols = 0, padding = 0, onProgress = () => {} }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const fw = Math.round(width * scale); const fh = Math.round(height * scale);
  const C = cols > 0 ? cols : Math.ceil(Math.sqrt(frames));
  const R = Math.ceil(frames / C);
  const SW = C * (fw + padding) - padding; const SH = R * (fh + padding) - padding;
  if (SW * SH > 16384 * 16384 || SW > 16384 || SH > 16384) throw new Error('The sprite sheet would be too big — lower the scale or the frame count.');
  const sheet = makeCanvas(SW, SH); const sctx = sheet.getContext('2d');
  const one = makeCanvas(fw, fh); const octx = one.getContext('2d');
  const atlas = { frames: {}, meta: { app: 'SoraLab Sora ANI', image: `${name}.png`, format: 'RGBA8888', size: { w: SW, h: SH }, scale: String(scale), frameRate: fps } };
  for (let i = 0; i < frames; i++) {
    octx.clearRect(0, 0, fw, fh);
    octx.save(); octx.scale(scale, scale); await draw(octx, start + i / fps, i); octx.restore();
    const x = (i % C) * (fw + padding); const y = Math.floor(i / C) * (fh + padding);
    sctx.drawImage(one, x, y);
    atlas.frames[`${name}_${String(i).padStart(4, '0')}`] = { frame: { x, y, w: fw, h: fh }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, duration: Math.round(1000 / fps) };
    onProgress((i + 1) / frames, `Frame ${i + 1} of ${frames}…`);
    if (i % 4 === 0) await tick();
  }
  const png = new Uint8Array(await (await toBlob(sheet)).arrayBuffer());
  return new Blob([zipSync({ [`${name}.png`]: [png, { level: 0 }], [`${name}.json`]: strToU8(JSON.stringify(atlas, null, 2)) })], { type: 'application/zip' });
}
