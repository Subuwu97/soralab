// The rest of the Mirai suite: open files from Minami Cloud (and Mirai Photos, which lives in Cloud), save exports
// and projects back to Cloud, and publish videos to Tsunami. Server-to-server calls carry a short-lived JWT signed
// with SUITE_SECRET naming the person (the same scheme Mail and Tsunami use).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { db, newId } from '../db.js';
import { requireUser } from '../auth.js';
import { h, fail, clean, safeName, loadDoc, loadAsset, assetFile, assetDir, checkQuota, docDir } from './util.js';
import { storeAsset, assetOut } from './assets.js';

export const suite = express.Router();
for (const p of ['/cloud', '/tsunami']) suite.use(p, requireUser);

const key = new TextEncoder().encode(config.suiteSecret || 'unset');
const token = (u, aud) => new SignJWT({ username: u.username, name: u.name, email: u.email || undefined, picture: u.picture || undefined, iss: 'soralab' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setAudience(aud).setIssuedAt().setExpirationTime('10m').sign(key);

/** The same signed token, for other server modules that call the suite (Sora Ningyō's Go live). */
export const suiteToken = token;

export const cloudEnabled = () => !!(config.suiteSecret && config.cloudInternalUrl);
export const tsunamiEnabled = () => !!(config.suiteSecret && config.tsunamiInternalUrl);

async function cloud(u, p, init = {}) {
  if (!cloudEnabled()) fail(503, 'cloud_off', 'Minami Cloud isn’t connected. Re-run the suite’s setup.');
  let r;
  try { r = await fetch(`${config.cloudInternalUrl}/internal${p}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${await token(u, 'cloud')}` } }); }
  catch { fail(503, 'cloud_down', 'Minami Cloud isn’t reachable right now.'); }
  return r;
}
async function cloudJson(u, p, init) {
  const r = await cloud(u, p, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) fail(r.status === 404 ? 404 : 502, 'cloud', b.message || `Minami Cloud error ${r.status}`);
  return b;
}

/** GET /api/cloud/folders/:id?kind=image|video|audio — browse Cloud ("root" = My Drive). */
suite.get('/cloud/folders/:id', h(async (req, res) => {
  const kind = String(req.query.kind || '');
  const r = await cloudJson(req.user, `/folders/${encodeURIComponent(req.params.id)}`);
  const kinds = kind ? kind.split(',') : null;
  res.json({ ...r, items: r.items.filter((f) => f.folder || !kinds || kinds.includes(f.kind) || (kinds.includes('pdf') && f.mime === 'application/pdf')) });
}));
suite.get('/cloud/search', h(async (req, res) => {
  res.json(await cloudJson(req.user, `/search?q=${encodeURIComponent(String(req.query.q || ''))}&kind=${encodeURIComponent(String(req.query.kind || ''))}`));
}));

/** POST /api/cloud/import { file_id, doc_id? } — copies a Cloud file into SoraLab (as an asset). */
suite.post('/cloud/import', express.json(), h(async (req, res) => {
  const docId = req.body?.doc_id ? loadDoc(req, req.body.doc_id, 'editor').doc.id : null;
  const meta = await cloudJson(req.user, `/files/${encodeURIComponent(String(req.body?.file_id || ''))}`);
  if (meta.folder) fail(400, 'is_folder', 'Choose a file, not a folder.');
  if (meta.size > config.maxUploadMb * 1024 * 1024) fail(413, 'too_large', `Files can be up to ${config.maxUploadMb} MB.`);
  checkQuota(req.user.id, meta.size);
  // The same Cloud file imported into the same project again is reused.
  const existing = db.prepare('SELECT * FROM assets WHERE owner = ? AND source = ? AND doc_id IS ? AND size = ?').get(req.user.id, `cloud:${meta.id}`, docId, meta.size);
  if (existing && fs.existsSync(assetFile(existing.id))) return res.json(assetOut(existing));
  const r = await cloud(req.user, `/files/${encodeURIComponent(meta.id)}/content`);
  if (!r.ok || !r.body) fail(502, 'cloud', 'Couldn’t read that file from Minami Cloud.');
  const tmp = path.join(config.dataDir, 'tmp', `cloud-${newId()}`);
  try { await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp)); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  const a = await storeAsset(req.user.id, tmp, { name: meta.name, mime: meta.mime, docId, source: `cloud:${meta.id}` });
  res.status(201).json(assetOut(a));
}));

