// ffmpeg / ffprobe helpers.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';

/** Runs a command; resolves with stdout. onStderr gets ffmpeg's progress lines; signal cancels it. */
export function run(cmd, args, { onStdout, onStderr, timeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = timeout ? setTimeout(() => { err += '\ntimed out'; p.kill('SIGKILL'); }, timeout) : null;
    const abort = () => { err += '\ncancelled'; p.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', (d) => { out += d; onStdout?.(String(d)); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-8000); onStderr?.(String(d)); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Like run(), but collects stdout as a Buffer (images, audio peaks). */
export function runBuffer(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error(err.trim().split('\n').pop() || `exit ${code}`)); });
  });
}

/** Size, length, frame rate and audio of any media file ffprobe understands (null if it isn't media). */
export async function probe(file) {
  try {
    const info = JSON.parse(await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeout: 30000 }));
    const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const a = info.streams.find((s) => s.codec_type === 'audio');
    let width = v?.width || null;
    let height = v?.height || null;
    const rot = Math.abs(Number(v?.tags?.rotate || v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || 0)) % 360;
    if (rot === 90 || rot === 270) [width, height] = [height, width];
    const [n, d] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
    const fps = d ? Math.round((n / d) * 1000) / 1000 : null;
    const duration = Number(info.format?.duration || v?.duration || a?.duration || 0) || null;
    return { width, height, duration, fps: fps && fps < 1000 ? fps : null, hasAudio: !!a, hasVideo: !!v, vcodec: v?.codec_name || null, acodec: a?.codec_name || null, format: info.format?.format_name };
  } catch { return null; }
}

/** Parses "time=00:01:02.50" from ffmpeg's stderr into seconds. */
export function progressTime(line) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
