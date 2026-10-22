// Sora Ningyō's 2D rig editor (Live2D Cubism-style): import a PSD, separate and mesh the parts, build warp / rotation
// deformers, record keyforms on parameters, add physics and expressions, map tracking to parameters, export.
// It renders into the app's EditorShell through `ui` (portals for the tool strip, options bar, panels and status).
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Tool, ToolDivider } from '../../../components/EditorShell.jsx';
import { Button, Slider, Select, Toggle, Tabs, Spinner, ProgressBar, toast, toastError, confirmDialog, cx } from '../../../components/ui.jsx';
import { useShortcuts, keyLabel } from '../../../lib/shortcuts.js';
import Viewport from './Viewport.jsx';
import { PartsPanel, DeformersPanel, ParamsPanel, PhysicsPanel, ExpressionsPanel, TrackingMapPanel } from './Panels2D.jsx';
import { defaults, editForm, exactKey, addParamKey, removeParamKey, paramById, uid, objById } from './model.js';
import { autoRig, mirrorToOpposite, mirrorToCounterpart, counterpart } from './rig.js';
import { autoMesh, retriangulate, withMesh } from './mesh.js';
import { texPixels, cachedPixels, saveTex, contentBox, cropData, splitByPolygon, fillBehind } from './textures.js';
import { readLayers, layersToParts, readPngs } from './psd.js';
import { exportSoraAvatar, importSoraAvatar, exportInochi2D, exportPng } from './export.js';
import { applyExpressions } from './render.js';

const TOOLS = [
  { id: 'select', label: 'Select / move part', key: 'v', icon: 'select' },
  { id: 'mesh', label: 'Edit mesh (rest pose)', key: 'm', icon: 'polygon', edit: true },
  { id: 'deform', label: 'Deform (record keyform)', key: 'd', icon: 'directSelect', edit: true },
  { divider: true },
  { id: 'lasso', label: 'Split part with lasso', key: 'l', icon: 'lasso', edit: true },
  { id: 'fill', label: 'Fill behind (extend colours into hidden areas)', key: 'f', icon: 'heal', edit: true },
  { divider: true },
  { id: 'hand', label: 'Hand', key: 'h', icon: 'hand' },
];

