// Sora Ningyō (VTuber avatars): the OBS output link, the live pose relay, and the Cubism Core file.
//
//   Output link   /avatar/<project>/output?key=…  is a page for an OBS Browser Source. It needs no sign-in: the random key
//                 (one per project, the owner can reset it) lets it read the project's contents and the files it uses.
//   Relay         a tiny WebSocket at /api/avatar/relay?doc=&key=&role=send|watch. The Perform page (signed in, an editor
//                 of the project) sends its pose ~30×/s; output pages with the key receive it. Messages are small JSON,
//                 rate-limited, and never stored. Written against RFC 6455 directly so the server needs no extra package.
//   Cubism Core   Live2D's live2dcubismcore.min.js can't ship with SoraLab, so an admin uploads it once; it's then served
//                 to signed-in people (and to output pages holding a valid key, so OBS can show Live2D models).
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { requireUser, requireAdmin, session } from '../auth.js';
import { h, fail, loadDoc, roleFor, assetFile, assetDir } from './util.js';
import { golive, goLiveUpgrade, GOLIVE_PATH } from './golive.js';

db.exec(`
CREATE TABLE IF NOT EXISTS avatar_keys (
  doc_id      TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                  -- the secret in the OBS output link
  created_at  INTEGER NOT NULL
);`);

export const avatar = express.Router();
avatar.use(golive); // "Go live on Tsunami" (golive.js)
const coreDir = path.join(config.dataDir, 'avatar');
const coreFile = path.join(coreDir, 'live2dcubismcore.min.js');
fs.mkdirSync(coreDir, { recursive: true });

const docById = db.prepare('SELECT * FROM docs WHERE id = ?');
const keyRow = db.prepare('SELECT key FROM avatar_keys WHERE doc_id = ?');
const newKey = () => crypto.randomBytes(18).toString('base64url');
function keyFor(docId, reset = false) {
  const row = keyRow.get(docId);
  if (row && !reset) return row.key;
  const key = newKey();
  db.prepare('INSERT INTO avatar_keys (doc_id, key, created_at) VALUES (?,?,?) ON CONFLICT(doc_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at').run(docId, key, now());
  return key;
}
/** The project when `key` is its output key (constant-time compare), else null. */
function docByKey(docId, key) {
  const doc = docById.get(String(docId || ''));
  if (!doc || doc.app !== 'avatar' || doc.trashed_at) return null;
  const row = keyRow.get(doc.id);
  if (!row || typeof key !== 'string') return null;
  const a = Buffer.from(row.key); const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? doc : null;
}
const needKey = (req) => docByKey(req.params.id, req.query.key) || fail(404, 'not_found', 'This output link is wrong or was reset. Copy it again from the Perform page.');

// ---------------------------------------------------------------- output link

avatar.get('/avatar/:id/output-key', requireUser, (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  if (doc.app !== 'avatar') fail(400, 'bad_app', 'That isn’t an avatar project.');
  res.json({ key: keyFor(doc.id) });
});
avatar.post('/avatar/:id/output-key/reset', requireUser, (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'owner');
  const key = keyFor(doc.id, true);
  relayClose(doc.id); // pages using the old link stop receiving
  res.json({ key });
});
/**
 * Your own avatar projects with their output keys, for another suite app's avatar picker (Hikari's camera source; it
 * calls this with credentials, see ../suite-cors.js). Only the owner's projects: a key lets anyone with it show the avatar.
 */
