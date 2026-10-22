// Files: images, video, audio and PDFs used in projects or kept in Files (Bridge), plus exports.
// Video and images get previews made by ffmpeg; codecs a browser can't play get a browser-friendly copy.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, newId, now, json } from '../db.js';
import { requireUser } from '../auth.js';
import { h, fail, safeName, loadDoc, loadAsset, assetDir, assetFile, checkQuota } from './util.js';
import { run, runBuffer, probe } from '../proc.js';

export const assets = express.Router();
assets.use('/assets', requireUser);

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', psd: 'image/vnd.adobe.photoshop', ico: 'image/x-icon',
  cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw', dng: 'image/x-adobe-dng', raf: 'image/x-fuji-raf', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mts: 'video/mp2t', ts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', aif: 'audio/aiff', aiff: 'audio/aiff', wma: 'audio/x-ms-wma',
  pdf: 'application/pdf', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv', srt: 'application/x-subrip', vtt: 'text/vtt', cube: 'text/plain', zip: 'application/zip',
  sora: 'application/json',
};
export const mimeOf = (name, given) => {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  if (EXT_MIME[ext] && (!given || given === 'application/octet-stream' || /^image\/x-|tiff|heic/.test(EXT_MIME[ext]))) return EXT_MIME[ext];
  return given && given !== 'application/octet-stream' ? given : EXT_MIME[ext] || 'application/octet-stream';
};
export const kindOf = (mime) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio'
  : mime === 'application/pdf' ? 'pdf' : mime.startsWith('font/') ? 'font' : 'other');
// What browsers show / play as-is. Everything else gets a converted copy for previews and editing.
const WEB_IMAGES = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/;
const WEB_VCODECS = ['h264', 'vp8', 'vp9', 'av1'];
const WEB_ACODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8'];

export function assetOut(a) {
  return {
    id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, width: a.width, height: a.height, duration: a.duration, fps: a.fps, has_audio: a.has_audio === null ? null : !!a.has_audio,
    doc_id: a.doc_id, is_export: !!a.is_export, source: a.source, created_at: a.created_at, meta: json(a.meta),
    url: `/api/assets/${a.id}/file`,
    // Use this for <img>/<video>/<audio>/canvas: the original when the browser can handle it, else the converted copy.
    web_url: a.web === 2 ? `/api/assets/${a.id}/web` : a.web === 0 ? `/api/assets/${a.id}/file` : null,
    web_status: a.web === 1 ? 'processing' : a.web === -1 ? 'failed' : 'ready',
    thumb: ['image', 'video', 'pdf'].includes(a.kind) ? `/api/assets/${a.id}/thumb` : null,
  };
}

/**
 * Stores a file that's already on disk (moved, not copied) as an asset and returns the row.
 * Used by uploads, Cloud imports and renders.
 */
