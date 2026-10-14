// Render queue (Encoder): exports of Cut timelines and file conversions, run in the background with ffmpeg.
// When a job finishes the result is a file in Exports; it can also go straight to Minami Cloud or Tsunami.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, newId, now, json } from '../db.js';
import { requireUser } from '../auth.js';
import { h, fail, clean, safeName, loadDoc, loadAsset, checkQuota } from './util.js';
import { storeAsset, assetOut } from './assets.js';
import { render, renderInfo, transcodeToTimeline, outputMime, PRESETS } from '../render.js';
import { putToCloud, publishToTsunami } from './suite.js';
import { notifier } from '../notify.js';

export const jobs = express.Router();
jobs.use(['/jobs', '/render'], requireUser);

const EXT = { mp4: 'mp4', mov: 'mov', webm: 'webm', mkv: 'mkv', gif: 'gif', png: 'png', mp3: 'mp3', m4a: 'm4a', wav: 'wav', flac: 'flac', ogg: 'ogg', aac: 'aac', opus: 'ogg' };

function jobOut(j) {
  const out = j.output_id ? db.prepare('SELECT * FROM assets WHERE id = ?').get(j.output_id) : null;
  const spec = json(j.spec);
  return {
    id: j.id, kind: j.kind, name: j.name, doc_id: j.doc_id, status: j.status, progress: j.progress, error: j.error, encoder: j.encoder,
    output: out ? assetOut(out) : null, after: json(j.after, null), after_result: json(j.after_result, null),
    format: spec.output || null, created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at,
    // For the Encoder's list: what was converted, and the size/trim asked for.
    source: j.kind === 'transcode' ? sourceOf(spec.asset_id) : null,
    settings: { preset: spec.preset || null, width: spec.width || null, height: spec.height || null, fps: spec.fps || null, trim: spec.trim || spec.range || null },
  };
}

function sourceOf(id) {
  const a = id ? db.prepare('SELECT id, name, kind, duration FROM assets WHERE id = ?').get(String(id)) : null;
  return a ? { id: a.id, name: a.name, kind: a.kind, duration: a.duration } : null;
}

jobs.get('/render/info', h(async (req, res) => res.json(await renderInfo())));

