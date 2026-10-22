// Sora Ningyō's 3D workspace (rendered inside the app's EditorShell): a tab rail on the left (Model, Rig, Expressions,
// Spring bones, Look, Tracking, Camera, Info & licence), the 3D view in the middle and the tab's panel on the right.
// The document lives in the shell's useHistory (every change is undoable); the live avatar, view toggles, test poses
// and expression previews are local state. three.js and three-vrm are only loaded with this file.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Button, IconButton, Spinner, ProgressBar, EmptyState, toast, toastError, confirmDialog, cx } from '../../../components/ui.jsx';
import { pickAssets } from '../../../components/Pickers.jsx';
import { uploadFiles, saveBlob } from '../../../lib/api.js';
import { saveThumb } from '../../../lib/doc.js';
import { useShortcuts } from '../../../lib/shortcuts.js';
import { Viewport } from './viewport.js';
import { Avatar } from './runtime.js';
import { Overlay } from './overlay.js';
import { defaultAssetUrl } from './load.js';
import { autoMap } from './humanoid.js';
import { guessExpressions } from './exprmap.js';
import { STARTER_DEFAULTS } from './starter.js';
import { worldVertices, suggestMarkers, depthField, autoRig, mirrorKey, showWeights, hideWeights, paintWeights, restPoint } from './autorig.js';
import { exportRoot, exportGLTF } from './vrmExport.js';
import { from3D, fileFormat, DEFAULT_META } from './model.js';
import { Glyph } from './icons.jsx';
import { ModelPanel, RigPanel, ExpressionsPanel, SpringsPanel, LookPanel, TrackingPanel, CameraPanel, InfoPanel } from './Panels.jsx';

const TABS = [
  { id: 'model', label: 'Model', glyph: 'figure', key: '1' },
  { id: 'rig', label: 'Rig & bones', glyph: 'bone', key: '2' },
  { id: 'face', label: 'Expressions', glyph: 'face', key: '3' },
  { id: 'springs', label: 'Spring bones', glyph: 'spring', key: '4' },
  { id: 'look', label: 'Look & materials', glyph: 'palette', key: '5' },
  { id: 'tracking', label: 'Tracking', glyph: 'tracking', key: '6' },
  { id: 'camera', label: 'Stage camera', glyph: 'camera', key: '7' },
  { id: 'info', label: 'Info & licence', glyph: 'info', key: '8' },
];
const MODEL_EXT = '.vrm,.glb,.gltf,.fbx,.bin,.png,.jpg,.jpeg,.webp,.tga,.bmp';
const PRIORITY = ['vrm', 'glb', 'gltf', 'fbx'];

