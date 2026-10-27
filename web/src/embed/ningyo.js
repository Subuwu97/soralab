// Sora Ningyō as a camera for the other suite apps (Hikari's "SoraLab avatar" camera source). Built as its own entry
// (see vite.config.js) and served at a stable address, /embed/ningyo.js, with CORS for the suite's apps only.
//
//   const { mount } = await import('https://soralab.example/embed/ningyo.js');
//   const av = await mount({ canvas, link | (projectId and key), video, onStatus, background, hands });
//   av.stream                     canvas.captureStream(30): send this instead of the webcam
//   av.setBackground({ mode: 'color', color } | { mode: 'room' })   video tracks have no alpha, so something is behind
//   av.setSize(w, h)   av.dispose()   av.stats() → { poses, tracking, fps, hands, kind, name }
//
// The avatar loads through the project's output key (the same key routes the OBS output page uses), so no sign-in is
// needed. `video` is the host app's webcam (a MediaStream or a <video>): it is only tracked here, never drawn, so the
// person's camera image never reaches the stream. Without it, the embed opens the camera itself.
// "room" draws the webcam shrunk to a few pixels and blurred: just the colours of the room, nothing recognisable.
import { Tracker, withTrackingDefaults } from '../apps/avatar/tracking/index.js';

const BASE = new URL(import.meta.url).origin; // SoraLab: where this module (and the avatar) comes from

/** Reads { projectId, key } from an output link like https://…/avatar/<id>/output?key=… (null if it isn't one). */
export function parseLink(link) {
  try {
    const u = new URL(String(link).trim());
    const m = u.pathname.match(/^\/avatar\/([^/]+)\/output\/?$/);
    const key = u.searchParams.get('key');
    return m && key ? { projectId: decodeURIComponent(m[1]), key } : null;
  } catch { return null; }
}

// A performing stage for each kind (the same renderers as Perform and the OBS output; ../apps/avatar/stage.js would
// pull in the React editor for 3D, which this page doesn't need).
async function makeStage(doc, canvas, opts) {
  if (doc.kind === '2d') return (await import('../apps/avatar/two/render.js')).createStage2D(canvas, doc, opts);
  if (doc.kind === 'live2d') return (await import('../apps/avatar/live2d/index.js')).createStageLive2D(canvas, doc, opts);
  if (doc.kind === '3d') return (await import('../apps/avatar/three/stage.js')).createStage(canvas, doc, opts);
  throw new Error('This project isn’t an avatar SoraLab can show here.');
}

const fail = (message, code) => Object.assign(new Error(message), { code });

