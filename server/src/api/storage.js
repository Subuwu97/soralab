// Storage cleanup: files the editors saved for themselves that nothing uses any more.
//
// Sora Kōsaku and Sora Paint store each changed layer as a new PNG (so a save only uploads what changed), Sora Audio
// keeps each edited take, Sora Eizō renders its titles to PNGs… and the old copies stay behind. A file is removed only
// when ALL of these hold:
//   - it's an editor's own file: source 'autosave' (set by the save helpers), or, for files from before that mark
//     existed, one that belongs to a project (doc_id set);
//   - it isn't an export, kept in Files ('keep…': uploads and library items), a library item's file, the original of a
//     project copy ('copy:<id>') or a render's output;
//   - nothing mentions it: not the current contents of any project (anyone's, the trash included), not any kept version,
//     not a project's meta or doc_refs, nor a library item's data, someone's settings or a render that's still waiting;
//   - it was made, and last mentioned by a save (assets.used_at), longer ago than the grace period (24 h). So saves in
//     flight, and layers that Undo may bring back, are left alone.
// Mentions are found the way updateRefs finds them: 12-letter ids. Here they're also matched outside quotes (in URLs,
// in contents that aren't JSON), reading the raw bytes, so a file is kept whenever in doubt.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, now, json } from '../db.js';
import { requireUser } from '../auth.js';
import { h, docDir, assetDir } from './util.js';

export const storage = express.Router();
storage.use('/storage', requireUser);

const state = {
  get: (k) => json(db.prepare('SELECT value FROM server_state WHERE key = ?').get(k)?.value, null),
  set: (k, v) => db.prepare('INSERT INTO server_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v)),
};
// When the editors started marking their own files. Older files are only candidates when they belong to a project.
if (state.get('autosave_mark_since') === null) state.set('autosave_mark_since', now());

// ---------------------------------------------------------------- finding mentions

const TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9]{12}(?![A-Za-z0-9])/g;
const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const scanText = (s, ids) => { if (s) for (const m of String(s).matchAll(TOKEN)) ids.add(m[0]); };

/** Adds every id-shaped token in a file. Read in 1 MB chunks; a run of letters cut by a chunk's end is carried over. */
function scanFile(file, ids) {
  return new Promise((resolve, reject) => {
    let carry = '';
    const rs = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 20 });
    rs.on('data', (chunk) => {
      const s = carry + chunk;
      let i = s.length;
      while (i > 0 && isAlnum(s.charCodeAt(i - 1))) i--;
      scanText(s.slice(0, i), ids);
      carry = s.slice(i);
      if (carry.length > 13) carry = carry.slice(-13); // still longer than an id, so it can't become one
    });
    rs.on('end', () => { scanText(carry, ids); resolve(); });
    rs.on('error', (e) => (e.code === 'ENOENT' ? resolve() : reject(e))); // any other read error stops the cleanup
  });
}

/** Ids mentioned anywhere a file can be in use. */
async function mentioned() {
  const ids = new Set();
  const versions = db.prepare('SELECT id FROM doc_versions WHERE doc_id = ?');
  for (const d of db.prepare('SELECT id, meta FROM docs').all()) {
    scanText(d.meta, ids);
    await scanFile(path.join(docDir(d.id), 'data'), ids);
    for (const v of versions.all(d.id)) await scanFile(path.join(docDir(d.id), 'versions', v.id), ids);
  }
  for (const r of db.prepare('SELECT data FROM library_items').all()) scanText(r.data, ids);
  for (const r of db.prepare('SELECT settings FROM users').all()) scanText(r.settings, ids);
  for (const r of db.prepare("SELECT spec FROM jobs WHERE status IN ('queued', 'running')").all()) scanText(r.spec, ids);
  for (const r of db.prepare("SELECT substr(source, 6) id FROM assets WHERE source LIKE 'copy:%'").all()) ids.add(r.id);
  return ids;
}

// ---------------------------------------------------------------- the cleanup

const candidates = db.prepare(`SELECT a.id, a.owner, a.doc_id, a.name, a.size, a.source, a.created_at, a.used_at FROM assets a
  WHERE a.is_export = 0
    AND (a.source = 'autosave' OR (a.created_at < @mark AND a.doc_id IS NOT NULL
      AND COALESCE(a.source, '') NOT LIKE 'keep%' AND COALESCE(a.source, '') NOT LIKE 'copy:%' AND COALESCE(a.source, '') != 'export'))
    AND MAX(a.created_at, COALESCE(a.used_at, 0)) < @cutoff
    AND NOT EXISTS (SELECT 1 FROM library_items li WHERE li.asset_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM doc_refs r WHERE r.asset_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.output_id = a.id)
    AND (@owner IS NULL OR a.owner = @owner)
  ORDER BY a.created_at`);
