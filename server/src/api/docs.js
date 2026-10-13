// Projects: create, list, open, save (with automatic version history), share, comment, trash.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, newId, now, json } from '../db.js';
import { requireUser } from '../auth.js';
import { h, fail, clean, loadDoc, docDir, roleFor, checkQuota, userOut } from './util.js';
import { notifier } from '../notify.js';
import { viaSecure } from '../suite-images.js';

export const docs = express.Router();
docs.use('/docs', requireUser);

export const APPS = ['photo', 'paint', 'develop', 'vector', 'express', 'proto', 'layout', 'pdf', 'cut', 'motion', 'animate', 'audio'];
const AUTOSAVE_VERSION_EVERY = 10 * 60e3; // a restorable version at most every 10 minutes while you work

export function docOut(d, user) {
  const owner = d.owner === user?.id ? null : userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(d.owner));
  return {
    id: d.id, app: d.app, name: d.name, mime: d.mime, size: d.size, rev: d.rev, width: d.width, height: d.height, duration: d.duration, pages: d.pages,
    thumb: d.has_thumb ? `/api/docs/${d.id}/thumb?v=${d.rev}` : null, starred: !!d.starred, meta: json(d.meta),
    created_at: d.created_at, updated_at: d.updated_at, opened_at: d.opened_at, trashed_at: d.trashed_at,
    role: roleFor(user, d), owner, shared: !!db.prepare('SELECT 1 FROM doc_shares WHERE doc_id = ?').get(d.id),
  };
}

const writeAtomic = (file, buf) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); };
const dims = (b) => ({
  width: Number.isFinite(+b.width) && +b.width > 0 ? Math.round(+b.width) : null,
  height: Number.isFinite(+b.height) && +b.height > 0 ? Math.round(+b.height) : null,
  duration: Number.isFinite(+b.duration) && +b.duration > 0 ? +b.duration : null,
  pages: Number.isFinite(+b.pages) && +b.pages > 0 ? Math.round(+b.pages) : null,
});

/** GET /api/docs?app=&q=&view=recent|starred|shared|trash */
docs.get('/docs', (req, res) => {
  const { app, q, view = 'recent' } = req.query;
  const where = [];
  const args = { me: req.user.id };
  if (view === 'shared') where.push('d.id IN (SELECT doc_id FROM doc_shares WHERE user_id = @me) AND d.trashed_at IS NULL');
  else if (view === 'trash') where.push('d.owner = @me AND d.trashed_at IS NOT NULL');
  else {
    where.push('(d.owner = @me OR d.id IN (SELECT doc_id FROM doc_shares WHERE user_id = @me)) AND d.trashed_at IS NULL');
    if (view === 'starred') where.push('d.starred = 1 AND d.owner = @me');
  }
  if (app && APPS.includes(String(app))) { where.push('d.app = @app'); args.app = String(app); }
  if (q) { where.push('lower(d.name) LIKE @q'); args.q = `%${String(q).toLowerCase().replace(/[%_]/g, '').slice(0, 100)}%`; }
  const rows = db.prepare(`SELECT d.* FROM docs d WHERE ${where.join(' AND ')} ORDER BY COALESCE(d.opened_at, d.updated_at) DESC LIMIT 500`).all(args);
  res.json(rows.map((d) => docOut(d, req.user)));
});