export async function storeAsset(userId, tmpPath, { name, mime, docId = null, isExport = false, source = 'upload' }) {
  const id = newId();
  const dir = assetDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'file');
  try { fs.renameSync(tmpPath, dest); } catch { fs.copyFileSync(tmpPath, dest); fs.rmSync(tmpPath, { force: true }); }
  const size = fs.statSync(dest).size;
  const m = mimeOf(name, mime);
  let kind = kindOf(m);
  let info = null;
  if (kind === 'video' || kind === 'audio' || (kind === 'image' && !/svg/.test(m))) info = await probe(dest);
  if (kind === 'video' && info && !info.hasVideo && info.hasAudio) kind = 'audio';
  let web = 0;
  if (kind === 'image' && !WEB_IMAGES.test(m)) web = 1;
  if (kind === 'video' && info && (!WEB_VCODECS.includes(info.vcodec) || (info.acodec && !WEB_ACODECS.includes(info.acodec)) || /matroska|avi|mpegts|flv|asf/.test(info.format || '') && !/webm/.test(info.format))) web = 1;
  if (kind === 'audio' && info && info.acodec && !WEB_ACODECS.includes(info.acodec)) web = 1;
  db.prepare(`INSERT INTO assets (id, owner, doc_id, name, mime, kind, size, width, height, duration, fps, has_audio, is_export, source, web, meta, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, docId, safeName(name, 'file'), m, kind, size, info?.width || null, info?.height || null,
    kind === 'image' ? null : info?.duration || null, info?.fps || null, info ? (info.hasAudio ? 1 : 0) : null, isExport ? 1 : 0, source, web,
    JSON.stringify(info ? { vcodec: info.vcodec, acodec: info.acodec, format: info.format } : {}), now());
  if (web === 1) makeWebCopy(id);
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

// Browser-friendly copies are made one at a time in the background.
let webChain = Promise.resolve();
function makeWebCopy(id) {
  webChain = webChain.then(async () => {
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!a) return;
    const src = assetFile(id);
    const out = path.join(assetDir(id), 'web');
    try {
      if (a.kind === 'image') {
        await run(config.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', out], { timeout: 120000 });
        const info = await probe(out);
        if (info?.width) db.prepare('UPDATE assets SET width = ?, height = ? WHERE id = ?').run(info.width, info.height, id);
      } else if (a.kind === 'video') {
        // Editing copy: H.264 up to 1080p with AAC, keyframe every second for snappy scrubbing.
        const { videoProfile, inputArgs, encoderArgs } = await import('../hwaccel.js');
        const p = await videoProfile();
        const args = (prof) => ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs(prof, { hwDecode: false }), '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale='min(1920,iw)':-2${prof.tail || ''}`, ...encoderArgs(prof), ...(prof.gpu ? ['-b:v', '8M'] : ['-crf', '20']), '-g', String(Math.round(a.fps || 30)),
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', out];
        try { await run(config.ffmpeg, args(p), { timeout: 6 * 3600e3 }); } catch (e) { if (!p.gpu) throw e; const { CPU } = await import('../hwaccel.js'); await run(config.ffmpeg, args(CPU), { timeout: 6 * 3600e3 }); }
      } else if (a.kind === 'audio') {
        await run(config.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-c:a', 'flac', '-f', 'flac', out], { timeout: 3600e3 });
      }
      db.prepare('UPDATE assets SET web = 2 WHERE id = ?').run(id);
    } catch (e) {
      console.warn(`[assets] couldn’t convert ${a.name}: ${e.message}`);
      db.prepare('UPDATE assets SET web = -1 WHERE id = ?').run(id);
    }
  });
}
/** Assets left half-converted when the server stopped. */
export function resumeWebCopies() {
  for (const a of db.prepare('SELECT id FROM assets WHERE web = 1').all()) makeWebCopy(a.id);
}

const upload = multer({
  dest: path.join(config.dataDir, 'tmp'),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 50 },
});

/** POST /api/assets (multipart: file or files[], doc_id?) — returns the stored files. */
assets.post('/assets', upload.any(), h(async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) fail(400, 'no_file', 'Choose a file to upload.');
    const docId = req.body.doc_id ? loadDoc(req, req.body.doc_id, 'editor').doc.id : null;
    checkQuota(req.user.id, files.reduce((n, f) => n + f.size, 0));
    const out = [];
    for (const f of files) out.push(assetOut(await storeAsset(req.user.id, f.path, { name: Buffer.from(f.originalname, 'latin1').toString('utf8'), mime: f.mimetype, docId })));
    res.status(201).json(out.length === 1 && !req.query.many ? out[0] : out);
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }
}));

/**
 * POST /api/assets/raw?name=&doc_id=&export=1&source=autosave — the body is the file. For things made in the browser:
 * PNG/JPEG/PDF/SVG exports, recorded audio, rendered animation, layer bitmaps.
 */
