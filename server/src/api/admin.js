// Server admins (Mirai Account admins): storage per person, suspend access, render queue overview.
import express from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { fail, usageOf, quotaOf, userOut } from './util.js';
import { renderInfo } from '../render.js';
import { h } from './util.js';
import { config } from '../config.js';
import { cleanUp, lastCleanup } from './storage.js';

export const admin = express.Router();
admin.use(requireAdmin);

admin.get('/overview', h(async (req, res) => {
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    people: count('SELECT COUNT(*) n FROM users'), projects: count('SELECT COUNT(*) n FROM docs WHERE trashed_at IS NULL'),
    files: count('SELECT COUNT(*) n FROM assets'), storage: count('SELECT COALESCE(SUM(size),0) n FROM assets') + count('SELECT COALESCE(SUM(size),0) n FROM docs') + count('SELECT COALESCE(SUM(size),0) n FROM fonts'),
    renders: { queued: count("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'"), running: count("SELECT COUNT(*) n FROM jobs WHERE status = 'running'"), failed: count("SELECT COUNT(*) n FROM jobs WHERE status = 'failed'") },
    by_app: db.prepare('SELECT app, COUNT(*) n FROM docs WHERE trashed_at IS NULL GROUP BY app ORDER BY n DESC').all(),
    render: await renderInfo(), quota: quotaOf(),
  });
}));

admin.get('/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json(rows.map((u) => ({ ...userOut(u), email: u.email, is_admin: !!u.is_admin, disabled: !!u.disabled, created_at: u.created_at,
    projects: db.prepare('SELECT COUNT(*) n FROM docs WHERE owner = ?').get(u.id).n, storage: usageOf(u.id).total })));
});

/** PATCH /api/admin/users/:id { disabled } — suspended people are signed out of SoraLab and can't sign back in. */
admin.patch('/users/:id', express.json(), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) fail(404, 'not_found', 'No such person.');
  if (u.id === req.user.id) fail(400, 'self', 'You can’t suspend yourself.');
  if (req.body?.disabled !== undefined) db.prepare('UPDATE users SET disabled = ?, session_ver = session_ver + 1 WHERE id = ?').run(req.body.disabled ? 1 : 0, u.id);
  res.json({ ok: true });
});

admin.get('/jobs', (req, res) => {
  res.json(db.prepare(`SELECT j.id, j.name, j.kind, j.status, j.progress, j.error, j.encoder, j.created_at, j.finished_at, u.name AS owner_name
    FROM jobs j JOIN users u ON u.id = j.owner ORDER BY j.created_at DESC LIMIT 200`).all());
});

// Storage cleanup (see storage.js): what it could free now, the last run, and "Clean up now" (or a dry run).
admin.get('/storage', h(async (req, res) => {
  const r = await cleanUp({ dryRun: true, cached: true });
  res.json({ unused: { files: r.files, bytes: r.bytes }, last_run: lastCleanup(), grace_hours: config.cleanupGraceHours, every_hours: config.cleanupEveryHours });
}));
/** POST /api/admin/storage/cleanup { dry_run? } */
admin.post('/storage/cleanup', express.json(), h(async (req, res) => {
  res.json(await cleanUp({ dryRun: !!req.body?.dry_run, by: 'admin' }));
}));