export async function mount({ canvas, link, projectId, key, video = null, onStatus, background = { mode: 'color', color: '#1d1f26' }, hands } = {}) {
  if (!canvas?.getContext) throw fail('mount() needs a canvas.', 'bad_args');
  const fromLink = link ? parseLink(link) : null;
  if (link && !fromLink) throw fail('That isn’t a Sora Ningyō output link. Copy it from the Perform page (Output for OBS).', 'bad_link');
  const id = fromLink?.projectId || projectId; const secret = fromLink?.key || key;
  if (!id || !secret) throw fail('Choose an avatar first.', 'bad_args');
  const status = (s) => { try { onStatus?.(s); } catch { /* the host's problem */ } };
  status({ state: 'loading', message: 'Loading your avatar…' });

  const enc = encodeURIComponent(secret);
  let r;
  try { r = await fetch(`${BASE}/api/avatar/${encodeURIComponent(id)}/out/data?key=${enc}`, { cache: 'no-store', credentials: 'omit' }); } catch { throw fail('Couldn’t reach SoraLab.', 'offline'); }
  if (!r.ok) throw fail(r.status === 404 ? 'This avatar link is wrong or was reset. Pick the avatar again, or copy a new link from its Perform page.' : `Couldn’t load the avatar (${r.status}).`, r.status === 404 ? 'not_found' : 'http');
  const doc = await r.json();

  // The stage draws the avatar with a transparent background; each frame is laid over the chosen background here.
  const art = document.createElement('canvas');
  let w = canvas.width || 960; let h = canvas.height || 540;
  art.width = w; art.height = h;
  let stage;
  try {
    stage = await makeStage(doc, art, {
      assetUrl: (a, kind) => `${BASE}/api/avatar/${encodeURIComponent(id)}/out/asset/${a}?key=${enc}${kind === 'web' ? '&web=1' : ''}`,
      coreUrl: `${BASE}/api/avatar/cubism-core.js?doc=${encodeURIComponent(id)}&key=${enc}`,
    });
  } catch (e) { throw fail(e.code === 'no_core' || /Cubism Core/i.test(e.message || '') ? 'This Live2D avatar needs Cubism Core, which hasn’t been added to SoraLab yet.' : `Couldn’t show this avatar: ${e.message}`, 'stage'); }
  stage.setBackground(null);
  stage.setFraming?.(doc.perform?.framing || {});
  stage.resize(w, h);

  // Tracking: the project's own settings (mirror, smoothing, neutral, per-value tuning, gesture triggers).
  let poses = 0;
  const tracker = new Tracker({
    onPose: (pose) => { stage.setPose(pose); poses++; },
    onStatus: (s) => status({ state: s.camera === 'tracking' ? 'tracking' : s.camera === 'error' ? 'error' : s.camera === 'off' ? 'ready' : 'searching', message: s.message || '', fps: s.fps || 0 }),
  });
  tracker.settings = withTrackingDefaults({ ...doc.tracking, ...(hands === undefined ? {} : { hands: !!hands }) });
  tracker.gestures = doc.perform?.gestures || {};
  const given = video instanceof MediaStream ? video : video?.srcObject instanceof MediaStream ? video.srcObject : null;
  tracker.startCamera(null, given);

  // ---------------------------------------------------------------- compositing
  const g = canvas.getContext('2d');
  const room = document.createElement('canvas'); room.width = 12; room.height = 7;
  const rg = room.getContext('2d', { willReadFrequently: false });
  let bg = background || { mode: 'color', color: '#1d1f26' };
  let raf = 0; let alive = true;
  // Registered after the stage's own animation frame loop, so each frame here runs right after the stage has drawn.
  const draw = () => {
    if (!alive) return;
    raf = requestAnimationFrame(draw);
    const v = tracker.video;
    if (bg.mode === 'room' && v?.videoWidth) {
      rg.drawImage(v, 0, 0, room.width, room.height);
      g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.filter = `blur(${Math.round(Math.max(w, h) / 30)}px)`;
      g.drawImage(room, -w * 0.1, -h * 0.1, w * 1.2, h * 1.2); // a little oversized so the blur has no dark edges
      g.restore();
    } else { g.fillStyle = bg.mode === 'room' ? '#30343f' : bg.color || '#1d1f26'; g.fillRect(0, 0, w, h); }
    g.drawImage(art, 0, 0, w, h);
  };
  raf = requestAnimationFrame(draw);
  const stream = canvas.captureStream(30); // from here on onStatus follows the tracker

  return {
    stream, doc,
    setBackground(next) { bg = next || { mode: 'color', color: '#1d1f26' }; },
    setSize(nw, nh) {
      w = Math.max(16, Math.round(nw)); h = Math.max(16, Math.round(nh));
      canvas.width = w; canvas.height = h; art.width = w; art.height = h; stage.resize(w, h);
    },
    stats: () => ({ poses, tracking: tracker.status.camera, fps: tracker.status.fps, hands: !!tracker.status.hands, kind: doc.kind, name: doc.name || '' }),
    dispose() {
      if (!alive) return;
      alive = false; cancelAnimationFrame(raf);
      tracker.dispose(); // leaves the host's webcam running (it owns it)
      stage.dispose();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