assets.post('/assets/raw', h(async (req, res) => {
  const name = safeName(req.query.name, 'export');
  const docId = req.query.doc_id ? loadDoc(req, req.query.doc_id, 'viewer').doc.id : null;
  const len = Number(req.get('content-length') || 0);
  if (len > config.maxUploadMb * 1024 * 1024) fail(413, 'too_large', `Files can be up to ${config.maxUploadMb} MB.`);
  checkQuota(req.user.id, len);
  const tmp = path.join(config.dataDir, 'tmp', `raw-${newId()}`);
  await new Promise((resolve, reject) => {
    let n = 0;
    const ws = fs.createWriteStream(tmp);
    req.on('data', (c) => { n += c.length; if (n > config.maxUploadMb * 1024 * 1024) { req.destroy(); reject(Object.assign(new Error('too large'), { code: 'LIMIT_FILE_SIZE' })); } });
    req.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    req.on('error', reject);
  }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
  // source=autosave: an editor's own working file (a layer's pixels, an edited take). The storage cleanup may remove it
  // once no project or version uses it any more (api/storage.js).
  const source = req.query.export ? 'export' : req.query.source === 'autosave' ? 'autosave' : 'upload';
  const a = await storeAsset(req.user.id, tmp, { name, mime: req.get('content-type'), docId, isExport: !!req.query.export, source });
  res.status(201).json(assetOut(a));
}));

/** GET /api/assets?doc_id=&kind=&exports=1&q=&limit= */
assets.get('/assets', (req, res) => {
  const where = [];
  const args = { me: req.user.id };
  if (req.query.doc_id) { loadDoc(req, req.query.doc_id); where.push('doc_id = @doc'); args.doc = String(req.query.doc_id); } else where.push('owner = @me');
  if (req.query.kind) { where.push('kind = @kind'); args.kind = String(req.query.kind); }
  if (req.query.exports) where.push('is_export = 1');
  if (req.query.q) { where.push('lower(name) LIKE @q'); args.q = `%${String(req.query.q).toLowerCase().replace(/[%_]/g, '').slice(0, 100)}%`; }
  const limit = Math.min(1000, Number(req.query.limit) || 300);
  res.json(db.prepare(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`).all(args).map(assetOut));
});

assets.get('/assets/:id', (req, res) => res.json(assetOut(loadAsset(req, req.params.id))));

const safeHeaders = (res, a, download) => {
  res.set('X-Content-Type-Options', 'nosniff');
  // Files are the person's own, but never let one run as a page on this origin.
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (download || !/^(image\/(?!svg)|video\/|audio\/|application\/pdf|font\/)/.test(a.mime)) res.attachment(a.name);
};

assets.get('/assets/:id/file', (req, res) => {
  const a = loadAsset(req, req.params.id);
  safeHeaders(res, a, !!req.query.download);
  res.type(a.mime).sendFile(assetFile(a.id));
});
assets.get('/assets/:id/web', (req, res) => {
  const a = loadAsset(req, req.params.id);
  const f = path.join(assetDir(a.id), a.web === 2 ? 'web' : 'file');
  safeHeaders(res, a, false);
  res.type(a.web !== 2 ? a.mime : a.kind === 'image' ? 'image/png' : a.kind === 'video' ? 'video/mp4' : 'audio/flac').sendFile(f);
});

/** Small preview (JPEG): an image, a video frame, or a PDF's first page. */
assets.get('/assets/:id/thumb', h(async (req, res) => {
  const a = loadAsset(req, req.params.id);
  const out = path.join(assetDir(a.id), 'thumb.jpg');
  if (!fs.existsSync(out)) {
    const src = a.web === 2 ? path.join(assetDir(a.id), 'web') : assetFile(a.id);
    try {
      if (a.kind === 'pdf') fail(404, 'no_thumb', 'No preview.'); // PDFs are previewed in the browser (pdf.js)
      await run(config.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...(a.kind === 'video' && a.duration > 4 ? ['-ss', String(Math.min(a.duration / 3, 10))] : []),
        '-i', src, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '4', out], { timeout: 60000 });
    } catch (e) { if (e.status) throw e; return res.status(404).end(); }
  }
  res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').sendFile(out);
}));

/** GET /api/assets/:id/frame?t=&w= — one video frame (JPEG), for timeline filmstrips and scrubbing. */
assets.get('/assets/:id/frame', h(async (req, res) => {
  const a = loadAsset(req, req.params.id);
  if (a.kind !== 'video') fail(400, 'not_video', 'Not a video.');
  const t = Math.max(0, Math.min(Number(req.query.t) || 0, Math.max(0, (a.duration || 0) - 0.05)));
  const w = Math.max(32, Math.min(1920, Number(req.query.w) || 160));
  const src = a.web === 2 ? path.join(assetDir(a.id), 'web') : assetFile(a.id);
  const buf = await runBuffer(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { timeout: 30000 });
  res.set('Cache-Control', 'private, max-age=31536000, immutable').type('image/jpeg').send(buf);
}));

/** GET /api/assets/:id/peaks?n=2000 — waveform: n pairs of [min, max] in -1..1 (cached), for audio and video. */
assets.get('/assets/:id/peaks', h(async (req, res) => {
  const a = loadAsset(req, req.params.id);
  if (!['audio', 'video'].includes(a.kind)) fail(400, 'no_audio', 'This file has no sound.');
  const n = Math.max(100, Math.min(20000, Number(req.query.n) || 2000));
  const cache = path.join(assetDir(a.id), `peaks-${n}.json`);
  if (!fs.existsSync(cache)) {
    const src = a.web === 2 ? path.join(assetDir(a.id), 'web') : assetFile(a.id);
    let pcm;
    try { pcm = await runBuffer(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { timeout: 600000 }); }
    catch { pcm = Buffer.alloc(0); }
    const samples = Math.floor(pcm.length / 2);
    const per = Math.max(1, Math.floor(samples / n));
    const peaks = [];
    for (let i = 0; i < samples && peaks.length < n; i += per) {
      let lo = 0; let hi = 0;
      for (let j = i; j < Math.min(samples, i + per); j++) { const v = pcm.readInt16LE(j * 2) / 32768; if (v < lo) lo = v; if (v > hi) hi = v; }
      peaks.push([Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000]);
    }
    fs.writeFileSync(cache, JSON.stringify({ duration: a.duration || samples / 8000, peaks }));
  }
  res.set('Cache-Control', 'private, max-age=31536000, immutable').type('application/json').sendFile(cache);
}));

/** PATCH /api/assets/:id { name?, doc_id? (null = keep in Files only) } */
assets.patch('/assets/:id', express.json(), (req, res) => {
  const a = loadAsset(req, req.params.id, { write: true });
  if (req.body?.name !== undefined) db.prepare('UPDATE assets SET name = ? WHERE id = ?').run(safeName(req.body.name, a.name), a.id);
  if (req.body?.doc_id !== undefined) {
    const docId = req.body.doc_id ? loadDoc(req, req.body.doc_id, 'editor').doc.id : null;
    db.prepare('UPDATE assets SET doc_id = ? WHERE id = ?').run(docId, a.id);
  }
  if (req.body?.keep !== undefined) db.prepare("UPDATE assets SET source = CASE WHEN ? THEN 'keep:' || COALESCE(source,'') ELSE replace(source, 'keep:', '') END WHERE id = ?").run(req.body.keep ? 1 : 0, a.id);
  res.json(assetOut(db.prepare('SELECT * FROM assets WHERE id = ?').get(a.id)));
});

assets.delete('/assets/:id', (req, res) => {
  const a = loadAsset(req, req.params.id, { write: true });
  fs.rmSync(assetDir(a.id), { recursive: true, force: true });
  db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

