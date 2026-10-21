// Sora Ningyō's 3D side, as the app shell sees it (see ../contract.js). This file stays light: three.js and three-vrm
// load only when a 3D project opens (the editor is lazy), a stage is created, or someone exports.
import { lazy, Suspense } from 'react';
import { Spinner } from '../../../components/ui.jsx';
import { empty3D } from './model.js';
import { defaultAssetUrl } from './assetUrl.js';

export { empty3D };

const Editor = lazy(() => import('./Editor.jsx'));

/**
 * The 3D workspace. Props: { project, history, canEdit } (history holds the '3d' document), plus optional
 * getPose() → the latest tracking pose for a live preview, and assetUrl(id, kind).
 */
export function Editor3D(props) {
  return (
    <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-fg2 text-sm gap-2"><Spinner size={24} /><span>Loading the 3D editor…</span></div>}>
      <Editor {...props} />
    </Suspense>
  );
}

/**
 * A renderer for performing / OBS output. The 3D engine and the model load in the background, so this returns a
 * Promise of the stage (await it to know it's showing, or to catch a model that won't load) that also has the stage
 * methods on it right away — calls made before it's ready are remembered and applied. Besides the contract's
 * setPose / resize / setBackground / snapshot / dispose, the stage has setFraming({ zoom, x, y }), expressions() and
 * setDoc(doc) for live updates.
 */
export function createStage3D(canvas, doc, { assetUrl = defaultAssetUrl, background = null } = {}) {
  let impl = null; let disposed = false;
  const queued = { pose: null, size: null, bg: background, doc: null, framing: undefined };
  const ready = import('./stage.js').then((m) => m.createStage(canvas, doc, { assetUrl, background })).then(async (s) => {
    if (disposed) { s.dispose(); return s; }
    impl = s;
    if (queued.size) s.resize(...queued.size);
    s.setBackground(queued.bg);
    if (queued.framing !== undefined) s.setFraming(queued.framing);
    if (queued.doc) await s.setDoc(queued.doc);
    if (queued.pose) s.setPose(queued.pose);
    return s;
  });
  return Object.assign(ready, {
    setPose(pose) { if (impl) impl.setPose(pose); else queued.pose = pose; },
    resize(w, h) { if (impl) impl.resize(w, h); else queued.size = [w, h]; },
    setBackground(css) { if (impl) impl.setBackground(css); else queued.bg = css; },
    setFraming(f) { if (impl) impl.setFraming(f); else queued.framing = f; },
    expressions() { return impl ? impl.expressions() : []; },
    async snapshot() { const s = impl || await ready; return s.snapshot(); },
    setDoc(next) { if (impl) return impl.setDoc(next); queued.doc = next; return ready; },
    dispose() { disposed = true; impl?.dispose(); impl = null; },
  });
}

/**
 * Export formats for EditorShell: { formats, render }. getDoc() returns the current '3d' document.
 */
export function exportConfig3D({ getDoc, assetUrl = defaultAssetUrl } = {}) {
  return {
    formats: [
      { id: 'vrm', label: 'VRM 1.0 avatar', ext: 'vrm', kind: 'model', note: 'For VSeeFace, VNyan, Warudo, VRoid Hub and other VRM apps. Uses the name, authors and licence from Info & licence.',
        options: [{ key: 'check', label: 'Check by loading it back', type: 'toggle', default: true }] },
      { id: 'glb', label: 'glTF binary (.glb)', ext: 'glb', kind: 'model', note: 'A plain glTF model: meshes, skeleton, shapes and materials (MToon kept as an extension). No VRM settings.' },
      { id: 'gltf', label: 'glTF (.gltf, one file)', ext: 'gltf', kind: 'model', note: 'Same as GLB, as JSON with the data embedded.' },
      { id: 'png', label: 'PNG snapshot', ext: 'png', kind: 'image', options: [
        { key: 'framing', label: 'Framing', type: 'select', default: 'stage', choices: [['stage', 'Stage camera'], ['face', 'Face'], ['bust', 'Bust-up'], ['waist', 'Waist-up'], ['full', 'Full body']] },
        { key: 'size', label: 'Height', type: 'select', default: 1080, choices: [[720, '720 px'], [1080, '1080 px'], [2048, '2048 px']] },
        { key: 'aspect', label: 'Shape', type: 'select', default: 'square', choices: [['square', 'Square'], ['wide', 'Wide 16:9'], ['tall', 'Tall 9:16']] },
        { key: 'transparent', label: 'Transparent background', type: 'toggle', default: true },
      ] },
    ],
    render: async (fid, options, { onProgress } = {}) => (await import('./export3d.js')).render3D(getDoc(), fid, options, { assetUrl, onProgress }),
  };
}
