// Sora Ningyō "Go live on Tsunami": stream the avatar straight from the browser, without OBS.
//
//   Browser   composites the stage onto a background, records it with MediaRecorder (WebM: VP8/VP9 + Opus, or H.264)
//             and sends the chunks over a WebSocket at /api/avatar/golive?doc=<project>.
//   Here      ffmpeg reads the WebM from stdin and pushes H.264/AAC FLV to Tsunami's RTMP ingest (re-encoded with the
//             GPU encoder from hwaccel.js, else libx264; H.264 from the browser is copied). One stream per person.
//   Tsunami   POST /internal/live/start hands out a one-time stream key for this stream (its title, visibility, chat);
//             the RTMP push then goes through Tsunami's own ingest checks, HLS packaging, chat and recording.
//
// Messages, browser → server: {t:'start', channel_id, title, description, visibility, members_only, chat, quality, mime},
// binary media chunks (only after 'ready'), {t:'stop'}, {t:'client', fps} (frames the page drew).
// Server → browser: {t:'state', state:'connecting'|'ready'|'live', …}, {t:'stats', …} every 2 s, {t:'ended', reason, error}.
// Written against RFC 6455 directly (like the pose relay in avatar.js), with binary frames, fragments and size/rate limits.
import express from 'express';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import cookieParser from 'cookie-parser';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireUser, session } from '../auth.js';
import { h, fail, loadDoc, roleFor, clean } from './util.js';
import { suiteToken, tsunamiEnabled } from './suite.js';
import { videoProfile, encoderArgs, inputArgs } from '../hwaccel.js';

export const golive = express.Router();
export const GOLIVE_PATH = '/api/avatar/golive';

// Output presets. Keyframes every 2 s (Tsunami cuts 2 s HLS segments), constant 30 fps.
export const QUALITIES = {
  '720p': { width: 1280, height: 720, fps: 30, kbps: 3000 },
  '1080p': { width: 1920, height: 1080, fps: 30, kbps: 6000 },
};
const KEYFRAME_S = 2;

const MAX_MSG = 4 * 1024 * 1024;              // one MediaRecorder chunk (250 ms) is ~100–400 KB; keyframes can be bigger
const BYTE_RATE = 3 * 1024 * 1024; const BYTE_BURST = 12 * 1024 * 1024; // ~24 Mbit/s sustained is far above any preset
const MSG_RATE = 60; const MSG_BURST = 200;
const BACKLOG_WARN = 6 * 1024 * 1024; const BACKLOG_MAX = 32 * 1024 * 1024; // media waiting for ffmpeg
const streams = new Map();                    // user id → Stream (one stream per person)

// ---------------------------------------------------------------- Tsunami (server to server)

