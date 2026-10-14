// Develop (Sora Hikari) — a Lightroom-style photo catalog and raw-style developer.
//
// Library (G): import, grid with ratings / flags / colour labels, filters, collections, keywords, metadata.
// Develop (D): a WebGL2 pipeline with Basic, Tone Curve, Color Mixer, Color Grading, Detail, Optics, Effects,
// crop & straighten (R), local masks (linear M, radial ⇧M, brush K), presets, snapshots, history and before/after (\).
// The whole catalog is one document in useHistory, so every change — in either module — is undoable.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { Spinner, Button, IconButton, Select, Segmented, Slider, Toggle, promptDialog, confirmDialog, toast, toastError, openMenu, cx } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { exportDialog } from '../../components/ProjectDialogs.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts } from '../../lib/shortcuts.js';
import { api, uploadFiles, saveBlob, download } from '../../lib/api.js';
import { appById } from '../../lib/apps.js';
import { useApp } from '../../lib/app.jsx';
import {
  fromSaved, toSaved, newPhoto, uid, clamp, compact, expand, overlay, copyableFull, defaultSettings, isEdited, filterPhotos, sortPhotos,
  COLOR_LABELS, ASPECTS, aspectValue, cropToAspect, constrainCrop, orientedSize, maskAdjDefaults, neutralize, toLinear,
} from './model.js';
import { Renderer, toCube, parseCube } from './engine.js';
import { renderPhoto, encode, loadPhotoImage, waitReady, getAsset, loadLut } from './media.js';
import { setIn } from './Panels.jsx';
import { DevelopPanels, MaskPanel, Histogram } from './Panels.jsx';
import { Grid, Filmstrip, FilterBar, CatalogPanel, MetadataPanel } from './Library.jsx';
import LeftPanels from './LeftPanels.jsx';
import Viewer from './Viewer.jsx';

const FILTER0 = { text: '', rating: 0, ratingOp: 'gte', flag: 'all', label: 'any', edited: 'all', collection: 'all' };
const MASK_TOOLS = ['linear', 'radial', 'brush', 'mask'];
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const baseName = (n) => (n || 'photo').replace(/\.[a-z0-9]+$/i, '');

// Settings copied with Ctrl+Shift+C (kept for this browser, so they paste into other catalogs too).
let clip = lsGet('hikari-clipboard', null);

