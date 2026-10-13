// Service worker shared by every Mirai web app (copied to each app's public/ folder by setup).
//  - Push: shows notifications sent by Mirai Account, opens the right page on click.
//  - Offline/installable: keeps the app shell (index.html and the hashed assets) so the app opens without a
//    network and can be installed; API calls, media and sign-in always go to the network.
//  - Share target: files shared to the installed app from the phone's share sheet are handed to the page.
const VERSION = 'mirai-sw-1';
const SHELL = `${VERSION}-shell`;
const SHARE = `${VERSION}-share`;
const NETWORK_ONLY = /^\/(api|auth|dav|media|internal|s|signin|authorize|token|\.well-known)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Share target: the manifest points POSTs from the share sheet here.
  if (req.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      const form = await req.formData();
      const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size);
      const cache = await caches.open(SHARE);
      for (const k of await cache.keys()) await cache.delete(k);
      const meta = [];
      for (const [i, f] of files.entries()) {
        await cache.put(`/__shared/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
        meta.push({ i, name: f.name, type: f.type, size: f.size });
      }
      const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
      await cache.put('/__shared/meta', new Response(JSON.stringify({ files: meta, text, at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || NETWORK_ONLY.test(url.pathname)) return;

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  // Pages: network first (so updates arrive), the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && r.headers.get('content-type')?.includes('text/html')) caches.open(SHELL).then((c) => c.put('/', r.clone()));
      return r;
    }).catch(async () => (await caches.match('/')) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })));
    return;
  }
  // Icons, manifest, fonts and other static files: cached copy while refreshing in the background.
  if (/\.(svg|png|webp|ico|woff2?|webmanifest|json)$/.test(url.pathname)) {
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

// ---------------------------------------------------------------- push

self.addEventListener('push', (e) => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch { n = { title: e.data?.text() || 'Notification' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'mirai-notification', notification: n }));
    // Someone looking at this app right now sees it in the bell instead of a system popup.
    if (wins.some((w) => w.focused && w.visibilityState === 'visible') && n.url && new URL(n.url).origin === location.origin) return;
    if (navigator.setAppBadge && n.unread != null) navigator.setAppBadge(n.unread).catch(() => {});
    await self.registration.showNotification(n.title || 'Notification', {
      body: n.body || '',
      icon: n.icon || '/brand/app-icon.svg',
      badge: '/brand/emblem.svg',
      image: n.image || undefined,
      tag: n.tag || undefined,
      renotify: !!n.tag,
      data: { url: n.url || '/', id: n.id },
      timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(url, location.origin);
    const same = wins.find((w) => new URL(w.url).origin === target.origin);
    if (same) {
      await same.focus();
      if ('navigate' in same && same.url !== target.href) return same.navigate(target.href).catch(() => self.clients.openWindow(target.href));
      return;
    }
    return self.clients.openWindow(target.href);
  })());
});
