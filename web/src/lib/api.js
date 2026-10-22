// Talking to the SoraLab server. Every call returns parsed JSON or throws an Error with the server's message.
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function request(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && typeof body !== 'string') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(url.startsWith('/') ? url : `/api/${url}`, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : opts.raw ? r : await r.text().catch(() => '');
  if (!r.ok) {
    if (r.status === 401 && !opts.quiet) window.dispatchEvent(new CustomEvent('sl-signed-out'));
    throw new ApiError(data?.message || data?.error || `Request failed (${r.status})`, r.status, data);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body ?? {}, opts),
  put: (url, body, opts) => request('PUT', url, body, opts),
  patch: (url, body, opts) => request('PATCH', url, body ?? {}, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
};

/**
 * Uploads with progress (XHR). onProgress(0..1). Returns parsed JSON.
 * opts.onStart(xhr) gives you the request so you can abort it.
 */
export function uploadWithProgress(url, body, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method || 'POST', url);
    for (const [k, v] of Object.entries(opts.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data?.message || `Upload failed (${xhr.status})`, xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed — check your connection.', 0));
    xhr.onabort = () => reject(Object.assign(new ApiError('Cancelled', 0), { cancelled: true }));
    opts.onStart?.(xhr);
    xhr.send(body);
  });
}

/** Uploads files as assets (optionally into a project). Returns an array of assets. */
export async function uploadFiles(files, { docId, onProgress, onStart } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (docId) fd.append('doc_id', docId);
  return uploadWithProgress('/api/assets?many=1', fd, onProgress, { onStart });
}

/**
 * Saves something made in the browser (a Blob) as a file in SoraLab. export: list it under Exports.
 * autosave: an editor's own working file (a layer's pixels, an edited take) that a newer save replaces. The server's
 * storage cleanup removes it once no project or version uses it any more.
 */
export function saveBlob(blob, name, { docId, isExport = true, autosave = false, onProgress } = {}) {
  const q = new URLSearchParams({ name, ...(docId ? { doc_id: docId } : {}), ...(isExport ? { export: '1' } : autosave ? { source: 'autosave' } : {}) });
  return uploadWithProgress(`/api/assets/raw?${q}`, blob, onProgress, { headers: { 'content-type': blob.type || 'application/octet-stream' } });
}

/** Asks the browser to download a Blob or URL. */
export function download(blobOrUrl, name) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};
export const fmtTime = (s, { frames, fps = 30 } = {}) => {
  if (!Number.isFinite(s)) return '0:00';
  const neg = s < 0; s = Math.abs(s);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * fps);
  const base = `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${base}${frames ? `:${String(f).padStart(2, '0')}` : ''}`;
};
export const ago = (ms) => {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  for (const [n, u] of [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (s >= n) { const k = Math.floor(s / n); return `${k} ${u}${k > 1 ? 's' : ''} ago`; }
  }
  return 'just now';
};