export default function DevelopEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const doc = h.state;
  const readOnly = !project.canEdit;
  const { libraries, reloadLibraries } = useApp();
  const app = appById('develop');

  const [view, setView] = useState('library');
  const [sel, setSel] = useState(() => new Set());
  const [cur, setCur] = useState(null);
  const [filter, setFilter] = useState(FILTER0);
  const [sort, setSort] = useState(() => lsGet('hikari-sort', { by: 'added', desc: false }));
  const [thumbSize, setThumbSize] = useState(() => lsGet('hikari-thumb', 170));
  const [tool, setTool] = useState(null);
  const [maskSel, setMaskSel] = useState(null);
  const [brush, setBrush] = useState({ size: 120, feather: 50, flow: 100, erase: false });
  const [showOverlay, setShowOverlay] = useState(false);
  const [before, setBefore] = useState('off');
  const [split, setSplit] = useState(0.5);
  const [zoom, setZoom] = useState('fit');
  const [clipWarn, setClipWarn] = useState(false);
  const [hist, setHist] = useState(null);
  const [hoverPreview, setHoverPreview] = useState(null);
  useEffect(() => lsSet('hikari-sort', sort), [sort]);
  useEffect(() => lsSet('hikari-thumb', thumbSize), [thumbSize]);

  // ---------------------------------------------------------------- load (and "Open in Develop" imports)
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    (async () => {
      let d = fromSaved(project.data);
      const ui = lsGet(`hikari-ui-${id}`, null);
      const pending = Array.isArray(project.doc.meta?.import) ? project.doc.meta.import : [];
      let first = null;
      if (!d.photos.length && pending.length) {
        const assets = (await Promise.all(pending.map((a) => api.get(`/api/assets/${encodeURIComponent(a)}`).catch(() => null)))).filter((a) => a && a.kind === 'image');
        d = { ...d, photos: assets.map(newPhoto) };
        first = d.photos[0]?.id;
      }
      if (off) return;
      h.reset(d);
      const keep = ui && d.photos.some((p) => p.id === ui.cur) ? ui.cur : null;
      const c = first || keep || d.photos[0]?.id || null;
      setCur(c); setSel(new Set(c ? [c] : []));
      setView(first && d.photos.length === 1 ? 'develop' : keep && ui.view === 'develop' ? 'develop' : 'library');
    })();
    return () => { off = true; };
  }, [project.data, project.doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (doc) lsSet(`hikari-ui-${id}`, { cur, view }); }, [cur, view, id, doc]);

  const photos = useMemo(() => (doc ? sortPhotos(filterPhotos(doc.photos, filter, doc.collections), sort.by, sort.desc) : []), [doc, filter, sort]);
  const photo = doc?.photos.find((p) => p.id === cur) || null;
  // Selection that actions apply to: the selected photos when the current one is among them, else just the current.
  const targets = useMemo(() => (!photo ? [] : sel.has(photo.id) ? [...sel].filter((x) => doc.photos.some((p) => p.id === x)) : [photo.id]), [sel, photo, doc]);

  // Leaving a photo ends tools that belong to it.
  useEffect(() => { setMaskSel(null); setHoverPreview(null); if (tool && tool !== 'crop') setTool(MASK_TOOLS.includes(tool) ? 'mask' : null); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- editing
  const serial = useRef(0);
  const commit = useCallback(() => { h.commit(); serial.current++; }, [h]);

  const mapPhotos = useCallback((ids, fn, label, merge) => {
    if (readOnly) return;
    const set = new Set(ids);
    h.set((d) => ({ ...d, photos: d.photos.map((p) => (set.has(p.id) ? fn(p) : p)) }), label, merge ? { merge } : undefined);
  }, [h, readOnly]);

  /** Changes a photo's develop settings and records the step in its own history. */
  const setSettings = useCallback((photoId, fn, label, key) => {
    if (readOnly || !photoId) return;
    const merge = key ? `${photoId}:${key}:${serial.current}` : undefined;
    mapPhotos([photoId], (p) => {
      const s = fn(p.settings);
      const entry = { label, t: Date.now(), s: compact(s), k: merge };
      const last = p.history[p.history.length - 1];
      const history = merge && last?.k === merge ? [...p.history.slice(0, -1), entry] : [...p.history, entry].slice(-50);
      return { ...p, settings: s, history };
    }, label, merge);
  }, [mapPhotos, readOnly]);

  const ed = useMemo(() => {
    const pid = photo?.id;
    const settings = photo?.settings;
    return {
      s: settings, readOnly, commit,
      set: (path, v, label) => setSettings(pid, (s) => {
        let n = setIn(s, path, v);
        if (path === 'temp' || path === 'tint') n = { ...n, wb: 'custom' };
        return n;
      }, label, path),
      setMany: (obj, label) => setSettings(pid, (s) => ({ ...s, ...obj }), label),
      setMask: (m, label = 'Adjust mask', merge) => setSettings(pid, (s) => ({ ...s, masks: s.masks.map((x) => (x.id === m.id ? m : x)) }), label, merge || `mask${m.id}`),
      addBrushMask: () => {
        const used = new Set(settings.masks.filter((m) => m.type === 'brush').map((m) => m.channel));
        const channel = [0, 1, 2, 3].find((c) => !used.has(c));
        if (channel === undefined) { toast('Up to 4 brush masks per photo'); return; }
        const m = { id: uid('m'), type: 'brush', name: `Brush ${settings.masks.filter((x) => x.type === 'brush').length + 1}`, channel, strokes: [], adj: { ...maskAdjDefaults(), exposure: 0.5 }, amount: 100, invert: false, visible: true };
        setSettings(pid, (s) => ({ ...s, masks: [...s.masks, m] }), 'New brush mask');
        commit();
        setMaskSel(m.id); setTool('brush');
      },
      deleteMask: (mid) => { setSettings(pid, (s) => ({ ...s, masks: s.masks.filter((m) => m.id !== mid) }), 'Delete mask'); commit(); if (maskSel === mid) setMaskSel(null); },
    };
  }, [photo, readOnly, commit, setSettings, maskSel]);

  const onAddMask = useCallback((type, geo) => {
    if (readOnly || !photo) return null;
    if (photo.settings.masks.length >= 8) { toast('Up to 8 masks per photo'); return null; }
    const n = photo.settings.masks.filter((m) => m.type === type).length + 1;
    const m = { id: uid('m'), type, name: `${type === 'linear' ? 'Linear gradient' : 'Radial gradient'} ${n}`, geo, adj: { ...maskAdjDefaults(), exposure: type === 'linear' ? -0.6 : 0.4 }, amount: 100, invert: false, visible: true };
    setSettings(photo.id, (s) => ({ ...s, masks: [...s.masks, m] }), m.name.replace(/ \d+$/, ''), `mask${m.id}`);
    setMaskSel(m.id); setTool('mask');
    return m;
  }, [photo, readOnly, setSettings]);
  const onMask = useCallback((m, isCommit, label) => { ed.setMask(m, label || 'Adjust mask'); if (isCommit) commit(); }, [ed, commit]);
  const onCrop = useCallback((c, isCommit) => { setSettings(photo?.id, (s) => ({ ...s, crop: c }), 'Crop', 'crop'); if (isCommit) commit(); }, [photo, setSettings, commit]);

  // ---------------------------------------------------------------- library actions
  const lib = useMemo(() => ({
    rate: (v) => { mapPhotos(targets, (p) => ({ ...p, rating: v }), v ? `Rating ${'★'.repeat(v)}` : 'Clear rating'); commit(); },
    flag: (v) => { mapPhotos(targets, (p) => ({ ...p, flag: v }), v === 1 ? 'Flag as pick' : v === -1 ? 'Reject' : 'Unflag'); commit(); },
    label: (v) => { mapPhotos(targets, (p) => ({ ...p, color_label: v }), v ? `Label ${v}` : 'Clear label'); commit(); },
    addKeywords: (list) => { mapPhotos(targets, (p) => ({ ...p, keywords: [...new Set([...p.keywords, ...list])] }), 'Add keywords'); commit(); },
    removeKeyword: (k) => { mapPhotos(targets, (p) => ({ ...p, keywords: p.keywords.filter((x) => x !== k) }), 'Remove keyword'); commit(); },
    newCollection: async () => {
      const name = await promptDialog({ title: 'New collection', label: 'Name', value: 'Collection' });
      if (!name) return;
      const c = { id: uid('c'), name, photo_ids: view === 'library' ? targets : [] };
      h.set((d) => ({ ...d, collections: [...d.collections, c] }), 'New collection'); commit();
    },
    addToCollection: (cid) => { h.set((d) => ({ ...d, collections: d.collections.map((c) => (c.id === cid ? { ...c, photo_ids: [...new Set([...c.photo_ids, ...targets])] } : c)) }), 'Add to collection'); commit(); },
    removeFromCollection: (cid) => { h.set((d) => ({ ...d, collections: d.collections.map((c) => (c.id === cid ? { ...c, photo_ids: c.photo_ids.filter((x) => !targets.includes(x)) } : c)) }), 'Remove from collection'); commit(); },
    renameCollection: async (cid) => {
      const c = doc.collections.find((x) => x.id === cid);
      const name = await promptDialog({ title: 'Rename collection', label: 'Name', value: c.name });
      if (name) { h.set((d) => ({ ...d, collections: d.collections.map((x) => (x.id === cid ? { ...x, name } : x)) }), 'Rename collection'); commit(); }
    },
    deleteCollection: (cid) => { h.set((d) => ({ ...d, collections: d.collections.filter((x) => x.id !== cid) }), 'Delete collection'); commit(); if (filter.collection === cid) setFilter({ ...filter, collection: 'all' }); },
  }), [mapPhotos, targets, commit, h, doc, view, filter]);

  const importPhotos = useCallback(async () => {
    if (readOnly) return;
    const assets = await pickAssets({ kinds: ['image'], multiple: true, docId: id, title: 'Import photos' });
    if (!assets?.length) return;
    const have = new Set(doc.photos.map((p) => p.asset_id));
    const fresh = assets.filter((a) => a.kind === 'image' && !have.has(a.id)).map(newPhoto);
    if (!fresh.length) { toast('Those photos are already in this catalog'); return; }
    h.set((d) => ({ ...d, photos: [...d.photos, ...fresh], collections: d.collections.map((c) => (c.id === filter.collection ? { ...c, photo_ids: [...c.photo_ids, ...fresh.map((p) => p.id)] } : c)) }), `Import ${fresh.length} photo${fresh.length > 1 ? 's' : ''}`);
    commit();
    setCur(fresh[0].id); setSel(new Set(fresh.map((p) => p.id)));
    if (fresh.some((p) => /x-|heic|heif|tiff/.test(p.mime || ''))) toast('Converting some files for the browser — they’ll show “Processing” for a moment');
  }, [readOnly, id, doc, h, commit, filter.collection]);

  const removePhotos = useCallback(async () => {
    if (readOnly || !targets.length) return;
    if (!await confirmDialog({ title: `Remove ${targets.length} photo${targets.length > 1 ? 's' : ''} from the catalog?`, message: 'The original files stay in Files. Their edits are removed from this catalog (you can undo).', confirm: 'Remove', danger: true })) return;
    const gone = new Set(targets);
    const idx = photos.findIndex((p) => p.id === cur);
    const next = photos.filter((p) => !gone.has(p.id))[Math.max(0, Math.min(idx, photos.length - gone.size - 1))];
    h.set((d) => ({ ...d, photos: d.photos.filter((p) => !gone.has(p.id)), collections: d.collections.map((c) => ({ ...c, photo_ids: c.photo_ids.filter((x) => !gone.has(x)) })) }), 'Remove photos');
    commit();
    setCur(next?.id || null); setSel(new Set(next ? [next.id] : []));
  }, [readOnly, targets, photos, cur, h, commit]);

  // Fill in dimensions once the server has finished converting a file.
  useEffect(() => {
    if (!doc) return;
    for (const p of doc.photos) {
      if (p.width) continue;
      waitReady(p.asset_id).then((a) => {
        if (a.width) h.replace((d) => ({ ...d, photos: d.photos.map((x) => (x.asset_id === a.id && !x.width ? { ...x, width: a.width, height: a.height } : x)) }));
      }).catch(() => {});
    }
  }, [doc?.photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- selection
  const select = useCallback((pid, e) => {
    if (!pid) { if (!e?.shiftKey && !(e?.ctrlKey || e?.metaKey)) setSel(new Set(cur ? [cur] : [])); return; }
    if (e?.shiftKey && cur) {
      const a = photos.findIndex((p) => p.id === cur); const b = photos.findIndex((p) => p.id === pid);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(photos.slice(lo, hi + 1).map((p) => p.id)));
      setCur(pid);
      return;
    }
    if (e?.ctrlKey || e?.metaKey) {
      setSel((s) => { const n = new Set(s); if (n.has(pid) && n.size > 1) n.delete(pid); else n.add(pid); return n; });
      setCur(pid);
      return;
    }
    setSel(new Set([pid])); setCur(pid);
  }, [cur, photos]);
  const step = (d) => {
    if (!photos.length) return;
    const i = photos.findIndex((p) => p.id === cur);
    const n = photos[clamp(i + d, 0, photos.length - 1)];
    if (n) { setCur(n.id); setSel(new Set([n.id])); }
  };
  const openDevelop = (pid) => { if (pid) { setCur(pid); setSel(new Set([pid])); } setView('develop'); };

  // ---------------------------------------------------------------- develop helpers
  const sw = photo?.width || 1; const sh = photo?.height || 1;
  const onSizeKnown = useCallback((p, w, hh) => {
    if (p.width !== w || p.height !== hh) h.replace((d) => ({ ...d, photos: d.photos.map((x) => (x.id === p.id ? { ...x, width: w, height: hh } : x)) }));
  }, [h]);

  const copySettings = () => {
    if (!photo) return;
    clip = copyableFull(photo.settings); lsSet('hikari-clipboard', clip);
    toast('Settings copied (everything except crop and masks)');
  };
  const pasteSettings = (ids = targets) => {
    if (readOnly || !clip || !ids.length) return;
    mapPhotos(ids, (p) => {
      const s = overlay(p.settings, clip);
      return { ...p, settings: s, history: [...p.history, { label: 'Paste settings', t: Date.now(), s: compact(s) }].slice(-50) };
    }, `Paste settings${ids.length > 1 ? ` to ${ids.length} photos` : ''}`);
    commit();
  };
  const syncSettings = () => {
    if (!photo || targets.length < 2) return;
    clip = copyableFull(photo.settings);
    pasteSettings(targets.filter((x) => x !== photo.id));
    toast(`Synced settings to ${targets.length - 1} photo${targets.length > 2 ? 's' : ''}`);
  };
  const resetSettings = (ids = targets) => {
    mapPhotos(ids, (p) => ({ ...p, settings: defaultSettings(), history: [...p.history, { label: 'Reset', t: Date.now(), s: {} }].slice(-50) }), 'Reset settings');
    commit(); setMaskSel(null);
  };
  const applyPreset = (name, partial) => {
    if (readOnly || !photo) return;
    setHoverPreview(null);
    mapPhotos(targets, (p) => {
      const s = overlay(p.settings, partial);
      return { ...p, settings: s, history: [...p.history, { label: `Preset: ${name}`, t: Date.now(), s: compact(s) }].slice(-50) };
    }, `Preset: ${name}`);
    commit();
  };

  const orientMap = { cw: (o, c) => [{ ...o, rot: (o.rot + 1) % 4 }, { ...c, cx: 1 - c.cy, cy: c.cx, w: c.h, h: c.w }], ccw: (o, c) => [{ ...o, rot: (o.rot + 3) % 4 }, { ...c, cx: c.cy, cy: 1 - c.cx, w: c.h, h: c.w }] };
  const rotate = (dir) => {
    mapPhotos(targets, (p) => {
      const s = p.settings;
      // Quarter turns and flips act on the oriented image, so the crop moves with it.
      let o = s.orient; let c = s.crop;
      if (dir === 'cw' || dir === 'ccw') {
        // Flips are applied after rotation; turning a flipped image swaps the direction of the turn.
        const d = (o.flipH !== o.flipV) ? (dir === 'cw' ? 'ccw' : 'cw') : dir;
        [o, c] = orientMap[dir](o, c);
        o = { ...o, rot: (s.orient.rot + (d === 'cw' ? 1 : 3)) % 4 };
      } else if (dir === 'flipH') { o = { ...o, flipH: !o.flipH }; c = { ...c, cx: 1 - c.cx, angle: -c.angle }; } else { o = { ...o, flipV: !o.flipV }; c = { ...c, cy: 1 - c.cy, angle: -c.angle }; }
      const ns = { ...s, orient: o, crop: c };
      return { ...p, settings: ns, history: [...p.history, { label: { cw: 'Rotate right', ccw: 'Rotate left', flipH: 'Flip horizontal', flipV: 'Flip vertical' }[dir], t: Date.now(), s: compact(ns) }].slice(-50) };
    }, { cw: 'Rotate right', ccw: 'Rotate left', flipH: 'Flip horizontal', flipV: 'Flip vertical' }[dir]);
    commit();
  };

  const sourceSample = async () => {
    const img = await loadPhotoImage(photo.asset_id);
    const s = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, c.width, c.height);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const autoWB = async () => {
    if (readOnly || !photo) return;
    // Grey world over the mid-tones.
    const d = await sourceSample();
    let R = 0; let G = 0; let B = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (l < 20 || l > 240) continue;
      R += toLinear(d[i] / 255); G += toLinear(d[i + 1] / 255); B += toLinear(d[i + 2] / 255);
    }
    const wb = neutralize(R, G, B);
    ed.setMany({ wb: 'auto', ...wb }, 'WB: Auto'); commit();
  };
  const autoTone = async () => {
    if (readOnly || !photo) return;
    const d = await sourceSample();
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
    L.sort((a, b) => a - b);
    const pct = (p) => L[Math.min(L.length - 1, Math.floor(L.length * p))] ?? 0.5;
    const med = pct(0.5); const lo = pct(0.005); const hi = pct(0.995);
    const exposure = clamp(+Math.log2(toLinear(0.46) / Math.max(1e-3, toLinear(med))).toFixed(2), -2, 2) * 0.8;
    const spread = hi - lo;
    ed.setMany({
      exposure: +exposure.toFixed(2), contrast: Math.round(clamp((0.8 - spread) * 40, -10, 25)),
      highlights: Math.round(clamp(-(hi - 0.85) * 200, -60, 0)), shadows: Math.round(clamp((0.2 - pct(0.1)) * 150, 0, 45)),
      whites: Math.round(clamp((0.97 - hi) * 120, -20, 30)), blacks: Math.round(clamp((0.03 - lo) * 160 - 5, -30, 10)), vibrance: 10,
    }, 'Auto tone');
    commit();
  };

  const presetsFromLib = useMemo(() => (libraries || []).flatMap((l) => l.items.filter((i) => i.kind === 'preset' && i.data?.app === 'develop').map((i) => ({ ...i, library: l.name }))), [libraries]);
  const savePreset = async () => {
    if (!photo) return;
    const name = await promptDialog({ title: 'New develop preset', label: 'Preset name', value: 'My look', message: 'Saves the current settings (not crop or masks) to your Libraries, so you can apply them in any catalog.' });
    if (!name) return;
    try {
      let target = libraries?.[0];
      if (!target) target = await api.post('/api/libraries', { name: 'My Library' });
      const partial = compact(copyableFull(photo.settings));
      await api.post(`/api/libraries/${target.id}/items`, { kind: 'preset', name, data: { app: 'develop', settings: { ...copyableFull(defaultSettings()), ...partial } } });
      await reloadLibraries?.();
      toast(`Saved preset “${name}” to ${target.name}`, { type: 'success' });
    } catch (e) { toastError(e, 'Couldn’t save the preset'); }
  };
  const deletePreset = async (p) => {
    if (!await confirmDialog({ title: `Delete preset “${p.name}”?`, message: `It’s removed from ${p.library}.`, confirm: 'Delete', danger: true })) return;
    await api.del(`/api/library-items/${p.id}`).catch(toastError);
    reloadLibraries?.();
  };

  const leftEd = {
    applyPreset, savePreset, deletePreset,
    newSnapshot: async () => {
      const name = await promptDialog({ title: 'New snapshot', label: 'Name', value: new Date().toLocaleString() });
      if (!name) return;
      mapPhotos([photo.id], (p) => ({ ...p, snapshots: [...p.snapshots, { id: uid('s'), name, s: compact(p.settings), created: Date.now() }] }), 'New snapshot');
      commit();
    },
    applySnapshot: (sn) => { setHoverPreview(null); setSettings(photo.id, () => expand(sn.s), `Snapshot: ${sn.name}`); commit(); },
    deleteSnapshot: (sid) => { mapPhotos([photo.id], (p) => ({ ...p, snapshots: p.snapshots.filter((x) => x.id !== sid) }), 'Delete snapshot'); commit(); },
    applyHistory: (e) => { setHoverPreview(null); setSettings(photo.id, () => expand(e.s), `History: ${e.label}`); commit(); },
    clearHistory: () => { mapPhotos([photo.id], (p) => ({ ...p, history: [] }), 'Clear history'); commit(); },
  };
  const onHoverPreset = useCallback((s, full) => setHoverPreview(s ? { s, full } : null), []);

  // LUT profiles
  const lutInput = useRef(null);
  const loadCube = async (file) => {
    try {
      parseCube(await file.text());
      const [a] = await uploadFiles([file], { docId: id });
      ed.set('lut', { asset_id: a.id, name: baseName(file.name), amount: 100 }, `Profile: ${baseName(file.name)}`); commit();
    } catch (e) { toastError(e, 'Couldn’t load the LUT'); }
  };
  const exportCube = async () => {
    if (!photo) return;
    try {
      const r = new Renderer(document.createElement('canvas'));
      if (photo.settings.lut?.asset_id) r.setLut(await loadLut(photo.settings.lut.asset_id), photo.settings.lut.asset_id);
      const data = r.lutCube(photo.settings, 33);
      r.gl.getExtension('WEBGL_lose_context')?.loseContext();
      download(new Blob([toCube(data, 33, `${baseName(photo.name)} look`)], { type: 'text/plain' }), `${baseName(photo.name)} look.cube`);
      toast('Exported the colour look as a 33³ .cube LUT (local, crop and detail effects aren’t part of a LUT)');
    } catch (e) { toastError(e, 'Couldn’t export the LUT'); }
  };

  // ---------------------------------------------------------------- export
  const exportList = () => {
    const ids = view === 'library' || targets.length > 1 ? targets : photo ? [photo.id] : [];
    return photos.filter((p) => ids.includes(p.id)).concat(doc.photos.filter((p) => ids.includes(p.id) && !photos.includes(p)));
  };
  const sizeOf = (o) => (o.resize === 'long' ? { long: o.long } : o.resize === 'mp' ? { mp: o.mp } : null);
  const formatOptions = (fmt) => [
    ...(fmt !== 'png' ? [{ key: 'quality', label: 'Quality', type: 'range', min: 10, max: 100, default: 90, unit: '%' }] : []),
    { key: 'resize', label: 'Size', type: 'select', default: 'full', choices: [['full', 'Full resolution'], ['long', 'Long edge'], ['mp', 'Megapixels']] },
    { key: 'long', label: 'Long edge', type: 'number', default: 2048, min: 64, max: 16384, unit: 'px', hint: 'Used when Size is “Long edge”' },
    { key: 'mp', label: 'Megapixels', type: 'number', default: 12, min: 0.1, max: 100, step: 0.1, unit: 'MP', hint: 'Used when Size is “Megapixels”' },
  ];
  const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
  const uniqueNames = (list, ext) => {
    const used = new Map();
    return list.map((p) => { const b = baseName(p.name); const n = used.get(b) || 0; used.set(b, n + 1); return `${b}${n ? `-${n + 1}` : ''}.${ext}`; });
  };
  const exportConfig = (!doc || !doc.photos.length) ? undefined : (() => {
    const list = exportList();
    const many = list.length > 1;
    const formats = ['jpeg', 'png', 'webp'].map((f) => ({
      id: f, label: `${f === 'jpeg' ? 'JPEG' : f === 'png' ? 'PNG' : 'WebP'}${many ? ` — ${list.length} photos (ZIP)` : ''}`, ext: many ? 'zip' : EXT[f], kind: 'image', options: formatOptions(f),
      note: many ? 'Each photo is rendered at full quality through the develop pipeline, then zipped. Use File → Export each photo separately for one-by-one downloads.' : 'Rendered at full quality through the develop pipeline.',
    }));
    return {
      formats,
      render: async (fmt, o, { onProgress }) => {
        const names = uniqueNames(list, EXT[fmt]);
        const files = {};
        let blob = null;
        for (let i = 0; i < list.length; i++) {
          const c = await renderPhoto(list[i], { size: sizeOf(o), onProgress: (p) => onProgress((i + p * 0.9) / list.length, `Rendering ${i + 1} of ${list.length}…`) });
          blob = await encode(c, fmt, (o.quality ?? 90) / 100);
          if (many) files[names[i]] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
        }
        if (!many) return blob;
        onProgress(1, 'Zipping…');
        return new Blob([zipSync(files)], { type: 'application/zip' });
      },
    };
  })();
  const exportSeparately = () => {
    const list = exportList();
    if (!list.length) return;
    exportDialog({
      name: baseName(list[list.length - 1].name), docId: id, title: `Export ${list.length} photo${list.length > 1 ? 's' : ''} one by one`,
      formats: ['jpeg', 'png', 'webp'].map((f) => ({ id: f, label: f.toUpperCase(), ext: EXT[f], kind: 'image', options: formatOptions(f), note: list.length > 1 ? 'Each photo downloads to this device as soon as it’s rendered; the last one goes where you choose below.' : undefined })),
      render: async (fmt, o, { onProgress }) => {
        const names = uniqueNames(list, EXT[fmt]);
        let blob = null;
        for (let i = 0; i < list.length; i++) {
          const c = await renderPhoto(list[i], { size: sizeOf(o), onProgress: (p) => onProgress((i + p) / list.length, `Rendering ${i + 1} of ${list.length}…`) });
          blob = await encode(c, fmt, (o.quality ?? 90) / 100);
          if (i < list.length - 1) download(blob, names[i]);
        }
        return blob;
      },
    });
  };
  const saveToFiles = async (list = exportList()) => {
    if (!list.length) return;
    try {
      const names = uniqueNames(list, 'jpg');
      for (let i = 0; i < list.length; i++) {
        toast(`Rendering ${list[i].name}…`);
        const blob = await encode(await renderPhoto(list[i]), 'jpeg', 0.92);
        await saveBlob(blob, names[i], { docId: id });
      }
      toast(`Saved ${list.length} JPEG${list.length > 1 ? 's' : ''} to Files → Exports`, { type: 'success', action: { label: 'Open', onClick: () => window.open('/files?tab=exports', '_blank') } });
    } catch (e) { toastError(e, 'Couldn’t save'); }
  };

  // ---------------------------------------------------------------- saving
  const thumbCache = useRef({ key: null, canvas: null });
  const getData = useCallback(async () => {
    const d = h.get();
    const out = { data: toSaved(d) };
    const first = d.photos[0];
    if (first) {
      const key = `${first.asset_id}|${JSON.stringify(compact(first.settings))}`;
      if (thumbCache.current.key !== key) {
        try { thumbCache.current = { key, canvas: await renderPhoto(first, { size: { long: 640 } }) }; } catch { /* still processing */ }
      }
      if (thumbCache.current.key === key) out.thumb = thumbCache.current.canvas;
    }
    return out;
  }, [h]);

  // ---------------------------------------------------------------- shortcuts
  const inDevelop = view === 'develop' && !!photo;
  const sliderFocused = () => document.activeElement?.type === 'range';
  const toggleTool = (t) => { if (!photo) return; if (view !== 'develop') setView('develop'); setTool((x) => (x === t ? null : t)); };
  const setAspect = (a) => {
    if (!photo || readOnly) return;
    const s = photo.settings;
    const [W, H] = orientedSize(sw, sh, s.orient);
    const curAr = (s.crop.w * W) / (s.crop.h * H);
    const r = aspectValue(a, W, H, curAr);
    const crop = r ? cropToAspect(sw, sh, { ...s, crop: { ...s.crop, aspect: a } }, r) : { ...s.crop, aspect: a };
    setSettings(photo.id, (x) => ({ ...x, crop: { ...crop, aspect: a } }), `Aspect ${ASPECTS.find((x) => x.id === a)?.label}`); commit();
  };
  const swapAspect = () => {
    if (!photo || readOnly) return;
    const s = photo.settings; const [W, H] = orientedSize(sw, sh, s.orient);
    const pw = s.crop.w * W; const ph = s.crop.h * H;
    const crop = constrainCrop(sw, sh, s, { ...s.crop, w: ph / W, h: pw / H });
    const fixed = cropToAspect(sw, sh, { ...s, crop }, ph / pw);
    setSettings(photo.id, (x) => ({ ...x, crop: fixed }), 'Swap crop orientation'); commit();
  };
  const shortcuts = {
    g: () => { setView('library'); setTool(null); },
    e: () => photo && setView('develop'),
    d: () => photo && setView('develop'),
    r: () => toggleTool('crop'),
    w: () => !readOnly && toggleTool('wb'),
    m: () => !readOnly && (setMaskSel(null), toggleTool('linear')),
    'shift+m': () => !readOnly && (setMaskSel(null), toggleTool('radial')),
    k: () => { if (readOnly || !photo) return; setView('develop'); const b = photo.settings.masks.find((m) => m.id === maskSel && m.type === 'brush'); if (b) setTool('brush'); else ed.addBrushMask(); },
    o: () => setShowOverlay((v) => !v),
    j: () => setClipWarn((v) => !v),
    z: () => inDevelop && setZoom((z) => (z === 'fit' ? 1 : 'fit')),
    '\\': () => inDevelop && setBefore((b) => (b === 'full' ? 'off' : 'full')),
    y: () => inDevelop && setBefore((b) => (b === 'split' ? 'off' : 'split')),
    escape: () => { if (tool) setTool(null); else if (maskSel) setMaskSel(null); else return false; },
    enter: () => { if (tool === 'crop') setTool(null); else if (view === 'library' && photo) setView('develop'); else return false; },
    arrowleft: () => (sliderFocused() ? false : step(-1)),
    arrowright: () => (sliderFocused() ? false : step(1)),
    '[': () => tool === 'brush' && setBrush((b) => ({ ...b, size: Math.max(2, Math.round(b.size / 1.15)) })),
    ']': () => tool === 'brush' && setBrush((b) => ({ ...b, size: Math.min(1500, Math.round(b.size * 1.15)) })),
    '{': () => tool === 'brush' && setBrush((b) => ({ ...b, feather: Math.max(0, b.feather - 10) })),
    '}': () => tool === 'brush' && setBrush((b) => ({ ...b, feather: Math.min(100, b.feather + 10) })),
    'shift+mod+c': () => copySettings(),
    'shift+mod+v': () => pasteSettings(),
    'shift+mod+s': () => syncSettings(),
    'shift+mod+r': () => !readOnly && resetSettings(),
    'mod+[': () => !readOnly && rotate('ccw'),
    'mod+]': () => !readOnly && rotate('cw'),
    'mod+a': () => { if (view !== 'library') return false; setSel(new Set(photos.map((p) => p.id))); },
    delete: () => (view === 'library' ? removePhotos() : false),
    backspace: () => (view === 'library' ? removePhotos() : false),
    'shift+mod+i': () => importPhotos(),
    p: () => !readOnly && photo && lib.flag(1),
    u: () => !readOnly && photo && lib.flag(0),
    x: () => { if (tool === 'crop') swapAspect(); else if (!readOnly && photo) lib.flag(-1); },
    a: () => { if (tool === 'crop') setAspect(photo.settings.crop.aspect === 'free' ? 'original' : 'free'); else return false; },
  };
  for (let n = 0; n <= 5; n++) shortcuts[String(n)] = () => !readOnly && photo && lib.rate(n);
  COLOR_LABELS.forEach((c) => { if (c.key) shortcuts[c.key] = () => !readOnly && photo && lib.label(photo.color_label === c.id ? null : c.id); });
  useShortcuts(shortcuts, [shortcuts]);

  // ---------------------------------------------------------------- render
  if (!doc) return <EditorShell app="develop" project={project}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;

  const settings = photo ? (hoverPreview ? (hoverPreview.full ? expand(hoverPreview.s) : overlay(photo.settings, hoverPreview.s)) : photo.settings) : null;
  const masking = MASK_TOOLS.includes(tool);
  const effTool = view === 'develop' ? tool : null;

  const tools = (
    <>
      <Tool icon="grid" label="Library grid" shortcut="g" active={view === 'library'} onClick={() => { setView('library'); setTool(null); }} />
      <Tool icon="sliders" label="Develop" shortcut="d" active={view === 'develop' && !tool} onClick={() => { if (photo) { setView('develop'); setTool(null); } }} />
      <ToolDivider />
      <Tool icon="crop" label="Crop & straighten" shortcut="r" active={effTool === 'crop'} onClick={() => toggleTool('crop')} />
      <Tool icon="eyedropper" label="White balance selector" shortcut="w" active={effTool === 'wb'} onClick={() => !readOnly && toggleTool('wb')} />
      <Tool icon="mask" label="Masking" active={view === 'develop' && masking} onClick={() => { if (!photo) return; setView('develop'); setTool(masking ? null : 'mask'); }} />
      <Tool icon="gradient" label="Linear gradient" shortcut="m" active={effTool === 'linear'} onClick={() => { if (!readOnly) { setMaskSel(null); toggleTool('linear'); } }} />
      <Tool icon="ellipse" label="Radial gradient" shortcut="shift+m" active={effTool === 'radial'} onClick={() => { if (!readOnly) { setMaskSel(null); toggleTool('radial'); } }} />
      <Tool icon="brush" label="Brush mask" shortcut="k" active={effTool === 'brush'} onClick={() => shortcuts.k()} />
      <ToolDivider />
      <Tool icon="compare" label="Before / after" shortcut="\" active={before !== 'off'} onClick={() => { if (photo) { setView('develop'); setBefore((b) => (b === 'off' ? 'split' : 'off')); } }} />
      <Tool icon="zoom" label="Zoom fit / 1:1" shortcut="z" active={zoom !== 'fit'} onClick={() => setZoom((z) => (z === 'fit' ? 1 : 'fit'))} />
      <Tool icon="warning" label="Show clipping" shortcut="j" active={clipWarn} onClick={() => setClipWarn((v) => !v)} />
    </>
  );

  const s = photo?.settings;
  let options = null;
  if (view === 'library') {
    options = (
      <>
        {!readOnly && <Button size="sm" variant="primary" icon="import" onClick={importPhotos}>Import</Button>}
        <span className="text-xs text-fg2 ml-1">{targets.length > 1 ? `${targets.length} selected` : photo ? photo.name : ''}</span>
        <span className="flex-1" />
        {photo && !readOnly && (
          <>
            <IconButton icon="rotate" label="Rotate left" shortcut="Ctrl+[" size={28} onClick={() => rotate('ccw')} style={{ transform: 'scaleX(-1)' }} />
            <IconButton icon="rotate" label="Rotate right" shortcut="Ctrl+]" size={28} onClick={() => rotate('cw')} />
            <Button size="sm" variant="ghost" icon="copy" onClick={copySettings}>Copy settings</Button>
            <Button size="sm" variant="ghost" onClick={() => pasteSettings()} disabled={!clip}>Paste{targets.length > 1 ? ` to ${targets.length}` : ''}</Button>
            {targets.length > 1 && <Button size="sm" variant="ghost" onClick={syncSettings}>Sync settings</Button>}
            <Button size="sm" variant="ghost" icon="sliders" onClick={() => setView('develop')}>Develop</Button>
          </>
        )}
      </>
    );
  } else if (photo && effTool === 'crop') {
    const curAr = (() => { const [W, H] = orientedSize(sw, sh, s.orient); return (s.crop.w * W) / (s.crop.h * H); })();
    options = (
      <>
        <span className="text-xs text-fg2">Aspect</span>
        <Select small value={s.crop.aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ value: a.id, label: a.label }))} disabled={readOnly} />
        <IconButton icon={s.crop.aspect === 'free' ? 'unlock' : 'lock'} label={s.crop.aspect === 'free' ? 'Aspect unlocked (A)' : 'Aspect locked (A)'} size={28} disabled={readOnly} onClick={() => setAspect(s.crop.aspect === 'free' ? 'original' : 'free')} />
        <IconButton icon="refresh" label="Swap portrait / landscape (X)" size={28} disabled={readOnly} onClick={swapAspect} />
        <span className="text-[11px] text-fg3 tabular-nums w-14">{curAr >= 1 ? `${curAr.toFixed(2)}:1` : `1:${(1 / curAr).toFixed(2)}`}</span>
        <span className="text-xs text-fg2 ml-2">Angle</span>
        <div className="w-44"><Slider value={s.crop.angle} min={-45} max={45} step={0.1} reset={0} showNumber disabled={readOnly}
          onChange={(v) => setSettings(photo.id, (x) => ({ ...x, crop: constrainCrop(sw, sh, x, { ...x.crop, angle: v }) }), `Straighten ${v}°`, 'angle')} onCommit={commit} /></div>
        <IconButton icon="rotate" label="Rotate left" shortcut="Ctrl+[" size={28} disabled={readOnly} onClick={() => rotate('ccw')} style={{ transform: 'scaleX(-1)' }} />
        <IconButton icon="rotate" label="Rotate right" shortcut="Ctrl+]" size={28} disabled={readOnly} onClick={() => rotate('cw')} />
        <IconButton icon="flipH" label="Flip horizontal" size={28} disabled={readOnly} onClick={() => rotate('flipH')} />
        <IconButton icon="flipV" label="Flip vertical" size={28} disabled={readOnly} onClick={() => rotate('flipV')} />
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => { setSettings(photo.id, (x) => ({ ...x, crop: defaultSettings().crop, orient: defaultSettings().orient }), 'Reset crop'); commit(); }}>Reset</Button>
        <span className="flex-1" />
        <span className="text-[11px] text-fg3">Drag outside the frame to straighten · Shift frees the aspect</span>
        <Button size="sm" variant="primary" onClick={() => setTool(null)}>Done</Button>
      </>
    );
  } else if (photo) {
    options = (
      <>
        <Segmented value={zoom === 'fit' ? 'fit' : String(zoom)} onChange={(v) => setZoom(v === 'fit' ? 'fit' : Number(v))}
          options={[{ value: 'fit', label: 'Fit' }, { value: '0.5', label: '1:2' }, { value: '1', label: '1:1' }, { value: '2', label: '2:1' }]} />
        <span className="text-xs text-fg2 ml-2">Before/After</span>
        <Segmented value={before} onChange={setBefore} options={[{ value: 'off', label: 'Off' }, { value: 'split', label: 'Split (Y)' }, { value: 'full', label: 'Before (\\)' }]} />
        <Toggle checked={clipWarn} onChange={setClipWarn} label="Clipping (J)" className="ml-2" />
        {tool === 'brush' && (
          <>
            <span className="text-xs text-fg2 ml-3">Size</span>
            <div className="w-28"><Slider value={brush.size} min={2} max={1500} onChange={(v) => setBrush({ ...brush, size: v })} showNumber={false} /></div>
            <span className="text-xs text-fg2">Feather</span>
            <div className="w-20"><Slider value={brush.feather} min={0} max={100} onChange={(v) => setBrush({ ...brush, feather: v })} showNumber={false} /></div>
            <Segmented value={brush.erase ? 'e' : 'a'} onChange={(v) => setBrush({ ...brush, erase: v === 'e' })} options={[{ value: 'a', label: 'Add' }, { value: 'e', label: 'Erase' }]} />
          </>
        )}
        <span className="flex-1" />
        {!readOnly && (
          <>
            <Button size="sm" variant="ghost" icon="copy" onClick={copySettings} title="Copy settings (Ctrl+Shift+C)">Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => pasteSettings()} disabled={!clip} title="Paste settings (Ctrl+Shift+V)">Paste</Button>
            {targets.length > 1 && <Button size="sm" variant="ghost" onClick={syncSettings} title="Sync settings to the selected photos (Ctrl+Shift+S)">Sync to {targets.length - 1}</Button>}
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => resetSettings([photo.id])} title="Reset (Ctrl+Shift+R)">Reset</Button>
          </>
        )}
      </>
    );
  }

  const asset = null;
  const panels = view === 'library'
    ? <MetadataPanel photos={doc.photos.filter((p) => targets.includes(p.id))} readOnly={readOnly} ed={lib} asset={asset} />
    : !photo ? null
      : masking ? (
        <>
          <Histogram hist={hist} />
          <MaskPanel ed={{ ...ed, s: settings }} maskSel={maskSel} setMaskSel={setMaskSel} tool={tool} setTool={setTool} brush={brush} setBrush={setBrush} showOverlay={showOverlay} setShowOverlay={setShowOverlay} />
        </>
      )
        : <DevelopPanels ed={{ ...ed, s: settings }} hist={hist} histInfo={`${photo.width || '?'} × ${photo.height || '?'}${zoom !== 'fit' ? ` · ${Math.round(zoom * 100)}%` : ''}${hoverPreview ? ' · previewing' : ''}`}
          autoTone={autoTone} autoWB={autoWB} onWBTool={() => toggleTool('wb')} wbActive={tool === 'wb'} onLut={() => lutInput.current?.click()} onExportCube={exportCube} />;

  const menus = [
    { label: 'Library', items: () => [
      { label: 'Import photos…', icon: 'import', shortcut: 'Ctrl+Shift+I', disabled: readOnly, onClick: importPhotos },
      { divider: true },
      { label: 'Grid', icon: 'grid', shortcut: 'G', checked: view === 'library', onClick: () => setView('library') },
      { label: 'Develop', icon: 'sliders', shortcut: 'D', checked: view === 'develop', disabled: !photo, onClick: () => setView('develop') },
      { divider: true },
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => { setView('library'); setSel(new Set(photos.map((p) => p.id))); } },
      { label: 'Select picks', onClick: () => setSel(new Set(photos.filter((p) => p.flag === 1).map((p) => p.id))) },
      { label: 'New collection…', icon: 'folder', disabled: readOnly, onClick: lib.newCollection },
      { divider: true },
      { label: 'Reset filters', icon: 'filter', onClick: () => setFilter(FILTER0) },
      { label: 'Remove from catalog…', icon: 'trash', danger: true, shortcut: 'Del', disabled: readOnly || !targets.length, onClick: removePhotos },
    ] },
    { label: 'Photo', items: () => [
      { label: 'Rotate left', shortcut: 'Ctrl+[', disabled: readOnly || !photo, onClick: () => rotate('ccw') },
      { label: 'Rotate right', shortcut: 'Ctrl+]', disabled: readOnly || !photo, onClick: () => rotate('cw') },
      { label: 'Flip horizontal', icon: 'flipH', disabled: readOnly || !photo, onClick: () => rotate('flipH') },
      { label: 'Flip vertical', icon: 'flipV', disabled: readOnly || !photo, onClick: () => rotate('flipV') },
      { divider: true },
      { label: 'Set rating', disabled: readOnly || !photo, items: [0, 1, 2, 3, 4, 5].map((n) => ({ label: n ? '★'.repeat(n) : 'None', shortcut: String(n), onClick: () => lib.rate(n) })) },
      { label: 'Set flag', disabled: readOnly || !photo, items: [{ label: 'Pick', shortcut: 'P', onClick: () => lib.flag(1) }, { label: 'Unflagged', shortcut: 'U', onClick: () => lib.flag(0) }, { label: 'Rejected', shortcut: 'X', onClick: () => lib.flag(-1) }] },
      { label: 'Set colour label', disabled: readOnly || !photo, items: [...COLOR_LABELS.map((c) => ({ label: c.label, shortcut: c.key || undefined, onClick: () => lib.label(c.id) })), { label: 'None', onClick: () => lib.label(null) }] },
      { divider: true },
      { label: 'Save to Files (JPEG)', icon: 'save', disabled: !photo, onClick: () => saveToFiles() },
      { label: 'Remove from catalog…', icon: 'trash', danger: true, disabled: readOnly || !photo, onClick: removePhotos },
    ] },
    { label: 'Settings', items: () => [
      { label: 'Copy settings', icon: 'copy', shortcut: 'Ctrl+Shift+C', disabled: !photo, onClick: copySettings },
      { label: targets.length > 1 ? `Paste settings to ${targets.length} photos` : 'Paste settings', shortcut: 'Ctrl+Shift+V', disabled: readOnly || !clip || !photo, onClick: () => pasteSettings() },
      { label: 'Sync settings to selected', shortcut: 'Ctrl+Shift+S', disabled: readOnly || targets.length < 2, onClick: syncSettings },
      { label: 'Reset all settings', icon: 'refresh', shortcut: 'Ctrl+Shift+R', disabled: readOnly || !photo, onClick: () => resetSettings() },
      { divider: true },
      { label: 'Auto tone', disabled: readOnly || !photo, onClick: autoTone },
      { label: 'Auto white balance', disabled: readOnly || !photo, onClick: autoWB },
      { label: 'Convert to black & white', disabled: readOnly || !photo, onClick: () => { ed.set('bw', !photo.settings.bw, 'Black & White'); commit(); } },
      { divider: true },
      { label: 'New preset from settings…', icon: 'presets', disabled: !photo, onClick: savePreset },
      { label: 'New snapshot…', icon: 'camera', disabled: readOnly || !photo, onClick: leftEd.newSnapshot },
      { label: 'Load .cube profile…', icon: 'import', disabled: readOnly || !photo, onClick: () => lutInput.current?.click() },
      { label: 'Export look as .cube LUT', icon: 'export', disabled: !photo, onClick: exportCube },
    ] },
    { label: 'View', items: () => [
      { label: 'Before / after (full)', shortcut: '\\', checked: before === 'full', disabled: !photo, onClick: () => { setView('develop'); setBefore(before === 'full' ? 'off' : 'full'); } },
      { label: 'Before / after split', shortcut: 'Y', checked: before === 'split', disabled: !photo, onClick: () => { setView('develop'); setBefore(before === 'split' ? 'off' : 'split'); } },
      { label: 'Zoom to fit', checked: zoom === 'fit', onClick: () => setZoom('fit') },
      { label: 'Zoom 1:1', shortcut: 'Z', checked: zoom === 1, onClick: () => setZoom(1) },
      { label: 'Show clipping', shortcut: 'J', checked: clipWarn, onClick: () => setClipWarn(!clipWarn) },
      { label: 'Show mask overlay', shortcut: 'O', checked: showOverlay, onClick: () => setShowOverlay(!showOverlay) },
    ] },
  ];
  const fileItems = [
    { label: 'Import photos…', icon: 'import', disabled: readOnly, onClick: importPhotos },
    { label: 'Export each photo separately…', icon: 'download', disabled: !photo, onClick: exportSeparately },
    { label: 'Save selected to Files (JPEG)', icon: 'save', disabled: !photo, onClick: () => saveToFiles() },
  ];

  const onContext = (e, p) => {
    e.preventDefault();
    if (!sel.has(p.id)) { setSel(new Set([p.id])); }
    setCur(p.id);
    openMenu(e, [
      { label: 'Open in Develop', icon: 'sliders', onClick: () => openDevelop(p.id) },
      { label: 'Save to Files (JPEG)', icon: 'save', onClick: () => saveToFiles(sel.has(p.id) ? exportList() : [p]) },
      { label: 'Export…', icon: 'export', onClick: () => exportConfig && exportDialog({ name: baseName(p.name), docId: id, ...exportConfig }) },
      { divider: true },
      { label: 'Copy settings', icon: 'copy', onClick: () => { clip = copyableFull(p.settings); lsSet('hikari-clipboard', clip); toast('Settings copied'); } },
      { label: 'Paste settings', disabled: readOnly || !clip, onClick: () => pasteSettings(sel.has(p.id) ? targets : [p.id]) },
      { label: 'Reset settings', disabled: readOnly, onClick: () => resetSettings(sel.has(p.id) ? targets : [p.id]) },
      { divider: true },
      ...doc.collections.map((c) => ({ label: `Add to “${c.name}”`, icon: 'folder', disabled: readOnly, onClick: () => lib.addToCollection(c.id) })),
      { label: 'Remove from catalog…', icon: 'trash', danger: true, disabled: readOnly, onClick: removePhotos },
    ]);
  };

  const filtered = filter.text || filter.rating || filter.flag !== 'all' || filter.label !== 'any' || filter.edited !== 'all';
  const filmInfo = (
    <>
      <span>{photos.length} of {doc.photos.length} photos{targets.length > 1 ? ` · ${targets.length} selected` : ''}</span>
      {photo && <span className="truncate">{photo.name}</span>}
      <span className="flex-1" />
      {filtered && <button type="button" className="text-accent hover:underline" onClick={() => setFilter({ ...FILTER0, collection: filter.collection })}>Clear filter</button>}
    </>
  );
  const bottom = doc.photos.length ? <Filmstrip photos={photos} sel={sel} cur={cur} onSelect={select} onOpen={openDevelop} onContext={onContext} info={filmInfo} /> : null;
  const status = (
    <>
      <span>{app.name}</span>
      <span>{view === 'library' ? 'Library' : tool === 'crop' ? 'Crop' : masking ? 'Masking' : 'Develop'}</span>
      {photo && <span>{photo.name} · {photo.width || '?'}×{photo.height || '?'}</span>}
      {readOnly && <span className="text-warn">View only</span>}
    </>
  );

  return (
    <EditorShell app="develop" project={project} history={h} getData={getData} menus={menus} fileItems={fileItems} exportConfig={exportConfig}
      tools={tools} options={options} panels={panels} panelWidth={300} bottom={bottom} status={status}
      commentAnchor={photo ? () => ({ photo: photo.id, name: photo.name }) : undefined} anchorLabel={(a) => a.name || 'photo'}
      onJumpToComment={(a) => { if (a.photo && doc.photos.some((p) => p.id === a.photo)) openDevelop(a.photo); }}>
      <div className="h-full flex">
        {view === 'library' ? (
          <>
            <div className="w-[220px] shrink-0 h-full overflow-y-auto scroll-thin bg-panel border-r border-line">
              <CatalogPanel doc={doc} filter={filter} setFilter={setFilter} readOnly={readOnly} onImport={importPhotos} ed={lib} />
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              {doc.photos.length > 0 && <FilterBar filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} count={photos.length} total={doc.photos.length} thumbSize={thumbSize} setThumbSize={setThumbSize} />}
              <div className="flex-1 min-h-0">
                <Grid photos={photos} all={doc.photos} sel={sel} cur={cur} onSelect={select} onOpen={openDevelop} onRate={(pid, v) => { mapPhotos([pid], (p) => ({ ...p, rating: v }), 'Rating'); commit(); }}
                  onContext={onContext} size={thumbSize} readOnly={readOnly} onImport={importPhotos}
                  filtered={<Button size="sm" variant="outline" onClick={() => setFilter(FILTER0)}>Clear filter</Button>} />
              </div>
            </div>
          </>
        ) : photo ? (
          <>
            <LeftPanels photo={photo} userPresets={presetsFromLib} readOnly={readOnly} ed={leftEd} onHoverPreset={onHoverPreset} />
            <div className="flex-1 min-w-0 relative">
              <Viewer key={photo.id} photo={photo} settings={settings} tool={effTool} maskSel={maskSel} brush={brush} before={before} split={split} setSplit={setSplit}
                zoom={zoom} setZoom={setZoom} clip={clipWarn} showOverlay={showOverlay || tool === 'brush'} readOnly={readOnly}
                onCrop={onCrop} onMask={onMask} onAddMask={onAddMask} onWB={(wb) => { ed.setMany({ wb: 'custom', ...wb }, 'White balance selector'); commit(); }}
                onHistogram={setHist} onSizeKnown={onSizeKnown} />
            </div>
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-fg2">Select a photo in the Library (G) to develop it.</div>
        )}
      </div>
      <input ref={lutInput} type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadCube(f); }} />
    </EditorShell>
  );
}
