// Images from the rest of the suite (profile pictures from Mirai Account, Tsunami thumbnails, Cloud previews) are on
// plain http:// addresses on a home network. A page served over https:// isn't allowed to show them, so when this app
// itself is on https these URLs are rewritten to /api/suite-image, which fetches them server-side (only from the
// suite's own apps — never arbitrary addresses).
import { config } from './config.js';

/** [origin a browser might have, internal base URL] for each suite app: its public http address, and its plain
 *  http port on this machine (older profile-picture links point there, e.g. from before Account moved to https). */
const origins = () => {
  const out = [];
  for (const [pub, internal] of [[config.accountsUrl, config.accountsInternalUrl], [config.tsunamiUrl, config.tsunamiInternalUrl], [config.cloudUrl, config.cloudInternalUrl]]) {
    if (!pub) continue;
    const base = (internal || pub).replace(/\/$/, '');
    const p = new URL(pub);
    if (p.protocol === 'http:') out.push([p.origin, base]);
    const port = new URL(base).port;
    if (port) for (const h of new Set([p.hostname, 'localhost', '127.0.0.1'])) out.push([`http://${h}:${port}`, base]);
  }
  return out;
};

const active = () => config.publicUrl.startsWith('https://');

/** The URL a browser on this app's (https) page can load. */
export function viaSecure(url) {
  if (!url || !active() || !/^http:\/\//.test(url)) return url;
  try { const o = new URL(url).origin; return origins().some(([pub]) => pub === o) ? `/api/suite-image?u=${encodeURIComponent(url)}` : url; } catch { return url; }
}

/** Rewrites image URLs inside message embeds. */
export function secureEmbeds(embeds) {
  if (!active() || !Array.isArray(embeds)) return embeds;
  return embeds.map((e) => ({
    ...e,
    ...(e.image ? { image: { ...e.image, url: viaSecure(e.image.url) } } : {}),
    ...(e.thumbnail ? { thumbnail: { ...e.thumbnail, url: viaSecure(e.thumbnail.url) } } : {}),
    ...(e.author?.icon_url ? { author: { ...e.author, icon_url: viaSecure(e.author.icon_url) } } : {}),
  }));
}

export async function suiteImageRoute(req, res) {
  let u;
  try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).end(); }
  const match = origins().find(([pub]) => pub === u.origin);
  if (!match) return res.status(404).end();
  try {
    const r = await fetch(`${match[1]}${u.pathname}${u.search}`, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//.test(type)) return res.status(r.ok ? 415 : r.status).end();
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=86400').set('X-Content-Type-Options', 'nosniff')
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
}
