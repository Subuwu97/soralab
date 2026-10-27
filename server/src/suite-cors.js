// CORS for the suite's other apps, so Hikari can use a Sora Ningyō avatar as its camera (web/src/embed/ningyo.js).
// Only the origins in config.suiteOrigins (SUITE_ORIGINS / HIKARI_URL, written by the suite's setup) get the headers;
// any other site's page can't read these responses. Two kinds of paths:
//   files and key routes  the embed module, its chunks, worker and wasm (/embed/…), the MediaPipe models (/models/…), and
//                         the output-key routes (/api/avatar/<id>/out/…, Cubism Core). No cookies: the key is the access.
//   signed-in routes      /api/avatar/mine (your avatar projects with their output keys) and /api/avatar/<id>/output-key.
//                         Sent with credentials: the apps are same-site on the network (same host, another port), so the
//                         SameSite=Lax session cookie comes along; the origin must match exactly.
import { config } from './config.js';

const FILES = /^\/(embed|models)\/|^\/api\/avatar\/[^/]+\/out\/|^\/api\/avatar\/cubism-core\.js$/;
const SIGNED_IN = /^\/api\/avatar\/(mine|[^/]+\/output-key)$/;

export function suiteCors(req, res, next) {
  const signedIn = SIGNED_IN.test(req.path);
  if (!signedIn && !FILES.test(req.path)) return next();
  res.vary('Origin');
  // The embed's entry keeps one address across updates, so browsers must check it each time (its chunks are hashed).
  if (req.path === '/embed/ningyo.js') res.set('Cache-Control', 'no-cache');
  const origin = req.get('origin');
  const allowed = !!origin && config.suiteOrigins.includes(origin);
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    if (signedIn) res.set('Access-Control-Allow-Credentials', 'true');
  }
  // The output keys are secrets: another site's page asking for them gets nothing at all (not just an unreadable answer).
  if (signedIn && origin && !allowed && origin !== `${req.protocol}://${req.get('host')}` && origin !== new URL(config.publicUrl).origin) {
    return res.status(403).json({ error: 'forbidden', message: 'This address isn’t one of your suite’s apps.' });
  }
  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    res.set('Access-Control-Allow-Methods', 'GET, HEAD').set('Access-Control-Max-Age', '600');
    if (req.get('access-control-request-headers')) res.set('Access-Control-Allow-Headers', 'content-type');
    return res.status(204).end();
  }
  next();
}