avatar.get('/avatar/mine', requireUser, (req, res) => {
  const rows = db.prepare("SELECT * FROM docs WHERE owner = ? AND app = 'avatar' AND trashed_at IS NULL ORDER BY COALESCE(opened_at, updated_at) DESC LIMIT 200").all(req.user.id);
  res.set('Cache-Control', 'no-store').json(rows.map((d) => {
    const key = keyFor(d.id); const q = `key=${encodeURIComponent(key)}`;
    let kind = null; try { kind = JSON.parse(d.meta || '{}').kind || null; } catch { /* old meta */ }
    return {
      id: d.id, name: d.name, kind, key, updated_at: d.updated_at,
      link: `${config.publicUrl}/avatar/${d.id}/output?${q}`,
      thumb: d.has_thumb ? `${config.publicUrl}/api/avatar/${d.id}/out/thumb?${q}&v=${d.rev}` : null,
    };
  }));
});
/** The project's thumbnail, for pickers holding the key. */
avatar.get('/avatar/:id/out/thumb', (req, res) => {
  const doc = needKey(req);
  const f = path.join(config.dataDir, 'docs', doc.id, 'thumb');
  if (!doc.has_thumb || !fs.existsSync(f)) return res.status(404).end();
  let type = 'image/png';
  try { type = fs.readFileSync(`${f}.type`, 'utf8').trim(); } catch { /* png */ }
  res.set('X-Content-Type-Options', 'nosniff').set('Content-Security-Policy', "default-src 'none'; sandbox").set('Cache-Control', 'private, max-age=86400');
  res.type(/^image\/(png|jpeg|webp)$/.test(type) ? type : 'application/octet-stream').sendFile(f);
});
/** The project's contents for the output page. */
avatar.get('/avatar/:id/out/data', (req, res) => {
  const doc = needKey(req);
  res.set('Cache-Control', 'no-store').type(doc.mime).sendFile(path.join(config.dataDir, 'docs', doc.id, 'data'));
});
/** A file the project uses (its own, or one it mentions), for the output page. */
avatar.get('/avatar/:id/out/asset/:aid', (req, res) => {
  const doc = needKey(req);
  const a = db.prepare('SELECT * FROM assets WHERE id = ? AND (doc_id = ? OR id IN (SELECT asset_id FROM doc_refs WHERE doc_id = ?))').get(String(req.params.aid), doc.id, doc.id);
  if (!a) fail(404, 'not_found', 'File not found.');
  res.set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  const web = a.web === 2 && req.query.web;
  res.type(web ? 'image/png' : a.mime).sendFile(web ? path.join(assetDir(a.id), 'web') : assetFile(a.id));
});

// ---------------------------------------------------------------- Cubism Core

