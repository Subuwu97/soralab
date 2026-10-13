// Browser side of notifications and installable apps, shared by every Mirai web app.

export const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
export const pushSupported = swSupported && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

/** Registers /sw.js (copied into each app's public folder by setup). Call once at startup. */
export function registerServiceWorker() {
  if (!swSupported || !window.isSecureContext) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw]', e.message)));
}

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function apiJson(base, path, opts = {}) {
  const r = await fetch(`${base}${path}`, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `Request failed (${r.status})`);
  return data;
}

/** 'on' | 'off' | 'blocked' | 'unsupported' for this browser and app. */
export async function pushState() {
  if (!pushSupported || !window.isSecureContext) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Asks for permission and subscribes this device; the subscription is stored with the person's account. */
export async function enablePush(base = '/api') {
  if (!pushSupported) throw new Error('This browser can’t show notifications.');
  if (!window.isSecureContext) throw new Error('Notifications need HTTPS (see README → HTTPS).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.' : 'Notifications weren’t allowed.');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { key } = await apiJson(base, '/notifications/push-key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await apiJson(base, '/notifications/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
}

export async function disablePush(base = '/api') {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  await apiJson(base, '/notifications/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe();
}

/**
 * Files shared to the installed app from the phone's share sheet (see the service worker's /share-target).
 * Returns { files: File[], text } once, or null. Call it once signed in: files shared before signing in
 * (within the last 30 minutes) are still waiting.
 */
export async function takeSharedFiles() {
  if (!('caches' in window)) return null;
  if (new URLSearchParams(location.search).has('shared')) history.replaceState(null, '', location.pathname);
  const names = await caches.keys();
  const cache = names.find((n) => n.endsWith('-share')) && (await caches.open(names.find((n) => n.endsWith('-share'))));
  const metaRes = cache && (await cache.match('/__shared/meta'));
  if (!metaRes) return null;
  const meta = await metaRes.json();
  if (Date.now() - meta.at > 30 * 60e3) { for (const k of await cache.keys()) await cache.delete(k); return null; }
  const files = [];
  for (const m of meta.files) {
    const r = await cache.match(`/__shared/${m.i}`);
    if (r) files.push(new File([await r.blob()], m.name, { type: m.type }));
  }
  for (const k of await cache.keys()) await cache.delete(k);
  return { files, text: meta.text };
}