export default function Editor2D({ project, h, doc, canEdit, ui }) {
  const docId = project.doc?.id;
  const [tool, setTool] = useState('select');
  const [sel, setSel] = useState(null);
  const [vsel, setVsel] = useState(() => new Set());
  const [values, setValues] = useState(() => defaults(doc));
  const [active, setActive] = useState('ParamAngleX');
  const [view, setView] = useState(null);
  const [tab, setTab] = useState('parts');
  const [opts, setOpts] = useState({ density: 48, soft: 0, brush: 24, showMesh: false });
  const [physics, setPhysics] = useState(false);
  const [preview, setPreview] = useState({}); // expressions previewed in the editor
  const [busy, setBusy] = useState(null); // { label, p }
  const [report, setReport] = useState([]);
  const fileRef = useRef(null);
  useEffect(() => { if (!canEdit) setTool('select'); }, [canEdit]);
  useEffect(() => { setVsel(new Set()); }, [sel?.id, tool]);
  // keep values for parameters that appear later
  useEffect(() => { setValues((v) => ({ ...defaults(doc), ...v })); }, [doc.params]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- editing (all through history)
  const edit = useCallback((fn, label, merge) => { if (canEdit) h.set((d) => fn(d), label, merge ? { merge } : undefined); }, [canEdit, h.set]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = useRef({ key: null, doc: null });
  const fromStart = (key) => { if (start.current.key !== key) start.current = { key, doc: h.get() }; return start.current.doc; };
  const commit = () => { h.commit(); start.current = { key: null, doc: null }; };
  const replacePart = (d, part) => ({ ...d, parts: d.parts.map((p) => (p.id === part.id ? part : p)) });
  const replaceObj = (d, obj) => (d.parts.some((p) => p.id === obj.id) ? replacePart(d, obj) : { ...d, deformers: d.deformers.map((x) => (x.id === obj.id ? obj : x)) });
  const pixelsOf = async (part) => cachedPixels(part.tex) || texPixels(part.tex);

  const onMovePart = (id, dx, dy, key) => {
    const s = fromStart(key);
    const ids = sel?.type === 'part' && (sel.id === id || sel.more?.includes(id)) ? [sel.id, ...(sel.more || [])] : [id];
    const rx = Math.round(dx); const ry = Math.round(dy);
    h.set({ ...s, parts: s.parts.map((p) => (ids.includes(p.id) ? { ...p, x: p.x + rx, y: p.y + ry, mesh: p.mesh && { ...p.mesh, v: p.mesh.v.map((v, i) => v + (i % 2 ? ry : rx)) } } : p)) }, 'Move part', { merge: key });
  };
  const onMoveDeformer = (id, dx, dy, corner, key) => {
    const s = fromStart(key);
    h.set({ ...s, deformers: s.deformers.map((d) => {
      if (d.id !== id) return d;
      if (d.type === 'rotation') return { ...d, pivot: [Math.round(d.pivot[0] + dx), Math.round(d.pivot[1] + dy)] };
      let [x, y, w, hh] = d.rect;
      if (corner < 0) { x += dx; y += dy; } else {
        if (corner === 0 || corner === 2) { x += dx; w -= dx; } else w += dx;
        if (corner === 0 || corner === 1) { y += dy; hh -= dy; } else hh += dy;
      }
      return { ...d, rect: [Math.round(x), Math.round(y), Math.max(8, Math.round(w)), Math.max(8, Math.round(hh))] };
    }) }, 'Move deformer', { merge: key });
  };
  const onMesh = async (id, mesh, label, key, o = {}) => {
    const part = h.get().parts.find((p) => p.id === id); if (!part) return;
    if (o.retriangulate) {
      const px = await pixelsOf(part).catch(() => null);
      mesh = { ...mesh, t: retriangulate(mesh.v, px, part.x, part.y) };
      edit((d) => replacePart(d, withMesh(d.parts.find((p) => p.id === id), mesh)), label);
      return;
    }
    h.set((d) => replacePart(d, { ...d.parts.find((p) => p.id === id), mesh }), label, key ? { merge: key } : undefined);
  };
  const removeVertices = () => {
    const part = sel?.type === 'part' && doc.parts.find((p) => p.id === sel.id);
    if (!part?.mesh || !vsel.size) return;
    if (part.mesh.v.length / 2 - vsel.size < 3) { toast('A mesh needs at least 3 vertices.'); return; }
    const keep = []; for (let i = 0; i < part.mesh.v.length / 2; i++) if (!vsel.has(i)) keep.push(i);
    const v = keep.flatMap((i) => [part.mesh.v[i * 2], part.mesh.v[i * 2 + 1]]);
    const pins = (part.mesh.pins || []).filter((i) => !vsel.has(i)).map((i) => keep.indexOf(i));
    const kf = (part.kf || []).map((b) => ({ ...b, forms: Object.fromEntries(Object.entries(b.forms).map(([k, f]) => [k, f.v ? { ...f, v: keep.flatMap((i) => [f.v[i * 2] || 0, f.v[i * 2 + 1] || 0]) } : f])) }));
    const px = cachedPixels(part.tex);
    edit((d) => replacePart(d, { ...part, kf, mesh: { ...part.mesh, v, pins, t: retriangulate(v, px, part.x, part.y) } }), 'Delete vertices');
    setVsel(new Set());
  };
  const togglePins = () => {
    const part = sel?.type === 'part' && doc.parts.find((p) => p.id === sel.id);
    if (!part?.mesh || !vsel.size) { toast('Select vertices (Mesh or Deform tool), then press P to pin them.'); return; }
    const pins = new Set(part.mesh.pins || []); const allPinned = [...vsel].every((i) => pins.has(i));
    for (const i of vsel) if (allPinned) pins.delete(i); else pins.add(i);
    edit((d) => replacePart(d, { ...part, mesh: { ...part.mesh, pins: [...pins] } }), allPinned ? 'Unpin vertices' : 'Pin vertices');
  };

  /** Which keyform the Deform tool edits for this object: the binding that uses the active parameter, at its key. */
  const editTarget = (obj) => {
    if (!active) { toast('Pick a parameter in the Parameters tab first.'); return null; }
    const bs = (obj.kf || []).filter((b) => b.params.includes(active));
    const b = bs.find((x) => exactKey(doc, x, values)) || bs[0] || { params: [active], forms: {} };
    const key = exactKey(doc, b, values);
    if (key === null) {
      const names = b.params.map((p) => paramById(doc, p)?.name).join(' and ');
      toast(`Move ${names} onto a key (◆) to record a keyform there.`); return null;
    }
    return { params: b.params, key };
  };
  const onForm = (id, target, fn, key) => {
    const o = objById(h.get(), id);
    if (!(o.kf || []).some((b) => b.params.join('|') === target.params.join('|'))) toast(`${o.name} now has keyforms on ${target.params.map((p) => paramById(doc, p)?.name).join(' × ')}.`);
    h.set((d) => replaceObj(d, editForm(objById(d, id), target.params, target.key, fn)), 'Deform', { merge: key });
  };

  // ---------------------------------------------------------------- texture tools
  const run = async (label, fn) => { setBusy({ label, p: null }); try { await fn((p, l) => setBusy({ label: l || label, p })); } catch (e) { toastError(e); } finally { setBusy(null); } };
  const onLasso = (id, pts) => run('Splitting…', async () => {
    const part = h.get().parts.find((p) => p.id === id);
    const px = await pixelsOf(part);
    const poly = pts.map(([x, y]) => [((x - part.x) / part.w) * px.width, ((y - part.y) / part.h) * px.height]);
    const { inside, outside } = splitByPolygon(px, poly);
    const bi = contentBox(inside); const bo = contentBox(outside);
    if (!bi) { toast('Nothing of this part is inside that lasso.'); return; }
    if (!bo) { toast('The lasso covers the whole part — nothing to split off.'); return; }
    const make = async (data, box, name) => {
      const tex = await saveTex(cropData(data, box), name, docId);
      const np = { ...part, tex, x: part.x + box[0], y: part.y + box[1], w: box[2], h: box[3] };
      const m = autoMesh(cropData(data, box), { density: part.mesh?.density || 48 });
      return withMesh(np, { v: m.v.map((v, k) => Math.round((v + (k % 2 ? np.y : np.x)) * 10) / 10), t: m.t, pins: [], density: part.mesh?.density || 48 });
    };
    const a = { ...(await make(inside, bi, `${part.name} (split)`)), id: uid('p'), name: `${part.name} (split)` };
    const b = await make(outside, bo, part.name);
    edit((d) => { const parts = []; for (const p of d.parts) { if (p.id === id) parts.push(b, a); else parts.push(p); } return { ...d, parts }; }, 'Split part');
    setSel({ type: 'part', id: a.id });
    toast('Split into two parts. The new one is on top; rename it in the Part panel.', { type: 'success' });
  });
  const onFill = (id, pts, radius) => run('Filling behind…', async () => {
    const part = h.get().parts.find((p) => p.id === id);
    const px = await pixelsOf(part);
    const sx = px.width / part.w; const sy = px.height / part.h;
    const { data, dx, dy } = fillBehind(px, pts.map(([x, y]) => [(x - part.x) * sx, (y - part.y) * sy]), radius * sx);
    const tex = await saveTex(data, part.name, docId);
    const np = { ...part, tex, x: part.x - dx / sx, y: part.y - dy / sy, w: data.width / sx, h: data.height / sy };
    // the texture grew: mesh it again so the new area shows (keyforms carry over)
    const m = autoMesh(data, { density: part.mesh?.density || 48 });
    const mesh = { v: m.v.map((v, k) => Math.round(((k % 2 ? v / sy + np.y : v / sx + np.x)) * 10) / 10), t: m.t, pins: [], density: part.mesh?.density || 48 };
    edit((d) => replacePart(d, withMesh(np, mesh)), 'Fill behind');
  });
  const onAutoCrop = (id) => run('Cropping…', async () => {
    const part = h.get().parts.find((p) => p.id === id);
    const px = await pixelsOf(part); const box = contentBox(px);
    if (!box) { toast('This part is empty.'); return; }
    if (box[2] === px.width && box[3] === px.height) { toast('Already cropped to its content.'); return; }
    const tex = await saveTex(cropData(px, box), part.name, docId);
    const sx = part.w / px.width; const sy = part.h / px.height;
    edit((d) => replacePart(d, { ...d.parts.find((p) => p.id === id), tex, x: part.x + box[0] * sx, y: part.y + box[1] * sy, w: box[2] * sx, h: box[3] * sy }), 'Auto-crop');
  });
  const onRemesh = (id, density) => run('Meshing…', async () => {
    const part = h.get().parts.find((p) => p.id === id);
    const px = await pixelsOf(part);
    const m = autoMesh(px, { density });
    const sx = part.w / px.width; const sy = part.h / px.height;
    const mesh = { v: m.v.map((v, k) => Math.round((k % 2 ? v * sy + part.y : v * sx + part.x) * 10) / 10), t: m.t, pins: [], density };
    edit((d) => replacePart(d, withMesh(d.parts.find((p) => p.id === id), mesh)), 'Auto mesh');
    toast(`${m.v.length / 2} vertices`);
  });
  const remeshAll = () => run('Meshing all parts…', async (prog) => {
    let d = h.get(); const n = d.parts.length;
    for (let i = 0; i < n; i++) {
      const part = d.parts[i]; prog(i / n, `Meshing ${part.name}…`);
      const px = await pixelsOf(part); const m = autoMesh(px, { density: opts.density });
      const sx = part.w / px.width; const sy = part.h / px.height;
      d = replacePart(d, withMesh(part, { v: m.v.map((v, k) => Math.round((k % 2 ? v * sy + part.y : v * sx + part.x) * 10) / 10), t: m.t, pins: [], density: opts.density }));
    }
    edit(() => d, 'Auto mesh all');
  });
  const onDelete = async (ids) => {
    if (!ids.length) return;
    const used = doc.parts.filter((p) => !ids.includes(p.id) && (p.clip || []).some((c) => ids.includes(c)));
    if (used.length && !(await confirmDialog({ title: 'Delete parts?', message: `${used.map((p) => p.name).join(', ')} use ${ids.length > 1 ? 'these parts' : 'this part'} as a clipping mask.`, confirm: 'Delete' }))) return;
    edit((d) => ({ ...d, parts: d.parts.filter((p) => !ids.includes(p.id)).map((p) => ({ ...p, clip: (p.clip || []).filter((c) => !ids.includes(c)) })) }), ids.length > 1 ? 'Delete parts' : 'Delete part');
    setSel(null);
  };
  const onAddDeformer = (type) => {
    const ids = sel?.type === 'part' ? [sel.id, ...(sel.more || [])] : [];
    const parts = ids.length ? doc.parts.filter((p) => ids.includes(p.id)) : doc.parts;
    if (!parts.length) { toast('Import some parts first.'); return; }
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const p of parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
    const parent = parts[0].parent && parts.every((p) => p.parent === parts[0].parent) ? parts[0].parent : (sel?.type === 'deformer' ? sel.id : null);
    const name = ids.length === 1 ? parts[0].name : type === 'warp' ? 'Warp' : 'Rotation';
    const d = type === 'warp'
      ? { id: uid('d'), name: `${name} warp`, type, parent, rect: [Math.round(x0 - 10), Math.round(y0 - 10), Math.round(x1 - x0 + 20), Math.round(y1 - y0 + 20)], cols: 3, rows: 3, opacity: 1, kf: [] }
      : { id: uid('d'), name: `${name} rotation`, type, parent, pivot: [Math.round((x0 + x1) / 2), Math.round(y1)], opacity: 1, kf: [] };
    edit((x) => ({ ...x, deformers: [...x.deformers, d], parts: ids.length ? x.parts.map((p) => (ids.includes(p.id) ? { ...p, parent: d.id } : p)) : x.parts }), `Add ${type} deformer`);
    setSel({ type: 'deformer', id: d.id }); setTab('rig');
  };
  const onAutoRig = () => {
    const { doc: next, report: r } = autoRig(h.get());
    setReport(r);
    if (next !== h.get()) { edit(() => next, 'Auto-rig face'); toast(`Face rigged${r.some((l) => l.startsWith('Arm')) ? ' (and arms)' : ''} — try the Angle X / Eye L Open / Mouth Open${r.some((l) => l.startsWith('Arm')) ? ' / Arm L A' : ''} sliders.`, { type: 'success' }); }
  };

  // ---------------------------------------------------------------- import
  const pick = (accept, multiple) => new Promise((resolve) => {
    const i = fileRef.current; i.accept = accept; i.multiple = multiple; i.value = '';
    i.onchange = () => resolve([...i.files]); i.click();
  });
  const placeLayers = async (res, label) => {
    let replace = !doc.parts.length;
    if (!replace) replace = await confirmDialog({ title: `${label}`, message: 'Replace the current parts, or add these to them?', confirm: 'Replace', cancel: 'Add' });
    const parts = await layersToParts(res.layers, { docId, density: opts.density, onProgress: (p, l) => setBusy({ label: l, p }) });
    edit((d) => (replace
      ? { ...d, width: res.width, height: res.height, parts, groups: res.groups, deformers: [], physics: [] }
      : { ...d, parts: [...d.parts, ...parts], groups: [...d.groups, ...res.groups] }), label);
    setView(null); setSel(null);
    const named = parts.filter((p) => p.role).length;
    toast(`${parts.length} parts imported, ${named} recognised for the face rig. Next: Rig → Auto-rig face.`, { type: 'success' });
  };
  const importPsd = async (f) => {
    const [file] = f || await pick('.psd,image/vnd.adobe.photoshop', false); if (!file) return;
    await run('Reading the PSD…', async () => {
      const res = readLayers(await file.arrayBuffer());
      if (!res.layers.length) { toast('No bitmap layers found in that PSD.', { type: 'error' }); return; }
      await placeLayers(res, 'Import PSD');
    });
  };
  const importPngs = async () => {
    const files = await pick('image/png,image/webp', true); if (!files.length) return;
    await run('Reading images…', async () => placeLayers(await readPngs(files), 'Import PNG layers'));
  };
  const openSora = async () => {
    const [file] = await pick('.sora-avatar,.zip', false); if (!file) return;
    await run('Opening…', async (prog) => {
      const m = await importSoraAvatar(file, docId, prog);
      edit((d) => ({ ...m, kind: '2d', tracking: d.tracking, perform: d.perform }), 'Open .sora-avatar'); setView(null);
    });
  };
  // drop a PSD / PNGs on the workspace
  const onDrop = (e) => {
    e.preventDefault(); if (!canEdit) return;
    const files = [...e.dataTransfer.files];
    if (files.some((f) => /\.psd$/i.test(f.name))) importPsd(files.filter((f) => /\.psd$/i.test(f.name)));
    else if (files.some((f) => /\.sora-avatar$/i.test(f.name))) toast('Use File → Open .sora-avatar…');
    else if (files.length) run('Reading images…', async () => placeLayers(await readPngs(files.filter((f) => f.type.startsWith('image/'))), 'Import PNG layers'));
  };

  // ---------------------------------------------------------------- keyforms
  const shownValues = useMemo(() => applyExpressions(doc, { ...values }, preview), [doc, values, preview]);
  const onBind = (obj, params) => {
    if (params.some((p) => !p)) return;
    if ((obj.kf || []).some((b) => b.params.join('|') === params.join('|'))) { toast('Already has keyforms on that.'); return; }
    edit((d) => replaceObj(d, { ...obj, kf: [...(obj.kf || []), { params, forms: {} }] }), 'Add keyforms');
    toast(`Now move ${params.map((p) => paramById(doc, p)?.name).join(' / ')} to a key and shape ${obj.name} with the Deform tool (D).`);
    setTool('deform');
  };
  const onMirror = (obj, pid) => {
    const v = values[pid]; const out = mirrorToOpposite(doc, obj, pid, v);
    if (!out) { toast('Move the parameter to a key (other than the middle) that has a form, with a matching key on the other side.'); return; }
    edit((d) => replaceObj(d, out), 'Mirror keyform'); toast('Mirrored to the opposite key.', { type: 'success' });
  };
  const onMirrorPair = (part) => {
    const out = mirrorToCounterpart(doc, part);
    if (!out) { toast(counterpart(doc, part) ? 'Both parts need meshes.' : 'No matching part on the other side (by role L/R or name).'); return; }
    edit((d) => replacePart(d, out), 'Copy keyforms to other side'); toast(`Copied to ${out.name}.`, { type: 'success' });
  };

  // ---------------------------------------------------------------- shell hookup: menus, export, thumbnail
  const docRef = useRef(doc); docRef.current = doc;
  const valRef = useRef(values); valRef.current = values;
  useEffect(() => {
    ui.set({
      fileItems: [
        { label: 'Import PSD…', icon: 'import', onClick: () => importPsd(), disabled: !canEdit },
        { label: 'Import PNG layers…', icon: 'image', onClick: importPngs, disabled: !canEdit },
        { label: 'Open .sora-avatar…', icon: 'folder', onClick: openSora, disabled: !canEdit },
      ],
      menus: [
        { label: 'Rig', items: () => [
          { label: 'Auto-rig face', icon: 'sparkles', onClick: onAutoRig, disabled: !canEdit },
          { label: 'Auto mesh all parts', icon: 'grid', onClick: remeshAll, disabled: !canEdit },
          { divider: true },
          { label: 'Add warp deformer', icon: 'grid', onClick: () => onAddDeformer('warp'), disabled: !canEdit },
          { label: 'Add rotation deformer', icon: 'rotate', onClick: () => onAddDeformer('rotation'), disabled: !canEdit },
          { divider: true },
          { label: 'Pin / unpin selected vertices', shortcut: 'P', onClick: togglePins, disabled: !canEdit },
          { label: 'Reset parameters', onClick: () => setValues(defaults(docRef.current)) },
        ] },
        { label: 'View', items: () => [
          { label: 'Fit', shortcut: keyLabel('mod+0'), onClick: () => setView(null) },
          { label: 'Show mesh on the selected part', checked: opts.showMesh, onClick: () => setOpts((o) => ({ ...o, showMesh: !o.showMesh })) },
          { label: 'Preview physics', checked: physics, onClick: () => setPhysics(!physics) },
        ] },
      ],
      exportConfig: {
        formats: [
          { id: 'png', label: 'PNG (current pose, transparent)', ext: 'png', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '100%'], [0.5, '50%'], [0.25, '25%']] }] },
          { id: 'sora', label: 'Sora Ningyō model (.sora-avatar)', ext: 'sora-avatar', kind: 'other', note: 'SoraLab’s open format: the rig as JSON plus PNG textures, zipped. Live2D .moc3 / .cmo3 files are proprietary, so SoraLab can’t write them.' },
          { id: 'inp', label: 'Inochi2D puppet (.inp)', ext: 'inp', kind: 'other', note: 'Parts, meshes, masks, blend modes and parameters (deformers baked into per-key vertex offsets). Physics and expressions aren’t carried over.' },
        ],
        render: async (fid, o, { onProgress }) => {
          const d = docRef.current;
          if (fid === 'sora') return exportSoraAvatar(d, onProgress);
          if (fid === 'inp') return exportInochi2D(d, project.doc?.name || 'Avatar', onProgress);
          return exportPng(d, valRef.current, o.scale || 1);
        },
      },
      thumb: async () => { const d = docRef.current; if (!d.parts.length) return null; return exportPng(d, defaults(d), Math.min(1, 480 / Math.max(d.width, d.height))); },
    });
  });

  // ---------------------------------------------------------------- shortcuts
  const E = (f) => () => { if (canEdit) f(); };
  useShortcuts({
    ...Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key, () => { if (t.edit && !canEdit) return; setTool(t.id); }])),
    p: E(togglePins),
    delete: E(() => (tool === 'mesh' && vsel.size ? removeVertices() : sel?.type === 'part' ? onDelete([sel.id, ...(sel.more || [])]) : null)),
    backspace: E(() => (tool === 'mesh' && vsel.size ? removeVertices() : null)),
    escape: () => { if (vsel.size) setVsel(new Set()); else setSel(null); },
    'mod+a': () => { const p = sel?.type === 'part' && doc.parts.find((x) => x.id === sel.id); if (p?.mesh && (tool === 'mesh' || tool === 'deform')) setVsel(new Set(p.mesh.v.map((_, i) => i).filter((i) => i % 2 === 0).map((i) => i / 2))); },
    'mod+0': () => setView(null),
    'mod+=': () => setView((v) => v && { ...v, s: v.s * 1.25 }), 'mod+-': () => setView((v) => v && { ...v, s: v.s / 1.25 }),
  }, [tool, sel, vsel, doc, canEdit, values, active]);

  // ---------------------------------------------------------------- slots
  const selObj = sel ? objById(doc, sel.id) : null;
  const target = tool === 'deform' && selObj && active ? (() => { const bs = (selObj.kf || []).filter((b) => b.params.includes(active)); const b = bs.find((x) => exactKey(doc, x, values)) || bs[0] || { params: [active] }; return { b, key: exactKey(doc, b, values), has: !!bs.length }; })() : null;
  const o = (patch) => setOpts((x) => ({ ...x, ...patch }));
  const options = {
    select: <><span className="text-xs text-fg3">Click a part to select it (Shift adds), drag to move it. Wheel zooms, Space-drag pans.</span><Toggle className="ml-2" label="Show mesh" checked={opts.showMesh} onChange={(v) => o({ showMesh: v })} /></>,
    mesh: <><span className="text-xs text-fg2">Density</span><Slider className="w-28" showNumber={false} value={opts.density} min={12} max={160} onChange={(v) => o({ density: v })} /><span className="text-xs tabular-nums w-10">{opts.density}px</span>
      <Button size="sm" icon="grid" disabled={!selObj?.mesh} onClick={() => onRemesh(sel.id, opts.density)}>Auto mesh</Button>
      <Button size="sm" variant="ghost" icon="pin" disabled={!vsel.size} onClick={togglePins}>Pin (P)</Button>
      <Button size="sm" variant="ghost" icon="trash" disabled={!vsel.size} onClick={removeVertices}>Delete vertices</Button>
      <span className="text-[11px] text-fg3">Click inside the part to add a vertex; drag to move (moves where the texture is sampled).</span></>,
    deform: <><span className="text-xs text-fg2">Soft radius</span><Slider className="w-28" showNumber={false} value={opts.soft} min={0} max={400} onChange={(v) => o({ soft: v })} /><span className="text-xs tabular-nums w-10">{opts.soft}px</span>
      <span className={cx('text-xs', target?.key ? 'text-ok' : 'text-warn')}>{!selObj ? 'Select a part or deformer.' : !active ? 'Pick a parameter.' : target?.key ? `Editing ${selObj.name} at ${target.b.params.map((p) => `${paramById(doc, p)?.name} = ${+(values[p] ?? 0).toFixed(2)}`).join(', ')}` : `Move ${target?.b.params.map((p) => paramById(doc, p)?.name).join(' / ')} onto a key (◆) to edit`}</span>
      <span className="text-[11px] text-fg3">Pinned vertices stay put.</span></>,
    lasso: <span className="text-xs text-fg3">Draw around part of the selected layer to split it off into its own part (e.g. separate an eye from the face).</span>,
    fill: <><span className="text-xs text-fg2">Brush</span><Slider className="w-28" showNumber={false} value={opts.brush} min={4} max={200} onChange={(v) => o({ brush: v })} /><span className="text-xs tabular-nums w-10">{opts.brush}px</span><span className="text-[11px] text-fg3">Paint where colour is missing behind other parts (e.g. skin under the hair) — edge colours grow into it.</span></>,
    hand: <span className="text-xs text-fg3">Drag to pan.</span>,
  }[tool];

  // The panels follow a deferred copy of the document: while dragging vertices they catch up when there's time,
  // so the viewport stays smooth with many parts (nothing they show changes during a drag anyway).
  const pdoc = useDeferredValue(doc);
  const panels = useMemo(() => (
        <div>
          <Tabs className="px-1 sticky top-0 bg-panel z-10" value={tab} onChange={setTab} tabs={[{ value: 'parts', label: 'Parts' }, { value: 'rig', label: 'Rig' }, { value: 'params', label: 'Params' }, { value: 'physics', label: 'Physics' }, { value: 'face', label: 'Face' }]} />
          {tab === 'parts' && <PartsPanel doc={pdoc} sel={sel} setSel={setSel} canEdit={canEdit} edit={edit} onAutoCrop={onAutoCrop} onRemesh={onRemesh} onDelete={onDelete} />}
          {tab === 'rig' && <DeformersPanel doc={pdoc} sel={sel} setSel={setSel} canEdit={canEdit} edit={edit} onAdd={onAddDeformer} onAutoRig={onAutoRig} report={report} />}
          {tab === 'params' && <ParamsPanel doc={pdoc} values={values} setValues={setValues} active={active} setActive={setActive} canEdit={canEdit} edit={edit} sel={sel} onAddKey={(pid, v) => edit((d) => addParamKey(d, pid, v), 'Add key')} onRemoveKey={(pid, v) => edit((d) => removeParamKey(d, pid, v), 'Remove key')} onMirror={onMirror} onMirrorPair={onMirrorPair} onBind={onBind} />}
          {tab === 'physics' && <PhysicsPanel doc={pdoc} canEdit={canEdit} edit={edit} running={physics} setRunning={setPhysics} />}
          {tab === 'face' && <><ExpressionsPanel doc={pdoc} values={values} canEdit={canEdit} edit={edit} preview={preview} setPreview={setPreview} /><TrackingMapPanel doc={pdoc} canEdit={canEdit} edit={edit} /></>}
        </div>
  ), [pdoc, tab, sel, values, active, canEdit, physics, preview, report]); // eslint-disable-line react-hooks/exhaustive-deps
  const tools = TOOLS.map((t, i) => (t.divider ? <ToolDivider key={i} /> : <Tool key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={tool === t.id} onClick={() => { if (t.edit && !canEdit) return; setTool(t.id); }} />));
  const verts = doc.parts.reduce((n, p) => n + (p.mesh?.v.length || 0) / 2, 0);

  return (
    <>
      {ui.portal('tools', tools)}
      {ui.portal('options', <>{options}<div className="ml-auto flex items-center gap-2"><Toggle label="Physics" checked={physics} onChange={setPhysics} /></div></>)}
      {ui.portal('panels', panels)}
      {ui.portal('status', <><span>{doc.parts.length} parts · {verts} vertices · {doc.deformers.length} deformers</span><span>{doc.width}×{doc.height}</span><span className="text-fg3">Saved in SoraLab’s open format (not Live2D .moc3)</span>{!canEdit && <span className="text-warn">View only</span>}</>)}
      <div className="absolute inset-0" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <Viewport doc={doc} values={shownValues} tool={tool} canEdit={canEdit} sel={sel} setSel={setSel} vsel={vsel} setVsel={setVsel} opts={opts} editTarget={editTarget} physics={physics}
          view={view} setView={setView} onMovePart={onMovePart} onMoveDeformer={onMoveDeformer} onMesh={onMesh} onForm={onForm} onCommit={commit} onLasso={onLasso} onFill={onFill}
          onPick={() => { if (tab !== 'parts' && tab !== 'params') setTab('parts'); }} />
        {!doc.parts.length && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="pointer-events-auto text-center max-w-md bg-panel/90 border border-line rounded-xl p-6 shadow-lg">
              <div className="font-head font-semibold text-lg mb-1">Start from your artwork</div>
              <p className="text-sm text-fg2 mb-4">Import a layered PSD: every layer becomes a part, in place. Name layers like “Face”, “Eye L white”, “Iris L”, “Mouth upper” or 前髪 and Auto-rig can set up the face for you.</p>
              <div className="flex gap-2 justify-center">
                <Button variant="primary" icon="import" disabled={!canEdit} onClick={() => importPsd()} data-testid="av-import-psd">Import PSD…</Button>
                <Button icon="image" disabled={!canEdit} onClick={importPngs}>PNG layers…</Button>
              </div>
              <p className="text-[11px] text-fg3 mt-3">Or drop files here. You can also open a .sora-avatar from the File menu.</p>
            </div>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/30">
            <div className="bg-panel border border-line rounded-xl p-4 w-80 shadow-lg">
              <div className="flex items-center gap-2 text-sm mb-2"><Spinner />{busy.label}</div>
              <ProgressBar value={busy.p ?? 0} indeterminate={busy.p === null} />
            </div>
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" className="hidden" data-testid="av-file" />
    </>
  );
}