async function tsunami(u, p, body) {
  if (!tsunamiEnabled()) fail(503, 'tsunami_off', 'Tsunami isn’t connected. Re-run the suite’s setup.');
  let r;
  try {
    r = await fetch(`${config.tsunamiInternalUrl}/internal${p}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${await suiteToken(u, 'tsunami')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { fail(503, 'tsunami_down', 'Tsunami isn’t reachable right now.'); }
  const b = await r.json().catch(() => ({}));
  if (r.status === 404) fail(501, 'tsunami_old', 'This Tsunami server doesn’t support going live from SoraLab yet. Update the Mirai suite.');
  if (!r.ok) fail(r.status === 409 || r.status === 403 || r.status === 503 ? r.status : 502, b.error || 'tsunami', b.message || `Tsunami error ${r.status}`);
  return b;
}

/** Where to push RTMP: TSUNAMI_RTMP_URL, else Tsunami's internal host on its RTMP port. */
function rtmpBase(start) {
  if (config.tsunamiRtmpUrl) return config.tsunamiRtmpUrl;
  try { return `rtmp://${new URL(config.tsunamiInternalUrl).hostname}:${start.rtmp_port || 1935}/live`; } catch { return start.rtmp_url; }
}

const editableAvatar = (req) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  if (doc.app !== 'avatar') fail(400, 'bad_app', 'That isn’t an avatar project.');
  return doc;
};

/** GET /api/avatar/:id/golive — the person's Tsunami channels and whether they can go live (for the Perform panel). */
golive.get('/avatar/:id/golive', requireUser, h(async (req, res) => {
  editableAvatar(req);
  if (!tsunamiEnabled()) return res.json({ enabled: false });
  const mine = streams.get(req.user.id);
  let t;
  try { t = await tsunami(req.user, '/live'); } catch (e) { return res.json({ enabled: true, error: e.message, channels: [], streaming: mine?.info() || null }); }
  res.json({ enabled: true, live_enabled: t.enabled, channels: t.channels, current: t.current, qualities: QUALITIES,
    tsunami_url: config.tsunamiUrl || null, streaming: mine?.info() || null });
}));

// ---------------------------------------------------------------- WebSocket

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, data) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : null;
  return head ? Buffer.concat([head, data]) : null; // the server only sends small messages
}
// The ffmpeg errors people can do something about, in plain language.
function explain(stderr, code, signal) {
  if (/Connection refused|Cannot open connection|Name or service not known/i.test(stderr)) return 'Couldn’t connect to Tsunami’s live ingest. Check that live streaming is on in Tsunami (and TSUNAMI_RTMP_URL on the SoraLab server).';
  if (/Broken pipe|Connection reset|End of file|Error writing trailer|Input\/output error/i.test(stderr)) return 'Tsunami closed the connection. The stream may have been ended on Tsunami.';
  if (/Invalid data found|EBML header parsing failed|could not find codec parameters/i.test(stderr)) return 'The server couldn’t read the video from the browser. Try another browser.';
  if (signal) return 'The video encoder on the server stopped unexpectedly.';
  const last = stderr.trim().split('\n').pop();
  return `The video encoder on the server stopped (code ${code})${last ? `: ${last.slice(0, 160)}` : ''}.`;
}

