// Renders with ffmpeg: Cut timelines (tracks of clips with transforms, effects, fades and audio mixing) and
// conversions (Encoder). Uses the fastest working H.264/HEVC encoder (NVENC, Quick Sync, AMF/VAAPI, VideoToolbox, CPU).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { run, progressTime } from './proc.js';
import { videoProfile, encoderArgs, inputArgs, CPU } from './hwaccel.js';

// ---------------------------------------------------------------- output formats

export const PRESETS = [
  { id: 'h264-1080p', label: 'H.264 1080p (MP4)', group: 'Video', output: { container: 'mp4', vcodec: 'h264', quality: 'high' }, width: 1920, height: 1080 },
  { id: 'h264-4k', label: 'H.264 4K (MP4)', group: 'Video', output: { container: 'mp4', vcodec: 'h264', quality: 'high' }, width: 3840, height: 2160 },
  { id: 'h264-720p', label: 'H.264 720p (MP4)', group: 'Video', output: { container: 'mp4', vcodec: 'h264', quality: 'medium' }, width: 1280, height: 720 },
  { id: 'hevc-4k', label: 'HEVC / H.265 4K (MP4)', group: 'Video', output: { container: 'mp4', vcodec: 'hevc', quality: 'high' }, width: 3840, height: 2160 },
  { id: 'tsunami', label: 'Tsunami (best quality upload)', group: 'Web', output: { container: 'mp4', vcodec: 'h264', quality: 'high' } },
  { id: 'vertical', label: 'Vertical 1080×1920 (Shorts, Reels, TikTok)', group: 'Web', output: { container: 'mp4', vcodec: 'h264', quality: 'high' }, width: 1080, height: 1920 },
  { id: 'square', label: 'Square 1080×1080', group: 'Web', output: { container: 'mp4', vcodec: 'h264', quality: 'high' }, width: 1080, height: 1080 },
  { id: 'webm', label: 'WebM VP9', group: 'Web', output: { container: 'webm', vcodec: 'vp9', quality: 'high' } },
  { id: 'av1', label: 'AV1 (MP4)', group: 'Web', output: { container: 'mp4', vcodec: 'av1', quality: 'high' } },
  { id: 'prores', label: 'ProRes 422 HQ (MOV) — for editing elsewhere', group: 'Master', output: { container: 'mov', vcodec: 'prores', audio_codec: 'pcm' } },
  { id: 'gif', label: 'Animated GIF', group: 'Image', output: { container: 'gif', vcodec: 'gif' }, width: 640 },
  { id: 'png-still', label: 'PNG still (first frame)', group: 'Image', output: { container: 'png', vcodec: 'png' } },
  { id: 'mp3', label: 'MP3 320 kbps', group: 'Audio', output: { container: 'mp3', audio_codec: 'mp3', audio_bitrate: 320 } },
  { id: 'm4a', label: 'AAC 256 kbps (M4A)', group: 'Audio', output: { container: 'm4a', audio_codec: 'aac', audio_bitrate: 256 } },
  { id: 'wav', label: 'WAV (uncompressed)', group: 'Audio', output: { container: 'wav', audio_codec: 'pcm' } },
  { id: 'flac', label: 'FLAC (lossless)', group: 'Audio', output: { container: 'flac', audio_codec: 'flac' } },
  { id: 'opus', label: 'Opus 160 kbps (OGG)', group: 'Audio', output: { container: 'ogg', audio_codec: 'opus', audio_bitrate: 160 } },
];

const AUDIO_ONLY = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac', 'opus'];
const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', gif: 'image/gif', png: 'image/png',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg' };
export const outputMime = (o) => MIME[o.container] || 'application/octet-stream';
export const isAudioOnly = (o) => AUDIO_ONLY.includes(o.container);

let encoderList = null;
async function encoders() {
  if (!encoderList) { try { encoderList = await run(config.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 15000 }); } catch { encoderList = ''; } }
  return encoderList;
}
export async function renderInfo() {
  const list = await encoders();
  const p = await videoProfile().catch(() => CPU);
  return {
    encoder: { id: p.id, label: p.label, gpu: !!p.gpu },
    codecs: {
      h264: true, hevc: /\b(libx265|hevc_\w+)\b/.test(list), vp9: /libvpx-vp9/.test(list), av1: /\b(libsvtav1|libaom-av1|av1_\w+)\b/.test(list), prores: /prores_ks/.test(list),
      mp3: /libmp3lame/.test(list), opus: /libopus/.test(list),
    },
    presets: PRESETS,
  };
}

