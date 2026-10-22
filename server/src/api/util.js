import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, json } from '../db.js';
import { viaSecure } from '../suite-images.js';

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };

/** Wraps async route handlers so thrown errors reach the error handler. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: `Files can be up to ${config.maxUploadMb} MB.` });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'That is too large to save.' });
  console.error('[soralab]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
}

export const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export const safeName = (s, fallback = 'Untitled') => clean(s, 180).replace(/[\\/:*?"<>|]/g, '-') || fallback;

export const docDir = (id) => path.join(config.dataDir, 'docs', id);
export const assetDir = (id) => path.join(config.dataDir, 'assets', id);
export const assetFile = (id) => path.join(assetDir(id), 'file');

// ---------------------------------------------------------------- access

const ROLES = ['viewer', 'commenter', 'editor', 'owner'];
const docById = db.prepare('SELECT * FROM docs WHERE id = ?');
const shareOf = db.prepare('SELECT role FROM doc_shares WHERE doc_id = ? AND user_id = ?');

export function roleFor(user, doc) {
  if (!user || !doc) return null;
  if (doc.owner === user.id) return 'owner';
  return shareOf.get(doc.id, user.id)?.role || null;
}

/** Loads a project the signed-in person can reach with at least `need` (viewer | commenter | editor | owner). */
export function loadDoc(req, id, need = 'viewer') {
  const doc = docById.get(String(id));
  const role = roleFor(req.user, doc);
  if (!doc || !role || (doc.trashed_at && need !== 'owner' && role !== 'owner')) fail(404, 'not_found', 'That project doesn’t exist or isn’t shared with you.');
  if (ROLES.indexOf(role) < ROLES.indexOf(need)) fail(403, 'forbidden', need === 'editor' ? 'You can only view this project.' : 'Only the owner can do that.');
  return { doc, role };
}

const assetById = db.prepare('SELECT * FROM assets WHERE id = ?');
const refDocs = db.prepare('SELECT d.* FROM doc_refs r JOIN docs d ON d.id = r.doc_id WHERE r.asset_id = ? AND d.trashed_at IS NULL');
/** An asset the person owns, or one used by a project they can open. */
export function loadAsset(req, id, { write = false } = {}) {
  const a = assetById.get(String(id));
  if (!a) fail(404, 'not_found', 'File not found.');
  if (a.owner === req.user.id) return a;
  if (!write && a.doc_id && roleFor(req.user, docById.get(a.doc_id))) return a;
  if (!write && refDocs.all(a.id).some((d) => roleFor(req.user, d))) return a;
  fail(404, 'not_found', 'File not found.');
}

const ID_RE = /"([A-Za-z0-9]{12})"/g;
/** Records which of the owner's files a project's contents mention (saved as JSON text), replacing the previous list. */
export function updateRefs(doc, body) {
  if (body.length > 64 * 1024 ** 2) return;
  const text = body.toString('utf8');
  const ids = [...new Set(Array.from(text.matchAll(ID_RE), (m) => m[1]))];
  const t = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM doc_refs WHERE doc_id = ?').run(doc.id);
    const add = db.prepare('INSERT OR IGNORE INTO doc_refs (doc_id, asset_id) SELECT ?, id FROM assets WHERE id = ? AND owner = ? AND (doc_id IS NULL OR doc_id != ?)');
    const used = db.prepare('UPDATE assets SET used_at = ? WHERE id = ?'); // the storage cleanup's grace period starts again
    for (const id of ids) { add.run(doc.id, id, doc.owner, doc.id); used.run(t, id); }
  });
  tx();
}

// ---------------------------------------------------------------- storage

const dirSize = (d) => {
  let n = 0;
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch { /* gone */ }
  return n;
};

export function usageOf(userId) {
  const assets = db.prepare('SELECT COALESCE(SUM(size),0) n FROM assets WHERE owner = ?').get(userId).n;
  const fonts = db.prepare('SELECT COALESCE(SUM(size),0) n FROM fonts WHERE owner = ?').get(userId).n;
  const docs = db.prepare('SELECT COALESCE(SUM(size),0) n FROM docs WHERE owner = ?').get(userId).n;
  const versions = db.prepare('SELECT COALESCE(SUM(v.size),0) n FROM doc_versions v JOIN docs d ON d.id = v.doc_id WHERE d.owner = ?').get(userId).n;
  return { assets, fonts, docs, versions, total: assets + fonts + docs + versions };
}
export const quotaOf = () => (config.storageGb > 0 ? config.storageGb * 1024 ** 3 : null);
export function checkQuota(userId, adding = 0) {
  const q = quotaOf();
  if (q && usageOf(userId).total + Number(adding || 0) > q) fail(413, 'quota', `You’ve used all ${config.storageGb} GB of your SoraLab storage. Delete some files or projects and try again.`);
}
export { dirSize, json };

export const userOut = (u) => u && ({ id: u.id, username: u.username, name: u.name, picture: viaSecure(u.picture) || null });
