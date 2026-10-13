// Opening and saving projects.
//
//   const project = useProject(id)
//   project.doc        metadata { id, app, name, rev, role, width, height, … } (null while loading)
//   project.data       the contents as saved (parsed JSON), loaded once — keep your live copy in useHistory()
//   project.error      Error if it couldn't be opened
//   project.canEdit    false for viewers / commenters
//   project.save(data, { thumb: Blob|canvas, width, height, duration, pages, meta })  → saves now (JSON or Blob)
//   project.saving / project.savedAt / project.saveError
//   project.rename(name)
//
// The editor shell autosaves: pass it `dirty` (true when there are unsaved changes) and `getData` (returns what to save).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { confirmDialog, toast } from '../components/ui.jsx';

export function useProject(id) {
  const [doc, setDoc] = useState(null);
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const rev = useRef(null);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let off = false;
    setDoc(null); setData(undefined); setError(null);
    (async () => {
      try {
        const meta = await api.get(`/api/docs/${id}?open=1`);
        const r = await fetch(`/api/docs/${id}/data`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new ApiError('Couldn’t open this project.', r.status);
        const body = /json/.test(r.headers.get('content-type') || '') ? await r.json().catch(() => ({})) : await r.blob();
        if (off) return;
        rev.current = Number(r.headers.get('x-rev')) || meta.rev;
        setDoc(meta); setData(body); setSavedAt(meta.updated_at);
      } catch (e) { if (!off) setError(e); }
    })();
    return () => { off = true; };
  }, [id]);

  const save = useCallback((value, opts = {}) => {
    // Saves run one after another so revisions stay in order.
    const p = queue.current.then(async () => {
      setSaving(true);
      try {
        const body = value instanceof Blob ? value : JSON.stringify(value);
        const q = new URLSearchParams();
        for (const k of ['width', 'height', 'duration', 'pages']) if (Number.isFinite(opts[k])) q.set(k, String(opts[k]));
        if (opts.meta) q.set('meta', JSON.stringify(opts.meta));
        const put = (match) => fetch(`/api/docs/${id}/data?${q}`, {
          method: 'PUT', credentials: 'same-origin', body,
          headers: { 'content-type': value instanceof Blob ? value.type || 'application/octet-stream' : 'application/json', ...(match ? { 'if-match': `"${rev.current}"` } : {}) },
        });
        let r = await put(true);
        if (r.status === 409) {
          const overwrite = await confirmDialog({
            title: 'This project changed somewhere else',
            message: 'Someone (or another tab) saved this project after you opened it.\n\nKeep your version (replaces theirs — theirs stays in Version history), or reload to get theirs?',
            confirm: 'Keep mine', cancel: 'Reload theirs',
          });
          if (!overwrite) { location.reload(); return; }
          r = await put(false);
        }
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new ApiError(out.message || `Couldn’t save (${r.status})`, r.status);
        rev.current = out.rev;
        setSavedAt(out.updated_at); setSaveError(null);
        setDoc((d) => (d ? { ...d, rev: out.rev, updated_at: out.updated_at, ...(opts.width ? { width: opts.width, height: opts.height } : {}) } : d));
        if (opts.thumb) saveThumb(id, opts.thumb).catch(() => {});
        return out;
      } catch (e) {
        setSaveError(e);
        throw e;
      } finally { setSaving(false); }
    });
    queue.current = p.catch(() => {});
    return p;
  }, [id]);

  const rename = useCallback(async (name) => {
    const d = await api.patch(`/api/docs/${id}`, { name });
    setDoc((x) => ({ ...x, name: d.name }));
    document.title = `${d.name} — SoraLab`;
  }, [id]);

  return { doc, setDoc, data, error, save, saving, savedAt, saveError, rename, canEdit: doc ? ['owner', 'editor'].includes(doc.role) : false, canComment: doc ? doc.role !== 'viewer' : false };
}

/** Small preview for project lists: a canvas (or Blob) scaled to fit 640px, sent as WebP/JPEG. */
export async function saveThumb(id, src) {
  let blob = src;
  if (!(src instanceof Blob)) {
    const max = 640;
    const w = src.width; const h = src.height;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
    if (!blob) blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  }
  if (blob.size > 2 * 1024 * 1024) return;
  await fetch(`/api/docs/${id}/thumb`, { method: 'PUT', credentials: 'same-origin', body: blob, headers: { 'content-type': blob.type || 'image/png' } });
}

/** Creates a project and returns it. */
export const createProject = (app, { name, width, height, duration, pages, meta, data }) =>
  api.post('/api/docs', { app, name, width, height, duration, pages, meta, data });

/** Loads an image (asset URL, data URL or Blob) into an HTMLImageElement, ready to draw. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Couldn’t load that image.'));
    img.src = src instanceof Blob ? URL.createObjectURL(src) : src;
  });
}

/** The URL to draw/play an asset in the browser (the converted copy when the original isn't browser-friendly). */
export const assetSrc = (a) => (typeof a === 'string' ? `/api/assets/${a}/web` : a.web_url || `/api/assets/${a.id}/web`);

/** Canvas → Blob. */
export const canvasBlob = (canvas, type = 'image/png', quality) => new Promise((resolve, reject) => {
  if (canvas.convertToBlob) canvas.convertToBlob({ type, quality }).then(resolve, reject);
  else canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the image.'))), type, quality);
});

export function notifySaved(what = 'Saved') { toast(what, { type: 'success' }); }
