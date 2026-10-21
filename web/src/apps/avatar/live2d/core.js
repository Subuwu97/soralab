// Live2D Cubism Core (live2dcubismcore.min.js) can't ship with SoraLab: Live2D's licence doesn't allow passing it
// on. A server admin downloads it from Live2D (Cubism SDK for Web, "Core" folder) and uploads it once; SoraLab then
// stores it on the server and serves it only to signed-in people (and to OBS output links of avatar projects).
import { api } from '../../../lib/api.js';

export const CORE_DOWNLOAD = 'https://www.live2d.com/en/sdk/download/web/';
export const CORE_LICENCE = 'https://www.live2d.com/en/sdk/license/';
export const coreStatus = () => api.get('/api/avatar/cubism-core');

let loading = null;
/** Loads Cubism Core from the server (once). Resolves to the Live2DCubismCore namespace; rejects with code 'no_core'. */
export function loadCore(url = '/api/avatar/cubism-core.js') {
  if (window.Live2DCubismCore) return Promise.resolve(window.Live2DCubismCore);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => (window.Live2DCubismCore ? resolve(window.Live2DCubismCore) : reject(Object.assign(new Error('Cubism Core loaded but didn’t start.'), { code: 'bad_core' })));
    s.onerror = () => reject(Object.assign(new Error('Cubism Core isn’t on this server yet.'), { code: 'no_core' }));
    document.head.appendChild(s);
  }).catch((e) => { loading = null; throw e; });
  return loading;
}

/** Admin: uploads live2dcubismcore.min.js to the server. */
export async function uploadCore(file) {
  const r = await fetch('/api/avatar/cubism-core.js', { method: 'PUT', credentials: 'same-origin', body: file, headers: { 'content-type': 'application/javascript' } });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.message || `Upload failed (${r.status})`);
  return out;
}
