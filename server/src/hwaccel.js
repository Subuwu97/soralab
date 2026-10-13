// GPU video encoding: finds the fastest encoder that actually works on this machine and builds its ffmpeg arguments.
// Tried in order: NVIDIA NVENC, Intel Quick Sync, AMD (AMF on Windows, VAAPI on Linux; VAAPI also covers Intel),
// Apple VideoToolbox, then the CPU (libx264). Each candidate gets a real test encode — an ffmpeg build can list an
// encoder that has no hardware or driver behind it — first with GPU decoding, then with CPU decoding.
// VIDEO_ENCODER=auto (default) | nvenc | qsv | amf | vaapi | videotoolbox | cpu (or an ffmpeg encoder name like h264_nvenc).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { run } from './proc.js';

const renderNodes = () => { try { return fs.readdirSync('/dev/dri').filter((f) => f.startsWith('renderD')).sort().map((f) => `/dev/dri/${f}`); } catch { return []; } };

/** Every way this platform could encode H.264. Fields: id, label, encoder, gpu, init (before -i), decode (before -i), tail (end of each scale filter), args, pixFmt. */
function candidates() {
  const list = [
    { id: 'nvenc', label: 'NVIDIA NVENC', encoder: 'h264_nvenc', gpu: true, decode: ['-hwaccel', 'cuda'],
      args: ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-profile:v', 'high', '-bf', '2', '-spatial-aq', '1'], pixFmt: 'yuv420p' },
    { id: 'qsv', label: 'Intel Quick Sync', encoder: 'h264_qsv', gpu: true, init: ['-init_hw_device', 'qsv=hw'], decode: ['-hwaccel', 'qsv'],
      args: ['-preset', 'faster', '-profile:v', 'high'], pixFmt: 'nv12' },
  ];
  if (process.platform === 'win32') {
    list.push({ id: 'amf', label: 'AMD AMF', encoder: 'h264_amf', gpu: true, decode: ['-hwaccel', 'd3d11va'],
      args: ['-quality', 'balanced', '-rc', 'vbr_peak', '-profile:v', 'high'], pixFmt: 'yuv420p' });
  }
  if (process.platform === 'linux') {
    for (const dev of renderNodes()) {
      list.push({ id: 'vaapi', label: `VAAPI (AMD / Intel) on ${path.basename(dev)}`, encoder: 'h264_vaapi', gpu: true, device: dev,
        init: ['-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va'], decode: ['-hwaccel', 'vaapi', '-hwaccel_device', 'va'],
        tail: ',format=nv12,hwupload', args: ['-rc_mode', 'VBR', '-profile:v', 'high'], pixFmt: null });
    }
  }
  if (process.platform === 'darwin') {
    list.push({ id: 'videotoolbox', label: 'Apple VideoToolbox', encoder: 'h264_videotoolbox', gpu: true, decode: ['-hwaccel', 'videotoolbox'],
      args: ['-profile:v', 'high', '-allow_sw', '0'], pixFmt: 'yuv420p' });
  }
  return list;
}

export const CPU = { id: 'cpu', label: 'CPU (libx264)', encoder: 'libx264', gpu: false, args: ['-preset', 'veryfast', '-profile:v', 'high'], pixFmt: 'yuv420p' };

/** ffmpeg input-side arguments (hardware device + decoding) for a profile. */
export const inputArgs = (p, { hwDecode = p.hwDecode } = {}) => [...(p.init || []), ...(hwDecode ? p.decode || [] : [])];
/** Encoder arguments shared by every rendition. */
export const encoderArgs = (p) => ['-c:v', p.encoder, ...(p.pixFmt ? ['-pix_fmt', p.pixFmt] : []), ...p.args];

let tested = null;
let testClip = null;

async function makeTestClip() {
  if (testClip && fs.existsSync(testClip)) return testClip;
  const file = path.join(os.tmpdir(), `soralab-hwtest-${process.pid}.mp4`);
  // Encoded with whatever CPU encoder exists, so GPU decoding of a real H.264 file gets tested too.
  for (const enc of [['-c:v', 'libx264', '-preset', 'ultrafast'], ['-c:v', 'mpeg4']]) {
    try {
      await run(config.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '2', ...enc, '-pix_fmt', 'yuv420p', file], { timeout: 30000 });
      testClip = file;
      return file;
    } catch { /* try the next one */ }
  }
  return null;
}

/** A short encode shaped like a real job: split into two sizes, scale, encode both. */
async function works(p, hwDecode) {
  const clip = await makeTestClip();
  const src = clip ? ['-i', clip] : ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'];
  const tail = p.tail || '';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs(p, { hwDecode: hwDecode && !!clip }), ...src, '-t', '1',
    '-filter_complex', `[0:v]split=2[a][b];[a]scale=-2:720${tail}[v0];[b]scale=-2:360${tail}[v1]`,
    '-map', '[v0]', '-map', '[v1]', ...encoderArgs(p), '-b:v', '2000k', '-f', 'null', '-'];
  try { await run(config.ffmpeg, args, { timeout: 30000 }); return true; } catch { return false; }
}

async function listedEncoders() {
  try { return await run(config.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 15000 }); } catch { return ''; }
}

/** The encoder to use, tested once and cached. */
export async function videoProfile() {
  if (tested) return tested;
  tested = (async () => {
    const want = String(config.videoEncoder || 'auto').toLowerCase();
    if (['cpu', 'libx264', 'software', 'none', 'off'].includes(want)) return log({ ...CPU });
    const listed = await listedEncoders();
    let pool = candidates().filter((c) => listed.includes(c.encoder));
    if (want !== 'auto') pool = pool.filter((c) => c.id === want || c.encoder === want || (want.includes('amd') && ['amf', 'vaapi'].includes(c.id)) || (want.includes('intel') && ['qsv', 'vaapi'].includes(c.id)));
    for (const c of pool) {
      if (await works(c, true)) return log({ ...c, hwDecode: true });
      if (await works(c, false)) return log({ ...c, hwDecode: false });
    }
    if (want !== 'auto') console.warn(`[render] VIDEO_ENCODER=${config.videoEncoder} isn't usable on this machine (driver or hardware missing); using the CPU.`);
    return log({ ...CPU });
  })();
  return tested;
}

function log(p) {
  console.log(`[render] video encoder: ${p.label}${p.gpu ? ` (GPU${p.hwDecode ? ', with GPU decoding' : ''})` : ''}`);
  if (testClip) fs.rm(testClip, { force: true }, () => {});
  return p;
}

/** For the admin panel: what's being used (null until the first test finishes). */
let current = null;
export const encoderInfo = () => current;
export function warmUp() { videoProfile().then((p) => { current = { id: p.id, label: p.label, gpu: p.gpu, hw_decode: !!p.hwDecode }; }).catch(() => {}); }
