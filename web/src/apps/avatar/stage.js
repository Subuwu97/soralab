// One way to make a performing stage for any kind of avatar (see contract.js): the 2D rig, a Live2D model, or the
// 3D side (./three/, built separately — until it's there, 3D projects say "3D is coming").
// The 3D module is found with import.meta.glob so the app builds whether or not ./three/index.jsx exists yet.
const THREE = import.meta.glob('./three/index.jsx');
const THREE_KEY = './three/index.jsx';

export const hasThree = () => !!THREE[THREE_KEY];
let threeMod = null;
/** The 3D module (or null when it isn't there yet). */
export async function loadThree() {
  if (!THREE[THREE_KEY]) return null;
  threeMod ||= THREE[THREE_KEY]();
  return threeMod;
}

/**
 * createStage(doc, canvas, { assetUrl(id) → url, coreUrl }) → { setPose, resize, setBackground, snapshot, dispose, … }
 * assetUrl: where to load an asset of the project from (the editor uses the signed-in URL, the OBS output its key URL).
 */
export async function createStage(doc, canvas, opts = {}) {
  if (doc.kind === '2d') return (await import('./two/render.js')).createStage2D(canvas, doc, opts);
  if (doc.kind === 'live2d') return (await import('./live2d/index.js')).createStageLive2D(canvas, doc, opts);
  if (doc.kind === '3d') {
    const m = await loadThree();
    if (!m?.createStage3D) throw Object.assign(new Error('3D is coming: the 3D avatar side isn’t installed on this server yet.'), { code: 'no3d' });
    return m.createStage3D(canvas, doc, opts);
  }
  throw new Error(`Unknown avatar kind “${doc.kind}”.`);
}