const coreInfo = () => { try { const s = fs.statSync(coreFile); return { installed: true, size: s.size, uploaded_at: s.mtimeMs }; } catch { return { installed: false }; } };
avatar.get('/avatar/cubism-core', requireUser, (req, res) => res.json({ ...coreInfo(), can_upload: !!req.user.is_admin }));
avatar.get('/avatar/cubism-core.js', (req, res) => {
  if (!req.user && !docByKey(req.query.doc, req.query.key)) fail(401, 'login_required', 'Sign in to do that.');
  if (!coreInfo().installed) fail(404, 'not_found', 'Cubism Core hasn’t been added to this server yet.');
  res.set('Cache-Control', 'private, max-age=3600').type('application/javascript').sendFile(coreFile);
});
avatar.put('/avatar/cubism-core.js', requireAdmin, express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  // A quick sanity check that this is Live2D's Core and not some other script.
  if (body.length < 1000 || !body.includes('Live2DCubismCore')) fail(400, 'bad_file', 'That doesn’t look like live2dcubismcore.min.js. Use the file from the Cubism SDK for Web (Core folder).');
  const tmp = `${coreFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body); fs.renameSync(tmp, coreFile);
  res.json(coreInfo());
});
avatar.delete('/avatar/cubism-core.js', requireAdmin, (req, res) => { fs.rmSync(coreFile, { force: true }); res.json(coreInfo()); });

// ---------------------------------------------------------------- relay (WebSocket)

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 16 * 1024;           // a pose with all 52 blendshapes is ~2 KB
const RATE = 60; const BURST = 90;   // messages per second a sender may send (30 is normal)
const MAX_WATCHERS = 12; const MAX_SENDERS = 4;
const rooms = new Map();             // doc id → { senders: Set, watchers: Set }
const room = (id) => { let r = rooms.get(id); if (!r) rooms.set(id, (r = { senders: new Set(), watchers: new Set() })); return r; };
const parseCookies = cookieParser();

function frame(op, data) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : null;
  if (!head) return null; // never send anything that big
  return Buffer.concat([head, data]);
}

class Peer {
  constructor(socket, docId, role) {
    this.socket = socket; this.docId = docId; this.role = role; this.buf = Buffer.alloc(0);
    this.tokens = BURST; this.last = Date.now(); this.seen = Date.now(); this.dropped = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }
  send(op, data) { if (this.socket.writable && this.socket.writableLength < 256 * 1024) { const f = frame(op, data); if (f) this.socket.write(f); } }
  text(s) { this.send(0x1, Buffer.from(s)); }
  close(code = 1000) { const b = Buffer.alloc(2); b.writeUInt16BE(code); this.send(0x8, b); this.socket.end(); setTimeout(() => this.socket.destroy(), 1000).unref(); }
  onData(d) {
    this.seen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_MSG * 4) return this.close(1009);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const op = b0 & 0x0f; let len = b1 & 0x7f; let off = 2;
      if (!(b1 & 0x80)) return this.close(1002);           // clients must mask
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; } else if (len === 127) return this.close(1009);
      if (len > MAX_MSG) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;           // wait for the rest
      const mask = this.buf.subarray(off, off + 4); const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (!(b0 & 0x80) || op === 0x0) return this.close(1003); // no fragmented messages (poses are small)
      if (op === 0x8) return this.close(1000);
      if (op === 0x9) { this.send(0xa, payload); continue; }   // ping → pong
      if (op === 0xa) continue;
      if (op === 0x1 && this.role === 'send') this.relay(payload);
    }
  }
  relay(payload) {
    // token bucket: steady RATE per second, short bursts allowed; flooding closes the connection
    const t = Date.now(); this.tokens = Math.min(BURST, this.tokens + ((t - this.last) / 1000) * RATE); this.last = t;
    if (this.tokens < 1) { if (++this.dropped > RATE * 10) this.close(1008); return; }
    this.tokens -= 1;
    const f = frame(0x1, payload);
    for (const w of room(this.docId).watchers) if (w.socket.writable && w.socket.writableLength < 256 * 1024) w.socket.write(f);
  }
  gone() {
    const r = rooms.get(this.docId);
    if (!r) return;
    const had = r.senders.delete(this) || r.watchers.delete(this);
    if (had && this.role === 'watch') announce(this.docId);
    if (!r.senders.size && !r.watchers.size) rooms.delete(this.docId);
  }
}

/** Tells senders how many output pages are listening (the Perform page shows "OBS connected"). */
function announce(docId) {
  const r = rooms.get(docId);
  if (r) for (const s of r.senders) s.text(JSON.stringify({ t: 'watchers', n: r.watchers.size }));
}
function relayClose(docId) {
  const r = rooms.get(docId);
  if (r) for (const p of [...r.senders, ...r.watchers]) p.close(4001);
}

const reject = (socket, status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };

/** Attaches the relay to an http(s) server's upgrade requests. */
export function attachRelay(server) {
  if (!server) return;
  server.on('upgrade', (req, socket) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { return reject(socket, 400, 'Bad Request'); }
    if (u.pathname === GOLIVE_PATH) return goLiveUpgrade(req, socket, u);
    if (u.pathname !== '/api/avatar/relay') { if (server.listenerCount('upgrade') === 1) socket.destroy(); return; }
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || String(req.headers.upgrade).toLowerCase() !== 'websocket') return reject(socket, 400, 'Bad Request');
    const docId = u.searchParams.get('doc'); const role = u.searchParams.get('role') === 'send' ? 'send' : 'watch';
    const doc = docByKey(docId, u.searchParams.get('key'));
    if (!doc) return reject(socket, 403, 'Forbidden');
    // Sending needs a signed-in editor of the project too; watching needs only the key.
    const go = () => {
      if (role === 'send' && !['owner', 'editor'].includes(roleFor(req.user, doc))) return reject(socket, 403, 'Forbidden');
      const r = room(doc.id);
      if ((role === 'send' ? r.senders.size >= MAX_SENDERS : r.watchers.size >= MAX_WATCHERS)) return reject(socket, 429, 'Too Many Requests');
      const accept = crypto.createHash('sha1').update(wsKey + GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const p = new Peer(socket, doc.id, role);
      (role === 'send' ? r.senders : r.watchers).add(p);
      announce(doc.id);
    };
    if (role !== 'send') return go();
    parseCookies(req, {}, () => session(req, {}, go));
  });
}

// Keep-alive: ping everyone now and then; drop connections that went quiet (a closed laptop, a removed OBS source).
setInterval(() => {
  const t = Date.now();
  for (const r of rooms.values()) for (const p of [...r.senders, ...r.watchers]) {
    if (t - p.seen > 70e3) { p.socket.destroy(); p.gone(); } else p.send(0x9, Buffer.alloc(0));
  }
}, 25e3).unref();