const cutoffNow = () => now() - config.cleanupGraceHours * 3600e3;

async function findUnused(owner) {
  const cutoff = cutoffNow();
  const rows = candidates.all({ mark: state.get('autosave_mark_since') || 0, cutoff, owner: owner || null });
  if (!rows.length) return { rows, cutoff };
  const ids = await mentioned();
  return { rows: rows.filter((a) => !ids.has(a.id)), cutoff };
}

const itemOut = (a) => ({ id: a.id, name: a.name, size: a.size, owner: a.owner, doc_id: a.doc_id, source: a.source, created_at: a.created_at });
const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;

// The count the Files and Admin pages show is cached for a short while (they ask on every visit); a real run clears it.
const counts = new Map();
let chain = Promise.resolve();

/**
 * Removes unused files, everyone's or one person's (owner). dryRun: only says what would go (cached: may reuse a
 * count from the last 30 s). Returns { files, bytes, at, by } (and items for a dry run). Real runs happen one at a time.
 */
export function cleanUp({ owner = null, dryRun = false, cached = false, by = 'schedule' } = {}) {
  if (dryRun) {
    const key = owner || '*';
    const hit = counts.get(key);
    if (cached && hit && now() - hit.t < 30e3) return hit.p;
    const p = findUnused(owner).then(({ rows }) => ({ dry_run: true, files: rows.length, bytes: rows.reduce((n, a) => n + a.size, 0), items: rows.slice(0, 200).map(itemOut) }));
    counts.set(key, { t: now(), p });
    p.catch(() => counts.delete(key));
    return p;
  }
  const run = async () => {
    const { rows, cutoff } = await findUnused(owner);
    const recheck = db.transaction((a) => {
      // A save may have mentioned it while the projects were being read.
      const row = db.prepare('SELECT created_at, used_at FROM assets WHERE id = ?').get(a.id);
      if (!row || Math.max(row.created_at, row.used_at || 0) >= cutoff) return false;
      if (db.prepare('SELECT 1 FROM doc_refs WHERE asset_id = ? UNION SELECT 1 FROM library_items WHERE asset_id = ?').get(a.id, a.id)) return false;
      db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
      return true;
    });
    let files = 0; let bytes = 0;
    for (const a of rows) {
      if (!recheck(a)) continue;
      fs.rmSync(assetDir(a.id), { recursive: true, force: true });
      files++; bytes += a.size;
      console.log(`[storage] removed unused file ${a.id} “${a.name}” (${a.source || 'upload'}, ${MB(a.size)}, owner ${a.owner}${a.doc_id ? `, project ${a.doc_id}` : ''})`);
    }
    const out = { at: now(), files, bytes, by, owner };
    state.set('cleanup_last', out);
    counts.clear();
    console.log(`[storage] cleanup (${by}${owner ? `, ${owner}` : ''}): removed ${files} file${files === 1 ? '' : 's'}, ${MB(bytes)}`);
    return out;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export const lastCleanup = () => state.get('cleanup_last');

/** The background job: a few minutes after start, then every CLEANUP_EVERY_HOURS (default 6). */
export function scheduleCleanup() {
  if (!(config.cleanupEveryHours > 0)) return;
  const go = () => cleanUp({ by: 'schedule' }).catch((e) => console.warn('[storage] cleanup failed, nothing was removed:', e.message));
  setTimeout(go, 5 * 60e3).unref();
  setInterval(go, config.cleanupEveryHours * 3600e3).unref();
}

// ---------------------------------------------------------------- per person (Files → storage)

/** GET /api/storage/unused — how much of your storage the cleanup could free. */
storage.get('/storage/unused', h(async (req, res) => {
  const r = await cleanUp({ owner: req.user.id, dryRun: true, cached: true });
  res.json({ files: r.files, bytes: r.bytes, grace_hours: config.cleanupGraceHours });
}));
/** POST /api/storage/cleanup { dry_run? } — frees your unused files now. */
storage.post('/storage/cleanup', express.json(), h(async (req, res) => {
  res.json(await cleanUp({ owner: req.user.id, dryRun: !!req.body?.dry_run, by: 'person' }));
}));