/** Streams a local file to Cloud. Never overwrites: Cloud keeps both. */
async function putToCloud(u, file, { folderId = 'root', name, mime }) {
  const r = await cloud(u, `/upload?parent=${encodeURIComponent(folderId || 'root')}&name=${encodeURIComponent(name)}`, {
    method: 'PUT', body: fs.createReadStream(file), duplex: 'half',
    headers: { 'content-type': mime || 'application/octet-stream', 'content-length': String(fs.statSync(file).size) },
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) fail(r.status === 413 ? 413 : 502, 'cloud', b.message || `Minami Cloud error ${r.status}`);
  return { ...b, cloud_url: config.cloudUrl ? `${config.cloudUrl}/folder/${encodeURIComponent(folderId || 'root')}` : null };
}
export { putToCloud };

/**
 * POST /api/cloud/save { asset_id | doc_id, folder_id?, name? } — saves an export (asset) or a project file to Cloud.
 * A project is saved as "<name>.sora" (the app's own format) so it can be opened again from Cloud.
 */
suite.post('/cloud/save', express.json(), h(async (req, res) => {
  const b = req.body || {};
  if (b.asset_id) {
    const a = loadAsset(req, b.asset_id);
    const f = a.web === 2 && b.web ? path.join(assetDir(a.id), 'web') : assetFile(a.id);
    return res.status(201).json(await putToCloud(req.user, f, { folderId: b.folder_id, name: safeName(b.name || a.name), mime: a.mime }));
  }
  if (b.doc_id) {
    const { doc } = loadDoc(req, b.doc_id);
    const name = safeName(b.name || `${doc.name}.sora`);
    // A .sora file is a small JSON wrapper: which app, the project's contents.
    const tmp = path.join(config.dataDir, 'tmp', `sora-${newId()}`);
    const data = fs.readFileSync(path.join(docDir(doc.id), 'data'));
    const wrapped = /json/.test(doc.mime)
      ? `{"soralab":1,"app":${JSON.stringify(doc.app)},"name":${JSON.stringify(doc.name)},"width":${doc.width ?? 'null'},"height":${doc.height ?? 'null'},"data":${data.toString('utf8') || '{}'}}`
      : JSON.stringify({ soralab: 1, app: doc.app, name: doc.name, mime: doc.mime, base64: data.toString('base64') });
    fs.writeFileSync(tmp, wrapped);
    try { return res.status(201).json(await putToCloud(req.user, tmp, { folderId: b.folder_id, name: name.endsWith('.sora') ? name : `${name}.sora`, mime: 'application/json' })); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  fail(400, 'nothing', 'Say what to save (asset_id or doc_id).');
}));

/** POST /api/cloud/open { file_id } — opens a .sora project from Cloud as a new SoraLab project. */
suite.post('/cloud/open', express.json(), h(async (req, res) => {
  const meta = await cloudJson(req.user, `/files/${encodeURIComponent(String(req.body?.file_id || ''))}`);
  if (meta.size > config.maxDocMb * 1024 * 1024) fail(413, 'too_large', 'That project is too large.');
  const r = await cloud(req.user, `/files/${encodeURIComponent(meta.id)}/content`);
  let wrapped;
  try { wrapped = JSON.parse(await r.text()); } catch { fail(400, 'not_sora', 'That isn’t a SoraLab project (.sora).'); }
  if (!wrapped?.soralab || !wrapped.app) fail(400, 'not_sora', 'That isn’t a SoraLab project (.sora).');
  const { APPS } = await import('./docs.js');
  if (!APPS.includes(wrapped.app)) fail(400, 'bad_app', 'That project is for an app this server doesn’t have.');
  const body = wrapped.base64 ? Buffer.from(wrapped.base64, 'base64') : Buffer.from(JSON.stringify(wrapped.data ?? {}));
  checkQuota(req.user.id, body.length);
  const id = newId();
  const t = Date.now();
  fs.mkdirSync(path.join(docDir(id), 'versions'), { recursive: true });
  fs.writeFileSync(path.join(docDir(id), 'data'), body);
  db.prepare(`INSERT INTO docs (id, owner, app, name, mime, size, rev, width, height, created_at, updated_at, opened_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)`)
    .run(id, req.user.id, wrapped.app, clean(wrapped.name || meta.name.replace(/\.sora$/i, ''), 200) || 'Untitled', wrapped.mime || 'application/json', body.length,
      Number(wrapped.width) || null, Number(wrapped.height) || null, t, t, t);
  res.status(201).json({ id, app: wrapped.app });
}));

// ---------------------------------------------------------------- Tsunami

/** Uploads a video file to Tsunami for the person. Returns { id, url }. */
export async function publishToTsunami(u, file, { title, description = '', visibility = 'private', name = 'video.mp4' }) {
  if (!tsunamiEnabled()) fail(503, 'tsunami_off', 'Tsunami isn’t connected. Re-run the suite’s setup.');
  const q = new URLSearchParams({ title: clean(title, 100) || name.replace(/\.[^.]+$/, ''), description: clean(description, 5000), visibility, name });
  let r;
  try {
    r = await fetch(`${config.tsunamiInternalUrl}/internal/videos?${q}`, {
      method: 'PUT', body: fs.createReadStream(file), duplex: 'half',
      headers: { authorization: `Bearer ${await token(u, 'tsunami')}`, 'content-type': 'application/octet-stream', 'content-length': String(fs.statSync(file).size) },
    });
  } catch { fail(503, 'tsunami_down', 'Tsunami isn’t reachable right now.'); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) fail(r.status === 413 || r.status === 403 ? r.status : 502, 'tsunami', b.message || `Tsunami error ${r.status}`);
  return { ...b, url: b.url || (config.tsunamiUrl ? `${config.tsunamiUrl}/watch?v=${b.id}` : null), studio_url: config.tsunamiUrl ? `${config.tsunamiUrl}/studio` : null };
}

/** POST /api/tsunami/publish { asset_id, title, description?, visibility? } */
suite.post('/tsunami/publish', express.json(), h(async (req, res) => {
  const a = loadAsset(req, req.body?.asset_id);
  if (a.kind !== 'video' && a.kind !== 'audio') fail(400, 'not_video', 'Only videos and music can be published to Tsunami.');
  const vis = ['public', 'unlisted', 'private'].includes(req.body?.visibility) ? req.body.visibility : 'private';
  res.status(201).json(await publishToTsunami(req.user, assetFile(a.id), { title: req.body?.title || a.name, description: req.body?.description, visibility: vis, name: a.name }));
}));