class Stream {
  constructor(socket, user, doc) {
    this.socket = socket; this.user = user; this.doc = doc;
    this.buf = Buffer.alloc(0); this.parts = null; this.partOp = 0; this.partLen = 0;
    this.bytes = BYTE_BURST; this.msgs = MSG_BURST; this.last = Date.now(); this.seen = Date.now();
    this.state = 'waiting'; this.done = false; this.proc = null; this.channel = null; this.started = null;
    this.stats = { in: 0, inAt: Date.now(), size: 0, frame: 0, dup: 0, drop: 0, speed: 0, clientFps: 0, viewers: 0 };
    this.stderr = '';
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish('disconnected', 'The connection to the browser was lost.'));
    socket.on('error', () => this.finish('disconnected', 'The connection to the browser was lost.'));
  }
  info() { return { doc_id: this.doc.id, state: this.state, channel: this.channel, started_at: this.started, url: this.url || null }; }
  send(obj) { if (this.socket.writable && this.socket.writableLength < 256 * 1024) { const f = frame(0x1, Buffer.from(JSON.stringify(obj))); if (f) this.socket.write(f); } }
  closeSocket(code = 1000) {
    if (!this.socket.writable) return this.socket.destroy();
    const b = Buffer.alloc(2); b.writeUInt16BE(code); this.socket.write(frame(0x8, b)); this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
  protocolError(code, reason) { this.finish('protocol', reason, { error: true, wsCode: code }); }

  onData(d) {
    this.seen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_MSG + 16) return this.protocolError(1009, 'A message from the browser was too large.');
    while (this.buf.length >= 2 && !this.done) {
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const fin = !!(b0 & 0x80); const op = b0 & 0x0f; let len = b1 & 0x7f; let off = 2;
      if (!(b1 & 0x80)) return this.protocolError(1002, 'Bad message from the browser.'); // clients must mask
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return this.protocolError(1009, 'A message from the browser was too large.'); len = Number(big); off = 10; }
      if (len > MAX_MSG) return this.protocolError(1009, 'A message from the browser was too large.');
      if (this.buf.length < off + 4 + len) return; // wait for the rest
      const mask = this.buf.subarray(off, off + 4); const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op >= 0x8) { // control frames can come between fragments
        if (op === 0x8) return this.finish('disconnected', 'The browser closed the connection.');
        if (op === 0x9 && this.socket.writable) this.socket.write(frame(0xa, payload));
        continue;
      }
      if (op === 0x0) { // continuation
        if (!this.parts) return this.protocolError(1002, 'Bad message from the browser.');
        this.parts.push(payload); this.partLen += len;
        if (this.partLen > MAX_MSG) return this.protocolError(1009, 'A message from the browser was too large.');
        if (fin) { const all = Buffer.concat(this.parts); const o = this.partOp; this.parts = null; this.message(o, all); }
        continue;
      }
      if (this.parts) return this.protocolError(1002, 'Bad message from the browser.');
      if (!fin) { this.parts = [payload]; this.partOp = op; this.partLen = len; continue; }
      this.message(op, payload);
    }
  }

  /** Token buckets for messages and bytes: bursts are fine, a flood ends the stream. */
  allow(n) {
    const t = Date.now(); const dt = (t - this.last) / 1000; this.last = t;
    this.msgs = Math.min(MSG_BURST, this.msgs + dt * MSG_RATE) - 1;
    this.bytes = Math.min(BYTE_BURST, this.bytes + dt * BYTE_RATE) - n;
    return this.msgs >= 0 && this.bytes >= 0;
  }

  message(op, payload) {
    if (!this.allow(payload.length)) return this.protocolError(1008, 'The browser sent too much data too quickly.');
    if (op === 0x2) return this.media(payload);
    if (op !== 0x1) return;
    let m;
    try { m = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (m.t === 'start' && this.state === 'waiting') this.start(m).catch((e) => this.finish('error', e.message || 'Couldn’t start the stream.', { error: true }));
    else if (m.t === 'stop') this.finish('stopped', 'You ended the stream.');
    else if (m.t === 'client') this.stats.clientFps = Math.max(0, Math.min(240, Number(m.fps) || 0));
  }

  media(chunk) {
    if (!this.proc || this.state === 'waiting' || this.state === 'connecting') return this.protocolError(1008, 'Video arrived before the stream was ready.');
    this.stats.in += chunk.length;
    const stdin = this.proc.stdin;
    if (stdin.writableLength > BACKLOG_MAX) return this.finish('slow', 'The server can’t encode fast enough for this quality. Try 720p, or close other heavy jobs on the server.', { error: true });
    stdin.write(chunk);
  }

  async start(m) {
    this.state = 'connecting';
    this.send({ t: 'state', state: 'connecting', message: 'Connecting to Tsunami…' });
    const q = QUALITIES[m.quality] || QUALITIES['720p'];
    this.quality = q;
    const mime = String(m.mime || '');
    const copy = /avc1|h264/i.test(mime); // H.264 from the browser is sent as it is
    const s = await tsunami(this.user, '/live/start', {
      channel_id: String(m.channel_id || ''), title: clean(m.title, 100), description: String(m.description ?? '').slice(0, 5000), // Tsunami cleans it (keeping line breaks)
      visibility: ['public', 'unlisted', 'private'].includes(m.visibility) ? m.visibility : 'public',
      members_only: m.members_only == null ? undefined : !!m.members_only, chat: m.chat !== false,
    });
    this.channel = s.channel;
    this.prepared = true;
    if (this.done) return this.stopOnTsunami(); // the browser left while we were waiting

    const p = copy ? null : await videoProfile().catch(() => null);
    const hw = p && p.id !== 'cpu' ? p : null;
    const vf = `scale=${q.width}:${q.height}:force_original_aspect_ratio=decrease,pad=${q.width}:${q.height}:(ow-iw)/2:(oh-ih)/2,fps=${q.fps},format=yuv420p${hw?.tail || ''}`;
    const video = copy ? ['-c:v', 'copy'] : [
      ...(hw ? encoderArgs(hw) : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-sc_threshold', '0']),
      '-vf', vf, '-r', String(q.fps), '-b:v', `${q.kbps}k`, '-maxrate', `${q.kbps}k`, '-bufsize', `${q.kbps * 2}k`,
      '-g', String(q.fps * KEYFRAME_S), '-keyint_min', String(q.fps * KEYFRAME_S), '-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_S})`,
    ];
    const target = `${rtmpBase(s).replace(/\/$/, '')}/${s.stream_key}`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
      ...(hw ? inputArgs(hw, { hwDecode: false }) : []),
      '-fflags', '+genpts', '-probesize', '2M', '-analyzeduration', '2M', '-thread_queue_size', '1024', '-f', 'matroska', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?', ...video, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', target];
    const proc = spawn(config.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.encoder = copy ? 'copy (H.264 from the browser)' : hw ? hw.label : 'CPU (libx264)';
    proc.stdin.on('error', () => {});
    proc.on('error', () => this.finish('ffmpeg', 'ffmpeg isn’t installed on the SoraLab server.', { error: true }));
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    let block = {};
    proc.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const i = line.indexOf('='); if (i < 0) continue;
        const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
        if (k === 'progress') { this.progress(block); block = {}; } else block[k] = v;
      }
    });
    proc.on('close', (code, signal) => {
      this.proc = null;
      if (!this.done) this.finish('ffmpeg', explain(this.stderr, code, signal), { error: true });
      this.stopOnTsunami();
    });
    this.state = 'ready';
    this.started = Date.now();
    this.send({ t: 'state', state: 'ready', message: 'Starting the stream…', encoder: this.encoder, channel: s.channel, width: q.width, height: q.height, fps: q.fps, kbps: q.kbps });
    this.timer = setInterval(() => this.report(), 2000);
    this.waitForLive();
  }

  progress(b) {
    const size = Number(b.total_size) || 0;
    this.stats.frame = Number(b.frame) || this.stats.frame;
    this.stats.dupTotal = Number(b.dup_frames) || 0; this.stats.dropTotal = Number(b.drop_frames) || 0;
    this.stats.speed = parseFloat(b.speed) || 0;
    this.stats.sizeNow = size;
  }

  /** Polls Tsunami until the stream shows as live there (then now and then for the viewer count). */
  async waitForLive() {
    const t0 = Date.now();
    while (!this.done) {
      await new Promise((r) => setTimeout(r, this.state === 'live' ? 10000 : 1500));
      if (this.done) return;
      let t;
      try { t = await tsunami(this.user, '/live'); } catch { continue; }
      const cur = t.channels?.find((c) => c.id === this.channel?.id)?.live;
      if (cur && cur.status === 'live') {
        this.stats.viewers = cur.viewers || 0;
        if (this.state !== 'live') {
          this.state = 'live'; this.url = cur.url; this.streamId = cur.id;
          this.send({ t: 'state', state: 'live', message: 'You’re live on Tsunami.', url: cur.url, stream_id: cur.id });
        }
      } else if (this.state === 'live') {
        return this.finish('tsunami', 'The stream was ended on Tsunami.', { error: true });
      } else if (Date.now() - t0 > 30000) {
        return this.finish('timeout', this.stats.frame ? 'Tsunami didn’t start the stream. Check that live streaming is on and the channel isn’t live from OBS.' : 'No video reached the server. Check that the page is still showing the avatar.', { error: true });
      }
    }
  }

  report() {
    const t = Date.now(); const st = this.stats; const dt = Math.max(0.5, (t - st.inAt) / 1000);
    const outKbps = Math.round((((st.sizeNow || 0) - st.size) * 8) / 1000 / dt);
    const inKbps = Math.round((st.in * 8) / 1000 / dt);
    const frames = st.frame - (st.lastFrame || 0);
    const dropped = (st.dupTotal || 0) + (st.dropTotal || 0) - (st.lastDropped || 0);
    st.size = st.sizeNow || 0; st.in = 0; st.inAt = t; st.lastFrame = st.frame; st.lastDropped = (st.dupTotal || 0) + (st.dropTotal || 0);
    const backlog = this.proc?.stdin.writableLength || 0;
    const fps = Math.round((frames / dt) * 10) / 10;
    const target = this.quality?.fps || 30;
    // good: keeping up; poor: frames missing or the encoder falling behind; bad: hardly anything getting through
    const health = !st.frame ? 'starting' : fps < target * 0.5 || backlog > BACKLOG_WARN * 2 ? 'bad'
      : fps < target * 0.85 || dropped > target * 0.3 || backlog > BACKLOG_WARN || (st.speed && st.speed < 0.9) ? 'poor' : 'good';
    this.send({ t: 'stats', fps, kbps: Math.max(0, outKbps), in_kbps: inKbps, dropped: Math.max(0, dropped), dropped_total: st.dupTotal + st.dropTotal || 0,
      speed: st.speed, backlog_kb: Math.round(backlog / 1024), viewers: st.viewers, client_fps: st.clientFps, uptime: Math.round((t - this.started) / 1000), health });
  }

  async stopOnTsunami() {
    if (!this.prepared || this.stopped) return;
    this.stopped = true;
    try { await tsunami(this.user, '/live/stop', { channel_id: this.channel?.id }); } catch { /* Tsunami ends it itself when the RTMP push stops */ }
  }

  /** Ends everything once: tells the browser why, lets ffmpeg finish (so the recording on Tsunami is complete), cleans up. */
  finish(code, reason, { error = false, wsCode } = {}) {
    if (this.done) return;
    this.done = true;
    this.state = 'ended';
    clearInterval(this.timer);
    if (streams.get(this.user.id) === this) streams.delete(this.user.id);
    if (code !== 'disconnected') { this.send({ t: 'ended', code, reason, error }); this.closeSocket(wsCode || (error ? 1011 : 1000)); }
    else this.socket.destroy();
    const proc = this.proc;
    if (proc) {
      try { proc.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 6000).unref();
    } else this.stopOnTsunami();
    console.log(`[golive] ${this.user.username || this.user.id} stream ended: ${code}${error ? ` (${reason})` : ''}`);
  }
}