const QUALITY = { high: { crf: 18, gpuBitrate: (w, h) => Math.round((w * h) / (1920 * 1080) * 12000) }, medium: { crf: 23, gpuBitrate: (w, h) => Math.round((w * h) / (1920 * 1080) * 6000) }, low: { crf: 28, gpuBitrate: (w, h) => Math.round((w * h) / (1920 * 1080) * 3000) } };

/** Video encoder args for an output, given the hardware profile. Returns { args, tail } (tail: filters to end the graph with, e.g. VAAPI upload). */
async function videoEncode(o, prof, w, h, fps) {
  const q = QUALITY[o.quality] || QUALITY.high;
  const list = await encoders();
  const bitrate = o.video_bitrate ? `${Math.round(o.video_bitrate)}k` : null;
  const gop = ['-g', String(Math.max(1, Math.round(fps * 2)))];
  switch (o.vcodec || 'h264') {
    case 'h264':
      if (prof.gpu) return { args: [...encoderArgs(prof), '-b:v', bitrate || `${Math.max(1500, q.gpuBitrate(w, h))}k`, '-maxrate', `${Math.round((o.video_bitrate || q.gpuBitrate(w, h)) * 1.5)}k`, ...gop], tail: prof.tail || '' };
      return { args: ['-c:v', 'libx264', '-preset', o.preset || 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...(bitrate ? ['-b:v', bitrate] : ['-crf', String(o.crf ?? q.crf)]), ...gop], tail: '' };
    case 'hevc': {
      const hw = { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', vaapi: 'hevc_vaapi', videotoolbox: 'hevc_videotoolbox' }[prof.id];
      if (prof.gpu && hw && list.includes(hw)) {
        return { args: ['-c:v', hw, ...(prof.pixFmt ? ['-pix_fmt', prof.pixFmt] : []), '-b:v', bitrate || `${Math.max(1000, Math.round(q.gpuBitrate(w, h) * 0.7))}k`, '-tag:v', 'hvc1', ...gop], tail: prof.tail || '' };
      }
      return { args: ['-c:v', 'libx265', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...(bitrate ? ['-b:v', bitrate] : ['-crf', String((o.crf ?? q.crf) + 4)]), '-tag:v', 'hvc1', ...gop], tail: '' };
    }
    case 'vp9': return { args: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', ...(bitrate ? ['-b:v', bitrate] : ['-crf', String((o.crf ?? q.crf) + 13), '-b:v', '0']), ...gop], tail: '' };
    case 'av1': {
      if (list.includes('libsvtav1')) return { args: ['-c:v', 'libsvtav1', '-preset', '8', '-pix_fmt', 'yuv420p', '-crf', String((o.crf ?? q.crf) + 12), ...gop], tail: '' };
      return { args: ['-c:v', 'libaom-av1', '-cpu-used', '6', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-crf', String((o.crf ?? q.crf) + 12), '-b:v', '0', ...gop], tail: '' };
    }
    case 'prores': return { args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'], tail: '' };
    default: throw new Error(`Unknown video codec ${o.vcodec}`);
  }
}

function audioEncode(o) {
  const ac = o.audio_codec || (o.container === 'webm' || o.container === 'ogg' ? 'opus' : o.container === 'mov' && o.vcodec === 'prores' ? 'pcm' : 'aac');
  const br = `${Math.round(o.audio_bitrate || (ac === 'opus' ? 160 : 256))}k`;
  switch (ac) {
    case 'aac': return ['-c:a', 'aac', '-b:a', br];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br];
    case 'opus': return ['-c:a', 'libopus', '-b:a', br];
    case 'flac': return ['-c:a', 'flac'];
    case 'pcm': return ['-c:a', o.container === 'wav' ? 'pcm_s16le' : 'pcm_s24le'];
    default: return ['-c:a', 'aac', '-b:a', br];
  }
}

function muxArgs(o) {
  if (o.container === 'mp4' || o.container === 'mov' || o.container === 'm4a') return ['-movflags', '+faststart'];
  return [];
}

// ---------------------------------------------------------------- timeline → filter graph

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = (c, d = '000000') => (/^#?[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).replace('#', '') : d);
const assetPath = (id) => {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(String(id));
  if (!a) return null;
  const web = path.join(config.dataDir, 'assets', a.id, 'web');
  // Use the original for quality; fall back to the converted copy when ffmpeg can't read the original (rare).
  return { a, file: path.join(config.dataDir, 'assets', a.id, 'file'), web: fs.existsSync(web) ? web : null };
};

/** atempo only takes 0.5–2 (older ffmpeg) per stage: chain stages for other speeds. */
function atempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

function effectFilters(effects = []) {
  const f = [];
  const eq = {};
  for (const e of effects) {
    if (!e || e.enabled === false) continue;
    const v = num(e.value);
    switch (e.type) {
      case 'brightness': eq.brightness = clamp(v, -1, 1); break;         // -1..1
      case 'contrast': eq.contrast = clamp(v, 0, 4); break;              // 1 = unchanged
      case 'saturation': eq.saturation = clamp(v, 0, 3); break;          // 1 = unchanged
      case 'gamma': eq.gamma = clamp(v, 0.1, 10); break;
      case 'exposure': f.push(`exposure=exposure=${clamp(v, -3, 3)}`); break;
      case 'temperature': f.push(`colortemperature=temperature=${clamp(v, 1000, 40000)}`); break;
      case 'hue': f.push(`hue=h=${clamp(v, -180, 180)}`); break;
      case 'blur': if (v > 0) f.push(`gblur=sigma=${clamp(v, 0, 100)}`); break;
      case 'sharpen': if (v > 0) f.push(`unsharp=5:5:${clamp(v, 0, 5)}:5:5:0`); break;
      case 'grayscale': f.push('hue=s=0'); break;
      case 'sepia': f.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'); break;
      case 'invert': f.push('negate'); break;
      case 'vignette': f.push(`vignette=angle=${clamp(v || 0.6, 0, 1.5)}`); break;
      case 'denoise': f.push(`hqdn3d=${clamp(v || 4, 0, 20)}`); break;
      case 'flip_h': f.push('hflip'); break;
      case 'flip_v': f.push('vflip'); break;
      case 'pixelate': if (v > 1) f.push(`scale=iw/${Math.round(v)}:ih/${Math.round(v)},scale=iw*${Math.round(v)}:ih*${Math.round(v)}:flags=neighbor`); break;
      case 'chroma_key': f.push(`format=yuva420p,chromakey=0x${hex(e.color, '00ff00')}:${clamp(num(e.similarity, 0.15), 0.01, 1)}:${clamp(num(e.blend, 0.05), 0, 1)}`); break;
      case 'lut': if (e.asset_id) { const p = assetPath(e.asset_id); if (p) f.push(`lut3d=file='${p.file.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`); } break;
      default: break;
    }
  }
  const eqs = Object.entries(eq).map(([k, v]) => `${k}=${v}`);
  if (eqs.length) f.unshift(`eq=${eqs.join(':')}`);
  return f;
}

// Keyframes: { prop: [{ t, v }] } with t in seconds from the clip's start on the timeline, linearly interpolated and held
// before the first / after the last key. kfExpr turns them into an ffmpeg expression of `T` (an expression for clip time).
const kfList = (c, prop) => (Array.isArray(c.keyframes?.[prop]) ? c.keyframes[prop] : [])
  .map((k) => ({ t: num(k.t), v: num(k.v) })).filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v)).sort((a, b) => a.t - b.t);
const hasKf = (c, prop) => kfList(c, prop).length > 1;
function kfExpr(keys, T, map = (v) => v) {
  const f = (x) => Number(x.toFixed(5));
  let e = String(f(map(keys[keys.length - 1].v)));
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]; const b = keys[i + 1];
    const va = f(map(a.v)); const vb = f(map(b.v)); const span = Math.max(1e-4, b.t - a.t);
    e = `if(lt(${T},${f(b.t)}),${va}+(${f(vb - va)})*(${T}-${f(a.t)})/${f(span)},${e})`;
  }
  return `if(lt(${T},${f(keys[0].t)}),${f(map(keys[0].v))},${e})`;
}

/**
 * Transitions: a clip's `transition_in: { type, duration }` joins it to the clip that ends where it starts on the same track.
 *   dissolve (video) / crossfade (audio): both clips are extended into each other's media (up to duration/2 each, as far as
 *     the source allows) and the incoming clip fades in (alpha, or volume for sound) over the overlap.
 *   dip_black / dip_white: the outgoing clip fades to the colour over the first half, the incoming fades from it over the second.
 * Returns the clips sorted by start with the extensions applied (extra fields: _xin, _dip_in, _dip_out, _xout for audio).
 */
function applyTransitions(clips, isAudio) {
  const list = clips.map((c) => ({ ...c, start: num(c.start), duration: Math.max(0, num(c.duration)), in: Math.max(0, num(c.in)) })).sort((a, b) => a.start - b.start);
  const srcLen = (c) => { if (!c.asset_id) return Infinity; const p = assetPath(c.asset_id); return p && p.a.kind !== 'image' ? num(p.a.duration, Infinity) : Infinity; };
  for (let i = 0; i < list.length; i++) {
    const c = list[i]; const tr = c.transition_in;
    if (!tr || !tr.type) continue;
    const prev = list.slice(0, i).reverse().find((p) => Math.abs(p.start + p.duration - c.start) < 0.02);
    const d = clamp(num(tr.duration, 1), 0.04, 10);
    if (!prev) { // nothing to join: a lone fade from black / transparent
      if (isAudio) c.fade_in = Math.max(num(c.fade_in), d); else if (tr.type.startsWith('dip')) c._dip_in = { d, color: tr.type === 'dip_white' ? 'white' : 'black' }; else c.fade_in = Math.max(num(c.fade_in), d);
      continue;
    }
    if (tr.type === 'dip_black' || tr.type === 'dip_white') {
      const color = tr.type === 'dip_white' ? 'white' : 'black';
      const h = Math.min(d / 2, prev.duration, c.duration);
      prev._dip_out = { d: h, color }; c._dip_in = { d: h, color };
      continue;
    }
    // dissolve / crossfade
    const sp = clamp(num(c.speed, 1), 0.05, 16); const psp = clamp(num(prev.speed, 1), 0.05, 16);
    const a = Math.max(0, Math.min(d / 2, c.in / sp));                                                     // incoming starts earlier
    const b = Math.max(0, Math.min(d / 2, (srcLen(prev) - (prev.in + prev.duration * psp)) / psp));         // outgoing runs longer
    if (a + b < 0.02) continue;
    c.start -= a; c.in -= a * sp; c.duration += a; c._shift = (c._shift || 0) + a;
    prev.duration += b;
    c._xin = a + b;
    if (isAudio) prev._xout = a + b;
  }
  // Keyframe times are relative to the clip start, which may have moved earlier.
  for (const c of list) {
    if (c._shift && c.keyframes) c.keyframes = Object.fromEntries(Object.entries(c.keyframes).map(([k, l]) => [k, (Array.isArray(l) ? l : []).map((x) => ({ ...x, t: num(x.t) + c._shift }))]));
  }
  return list;
}

/** Stereo balance: -1 (left) … 1 (right). */
const panFilter = (p) => {
  const v = clamp(num(p), -1, 1);
  if (Math.abs(v) < 0.005) return null;
  return `pan=stereo|c0=${Math.min(1, 1 - v).toFixed(3)}*c0|c1=${Math.min(1, 1 + v).toFixed(3)}*c1`;
};

/**
 * Builds ffmpeg arguments for a timeline. Spec:
 * { width, height, fps, duration, background, master_volume,
 *   video: [{ hidden, clips: [{ asset_id | color, start, in, duration, speed, volume, mute, opacity, fade_in, fade_out, audio_fade_in, audio_fade_out,
 *            transform: { x, y, scale, rotation, fit: contain|cover|stretch|none }, crop: { l, t, r, b }, effects: [...],
 *            keyframes: { x, y, scale, rotation, opacity: [{ t, v }] },              // t = seconds from the clip's start
 *            transition_in: { type: dissolve|dip_black|dip_white, duration } }] }],  // bottom track first
 *   audio: [{ mute, volume, pan, clips: [{ asset_id, start, in, duration, speed, volume, pan, fade_in, fade_out,
 *            keyframes: { volume: [{ t, v }] }, transition_in: { type: crossfade, duration } }] }],
 *   range: { start, end }, output: { container, vcodec, quality, crf, video_bitrate, audio_codec, audio_bitrate } }
 * Keyframed x/y become overlay expressions, scale a per-frame scale padded to its largest size, rotation a rotate
 * expression, opacity a geq alpha expression (slower — only used when opacity is keyframed), volume a volume expression.
 */
export async function timelineArgs(spec, out, prof) {
  const W = clamp(Math.round(num(spec.width, 1920) / 2) * 2, 16, 8192);
  const H = clamp(Math.round(num(spec.height, 1080) / 2) * 2, 16, 8192);
  const FPS = clamp(num(spec.fps, 30), 1, 240);
  const rStart = Math.max(0, num(spec.range?.start, 0));
  const total = num(spec.duration, 0);
  const rEnd = spec.range?.end ? Math.min(total || Infinity, num(spec.range.end)) : total;
  const D = Math.max(1 / FPS, rEnd - rStart);
  const o = spec.output || { container: 'mp4', vcodec: 'h264' };
  const audioOnly = isAudioOnly(o);
  const still = o.container === 'png';

  const inputs = [];
  const filters = [];
  const audioLabels = [];
  let base = 'base';
  if (!audioOnly) filters.push(`color=c=0x${hex(spec.background)}:s=${W}x${H}:r=${FPS}:d=${D.toFixed(3)},format=yuva420p[base]`);

  const addInput = (args) => { inputs.push(...args); return inputs.filter((x) => x === '-i').length - 1; };

  // Visible window of a clip after the export range is applied.
  const window = (c) => {
    const start = num(c.start); const dur = Math.max(0, num(c.duration)); const speed = clamp(num(c.speed, 1), 0.05, 16);
    const s = Math.max(start, rStart); const e = Math.min(start + dur, rStart + D);
    if (e <= s) return null;
    return { at: s - rStart, len: e - s, srcIn: Math.max(0, num(c.in)) + (s - start) * speed, speed, cut: s - start, dur };
  };

  let vi = 0;
  for (const track of spec.video || []) {
    if (track.hidden) continue;
    for (const c of applyTransitions(track.clips || [], false)) {
      const w = window(c);
      if (!w) continue;
      const p = c.asset_id ? assetPath(c.asset_id) : null;
      if (c.asset_id && !p) continue;
      const isImage = p?.a.kind === 'image';
      const isVideo = p?.a.kind === 'video';
      let idx = null;
      let src;
      if (!audioOnly) {
        if (isVideo) { idx = addInput(['-ss', w.srcIn.toFixed(3), '-t', (w.len * w.speed + 0.1).toFixed(3), '-i', p.file]); src = `[${idx}:v]`; }
        else if (isImage) { idx = addInput(['-loop', '1', '-framerate', String(FPS), '-t', (w.len + 0.1).toFixed(3), '-i', p.web && !/png|jpeg|webp|gif|bmp/.test(p.a.mime) ? p.web : p.file]); src = `[${idx}:v]`; }
        const chain = [];
        if (!src) { // solid colour
          chain.push(`color=c=0x${hex(c.color, 'ffffff')}:s=${W}x${H}:r=${FPS}:d=${(w.len + 0.1).toFixed(3)}`);
        } else {
          chain.push(isVideo ? `setpts=(PTS-STARTPTS)/${w.speed}` : 'setpts=PTS-STARTPTS', `fps=${FPS}`);
        }
        const cr = c.crop || {};
        if (num(cr.l) || num(cr.t) || num(cr.r) || num(cr.b)) {
          const l = clamp(num(cr.l), 0, 0.95); const t = clamp(num(cr.t), 0, 0.95); const r = clamp(num(cr.r), 0, 0.95 - l); const b = clamp(num(cr.b), 0, 0.95 - t);
          chain.push(`crop=iw*${(1 - l - r).toFixed(4)}:ih*${(1 - t - b).toFixed(4)}:iw*${l.toFixed(4)}:ih*${t.toFixed(4)}`);
        }
        chain.push(...effectFilters(c.effects));
        const tf = c.transform || {};
        const sc = clamp(num(tf.scale, 1), 0.01, 20);
        const fit = tf.fit || 'contain';
        const bw = Math.max(2, Math.round((W * sc) / 2) * 2); const bh = Math.max(2, Math.round((H * sc) / 2) * 2);
        // Clip time (seconds from the clip's start) inside this chain, where t starts at 0 at the visible window.
        const CT = `(t+${w.cut.toFixed(4)})`;
        if (hasKf(c, 'scale')) {
          // Per-frame size, padded to the largest size so the overlay always gets frames of one size.
          const sw0 = (src ? num(p.a.width, W) : W) * (1 - clamp(num(cr.l), 0, 0.95) - clamp(num(cr.r), 0, 0.95));
          const sh0 = (src ? num(p.a.height, H) : H) * (1 - clamp(num(cr.t), 0, 0.95) - clamp(num(cr.b), 0, 0.95));
          const k = fit === 'stretch' ? null : fit === 'cover' ? Math.max(W / sw0, H / sh0) : Math.min(W / sw0, H / sh0);
          const bw0 = k ? sw0 * k : W; const bh0 = k ? sh0 * k : H;
          const keys = kfList(c, 'scale').map((x) => ({ ...x, v: clamp(x.v, 0.01, 20) }));
          const maxS = Math.max(...keys.map((x) => x.v));
          const S = kfExpr(keys, CT);
          chain.push(`scale=w='max(2,trunc(${bw0.toFixed(2)}*(${S})/2)*2)':h='max(2,trunc(${bh0.toFixed(2)}*(${S})/2)*2)':eval=frame`, 'format=yuva420p',
            `pad=w=${Math.ceil((bw0 * maxS) / 2) * 2 + 2}:h=${Math.ceil((bh0 * maxS) / 2) * 2 + 2}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
        } else {
          if (fit === 'cover') chain.push(`scale=${bw}:${bh}:force_original_aspect_ratio=increase`, `crop=${bw}:${bh}`);
          else if (fit === 'stretch') chain.push(`scale=${bw}:${bh}`);
          else if (fit === 'none') chain.push(`scale=trunc(iw*${sc}/2)*2:trunc(ih*${sc}/2)*2`);
          else chain.push(`scale=${bw}:${bh}:force_original_aspect_ratio=decrease`);
          chain.push('format=yuva420p');
        }
        const rot = num(tf.rotation);
        if (hasKf(c, 'rotation')) chain.push(`rotate=a='(${kfExpr(kfList(c, 'rotation'), CT)})*PI/180':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)'`);
        else if (rot % 360) chain.push(`rotate=${(rot * Math.PI / 180).toFixed(5)}:c=none:ow=rotw(${(rot * Math.PI / 180).toFixed(5)}):oh=roth(${(rot * Math.PI / 180).toFixed(5)})`);
        if (hasKf(c, 'opacity')) {
          chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${kfExpr(kfList(c, 'opacity'), `(T+${w.cut.toFixed(4)})`)},0,1)'`);
        } else {
          const op = clamp(num(c.opacity, 1), 0, 1);
          if (op < 1) chain.push(`colorchannelmixer=aa=${op.toFixed(3)}`);
        }
        // Fades (relative to the clip, so a range starting mid-clip still fades correctly). A dissolve fades the incoming clip in.
        const fi = Math.max(num(c.fade_in), num(c._xin)); const fo = num(c.fade_out);
        if (fi > 0 && w.cut < fi) chain.push(`fade=t=in:st=${(-w.cut).toFixed(3)}:d=${fi.toFixed(3)}:alpha=1`);
        if (fo > 0) chain.push(`fade=t=out:st=${(w.dur - fo - w.cut).toFixed(3)}:d=${fo.toFixed(3)}:alpha=1`);
        // Dips fade the picture itself to a colour (not to transparent).
        if (c._dip_in && w.cut < c._dip_in.d) chain.push(`fade=t=in:st=${(-w.cut).toFixed(3)}:d=${c._dip_in.d.toFixed(3)}:color=${c._dip_in.color}`);
        if (c._dip_out) chain.push(`fade=t=out:st=${(w.dur - c._dip_out.d - w.cut).toFixed(3)}:d=${c._dip_out.d.toFixed(3)}:color=${c._dip_out.color}`);
        chain.push(`setpts=PTS+${w.at.toFixed(3)}/TB`);
        const lbl = `v${vi}`;
        filters.push(`${src || ''}${chain.join(',')}[${lbl}]`);
        const x = num(tf.x); const y = num(tf.y);
        // In the overlay, t is output time: clip time = t - at + cut.
        const OT = `(t-${w.at.toFixed(4)}+${w.cut.toFixed(4)})`;
        const ox = hasKf(c, 'x') ? `'(W-w)/2+(${kfExpr(kfList(c, 'x'), OT)})'` : `(W-w)/2+${x.toFixed(1)}`;
        const oy = hasKf(c, 'y') ? `'(H-h)/2+(${kfExpr(kfList(c, 'y'), OT)})'` : `(H-h)/2+${y.toFixed(1)}`;
        filters.push(`[${base}][${lbl}]overlay=x=${ox}:y=${oy}:eof_action=pass:enable='between(t,${w.at.toFixed(3)},${(w.at + w.len).toFixed(3)})'[o${vi}]`);
        base = `o${vi}`;
        vi++;
      }
      // The clip's own sound.
      if (!still && o.container !== 'gif' && isVideo && p.a.has_audio && !c.mute && !track.mute && num(c.volume, 1) > 0) {
        const aidx = idx !== null && !audioOnly ? idx : addInput(['-ss', w.srcIn.toFixed(3), '-t', (w.len * w.speed + 0.1).toFixed(3), '-i', p.file]);
        audioLabels.push(audioChain(`[${aidx}:a]`, c, w, track, filters, audioLabels.length, 'audio_fade_'));
      }
    }
  }
  for (const track of still || o.container === 'gif' ? [] : spec.audio || []) {
    if (track.mute) continue;
    for (const c of applyTransitions(track.clips || [], true)) {
      const w = window(c);
      if (!w || !c.asset_id || c.mute) continue;
      const p = assetPath(c.asset_id);
      if (!p || !['audio', 'video'].includes(p.a.kind) || p.a.has_audio === 0) continue;
      const idx = addInput(['-ss', w.srcIn.toFixed(3), '-t', (w.len * w.speed + 0.1).toFixed(3), '-i', p.file]);
      audioLabels.push(audioChain(`[${idx}:a]`, c, w, track, filters, audioLabels.length, 'fade_'));
    }
  }

  const mv = clamp(num(spec.master_volume, 1), 0, 4);
  // Silence fills the gaps, so the sound always runs the full length of the export. (Stills and GIFs have no sound.)
  if (still || o.container === 'gif') { /* no audio graph */ } else if (audioLabels.length) filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,volume=${mv},apad,atrim=0:${D.toFixed(3)},aresample=48000[aout]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)}[aout]`);

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats', ...inputArgs(prof, { hwDecode: false }), ...inputs];
  if (audioOnly) {
    args.push('-filter_complex', filters.join(';'), '-map', '[aout]', ...audioEncode(o), out);
    return { args, duration: D };
  }
  if (still) {
    filters.push(`[${base}]trim=end_frame=1,format=rgba[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-frames:v', '1', out);
    return { args, duration: D };
  }
  if (o.container === 'gif') {
    const gw = num(o.width, Math.min(W, 640));
    filters.push(`[${base}]fps=${Math.min(FPS, 20)},scale=${gw}:-1:flags=lanczos,split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=bayer:bayer_scale=4[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-t', D.toFixed(3), out);
    return { args, duration: D };
  }
  const enc = await videoEncode(o, prof, W, H, FPS);
  filters.push(`[${base}]format=yuv420p${enc.tail}[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-r', String(FPS), ...enc.args, ...audioEncode(o), ...muxArgs(o), '-t', D.toFixed(3), out);
  return { args, duration: D };
}

function audioChain(src, c, w, track, filters, n, fadeKey) {
  const trackVol = clamp(num(track.volume, 1), 0, 8);
  const chain = ['asetpts=PTS-STARTPTS', ...atempo(w.speed)];
  // Volume keyframes multiply with the track volume; t here is time from the visible window's start.
  if (hasKf(c, 'volume')) chain.push(`volume='${trackVol.toFixed(3)}*max(0,${kfExpr(kfList(c, 'volume'), `(t+${w.cut.toFixed(4)})`)})':eval=frame`);
  else chain.push(`volume=${(clamp(num(c.volume, 1), 0, 8) * trackVol).toFixed(3)}`);
  const fi = num(c[`${fadeKey}in`] ?? c.fade_in); const fo = num(c[`${fadeKey}out`] ?? c.fade_out);
  if (fi > 0 && w.cut < fi) chain.push(`afade=t=in:st=${Math.max(0, -w.cut).toFixed(3)}:d=${(fi - w.cut).toFixed(3)}`);
  if (fo > 0) chain.push(`afade=t=out:st=${Math.max(0, w.dur - fo - w.cut).toFixed(3)}:d=${fo.toFixed(3)}`);
  // Crossfades: equal-power curves over the overlap.
  if (c._xin && w.cut < c._xin) chain.push(`afade=t=in:st=${Math.max(0, -w.cut).toFixed(3)}:d=${(c._xin - w.cut).toFixed(3)}:curve=qsin`);
  if (c._xout) chain.push(`afade=t=out:st=${Math.max(0, w.dur - c._xout - w.cut).toFixed(3)}:d=${c._xout.toFixed(3)}:curve=qsin`);
  chain.push(`atrim=0:${w.len.toFixed(3)}`, 'aresample=48000', 'aformat=channel_layouts=stereo');
  for (const p of [panFilter(c.pan), panFilter(track.pan)]) if (p) chain.push(p);
  chain.push(`adelay=${Math.round(w.at * 1000)}:all=1`);
  filters.push(`${src}${chain.join(',')}[a${n}]`);
  return `a${n}`;
}

/**
 * Conversion of one file (Encoder): { asset_id, output, width?, height?, fps?, trim: { start, end }, fit }.
 * Built as a one-clip timeline so it gets the same scaling, trimming and encoders.
 */
export function transcodeToTimeline(spec, a) {
  const o = spec.output || {};
  const start = Math.max(0, num(spec.trim?.start));
  const end = spec.trim?.end ? Math.min(num(spec.trim.end), a.duration || Infinity) : a.duration || 0;
  let W = num(spec.width) || a.width || 1920; let H = num(spec.height) || a.height || 1080;
  if (num(spec.width) && !num(spec.height) && a.width) H = Math.round((W * a.height) / a.width / 2) * 2;
  if (!num(spec.width) && num(spec.height) && a.height) W = Math.round((H * a.width) / a.height / 2) * 2;
  const dur = a.kind === 'image' ? Math.max(0.04, num(spec.duration, 5)) : Math.max(0.04, end - start);
  const clip = { asset_id: a.id, start: 0, in: start, duration: dur, transform: { fit: spec.fit || 'contain' }, effects: spec.effects || [] };
  return {
    width: W, height: H, fps: num(spec.fps) || a.fps || 30, duration: dur, background: spec.background || '#000000', output: o,
    video: a.kind === 'audio' ? [] : [{ clips: [clip] }],
    audio: a.kind === 'audio' ? [{ clips: [clip] }] : [],
  };
}

/** Runs a render; onProgress(0..1). Retries on the CPU if the GPU encoder fails partway. */
export async function render(spec, out, { onProgress, signal, onEncoder } = {}) {
  const prof = await videoProfile().catch(() => CPU);
  const attempt = async (p) => {
    const { args, duration } = await timelineArgs(spec, out, p);
    onEncoder?.(p.gpu && !isAudioOnly(spec.output || {}) && (spec.output?.vcodec || 'h264').match(/h264|hevc/) ? p.label : 'CPU');
    await run(config.ffmpeg, args, {
      signal, timeout: 24 * 3600e3,
      onStderr: (line) => { const t = progressTime(line); if (t !== null && duration) onProgress?.(clamp(t / duration, 0, 0.999)); },
    });
  };
  try { await attempt(prof); }
  catch (e) {
    if (signal?.aborted || !prof.gpu) throw e;
    console.warn(`[render] ${prof.label} failed (${e.message.slice(0, 200)}); trying again on the CPU`);
    await attempt(CPU);
  }
  onProgress?.(1);
}