export default function Editor({ project, history: h, canEdit = project?.canEdit, getPose, assetUrl = defaultAssetUrl }) {
  const doc = useMemo(() => (h.state ? from3D(h.state, project?.doc) : null), [h.state, project?.doc]);
  const docId = project?.doc?.id;
  const edit = useCallback((fn, label, merge) => { if (canEdit) h.set((d) => fn(from3D(d, project?.doc)), label, merge ? { merge } : undefined); }, [canEdit, h.set, project?.doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const wrap = useRef(null); const canvas = useRef(null); const fileInput = useRef(null);
  const eng = useRef({});
  const [avatar, setAvatar] = useState(null);
  const [loading, setLoading] = useState(null); // { label, p }
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('sl-ningyo3d-tab') || 'model'; } catch { return 'model'; } });
  useEffect(() => { try { localStorage.setItem('sl-ningyo3d-tab', tab); } catch { /* private mode */ } }, [tab]);
  const [view, setView] = useState({ skeleton: false, colliders: false, joints: false });
  const [preview, setPreview] = useState({});
  const [testPose, setTestPose] = useState(null);
  const [selBone, setSelBone] = useState(null);
  const [pick, setPick] = useState(null);   // { label, onPick(boneName) }
  const [rig, setRig] = useState(null);     // auto-rig marker placement: { markers, box, symmetric, smooth, selected }
  const [paint, setPaint] = useState(null); // weight painting: { bone, mode, radius, strength, bend, dirty }
  const [stageCam, setStageCam] = useState(false);
  const [rev, setRev] = useState(0);        // bumps when the avatar's runtime parts change (panels re-read them)
  const live = useRef({});
  live.current = { doc, testPose, preview, paint, rig, stageCam, getPose, pick, selBone, tab };

  // ---------------------------------------------------------------- engine (once)
  useEffect(() => {
    // A fresh canvas per mount: a disposed renderer loses its canvas's WebGL context for good.
    const cv = document.createElement('canvas');
    cv.className = 'absolute inset-0 w-full h-full block outline-none'; cv.tabIndex = 0;
    wrap.current.prepend(cv);
    canvas.current = cv;
    let vp;
    try { vp = new Viewport(cv); } catch (err) { setError(new Error('This browser couldn’t start 3D (WebGL). Try another browser, or turn on graphics acceleration.')); cv.remove(); return undefined; }
    const controls = new OrbitControls(vp.camera, canvas.current);
    controls.target = vp.target; controls.enableDamping = true; controls.dampingFactor = 0.15; controls.screenSpacePanning = true;
    const overlay = new Overlay(vp);
    const e = eng.current = { vp, controls, overlay, avatar: null, framed: false };
    if (import.meta.env.DEV) window.__ningyo3d = e; // for tests and debugging (dev server only)
    const ro = new ResizeObserver(() => { const r = wrap.current.getBoundingClientRect(); vp.resize(r.width, r.height); });
    ro.observe(wrap.current);
    let raf = 0; let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const a = e.avatar; const L = live.current;
      if (a) {
        if (L.paint) {
          // Painting: rest pose, plus the "bend test" on the chosen bone.
          a.restore();
          const b = a.node(L.paint.bone);
          if (b && L.paint.bend) {
            const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
            const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(/Leg|Foot|spine|chest|Chest|hips|neck|head/i.test(b.name) ? 1 : 0, 0, /Leg|Foot|spine|chest|Chest|hips|neck|head/i.test(b.name) ? 0 : 1), (L.paint.bend * Math.PI) / 180);
            b.quaternion.premultiply(pw.clone().invert().multiply(rot).multiply(pw));
          }
          a.holder.updateMatrixWorld(true);
        } else {
          const p = L.getPose?.();
          if (p) a.setPose(p);
          a.driver.manual = L.testPose;
          a.setPreview(L.preview);
          a.update(dt);
        }
        if (L.stageCam) vp.frame(a, L.doc?.camera);
      }
      controls.enabled = !L.stageCam;
      if (!L.stageCam) controls.update();
      overlay.update();
      vp.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); overlay.dispose(); e.avatar?.dispose(); e.pending?.avatar?.dispose(); vp.dispose({ loseContext: true }); cv.remove(); eng.current = {}; };
  }, []);

  // ---------------------------------------------------------------- model (re)load
  const modelKey = JSON.stringify(doc?.model || null);
  useEffect(() => {
    const e = eng.current;
    if (!e.vp) return undefined;
    if (!doc?.model) { e.avatar?.dispose(); e.avatar = null; setAvatar(null); return undefined; }
    let off = false;
    const pending = e.pending?.key === modelKey ? e.pending.avatar : null;
    if (e.pending && !pending) e.pending.avatar.dispose();
    e.pending = null;
    setLoading({ label: 'Loading the avatar…', p: null }); setError(null);
    (async () => {
      try {
        const a = pending || await Avatar.load(live.current.doc, { assetUrl });
        if (off) { a.dispose(); return; }
        await a.apply(live.current.doc);
        e.avatar?.dispose();
        e.avatar = a; e.vp.scene.add(a.holder); e.overlay.setAvatar(a);
        if (!e.framed) { e.vp.frame(a, { framing: 'full' }); e.framed = true; }
        setAvatar(a); setRev((r) => r + 1);
      } catch (err) { if (!off) { setError(err); console.error(err); } }
      finally { if (!off) setLoading(null); }
    })();
    return () => { off = true; };
  }, [modelKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything else in the document applies to the live avatar without reloading.
  useEffect(() => {
    const e = eng.current;
    if (!doc || !e.vp) return;
    e.vp.setLook(doc.look);
    e.vp.setBackground(doc.look.background || '#2b2f3a');
    if (avatar && !paint) avatar.apply(doc).then(() => setRev((r) => r + 1)).catch(toastError);
  }, [doc, avatar]); // eslint-disable-line react-hooks/exhaustive-deps
  // Colliders show on the Spring bones tab (or when toggled on).
  useEffect(() => { eng.current.overlay?.setOptions({ ...view, colliders: view.colliders || tab === 'springs', selected: selBone }); }, [view, selBone, rev, tab]);
  useEffect(() => { eng.current.overlay?.setMarkers(rig?.markers || null, rig?.selected); }, [rig]);

  // Project thumbnail: a bust-up of the avatar, a few seconds after changes.
  useEffect(() => {
    if (!avatar || !canEdit || !docId) return undefined;
    const t = setTimeout(async () => {
      const { vp } = eng.current;
      try {
        const c = document.createElement('canvas'); c.width = 480; c.height = 360;
        vp.render();
        const src = vp.canvas; const s = Math.max(480 / src.width, 360 / src.height);
        const g = c.getContext('2d'); g.fillStyle = doc.look.background || '#2b2f3a'; g.fillRect(0, 0, 480, 360);
        g.drawImage(src, (480 - src.width * s) / 2, (360 - src.height * s) / 2, src.width * s, src.height * s);
        await saveThumb(docId, c);
      } catch { /* thumbnails are optional */ }
    }, 4000);
    return () => clearTimeout(t);
  }, [avatar, h.version, canEdit, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- import
  const finishImport = useCallback(async (model, label) => {
    setLoading({ label: 'Reading the model…', p: null });
    try {
      const cur = live.current.doc;
      const blank = { ...cur, model, humanoid: { bones: {} }, expressions: {}, springs: { chains: [], colliders: [] }, materials: {}, lookAt: { type: 'auto', range: 10 } };
      const a = await Avatar.load(blank, { assetUrl });
      const f = a.loaded.file || {};
      const bones = f.humanoid?.bones && Object.keys(f.humanoid.bones).length ? f.humanoid.bones : autoMap(a.bones, a.deform);
      const base = (model.fileName || 'Avatar').replace(/\.[^.]+$/, '');
      const next = {
        ...cur, model: { ...model, scale: model.scale ?? a.loaded.scale },
        humanoid: { bones }, autorig: null, materials: {},
        expressions: f.expressions && Object.keys(f.expressions).length ? f.expressions : guessExpressions(a.morphList()),
        springs: f.springs || { chains: [], colliders: [] }, lookAt: f.lookAt || { type: 'auto', range: 10 },
        meta: { ...DEFAULT_META, name: base, ...(f.meta || {}), thumbnail: null },
      };
      a.sig = {}; await a.apply(next);
      eng.current.pending = { key: JSON.stringify(next.model), avatar: a };
      eng.current.framed = false;
      h.set(next, label);
      setRig(null); setPaint(null); setSelBone(null);
      const st = a.stats();
      toast(st.skinned ? `Imported ${model.fileName || 'the avatar'}${a.loaded.vrmVersion ? ` (VRM ${a.loaded.vrmVersion === '0' ? '0.x' : '1.0'})` : ''}` : 'Imported — this model has no skeleton yet. Use Rig & bones → Auto-rig.', { type: 'success' });
      if (!st.skinned) setTab('rig');
    } catch (e) { toastError(e, 'Couldn’t import that model'); setLoading(null); }
  }, [assetUrl, h.set]); // eslint-disable-line react-hooks/exhaustive-deps

  const importAssets = useCallback(async (assets) => {
    const models = assets.filter((a) => fileFormat(a.name));
    const main = models.sort((x, y) => PRIORITY.indexOf(fileFormat(x.name)) - PRIORITY.indexOf(fileFormat(y.name)))[0];
    if (!main) { toast('Pick a .vrm, .glb, .gltf or .fbx file (and its textures, if they’re separate).', { type: 'error' }); return; }
    const files = Object.fromEntries(assets.filter((a) => a !== main).map((a) => [a.name, a.id]));
    await finishImport({ asset: main.id, format: fileFormat(main.name), fileName: main.name, files }, 'Import model');
  }, [finishImport]);
  const confirmReplace = async () => !live.current.doc?.model || confirmDialog({ title: 'Replace the model?', message: 'Your expressions, spring bones and materials are set up again from the new file. You can undo this.', confirm: 'Replace' });
  const importFiles = useCallback(async () => { if (await confirmReplace()) fileInput.current?.click(); }, []);
  const onFiles = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setLoading({ label: 'Uploading…', p: 0 });
    try {
      const assets = await uploadFiles(files, { docId, onProgress: (p) => setLoading({ label: 'Uploading…', p }) });
      await importAssets(assets);
    } catch (e) { toastError(e, 'Upload failed'); setLoading(null); }
  };
  const fromFiles = useCallback(async () => {
    if (!(await confirmReplace())) return;
    const assets = await pickAssets({ multiple: true, docId, title: 'Choose a 3D model (.vrm, .glb, .gltf, .fbx)' });
    if (assets?.length) await importAssets(assets);
  }, [docId, importAssets]);
  const startStarter = useCallback(async () => {
    if (!(await confirmReplace())) return;
    await finishImport({ format: 'starter', starter: { ...STARTER_DEFAULTS }, fileName: 'Starter avatar' }, 'Use the starter avatar');
  }, [finishImport]);

  // ---------------------------------------------------------------- auto-rig
  const startRig = useCallback(() => {
    const a = eng.current.avatar;
    if (!a) return;
    a.toRest();
    const parts = worldVertices(a.root).filter((p) => !p.mesh.userData.slExtra);
    const s = suggestMarkers(parts);
    const saved = live.current.doc.autorig?.markers;
    setRig({ markers: saved || s.markers, box: s.box, symmetric: true, smooth: live.current.doc.autorig?.smooth ?? 0.5, selected: null, depth: depthField(parts), suggested: s.markers });
    setStageCam(false); setView((v) => ({ ...v, skeleton: false }));
    eng.current.vp.frame(a, { framing: 'full' });
  }, []);
  const buildRig = useCallback(async () => {
    const a = eng.current.avatar; const r = live.current.rig;
    if (!a || !r) return;
    setLoading({ label: 'Building the skeleton…', p: 0 });
    try {
      a.toRest();
      const out = await autoRig(a.root, r.markers, r.box, { smooth: r.smooth, onProgress: (p, label) => setLoading({ label, p }) });
      setLoading({ label: 'Saving the rigged model…', p: null });
      const buf = await exportRoot(out.root, { binary: true });
      out.root.traverse((o) => o.geometry?.dispose());
      const cur = live.current.doc;
      const base = (cur.model.fileName || 'Avatar').replace(/\.[^.]+$/, '').replace(/ \(rigged\)$/, '');
      const asset = await saveBlob(new Blob([buf], { type: 'model/gltf-binary' }), `${base} (rigged).glb`, { docId, isExport: false, autosave: true }); // replaced by the next re-rig / paint
      eng.current.framed = false;
      h.set({ ...cur, model: { asset: asset.id, format: 'glb', fileName: asset.name, files: {}, scale: 1, rigged: 'auto', source: cur.model.source || cur.model },
        humanoid: { bones: out.humanoid }, autorig: { markers: r.markers, smooth: r.smooth } }, 'Auto-rig');
      setRig(null);
      toast('Rigged. Check the bends with the test pose or the weight brush.', { type: 'success' });
    } catch (e) { toastError(e, 'Auto-rig failed'); setLoading(null); }
  }, [docId, h.set]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- weight painting
  const paintMats = useRef(null);
  const startPaint = useCallback((bone) => {
    const a = eng.current.avatar;
    if (!a) return;
    a.toRest();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    paintMats.current = { mat, saved: new Map() };
    for (const m of a.meshes) if (m.isSkinnedMesh) { paintMats.current.saved.set(m, m.material); m.material = Array.isArray(m.material) ? m.material.map(() => mat) : mat; }
    for (const o of a.outlines) o.visible = false;
    const b = bone || a.bones.find((x) => a.deform.has(x))?.name;
    for (const m of paintMats.current.saved.keys()) showWeights(m, a.node(b));
    setPaint({ bone: b, mode: 'add', radius: +(a.height * 0.04).toFixed(3), strength: 0.35, bend: 0, dirty: false });
    setView((v) => ({ ...v, skeleton: true }));
    setSelBone(b);
  }, []);
  const stopPaint = useCallback(async ({ save = true } = {}) => {
    const a = eng.current.avatar; const p = live.current.paint;
    if (a && paintMats.current) {
      for (const [m, mat] of paintMats.current.saved) { m.material = mat; hideWeights(m); }
      for (const o of a.outlines) o.visible = true;
      paintMats.current.mat.dispose(); paintMats.current = null;
      a.restore();
    }
    setPaint(null);
    if (save && p?.dirty && a) {
      setLoading({ label: 'Saving the painted weights…', p: null });
      try {
        const buf = await exportGLTF(a, { binary: true });
        const cur = live.current.doc;
        const base = (cur.model.fileName || 'Avatar').replace(/\.[^.]+$/, '').replace(/ \((rigged|weights)\)$/, '');
        const asset = await saveBlob(new Blob([buf], { type: 'model/gltf-binary' }), `${base} (weights).glb`, { docId, isExport: false, autosave: true }); // replaced by the next paint
        // The saved file carries the scale and VRM 0.x turn already, and the document has every VRM setting.
        h.set({ ...cur, model: { asset: asset.id, format: 'glb', fileName: asset.name, files: {}, scale: 1, rigged: cur.model.rigged || 'painted', source: cur.model.source || cur.model } }, 'Paint weights');
      } catch (e) { toastError(e, 'Couldn’t save the weights'); setLoading(null); }
    }
  }, [docId, h.set]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = eng.current.avatar;
    if (!a || !paint || !paintMats.current) return;
    for (const m of paintMats.current.saved.keys()) showWeights(m, a.node(paint.bone));
  }, [paint?.bone]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab !== 'rig' && paint) stopPaint(); if (tab !== 'rig' && rig) setRig(null); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- pointer: pick bones, drag markers, paint
  const ray = (ev) => {
    const r = canvas.current.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), eng.current.vp.camera);
    return rc;
  };
  const onPointerDownCapture = (ev) => {
    const e = eng.current; const a = e.avatar; const L = live.current;
    if (!a || ev.button !== 0) return;
    const rc = ray(ev);
    const drag = (move, up) => {
      ev.stopPropagation(); ev.preventDefault();
      const mv = (x) => move(x); const u = (x) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', u); up?.(x); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', u);
    };
    if (L.paint && canEdit) {
      const skinned = a.meshes.filter((m) => m.isSkinnedMesh);
      const hit0 = rc.intersectObjects(skinned, false)[0];
      if (!hit0) return;
      const dab = (hit) => {
        const p = live.current.paint;
        const c = restPoint(hit);
        if (paintWeights(skinned, a.node(p.bone), c, { radius: p.radius, strength: p.strength * 0.5, mode: ev.altKey ? (p.mode === 'add' ? 'remove' : 'add') : p.mode }) && !p.dirty) setPaint((x) => ({ ...x, dirty: true }));
        e.overlay.setBrush(hit.point, p.radius);
      };
      dab(hit0);
      drag((x) => { const h2 = ray(x).intersectObjects(skinned, false)[0]; if (h2) dab(h2); }, () => e.overlay.setBrush(null));
      return;
    }
    if (L.rig) {
      const key = e.overlay.pickMarker(rc);
      if (!key) return;
      const start = new THREE.Vector3(...L.rig.markers[key]);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(e.vp.camera.getWorldDirection(new THREE.Vector3()).negate(), start);
      const cx = (L.rig.box.min[0] + L.rig.box.max[0]) / 2;
      setRig((r) => ({ ...r, selected: key }));
      drag((x) => {
        const p = ray(x).ray.intersectPlane(plane, new THREE.Vector3());
        if (!p) return;
        setRig((r) => {
          const m = { ...r.markers };
          // Seen from the front, keep the marker in the middle of the body's depth.
          const front = Math.abs(e.vp.camera.getWorldDirection(new THREE.Vector3()).z) > 0.8;
          const z = front ? r.depth(p.x, p.y) : p.z;
          m[key] = [p.x, p.y, z];
          const mk = mirrorKey(key);
          if (r.symmetric && mk) m[mk] = [2 * cx - p.x, p.y, z];
          if (key === 'chin' && r.symmetric) m.chin = [cx, p.y, z];
          return { ...r, markers: m };
        });
      });
      return;
    }
    if (L.pick || view.skeleton) {
      const b = e.overlay.pickBone(rc);
      if (!b) return;
      ev.stopPropagation();
      setSelBone(b.name);
      if (L.pick) { L.pick.onPick(b.name); setPick(null); }
      if (L.paint) setPaint((p) => ({ ...p, bone: b.name }));
    }
  };
  const onPointerMove = (ev) => {
    const e = eng.current; const L = live.current;
    if (!L.paint || !e.avatar || ev.buttons) return;
    const hit = ray(ev).intersectObjects(e.avatar.meshes.filter((m) => m.isSkinnedMesh), false)[0];
    e.overlay.setBrush(hit ? hit.point : null, L.paint.radius);
  };

  // ---------------------------------------------------------------- view helpers
  const frameView = (framing) => { const e = eng.current; if (e.avatar) { setStageCam(false); e.vp.frame(e.avatar, { framing, fov: 30 }); } };
  const saveView = () => ({ position: eng.current.vp.camera.position.toArray().map((v) => +v.toFixed(4)), target: eng.current.vp.target.toArray().map((v) => +v.toFixed(4)) });
  const wiggle = () => { if (eng.current.avatar) eng.current.avatar.driver.wiggle = 1.6; };
  useShortcuts({
    f: () => frameView('full'), b: () => frameView('bust'), k: () => setView((v) => ({ ...v, skeleton: !v.skeleton })), w: wiggle,
    escape: () => { setPick(null); return false; },
    ...Object.fromEntries(TABS.map((t) => [t.key, () => setTab(t.id)])),
  }, [avatar]);

  const ctx = {
    doc, edit, canEdit, avatar, rev, docId, assetUrl, setTab,
    preview, setPreview, testPose, setTestPose, selBone, setSelBone, pick, setPick,
    view, setView, rig, setRig, startRig, buildRig, paint, setPaint, startPaint, stopPaint,
    importFiles, fromFiles, startStarter, wiggle, saveView, stageCam, setStageCam, frameView, busy: !!loading,
  };
  const Panel = { model: ModelPanel, rig: RigPanel, face: ExpressionsPanel, springs: SpringsPanel, look: LookPanel, tracking: TrackingPanel, camera: CameraPanel, info: InfoPanel }[tab] || ModelPanel;
  const st = avatar?.stats();

  return (
    <div className="absolute inset-0 flex bg-work text-fg">
      {/* tab rail */}
      <nav className="w-12 shrink-0 bg-panel border-r border-line flex flex-col items-center py-1.5 gap-0.5" aria-label="3D avatar sections">
        {TABS.map((t) => (
          <IconButton key={t.id} label={`${t.label} (${t.key})`} active={tab === t.id} size={36} onClick={() => setTab(t.id)} disabled={!doc?.model && !['model', 'info'].includes(t.id)}>
            <Glyph name={t.glyph} />
          </IconButton>
        ))}
      </nav>

      {/* 3D view */}
      <div className={cx('flex-1 min-w-0 relative', paint && 'cursor-crosshair', (pick || rig) && 'cursor-pointer')} ref={wrap} onPointerDownCapture={onPointerDownCapture} onPointerMove={onPointerMove} onPointerLeave={() => eng.current.overlay?.setBrush(null)}>
        {doc?.model && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-panel/85 backdrop-blur rounded-lg border border-line p-1 shadow-sm">
            <Button size="xs" variant="ghost" onClick={() => frameView('face')} title="Frame the face">Face</Button>
            <Button size="xs" variant="ghost" onClick={() => frameView('bust')} title="Frame bust-up (B)">Bust</Button>
            <Button size="xs" variant="ghost" onClick={() => frameView('full')} title="Frame the whole body (F)">Full</Button>
            <span className="w-px h-4 bg-line mx-0.5" />
            <IconButton size={24} label="Show skeleton (K)" active={view.skeleton} onClick={() => setView((v) => ({ ...v, skeleton: !v.skeleton }))}><Glyph name="bone" size={15} /></IconButton>
            <IconButton size={24} label="Show spring colliders" active={view.colliders} onClick={() => setView((v) => ({ ...v, colliders: !v.colliders }))}><Glyph name="collider" size={15} /></IconButton>
            <IconButton size={24} label="Show spring joints" active={view.joints} onClick={() => setView((v) => ({ ...v, joints: !v.joints }))}><Glyph name="spring" size={15} /></IconButton>
            <IconButton size={24} icon="wave" iconSize={15} label="Wiggle — shake the head to test spring bones (W)" onClick={wiggle} />
            <IconButton size={24} icon="camera" iconSize={15} label="Look through the stage camera" active={stageCam} onClick={() => setStageCam(!stageCam)} />
          </div>
        )}
        {pick && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-accent text-[#06121f] text-[13px] font-medium rounded-full px-3 py-1 shadow flex items-center gap-2">
            {pick.label}<button type="button" className="underline" onClick={() => setPick(null)}>Cancel</button>
          </div>
        )}
        {rig && <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-panel/90 border border-line text-[13px] rounded-full px-3 py-1 shadow">Drag the pink markers onto the chin, shoulders, elbows, wrists, hips, knees and ankles.</div>}
        {paint && <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-panel/90 border border-line text-[13px] rounded-full px-3 py-1 shadow">Painting <b>{paint.bone}</b> — drag on the model; hold Alt to do the opposite. Click a joint to switch bones.</div>}
        {st && <div className="absolute bottom-2 left-2 text-[11px] text-fg3 bg-panel/70 rounded px-2 py-0.5 pointer-events-none">
          {avatar.loaded.vrmVersion ? `VRM ${avatar.loaded.vrmVersion === '0' ? '0.x' : '1.0'}` : doc.model.format === 'starter' ? 'Starter avatar' : (doc.model.format || '').toUpperCase()} · {st.tris.toLocaleString()} triangles · {st.bones} bones · {st.morphs} shapes{st.arkit ? ` (${st.arkit}/52 ARKit)` : ''}
        </div>}
        {!doc?.model && !loading && (
          <div className="absolute inset-0 grid place-items-center">
            <EmptyState icon="user" title="Bring in a 3D avatar" className="bg-panel/80 rounded-2xl border border-line"
              action={canEdit ? (
                <div className="flex flex-col gap-2 items-stretch">
                  <Button variant="primary" icon="upload" onClick={importFiles}>Import a model…</Button>
                  <Button icon="folder" onClick={fromFiles}>Choose from Files…</Button>
                  <Button variant="ghost" icon="sparkles" onClick={startStarter}>Use the starter avatar</Button>
                </div>
              ) : null}>
              {canEdit ? 'VRM 0.x or 1.0, glTF / GLB, or FBX (with its textures). No model yet? Start with the starter avatar to try expressions, spring bones and tracking.' : 'This project has no avatar yet.'}
            </EmptyState>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-work/50">
            <div className="bg-panel border border-line rounded-xl px-5 py-4 w-72 shadow-lg">
              <div className="flex items-center gap-2 text-sm mb-2"><Spinner /> {loading.label}</div>
              <ProgressBar value={loading.p ?? 0} indeterminate={loading.p === null || loading.p === undefined} />
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-x-0 bottom-10 flex justify-center">
            <div className="bg-panel border border-danger/50 rounded-lg px-4 py-2 text-sm max-w-md">Couldn’t load the avatar: {error.message}</div>
          </div>
        )}
        <input ref={fileInput} type="file" hidden multiple accept={MODEL_EXT} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {/* panel */}
      <aside className="w-[300px] shrink-0 bg-panel border-l border-line overflow-y-auto scroll-thin" aria-label={TABS.find((t) => t.id === tab)?.label}>
        <div className="h-9 px-3 flex items-center border-b border-line text-[13px] font-semibold">{TABS.find((t) => t.id === tab)?.label}</div>
        {doc && <Panel {...ctx} />}
      </aside>
    </div>
  );
}