const reject = (socket, status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
const parseCookies = cookieParser();
const docById = db.prepare('SELECT * FROM docs WHERE id = ?');
/** Only SoraLab's own pages may open the stream (the WebSocket carries the sign-in cookie). */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // not a browser
  try { const u = new URL(o); return u.host === req.headers.host || u.origin === new URL(config.publicUrl).origin; } catch { return false; }
}

/** Handles an upgrade request for GOLIVE_PATH (called from the relay's upgrade handler in avatar.js). */
export function goLiveUpgrade(req, socket, url) {
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey || String(req.headers.upgrade).toLowerCase() !== 'websocket') return reject(socket, 400, 'Bad Request');
  if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
  parseCookies(req, {}, () => session(req, {}, () => {
    const doc = docById.get(String(url.searchParams.get('doc') || ''));
    if (!req.user) return reject(socket, 401, 'Unauthorized');
    if (!doc || doc.app !== 'avatar' || doc.trashed_at || !['owner', 'editor'].includes(roleFor(req.user, doc))) return reject(socket, 403, 'Forbidden');
    const accept = crypto.createHash('sha1').update(wsKey + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const s = new Stream(socket, req.user, doc);
    // One stream per person: the second one is told why and closed (the first keeps going).
    if (!tsunamiEnabled()) return s.finish('tsunami_off', 'Tsunami isn’t connected to this SoraLab server.', { error: true });
    if (streams.has(req.user.id)) return s.finish('busy', 'You’re already live from SoraLab (maybe in another tab). Stop that stream first.', { error: true, wsCode: 4009 });
    streams.set(req.user.id, s);
  }));
}

// Keep-alive: ping now and then; drop streams whose browser went quiet (no media, no pongs).
setInterval(() => {
  const t = Date.now();
  for (const s of streams.values()) {
    if (t - s.seen > 45e3) s.finish('timeout', 'The browser stopped sending video.', { error: true });
    else if (s.socket.writable) s.socket.write(frame(0x9, Buffer.alloc(0)));
  }
}, 15e3).unref();
