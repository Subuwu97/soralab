// Libraries (colours, styles, graphics, brushes, presets…), fonts, and per-person settings.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, newId, now, json } from '../db.js';
import { requireUser } from '../auth.js';
import { h, fail, clean, loadAsset, checkQuota, usageOf, quotaOf } from './util.js';

export const libraries = express.Router();
for (const p of ['/libraries', '/library-items', '/fonts', '/me']) libraries.use(p, requireUser);

const KINDS = ['color', 'gradient', 'swatchgroup', 'charstyle', 'parastyle', 'graphic', 'brush', 'preset', 'lut', 'template', 'text', 'pattern', 'shape', 'look'];

const itemOut = (i) => ({ id: i.id, library_id: i.library_id, kind: i.kind, name: i.name, data: json(i.data), asset_id: i.asset_id,
  asset_url: i.asset_id ? `/api/assets/${i.asset_id}/file` : null, position: i.position, created_at: i.created_at });

function loadLibrary(req, id) {
  const l = db.prepare('SELECT * FROM libraries WHERE id = ? AND owner = ?').get(String(id), req.user.id);
  if (!l) fail(404, 'not_found', 'Library not found.');
  return l;
}

/** GET /api/libraries — every library with its items (?kind= narrows items). */
libraries.get('/libraries', (req, res) => {
  const libs = db.prepare('SELECT * FROM libraries WHERE owner = ? ORDER BY position, created_at').all(req.user.id);
  const kind = req.query.kind ? String(req.query.kind).split(',') : null;
  res.json(libs.map((l) => ({
    id: l.id, name: l.name, created_at: l.created_at,
    items: db.prepare('SELECT * FROM library_items WHERE library_id = ? ORDER BY position, created_at').all(l.id).filter((i) => !kind || kind.includes(i.kind)).map(itemOut),
  })));
});
libraries.post('/libraries', express.json(), (req, res) => {
  const id = newId();
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM libraries WHERE owner = ?').get(req.user.id).p;
  db.prepare('INSERT INTO libraries (id, owner, name, position, created_at) VALUES (?,?,?,?,?)').run(id, req.user.id, clean(req.body?.name, 100) || 'New library', pos, now());
  res.status(201).json({ id, name: clean(req.body?.name, 100) || 'New library', items: [] });
});
libraries.patch('/libraries/:id', express.json(), (req, res) => {
  const l = loadLibrary(req, req.params.id);
  if (req.body?.name) db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(clean(req.body.name, 100), l.id);
  if (Number.isFinite(req.body?.position)) db.prepare('UPDATE libraries SET position = ? WHERE id = ?').run(req.body.position, l.id);
  res.json({ ok: true });
});
libraries.delete('/libraries/:id', (req, res) => {
  const l = loadLibrary(req, req.params.id);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

/** POST /api/libraries/:id/items { kind, name, data, asset_id? } */
libraries.post('/libraries/:id/items', express.json({ limit: '5mb' }), (req, res) => {
  const l = loadLibrary(req, req.params.id);
  const b = req.body || {};
  if (!KINDS.includes(b.kind)) fail(400, 'bad_kind', `Kind must be one of: ${KINDS.join(', ')}.`);
  const asset = b.asset_id ? loadAsset(req, b.asset_id, { write: true }) : null;
  if (asset) db.prepare("UPDATE assets SET source = 'keep:library' WHERE id = ? AND source NOT LIKE 'keep%'").run(asset.id); // survives its project being deleted
  const id = newId();
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM library_items WHERE library_id = ?').get(l.id).p;
  db.prepare('INSERT INTO library_items (id, library_id, kind, name, data, asset_id, position, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, l.id, b.kind, clean(b.name, 120) || b.kind, JSON.stringify(b.data ?? {}).slice(0, 4_000_000), asset?.id || null, pos, now());
  res.status(201).json(itemOut(db.prepare('SELECT * FROM library_items WHERE id = ?').get(id)));
});
const loadItem = (req, id) => {
  const i = db.prepare('SELECT i.* FROM library_items i JOIN libraries l ON l.id = i.library_id WHERE i.id = ? AND l.owner = ?').get(String(id), req.user.id);
  if (!i) fail(404, 'not_found', 'Item not found.');
  return i;
};
libraries.patch('/library-items/:id', express.json({ limit: '5mb' }), (req, res) => {
  const i = loadItem(req, req.params.id);
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE library_items SET name = ? WHERE id = ?').run(clean(b.name, 120) || i.name, i.id);
  if (b.data !== undefined) db.prepare('UPDATE library_items SET data = ? WHERE id = ?').run(JSON.stringify(b.data).slice(0, 4_000_000), i.id);
  if (b.library_id) { loadLibrary(req, b.library_id); db.prepare('UPDATE library_items SET library_id = ? WHERE id = ?').run(b.library_id, i.id); }
  if (Number.isFinite(b.position)) db.prepare('UPDATE library_items SET position = ? WHERE id = ?').run(b.position, i.id);
  res.json(itemOut(db.prepare('SELECT * FROM library_items WHERE id = ?').get(i.id)));
});
libraries.delete('/library-items/:id', (req, res) => {
  const i = loadItem(req, req.params.id);
  db.prepare('DELETE FROM library_items WHERE id = ?').run(i.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- fonts

const fontOut = (f) => ({ id: f.id, family: f.family, style: f.style, weight: f.weight, mime: f.mime, size: f.size, url: `/api/fonts/${f.id}/file`, created_at: f.created_at });
const FONT_MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const fontUpload = multer({ dest: path.join(config.dataDir, 'tmp'), limits: { fileSize: 30 * 1024 * 1024, files: 50 } });

/** Family, weight and style from the font's own name table (TTF/OTF), falling back to the file name. */
function fontNames(file, fallback) {
  const guess = () => {
    const base = fallback.replace(/\.(ttf|otf|woff2?)$/i, '');
    const weight = /thin|hairline/i.test(base) ? 100 : /extra-?light|ultra-?light/i.test(base) ? 200 : /light/i.test(base) ? 300 : /medium/i.test(base) ? 500
      : /semi-?bold|demi/i.test(base) ? 600 : /extra-?bold|ultra-?bold/i.test(base) ? 800 : /black|heavy/i.test(base) ? 900 : /bold/i.test(base) ? 700 : 400;
    const family = base.replace(/[-_ ]?(thin|hairline|extra-?light|ultra-?light|light|regular|book|medium|semi-?bold|demi-?bold|extra-?bold|ultra-?bold|bold|black|heavy|italic|oblique|variable|vf)+$/gi, '')
      .replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || base;
    return { family, weight, style: /italic|oblique/i.test(base) ? 'italic' : 'normal' };
  };
  try {
    const b = fs.readFileSync(file);
    const sig = b.readUInt32BE(0);
    if (sig !== 0x00010000 && sig !== 0x4f54544f) return guess(); // WOFF/WOFF2 are compressed; use the file name
    const n = b.readUInt16BE(4);
    let name = null; let os2 = null;
    for (let i = 0; i < n; i++) {
      const tag = b.toString('latin1', 12 + i * 16, 16 + i * 16);
      const off = b.readUInt32BE(12 + i * 16 + 8);
      if (tag === 'name') name = off;
      if (tag === 'OS/2') os2 = off;
    }
    const g = guess();
    if (os2 !== null) { g.weight = b.readUInt16BE(os2 + 4) || g.weight; g.style = b.readUInt16BE(os2 + 62) & 1 ? 'italic' : 'normal'; }
    if (name !== null) {
      const count = b.readUInt16BE(name + 2);
      const strings = name + b.readUInt16BE(name + 4);
      const found = {};
      for (let i = 0; i < count; i++) {
        const r = name + 6 + i * 12;
        const [platform, , lang, id, len, off] = [b.readUInt16BE(r), b.readUInt16BE(r + 2), b.readUInt16BE(r + 4), b.readUInt16BE(r + 6), b.readUInt16BE(r + 8), b.readUInt16BE(r + 10)];
        if (![1, 16].includes(id) || found[id]) continue;
        const raw = b.subarray(strings + off, strings + off + len);
        if (platform === 3 && (lang === 0x409 || !found[id])) found[id] = raw.swap16 ? Buffer.from(raw).swap16().toString('utf16le') : '';
        else if (platform === 1 && !found[id]) found[id] = raw.toString('latin1');
      }
      g.family = (found[16] || found[1] || g.family).replace(/\0/g, '').trim() || g.family;
    }
    return g;
  } catch { return guess(); }
}

libraries.get('/fonts', (req, res) => res.json(db.prepare('SELECT * FROM fonts WHERE owner = ? ORDER BY family, weight, style').all(req.user.id).map(fontOut)));
libraries.post('/fonts', fontUpload.any(), h(async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) fail(400, 'no_file', 'Choose font files (TTF, OTF, WOFF or WOFF2).');
    checkQuota(req.user.id, files.reduce((n, f) => n + f.size, 0));
    const out = [];
    for (const f of files) {
      const orig = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const ext = path.extname(orig).slice(1).toLowerCase();
      if (!FONT_MIME[ext]) continue;
      const id = newId();
      const dest = path.join(config.dataDir, 'fonts', `${id}.${ext}`);
      fs.renameSync(f.path, dest);
      const n = fontNames(dest, orig);
      db.prepare('INSERT INTO fonts (id, owner, family, style, weight, file, mime, size, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, req.user.id, clean(n.family, 100), n.style, Math.max(1, Math.min(1000, n.weight)), `${id}.${ext}`, FONT_MIME[ext], f.size, now());
      out.push(fontOut(db.prepare('SELECT * FROM fonts WHERE id = ?').get(id)));
    }
    if (!out.length) fail(400, 'bad_font', 'Those aren’t font files (TTF, OTF, WOFF or WOFF2).');
    res.status(201).json(out);
  } finally { for (const f of files) fs.rm(f.path, { force: true }, () => {}); }
}));
libraries.get('/fonts/:id/file', (req, res) => {
  const f = db.prepare('SELECT * FROM fonts WHERE id = ? AND owner = ?').get(req.params.id, req.user.id);
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable').set('X-Content-Type-Options', 'nosniff').type(f.mime).sendFile(path.join(config.dataDir, 'fonts', f.file));
});
libraries.patch('/fonts/:id', express.json(), (req, res) => {
  const f = db.prepare('SELECT * FROM fonts WHERE id = ? AND owner = ?').get(req.params.id, req.user.id);
  if (!f) fail(404, 'not_found', 'Font not found.');
  const b = req.body || {};
  db.prepare('UPDATE fonts SET family = ?, weight = ?, style = ? WHERE id = ?').run(clean(b.family, 100) || f.family, Number(b.weight) || f.weight, b.style === 'italic' ? 'italic' : b.style === 'normal' ? 'normal' : f.style, f.id);
  res.json(fontOut(db.prepare('SELECT * FROM fonts WHERE id = ?').get(f.id)));
});
libraries.delete('/fonts/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM fonts WHERE id = ? AND owner = ?').get(req.params.id, req.user.id);
  if (!f) fail(404, 'not_found', 'Font not found.');
  fs.rmSync(path.join(config.dataDir, 'fonts', f.file), { force: true });
  db.prepare('DELETE FROM fonts WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- me

libraries.get('/me', (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, name: u.name, email: u.email, picture: u.picture, is_admin: !!u.is_admin, settings: json(u.settings),
    storage: { ...usageOf(u.id), quota: quotaOf() } });
});
/** PATCH /api/me/settings { ...partial } — merged into the stored settings (theme, workspaces, recent colours, shortcuts…). */
libraries.patch('/me/settings', express.json({ limit: '1mb' }), (req, res) => {
  const merged = { ...json(req.user.settings), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
  const s = JSON.stringify(merged);
  if (s.length > 1_000_000) fail(413, 'too_large', 'Settings are too large.');
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(s, req.user.id);
  res.json(merged);
});