/** POST /api/docs { app, name, width?, height?, duration?, pages?, meta?, data? } — data is the initial contents (JSON). */
docs.post('/docs', express.json({ limit: `${config.maxDocMb}mb` }), (req, res) => {
  const b = req.body || {};
  if (!APPS.includes(b.app)) fail(400, 'bad_app', 'Unknown app.');
  const body = b.data === undefined ? Buffer.from('{}') : Buffer.from(typeof b.data === 'string' ? b.data : JSON.stringify(b.data));
  checkQuota(req.user.id, body.length);
  const id = newId();
  const t = now();
  fs.mkdirSync(path.join(docDir(id), 'versions'), { recursive: true });
  writeAtomic(path.join(docDir(id), 'data'), body);
  const d = dims(b);
  db.prepare(`INSERT INTO docs (id, owner, app, name, size, rev, width, height, duration, pages, meta, created_at, updated_at, opened_at)
    VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(id, req.user.id, b.app, clean(b.name, 200) || 'Untitled', body.length, d.width, d.height, d.duration, d.pages,
    JSON.stringify(b.meta && typeof b.meta === 'object' ? b.meta : {}).slice(0, 8000), t, t, t);
  res.status(201).json(docOut(db.prepare('SELECT * FROM docs WHERE id = ?').get(id), req.user));
});

docs.get('/docs/:id', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  if (req.query.open) db.prepare('UPDATE docs SET opened_at = ? WHERE id = ?').run(now(), doc.id);
  res.json(docOut(doc, req.user));
});

/** The project's contents, exactly as the app saved them. ETag is the revision. */
docs.get('/docs/:id/data', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  res.set('ETag', `"${doc.rev}"`).set('X-Rev', String(doc.rev)).set('Cache-Control', 'no-store').type(doc.mime);
  res.sendFile(path.join(docDir(doc.id), 'data'));
});

/**
 * PUT /api/docs/:id/data — saves the contents (any body; Content-Type is kept).
 * Send If-Match: "<rev>" to refuse the save when someone else saved in between (409 with the current rev).
 * Optional query: width, height, duration, pages, meta (JSON) to update what lists show.
 */
docs.put('/docs/:id/data', express.raw({ type: () => true, limit: `${config.maxDocMb}mb` }), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  const want = (req.get('if-match') || '').replace(/"/g, '');
  if (want && Number(want) !== doc.rev) return res.status(409).json({ error: 'conflict', message: 'This project was changed somewhere else since you opened it.', rev: doc.rev });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  checkQuota(doc.owner, body.length - doc.size);
  const dir = docDir(doc.id);
  const file = path.join(dir, 'data');
  // Keep the previous contents as a version every so often (and always before the first save of a session's work).
  const last = db.prepare('SELECT created_at FROM doc_versions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
  if (fs.existsSync(file) && doc.size > 2 && (!last || now() - last.created_at > AUTOSAVE_VERSION_EVERY)) snapshot(doc, null, req.user.id);
  writeAtomic(file, body);
  const d = dims(req.query);
  const meta = req.query.meta ? JSON.stringify(json(String(req.query.meta))).slice(0, 8000) : null;
  db.prepare(`UPDATE docs SET size = ?, rev = rev + 1, mime = ?, updated_at = ?, width = COALESCE(?, width), height = COALESCE(?, height),
    duration = COALESCE(?, duration), pages = COALESCE(?, pages), meta = COALESCE(?, meta) WHERE id = ?`)
    .run(body.length, (req.get('content-type') || 'application/json').slice(0, 100), now(), d.width, d.height, d.duration, d.pages, meta, doc.id);
  const after = db.prepare('SELECT * FROM docs WHERE id = ?').get(doc.id);
  res.set('ETag', `"${after.rev}"`).json({ rev: after.rev, size: after.size, updated_at: after.updated_at });
});

function snapshot(doc, label, author) {
  const id = newId();
  fs.mkdirSync(path.join(docDir(doc.id), 'versions'), { recursive: true });
  fs.copyFileSync(path.join(docDir(doc.id), 'data'), path.join(docDir(doc.id), 'versions', id));
  db.prepare('INSERT INTO doc_versions (id, doc_id, rev, label, size, author, created_at) VALUES (?,?,?,?,?,?,?)').run(id, doc.id, doc.rev, label, doc.size, author, now());
  // Prune unnamed versions beyond the limit (oldest first).
  const extra = db.prepare('SELECT id FROM doc_versions WHERE doc_id = ? AND label IS NULL ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(doc.id, config.versionsPerDoc);
  for (const v of extra) { fs.rmSync(path.join(docDir(doc.id), 'versions', v.id), { force: true }); db.prepare('DELETE FROM doc_versions WHERE id = ?').run(v.id); }
  return id;
}

/** Thumbnail for lists: PUT an image (PNG/JPEG/WebP, ≤ 2 MB); GET it back. */
docs.put('/docs/:id/thumb', express.raw({ type: 'image/*', limit: '2mb' }), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'no_image', 'Send an image.');
  writeAtomic(path.join(docDir(doc.id), 'thumb'), req.body);
  fs.writeFileSync(path.join(docDir(doc.id), 'thumb.type'), (req.get('content-type') || 'image/png').slice(0, 40));
  db.prepare('UPDATE docs SET has_thumb = 1 WHERE id = ?').run(doc.id);
  res.json({ thumb: `/api/docs/${doc.id}/thumb?v=${doc.rev}` });
});
docs.get('/docs/:id/thumb', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  const f = path.join(docDir(doc.id), 'thumb');
  if (!doc.has_thumb || !fs.existsSync(f)) return res.status(404).end();
  let type = 'image/png';
  try { type = fs.readFileSync(path.join(docDir(doc.id), 'thumb.type'), 'utf8'); } catch { /* png */ }
  res.set('Cache-Control', 'private, max-age=86400').type(type).sendFile(f);
});

/** PATCH /api/docs/:id { name?, starred?, meta? } */
docs.patch('/docs/:id', express.json(), (req, res) => {
  const { doc, role } = loadDoc(req, req.params.id, 'editor');
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE docs SET name = ? WHERE id = ?').run(clean(b.name, 200) || doc.name, doc.id);
  if (b.starred !== undefined && role === 'owner') db.prepare('UPDATE docs SET starred = ? WHERE id = ?').run(b.starred ? 1 : 0, doc.id);
  if (b.meta && typeof b.meta === 'object') db.prepare('UPDATE docs SET meta = ? WHERE id = ?').run(JSON.stringify(b.meta).slice(0, 8000), doc.id);
  res.json(docOut(db.prepare('SELECT * FROM docs WHERE id = ?').get(doc.id), req.user));
});

/** POST /api/docs/:id/duplicate { name? } — a copy owned by you (works for projects shared with you, too). */
docs.post('/docs/:id/duplicate', express.json(), (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  checkQuota(req.user.id, doc.size);
  const id = newId();
  const t = now();
  fs.mkdirSync(path.join(docDir(id), 'versions'), { recursive: true });
  fs.copyFileSync(path.join(docDir(doc.id), 'data'), path.join(docDir(id), 'data'));
  for (const f of ['thumb', 'thumb.type']) if (fs.existsSync(path.join(docDir(doc.id), f))) fs.copyFileSync(path.join(docDir(doc.id), f), path.join(docDir(id), f));
  db.prepare(`INSERT INTO docs (id, owner, app, name, mime, size, rev, width, height, duration, pages, has_thumb, meta, created_at, updated_at, opened_at)
    VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`).run(id, req.user.id, doc.app, clean(req.body?.name, 200) || `${doc.name} copy`, doc.mime, doc.size,
    doc.width, doc.height, doc.duration, doc.pages, doc.has_thumb, doc.meta, t, t, t);
  // Assets the project uses stay readable by the copy: link them (they're owned by the original owner).
  if (doc.owner !== req.user.id) {
    for (const a of db.prepare('SELECT * FROM assets WHERE doc_id = ?').all(doc.id)) {
      db.prepare(`INSERT INTO assets (id, owner, doc_id, name, mime, kind, size, width, height, duration, fps, has_audio, source, created_at)
        SELECT ?, ?, ?, name, mime, kind, size, width, height, duration, fps, has_audio, 'copy:' || id, ? FROM assets WHERE id = ?`).run(newId(), req.user.id, id, t, a.id);
    }
  }
  res.status(201).json(docOut(db.prepare('SELECT * FROM docs WHERE id = ?').get(id), req.user));
});

/** DELETE /api/docs/:id — to the trash; ?permanent=1 deletes it for good (and assets only it used). */
docs.delete('/docs/:id', (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'owner');
  if (!req.query.permanent) {
    db.prepare('UPDATE docs SET trashed_at = ? WHERE id = ?').run(now(), doc.id);
    return res.json({ ok: true, trashed: true });
  }
  removeDoc(doc);
  res.json({ ok: true, deleted: true });
});
docs.post('/docs/:id/restore', (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'owner');
  db.prepare('UPDATE docs SET trashed_at = NULL WHERE id = ?').run(doc.id);
  res.json(docOut(db.prepare('SELECT * FROM docs WHERE id = ?').get(doc.id), req.user));
});
docs.post('/docs/trash/empty', (req, res) => {
  const rows = db.prepare('SELECT * FROM docs WHERE owner = ? AND trashed_at IS NOT NULL').all(req.user.id);
  for (const d of rows) removeDoc(d);
  res.json({ ok: true, deleted: rows.length });
});

export function removeDoc(doc) {
  // Files uploaded into this project and not kept in Files on their own go with it.
  for (const a of db.prepare("SELECT id FROM assets WHERE doc_id = ? AND is_export = 0 AND source NOT LIKE 'keep%'").all(doc.id)) {
    fs.rmSync(path.join(config.dataDir, 'assets', a.id), { recursive: true, force: true });
    db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
  }
  fs.rmSync(docDir(doc.id), { recursive: true, force: true });
  db.prepare('DELETE FROM docs WHERE id = ?').run(doc.id);
}

// ---------------------------------------------------------------- versions

docs.get('/docs/:id/versions', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  const rows = db.prepare('SELECT v.*, u.name AS author_name FROM doc_versions v LEFT JOIN users u ON u.id = v.author WHERE v.doc_id = ? ORDER BY v.created_at DESC').all(doc.id);
  res.json({ current: { rev: doc.rev, updated_at: doc.updated_at, size: doc.size }, versions: rows.map((v) => ({ id: v.id, rev: v.rev, label: v.label, size: v.size, author: v.author_name, created_at: v.created_at })) });
});
/** POST /api/docs/:id/versions { label } — keeps the current contents as a named version. */
docs.post('/docs/:id/versions', express.json(), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  const id = snapshot(doc, clean(req.body?.label, 100) || `Version ${new Date().toLocaleString('en-US')}`, req.user.id);
  res.status(201).json({ id });
});
docs.patch('/docs/:id/versions/:vid', express.json(), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  db.prepare('UPDATE doc_versions SET label = ? WHERE id = ? AND doc_id = ?').run(clean(req.body?.label, 100) || null, req.params.vid, doc.id);
  res.json({ ok: true });
});
docs.get('/docs/:id/versions/:vid/data', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  const v = db.prepare('SELECT * FROM doc_versions WHERE id = ? AND doc_id = ?').get(req.params.vid, doc.id);
  if (!v) fail(404, 'not_found', 'Version not found.');
  res.set('Cache-Control', 'no-store').type(doc.mime).sendFile(path.join(docDir(doc.id), 'versions', v.id));
});
/** Makes a version current again (what was current is kept as a version first). */
docs.post('/docs/:id/versions/:vid/restore', (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  const v = db.prepare('SELECT * FROM doc_versions WHERE id = ? AND doc_id = ?').get(req.params.vid, doc.id);
  if (!v) fail(404, 'not_found', 'Version not found.');
  snapshot(doc, null, req.user.id);
  fs.copyFileSync(path.join(docDir(doc.id), 'versions', v.id), path.join(docDir(doc.id), 'data'));
  db.prepare('UPDATE docs SET size = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(v.size, now(), doc.id);
  res.json(docOut(db.prepare('SELECT * FROM docs WHERE id = ?').get(doc.id), req.user));
});
docs.delete('/docs/:id/versions/:vid', (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'editor');
  fs.rmSync(path.join(docDir(doc.id), 'versions', String(req.params.vid).replace(/[^\w]/g, '')), { force: true });
  db.prepare('DELETE FROM doc_versions WHERE id = ? AND doc_id = ?').run(req.params.vid, doc.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- sharing

docs.get('/docs/:id/shares', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  const rows = db.prepare('SELECT s.role, u.* FROM doc_shares s JOIN users u ON u.id = s.user_id WHERE s.doc_id = ? ORDER BY s.created_at').all(doc.id);
  res.json({ owner: userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(doc.owner)), people: rows.map((r) => ({ ...userOut(r), role: r.role })) });
});
/** POST /api/docs/:id/shares { username, role } — anyone who has signed in to SoraLab at least once. */
docs.post('/docs/:id/shares', express.json(), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'owner');
  const who = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR lower(email) = ?').get(who.split('@')[0], who);
  if (!u) fail(404, 'no_user', 'Nobody with that username has used SoraLab yet. Ask them to open SoraLab once, then try again.');
  if (u.id === doc.owner) fail(400, 'owner', 'That’s the owner.');
  const role = ['viewer', 'commenter', 'editor'].includes(req.body?.role) ? req.body.role : 'viewer';
  db.prepare(`INSERT INTO doc_shares (doc_id, user_id, role, created_at) VALUES (?,?,?,?)
    ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role`).run(doc.id, u.id, role, now());
  notifier.notify(u.id, {
    kind: 'share', app: 'soralab', title: `${req.user.name} shared “${doc.name}” with you`, body: role === 'editor' ? 'You can edit it.' : role === 'commenter' ? 'You can view and comment.' : 'You can view it.',
    url: `${config.publicUrl}/${doc.app}/${doc.id}`, icon: req.user.picture || undefined, tag: `share-${doc.id}`,
  });
  res.status(201).json({ ...userOut(u), role });
});
docs.delete('/docs/:id/shares/:userId', (req, res) => {
  const { doc, role } = loadDoc(req, req.params.id);
  const target = req.params.userId === 'me' ? req.user.id : req.params.userId; // "me": leave a project shared with you
  if (role !== 'owner' && target !== req.user.id) fail(403, 'forbidden', 'Only the owner can do that.');
  db.prepare('DELETE FROM doc_shares WHERE doc_id = ? AND user_id = ?').run(doc.id, target);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- review comments

const commentOut = (c) => ({ id: c.id, parent_id: c.parent_id, body: c.body, anchor: json(c.anchor, null), resolved: !!c.resolved, created_at: c.created_at,
  author: { id: c.author, name: c.author_name, picture: viaSecure(c.author_picture) } });
docs.get('/docs/:id/comments', (req, res) => {
  const { doc } = loadDoc(req, req.params.id);
  const rows = db.prepare(`SELECT c.*, u.name AS author_name, u.picture AS author_picture FROM doc_comments c JOIN users u ON u.id = c.author
    WHERE c.doc_id = ? ORDER BY c.created_at`).all(doc.id);
  res.json(rows.map(commentOut));
});
/** POST /api/docs/:id/comments { body, anchor?: { x, y, t, page, layer }, parent_id? } */
docs.post('/docs/:id/comments', express.json(), (req, res) => {
  const { doc } = loadDoc(req, req.params.id, 'commenter');
  const body = clean(req.body?.body, 4000);
  if (!body) fail(400, 'empty', 'Write a comment first.');
  const id = newId();
  const parent = req.body?.parent_id ? db.prepare('SELECT * FROM doc_comments WHERE id = ? AND doc_id = ?').get(req.body.parent_id, doc.id) : null;
  db.prepare('INSERT INTO doc_comments (id, doc_id, parent_id, author, body, anchor, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, doc.id, parent?.id || null, req.user.id, body, req.body?.anchor ? JSON.stringify(req.body.anchor).slice(0, 2000) : null, now());
  // Tell the owner and everyone else in the thread.
  const people = new Set([doc.owner, ...(parent ? db.prepare('SELECT author FROM doc_comments WHERE id = ? OR parent_id = ?').all(parent.id, parent.id).map((r) => r.author) : [])]);
  people.delete(req.user.id);
  notifier.notify([...people], { kind: 'comment', app: 'soralab', title: `${req.user.name} commented on “${doc.name}”`, body: body.slice(0, 200),
    url: `${config.publicUrl}/${doc.app}/${doc.id}?comment=${id}`, icon: req.user.picture || undefined });
  const c = db.prepare('SELECT c.*, u.name AS author_name, u.picture AS author_picture FROM doc_comments c JOIN users u ON u.id = c.author WHERE c.id = ?').get(id);
  res.status(201).json(commentOut(c));
});
docs.patch('/docs/:id/comments/:cid', express.json(), (req, res) => {
  const { doc, role } = loadDoc(req, req.params.id, 'commenter');
  const c = db.prepare('SELECT * FROM doc_comments WHERE id = ? AND doc_id = ?').get(req.params.cid, doc.id);
  if (!c) fail(404, 'not_found', 'Comment not found.');
  if (req.body?.resolved !== undefined) db.prepare('UPDATE doc_comments SET resolved = ? WHERE id = ?').run(req.body.resolved ? 1 : 0, c.id);
  if (req.body?.body !== undefined) {
    if (c.author !== req.user.id) fail(403, 'forbidden', 'You can only edit your own comments.');
    db.prepare('UPDATE doc_comments SET body = ? WHERE id = ?').run(clean(req.body.body, 4000) || c.body, c.id);
  }
  void role;
  res.json({ ok: true });
});
docs.delete('/docs/:id/comments/:cid', (req, res) => {
  const { doc, role } = loadDoc(req, req.params.id, 'commenter');
  const c = db.prepare('SELECT * FROM doc_comments WHERE id = ? AND doc_id = ?').get(req.params.cid, doc.id);
  if (!c) fail(404, 'not_found', 'Comment not found.');
  if (c.author !== req.user.id && role !== 'owner') fail(403, 'forbidden', 'You can only delete your own comments.');
  db.prepare('DELETE FROM doc_comments WHERE id = ? OR parent_id = ?').run(c.id, c.id);
  res.json({ ok: true });
});