/** GET /api/jobs?doc_id=&active=1 */
jobs.get('/jobs', (req, res) => {
  const where = ['owner = @me'];
  const args = { me: req.user.id };
  if (req.query.doc_id) { where.push('doc_id = @doc'); args.doc = String(req.query.doc_id); }
  if (req.query.active) where.push("status IN ('queued','running')");
  res.json(db.prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`).all(args).map(jobOut));
});
jobs.get('/jobs/:id', (req, res) => res.json(jobOut(loadJob(req))));

function loadJob(req) {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ? AND owner = ?').get(String(req.params.id), req.user.id);
  if (!j) fail(404, 'not_found', 'Render not found.');
  return j;
}

/**
 * POST /api/jobs
 *   { kind: 'timeline', name, doc_id?, spec: <timeline spec, see render.js>, after? }
 *   { kind: 'transcode', name?, doc_id?, spec: { asset_id, preset? | output, width?, height?, fps?, trim?, fit? }, after? }
 * after: { cloud: { folder_id }, tsunami: { title, description, visibility } }
 */
jobs.post('/jobs', express.json({ limit: '20mb' }), h(async (req, res) => {
  const b = req.body || {};
  if (!['timeline', 'transcode'].includes(b.kind)) fail(400, 'bad_kind', 'kind must be timeline or transcode.');
  const docId = b.doc_id ? loadDoc(req, b.doc_id).doc.id : null;
  const spec = b.spec && typeof b.spec === 'object' ? { ...b.spec } : fail(400, 'no_spec', 'Missing spec.');
  if (spec.preset) {
    const p = PRESETS.find((x) => x.id === spec.preset);
    if (!p) fail(400, 'bad_preset', 'Unknown preset.');
    spec.output = { ...p.output, ...(spec.output || {}) };
    if (b.kind === 'transcode') { spec.width ??= p.width; spec.height ??= p.height; }
  }
  spec.output ||= { container: 'mp4', vcodec: 'h264', quality: 'high' };
  if (!EXT[spec.output.container]) fail(400, 'bad_format', 'Unknown output format.');
  let name = clean(b.name, 150);
  // Check every file the render needs is reachable now, so the job doesn't fail later.
  const ids = b.kind === 'transcode' ? [spec.asset_id]
    : [...(spec.video || []), ...(spec.audio || [])].flatMap((t) => (t.clips || []).flatMap((c) => [c.asset_id, ...(c.effects || []).map((e) => e?.asset_id)])).filter(Boolean);
  for (const id of new Set(ids)) loadAsset(req, id);
  if (b.kind === 'transcode') name ||= db.prepare('SELECT name FROM assets WHERE id = ?').get(spec.asset_id).name.replace(/\.[^.]+$/, '');
  checkQuota(req.user.id);
  const after = b.after && typeof b.after === 'object' ? {
    ...(b.after.cloud ? { cloud: { folder_id: String(b.after.cloud.folder_id || 'root') } } : {}),
    ...(b.after.tsunami ? { tsunami: { title: clean(b.after.tsunami.title, 100), description: clean(b.after.tsunami.description, 5000),
      visibility: ['public', 'unlisted', 'private'].includes(b.after.tsunami.visibility) ? b.after.tsunami.visibility : 'private' } } : {}),
  } : null;
  const id = newId();
  db.prepare('INSERT INTO jobs (id, owner, doc_id, kind, name, spec, after, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, docId, b.kind, name || 'Export', JSON.stringify(spec), after ? JSON.stringify(after) : null, now());
  pump();
  res.status(201).json(jobOut(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)));
}));

jobs.post('/jobs/:id/cancel', (req, res) => {
  const j = loadJob(req);
  if (j.status === 'queued') db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), j.id);
  else if (j.status === 'running') running.get(j.id)?.abort();
  res.json({ ok: true });
});
jobs.post('/jobs/:id/retry', (req, res) => {
  const j = loadJob(req);
  if (!['failed', 'cancelled'].includes(j.status)) fail(400, 'not_finished', 'Only failed or cancelled renders can be retried.');
  db.prepare("UPDATE jobs SET status = 'queued', progress = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?").run(j.id);
  pump();
  res.json(jobOut(db.prepare('SELECT * FROM jobs WHERE id = ?').get(j.id)));
});
/** Removes it from the list (the exported file stays in Exports). */
jobs.delete('/jobs/:id', (req, res) => {
  const j = loadJob(req);
  if (j.status === 'running') running.get(j.id)?.abort();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
  res.json({ ok: true });
});
jobs.post('/jobs/clear', (req, res) => {
  const n = db.prepare("DELETE FROM jobs WHERE owner = ? AND status IN ('done','failed','cancelled')").run(req.user.id).changes;
  res.json({ ok: true, deleted: n });
});

// ---------------------------------------------------------------- the queue

const running = new Map(); // job id → AbortController

export function pump() {
  while (running.size < config.renderJobs) {
    const j = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
    if (!j) return;
    const ac = new AbortController();
    running.set(j.id, ac);
    db.prepare("UPDATE jobs SET status = 'running', started_at = ?, progress = 0 WHERE id = ?").run(now(), j.id);
    runJob(j, ac.signal).finally(() => { running.delete(j.id); pump(); });
  }
}

/** Renders interrupted by a restart start again. */
export function resumeJobs() {
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
  pump();
}

async function runJob(j, signal) {
  const spec0 = json(j.spec);
  const dir = path.join(config.dataDir, 'jobs', j.id);
  fs.mkdirSync(dir, { recursive: true });
  const o = spec0.output;
  const out = path.join(dir, `out.${EXT[o.container]}`);
  let lastSave = 0;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(j.owner);
  try {
    let spec = spec0;
    if (j.kind === 'transcode') {
      const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(spec0.asset_id);
      if (!a) throw new Error('The file to convert was deleted.');
      spec = transcodeToTimeline(spec0, a);
    }
    await render(spec, out, {
      signal,
      onEncoder: (label) => db.prepare('UPDATE jobs SET encoder = ? WHERE id = ?').run(label, j.id),
      onProgress: (p) => { if (Date.now() - lastSave > 700 || p === 1) { lastSave = Date.now(); db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(p, j.id); } },
    });
    const asset = await storeAsset(j.owner, out, { name: `${safeName(j.name, 'Export')}.${EXT[o.container]}`, mime: outputMime(o), docId: j.doc_id, isExport: true, source: `render:${j.id}` });
    db.prepare("UPDATE jobs SET status = 'done', progress = 1, output_id = ?, finished_at = ? WHERE id = ?").run(asset.id, now(), j.id);
    // Then: Minami Cloud and/or Tsunami.
    const after = json(j.after, null);
    const result = {};
    if (after?.cloud) {
      try { result.cloud = await putToCloud(user, path.join(config.dataDir, 'assets', asset.id, 'file'), { folderId: after.cloud.folder_id, name: asset.name, mime: asset.mime }); }
      catch (e) { result.cloud = { error: e.message }; }
    }
    if (after?.tsunami) {
      try { result.tsunami = await publishToTsunami(user, path.join(config.dataDir, 'assets', asset.id, 'file'), { ...after.tsunami, title: after.tsunami.title || j.name, name: asset.name }); }
      catch (e) { result.tsunami = { error: e.message }; }
    }
    if (after) db.prepare('UPDATE jobs SET after_result = ? WHERE id = ?').run(JSON.stringify(result), j.id);
    notifier.notify(j.owner, {
      kind: 'render_done', app: 'soralab', title: `“${j.name}” is ready`,
      body: result.tsunami?.id ? 'Exported and sent to Tsunami — it’s processing there now.' : result.cloud?.id ? 'Exported and saved to Minami Cloud.' : 'Your export finished. Download it from Exports.',
      url: `${config.publicUrl}/encoder?job=${j.id}`, tag: `job-${j.id}`,
    });
  } catch (e) {
    const cancelled = signal.aborted;
    db.prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(cancelled ? 'cancelled' : 'failed', cancelled ? null : e.message.slice(0, 1000), now(), j.id);
    if (!cancelled) {
      console.warn(`[render] ${j.id} failed: ${e.message}`);
      notifier.notify(j.owner, { kind: 'render_failed', app: 'soralab', title: `“${j.name}” couldn’t be exported`, body: e.message.slice(0, 200), url: `${config.publicUrl}/encoder?job=${j.id}`, tag: `job-${j.id}` });
    }
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}
