// The performing renderer (Perform view, OBS browser source): just the avatar, a transparent or coloured background,
// the saved camera framing, and poses smoothed between tracking frames so 30 fps tracking still looks fluid at 60 fps.
import { Viewport } from './viewport.js';
import { Avatar } from './runtime.js';
import { defaultAssetUrl } from './load.js';
import { PRESET_LABELS as LABELS } from './model.js';

const SMOOTH = 16; // 1/s: higher = snappier, lower = smoother

export async function createStage(canvas, doc, { assetUrl = defaultAssetUrl, background = null } = {}) {
  const vp = new Viewport(canvas, { alpha: true });
  vp.renderer.setPixelRatio(1); // resize() gets device pixels (the canvas's CSS size is the page's business)
  vp.setBackground(background);
  vp.setLook(doc.look || {});
  let avatar = await Avatar.load(doc, { assetUrl });
  vp.scene.add(avatar.holder);
  let cam = doc.camera || {};
  let framing = null; // Perform's framing on top of the saved stage camera: { zoom, x, y }
  const camera = () => (framing ? { ...cam, zoom: (cam.zoom || 1) * (framing.zoom || 1), x: (cam.x || 0) - (framing.x || 0) * 0.5, y: (cam.y || 0) - (framing.y || 0) * 0.5 } : cam);
  let target = null; let targetAt = -1e9; const cur = { blend: {} };
  let raf = 0; let last = performance.now(); let disposed = false;
  const fit = () => { vp.frame(avatar, camera()); };
  const size = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth ? canvas.clientWidth * dpr : canvas.width || 1280; const h = canvas.clientHeight ? canvas.clientHeight * dpr : canvas.height || 720;
    vp.resize(w, h); fit();
  };
  size();
  const loop = (now) => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (target && now - targetAt < 700) {
      // Ease every number towards the latest tracking frame.
      const k = 1 - Math.exp(-dt * SMOOTH);
      for (const [key, v] of Object.entries(target)) {
        if (key === 'blend' && v) { for (const [b, x] of Object.entries(v)) cur.blend[b] = (cur.blend[b] ?? x) + (x - (cur.blend[b] ?? x)) * k; continue; }
        if (Number.isFinite(v)) cur[key] = (Number.isFinite(cur[key]) ? cur[key] : v) + (v - (Number.isFinite(cur[key]) ? cur[key] : v)) * k;
      }
      avatar.setPose({ ...cur, blend: target.blend ? cur.blend : undefined, expr: target.expr });
    }
    avatar.update(dt);
    vp.render();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    avatar, viewport: vp,
    setPose(pose) { target = pose || null; targetAt = performance.now(); },
    resize(w, h) { vp.resize(w, h); fit(); },
    setBackground(css) { vp.setBackground(css ?? null); },
    /** Perform's zoom / pan on top of the saved camera (x, y −1..1). */
    setFraming(f) { framing = f || null; fit(); },
    /** Expressions people can toggle with hotkeys in Perform (sent back as pose.expr). */
    expressions() { return (avatar.expressions?.expressions || []).map((e) => e.expressionName).filter((n) => n !== 'neutral').map((id) => ({ id, name: LABELS[id] || id })); },
    snapshot() { avatar.update(0); return vp.snapshot(); },
    /** Live document updates (expressions, camera, materials…); a different model reloads. */
    async setDoc(next) {
      if (JSON.stringify(next.model) !== JSON.stringify(doc.model)) {
        const a = await Avatar.load(next, { assetUrl });
        if (disposed) { a.dispose(); return; }
        avatar.dispose(); avatar = a; vp.scene.add(a.holder); this.avatar = a;
      } else await avatar.apply(next);
      doc = next; cam = next.camera || {}; vp.setLook(next.look || {}); fit();
    },
    dispose() { disposed = true; cancelAnimationFrame(raf); avatar.dispose(); vp.dispose(); },
  };
}
