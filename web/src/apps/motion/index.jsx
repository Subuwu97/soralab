// Sora Ugoki (Motion) — an After Effects-style motion graphics editor: compositions of layers (solids, shapes with trim
// paths and repeaters, text with per-character animators, images, video, audio, nulls, adjustment layers, precomps),
// keyframes with easing and expressions, masks, track mattes, blend modes, effects, templates, and in-browser export.
// The project lives in useHistory (every change is undoable); playhead, selection and tools are local state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { Spinner, Button, Modal, NumberInput, Select, ColorSwatch, Toggle, IconButton, TextInput, Segmented, toast, toastError, cx, ProgressBar } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { saveBlob } from '../../lib/api.js';
import { renderFrame, prepareFrame, compById, audioClips, worldMatrix } from '../_anim/comp.js';
import { mixAudio, playBuffer } from '../_anim/media.js';
import { exportVideo, exportGif, exportPng, exportPngSequence, videoSupport } from '../_anim/export.js';
import { EASE_PRESETS, isAnimated, keyedValue } from '../_anim/keyframes.js';
import { invert, apply } from '../_anim/geom.js';
import {
  fromSaved, emptyComp, newLayer, newEffect, uid, duplicateLayer, compContains, allProps, animatedProps, layerKeyTimes, getPath, updatePath, fmtTC, snapT, boxCenter, newMask,
} from './model.js';
import { TEMPLATES } from './templates.js';
import Viewer from './Viewer.jsx';
import Timeline, { keyId, parseKeyId } from './Timeline.jsx';
import { LayerPanel, EffectsPanel, ProjectPanel } from './Panels.jsx';

const SHAPE_TOOLS = ['rect', 'ellipse', 'polygon', 'star'];
const PenSvg = () => <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z" /><path d="M2 2l7.6 7.6" /></svg>;
const AnchorSvg = () => <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v6M12 16v6M2 12h6M16 12h6" /></svg>;

let clipboard = null; // { kind: 'layers' | 'keys', items }

export default function MotionEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const nav = useNavigate();
  const canEdit = project.canEdit;
  useEffect(() => { if (project.data !== undefined && project.doc) h.reset(fromSaved(project.data, project.doc)); }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = h.state;

  const [compId, setCompId] = useState(null);
  const comp = doc ? compById(doc, compId) || compById(doc, doc.main) || doc.comps[0] : null;
  const [time, setTime] = useState(0);
  const [sel, setSel] = useState([]);
  const [selKeys, setSelKeys] = useState([]);
  const [selProp, setSelProp] = useState(null);
  const [tool, setTool] = useState('select');
  const [lastShape, setLastShape] = useState('rect');
  const [twirl, setTwirl] = useState({});
  const [reveal, setReveal] = useState({});
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [res, setRes] = useState('auto');
  const [zoom, setZoom] = useState('fit');
  const [guides, setGuides] = useState(false);
  const [tlHeight, setTlHeight] = useState(300);
  const [editingText, setEditingText] = useState(null);
  const [newFill, setNewFill] = useState('#ff4f7b');
  const [newStroke, setNewStroke] = useState(null);
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [compDialog, setCompDialog] = useState(null);
  const [sending, setSending] = useState(null);
  const renderRef = useRef(null);

  useEffect(() => { setSel([]); setSelKeys([]); setTime((t) => (comp ? Math.min(t, comp.duration - 1 / comp.fps) : 0)); }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- editing helpers (all go through history)
  const editProject = useCallback((fn, label, merge) => { if (canEdit) h.set((d) => fn(d), label, merge ? { merge } : undefined); }, [canEdit, h.set]); // eslint-disable-line react-hooks/exhaustive-deps
  const cid = comp?.id;
  const editComp = useCallback((fn, label, merge) => editProject((d) => ({ ...d, comps: d.comps.map((c) => (c.id === cid ? fn(c) : c)) }), label, merge), [editProject, cid]);
  const editLayer = useCallback((lid, fn, label, merge) => editComp((c) => ({ ...c, layers: c.layers.map((l) => (l.id === lid ? fn(l) : l)) }), label, merge), [editComp]);
  const endMerge = useCallback(() => h.commit(), [h.commit]); // eslint-disable-line react-hooks/exhaustive-deps
  const addLayer = useCallback((l, { select = true, above } = {}) => {
    editComp((c) => {
      const layers = c.layers.slice();
      const i = above ? Math.max(0, layers.findIndex((x) => x.id === above)) : 0;
      layers.splice(i, 0, l);
      return { ...c, layers };
    }, `New ${l.type} layer`);
    if (select) setSel([l.id]);
  }, [editComp]);

  const seek = useCallback((t) => setTime(Math.max(0, t)), []);
  const fps = comp?.fps || 30;
  const frame = 1 / fps;
  const selLayers = comp ? comp.layers.filter((l) => sel.includes(l.id)) : [];
  const primary = selLayers[0];

  // ---------------------------------------------------------------- playback (with the audio mix)
  const playRef = useRef(null);
  const audioCache = useRef({ key: null, buf: null });
  const getMix = useCallback(async () => {
    const clips = audioClips(doc, comp);
    const key = JSON.stringify([clips, comp.duration]);
    if (audioCache.current.key !== key) audioCache.current = { key, buf: clips.length ? await mixAudio(clips, comp.duration) : null };
    return audioCache.current.buf;
  }, [doc, comp]);
  const stop = useCallback(() => { if (playRef.current) { cancelAnimationFrame(playRef.current.raf); playRef.current.stopAudio(); playRef.current = null; } setPlaying(false); }, []);
  const play = useCallback(async () => {
    if (!comp) return;
    const work = comp.work || [0, comp.duration];
    let t0 = time >= work[1] - frame || time < work[0] ? work[0] : time;
    const state = { raf: 0, stopAudio: () => {} };
    playRef.current = state;
    setPlaying(true);
    const mix = await getMix().catch(() => null);
    if (playRef.current !== state) return;
    const startClock = () => { state.stopAudio(); state.stopAudio = playBuffer(mix, t0); state.wall = performance.now(); state.from = t0; };
    startClock();
    const step = () => {
      if (playRef.current !== state) return;
      let t = state.from + (performance.now() - state.wall) / 1000;
      if (t >= work[1]) {
        if (!loop) { setTime(work[1] - frame); stop(); return; }
        t0 = work[0]; startClock(); t = t0;
      }
      setTime(snapT(t, fps));
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  }, [comp, time, frame, fps, loop, getMix, stop]);
  useEffect(() => () => stop(), [stop]);
  const togglePlay = () => (playing ? stop() : play());

  // ---------------------------------------------------------------- layer commands
  const deleteSelection = () => {
    if (selKeys.length) {
      const keys = selKeys.map(parseKeyId);
      editComp((c) => ({ ...c, layers: c.layers.map((l) => {
        const mine = keys.filter((k) => k.lid === l.id);
        let out = l;
        for (const path of new Set(mine.map((k) => k.path))) {
          out = updatePath(out, path, (p) => {
            const k = p.k.filter((kk) => !mine.some((m) => m.path === path && Math.abs(m.t - kk.t) < 1e-3));
            return k.length ? { ...p, k } : { ...p, k: undefined, v: keyedValue(p, time) };
          });
        }
        return out;
      }) }), 'Delete keyframes');
      setSelKeys([]);
      return;
    }
    if (!sel.length) return;
    editComp((c) => ({ ...c, layers: c.layers.filter((l) => !sel.includes(l.id)).map((l) => ({ ...l, parent: sel.includes(l.parent) ? null : l.parent, matte: sel.includes(l.matte?.layer) ? null : l.matte })) }), sel.length > 1 ? 'Delete layers' : 'Delete layer');
    setSel([]);
  };
  const duplicate = () => {
    if (!selLayers.length) return;
    const copies = selLayers.map(duplicateLayer);
    editComp((c) => {
      const layers = c.layers.slice();
      for (let i = copies.length - 1; i >= 0; i--) layers.splice(layers.findIndex((l) => l.id === selLayers[i].id), 0, copies[i]);
      return { ...c, layers };
    }, 'Duplicate');
    setSel(copies.map((c) => c.id));
  };
  const splitLayers = () => {
    const targets = selLayers.filter((l) => time > l.in && time < l.out);
    if (!targets.length) return;
    const tops = [];
    editComp((c) => {
      let layers = c.layers.slice();
      for (const l of targets) {
        const top = { ...duplicateLayer(l), name: l.name, in: time };
        tops.push(top.id);
        layers = layers.map((x) => (x.id === l.id ? { ...x, out: time } : x));
        layers.splice(layers.findIndex((x) => x.id === l.id), 0, top);
      }
      return { ...c, layers };
    }, 'Split layer');
    setSel(tops);
  };
  const reorder = (dir) => {
    if (!sel.length) return;
    editComp((c) => {
      let layers = c.layers.slice();
      const picked = layers.filter((l) => sel.includes(l.id));
      if (dir === 'front' || dir === 'back') { layers = layers.filter((l) => !sel.includes(l.id)); return { ...c, layers: dir === 'front' ? [...picked, ...layers] : [...layers, ...picked] }; }
      const idx = layers.map((l, i) => (sel.includes(l.id) ? i : -1)).filter((i) => i >= 0);
      if (dir === 'up') { for (const i of idx) if (i > 0 && !sel.includes(layers[i - 1].id)) [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]]; }
      else for (const i of idx.reverse()) if (i < layers.length - 1 && !sel.includes(layers[i + 1].id)) [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]];
      return { ...c, layers };
    }, 'Arrange layers');
  };
  const moveToPlayhead = (edge) => { // [ or ]: slide so the in (or out) point is at the playhead
    for (const l of selLayers) {
      const dt = edge === 'in' ? time - l.in : time - l.out;
      editLayer(l.id, (x) => shiftLayer(x, dt), 'Move layer to playhead');
    }
  };
  const trimToPlayhead = (edge) => {
    for (const l of selLayers) editLayer(l.id, (x) => (edge === 'in' ? { ...x, in: Math.min(time, x.out - frame) } : { ...x, out: Math.max(time + frame, x.in + frame) }), 'Trim layer');
  };
  const precompose = () => {
    if (!selLayers.length) return;
    const sub = { ...emptyComp({ width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration, name: `${selLayers[0].name} Comp 1` }), bg: comp.bg };
    sub.layers = comp.layers.filter((l) => sel.includes(l.id)).map((l) => ({ ...l, parent: sel.includes(l.parent) ? l.parent : null, matte: sel.includes(l.matte?.layer) ? l.matte : null }));
    const pl = newLayer('precomp', comp, { sub, name: sub.name });
    editProject((d) => ({
      ...d,
      comps: [...d.comps.map((c) => {
        if (c.id !== comp.id) return c;
        const i = c.layers.findIndex((l) => sel.includes(l.id));
        const layers = c.layers.filter((l) => !sel.includes(l.id)).map((l) => ({ ...l, parent: sel.includes(l.parent) ? null : l.parent }));
        layers.splice(i, 0, pl);
        return { ...c, layers };
      }), sub],
    }), 'Pre-compose');
    setSel([pl.id]);
  };
  const centerAnchor = () => {
    for (const l of selLayers) {
      const c = boxCenter(doc, l, time, comp);
      const M = worldMatrix(l, time, comp);
      const parent = l.parent && comp.layers.find((x) => x.id === l.parent);
      const pm = parent ? worldMatrix(parent, time, comp) : [1, 0, 0, 1, 0, 0];
      const p = apply(invert(pm), apply(M, c));
      editLayer(l.id, (x) => ({ ...x, tr: { ...x.tr, anchor: { v: c }, position: isAnimated(x.tr.position) ? x.tr.position : { ...x.tr.position, v: p } } }), 'Centre anchor point');
    }
  };
  const fitToComp = () => {
    for (const l of selLayers) {
      if (!l.w) continue;
      const s = Math.min(comp.width / l.w, comp.height / l.h) * 100;
      editLayer(l.id, (x) => ({ ...x, tr: { ...x.tr, scale: { v: [s, s] }, position: { v: [comp.width / 2, comp.height / 2] }, anchor: { v: [l.w / 2, l.h / 2] } } }), 'Fit to comp');
    }
  };

  // ---------------------------------------------------------------- keyframe commands
  const visibleKeyTimes = () => {
    const layers = selLayers.length ? selLayers : comp.layers;
    return [...new Set(layers.flatMap(layerKeyTimes).concat(layers.flatMap((l) => [l.in, l.out])))].sort((a, b) => a - b);
  };
  const jumpKey = (dir) => {
    const ts = visibleKeyTimes();
    const t = dir < 0 ? [...ts].reverse().find((x) => x < time - 1e-4) : ts.find((x) => x > time + 1e-4);
    if (t !== undefined) seek(Math.min(t, comp.duration - frame));
  };
  const easeSelected = (kind) => {
    if (!selKeys.length) { toast('Select keyframes first'); return; }
    const keys = selKeys.map(parseKeyId);
    editComp((c) => ({ ...c, layers: c.layers.map((l) => {
      let out = l;
      for (const k of keys.filter((x) => x.lid === l.id)) {
        out = updatePath(out, k.path, (p) => ({ ...p, k: p.k.map((kk) => {
          if (Math.abs(kk.t - k.t) > 1e-3) return kk;
          const { bz, ...rest } = kk; // eslint-disable-line no-unused-vars
          if (kind === 'easy') return { ...rest, in: 'ease', out: 'ease' };
          if (kind === 'in') return { ...rest, in: 'ease' };
          if (kind === 'out') return { ...rest, out: 'ease' };
          if (kind === 'linear') return { ...rest, in: 'linear', out: 'linear' };
          if (kind === 'hold') return { ...kk, out: kk.out === 'hold' ? 'linear' : 'hold' };
          return kk;
        }) }));
      }
      return out;
    }) }), { easy: 'Easy Ease', in: 'Easy Ease In', out: 'Easy Ease Out', linear: 'Linear keyframes', hold: 'Toggle hold keyframes' }[kind]);
  };
  const copy = () => {
    if (selKeys.length) {
      const keys = selKeys.map(parseKeyId);
      const t0 = Math.min(...keys.map((k) => k.t));
      clipboard = { kind: 'keys', items: keys.map((k) => { const l = comp.layers.find((x) => x.id === k.lid); const p = getPath(l, k.path); const kk = p.k.find((x) => Math.abs(x.t - k.t) < 1e-3); return { path: k.path, dt: k.t - t0, key: kk }; }) };
      toast(`Copied ${keys.length} keyframe${keys.length > 1 ? 's' : ''}`);
    } else if (selLayers.length) { clipboard = { kind: 'layers', items: structuredClone(selLayers) }; toast(`Copied ${selLayers.length} layer${selLayers.length > 1 ? 's' : ''}`); }
  };
  const paste = () => {
    if (!clipboard) return;
    if (clipboard.kind === 'layers') {
      const copies = clipboard.items.map(duplicateLayer).map((l, i) => ({ ...l, name: clipboard.items[i].name }));
      const ids = new Map(clipboard.items.map((l, i) => [l.id, copies[i].id]));
      for (const c of copies) { c.parent = ids.get(c.parent) || (comp.layers.some((l) => l.id === c.parent) ? c.parent : null); if (c.matte) c.matte = ids.has(c.matte.layer) ? { ...c.matte, layer: ids.get(c.matte.layer) } : null; }
      editComp((c) => ({ ...c, layers: [...copies, ...c.layers] }), 'Paste layers');
      setSel(copies.map((c) => c.id));
      return;
    }
    const targets = selLayers.length ? selLayers : [];
    if (!targets.length) { toast('Select a layer to paste keyframes into'); return; }
    for (const l of targets) {
      editLayer(l.id, (x) => {
        let out = x;
        for (const it of clipboard.items) {
          if (!getPath(out, it.path)) continue;
          out = updatePath(out, it.path, (p) => {
            const t = +(time + it.dt).toFixed(5);
            const k = (p.k || []).filter((kk) => Math.abs(kk.t - t) > 1e-4);
            return { ...p, k: [...k, { ...it.key, t }].sort((a, b) => a.t - b.t) };
          });
        }
        return out;
      }, 'Paste keyframes');
    }
  };
  const revealProps = (which, add) => {
    if (!comp) return;
    const targets = selLayers.length ? selLayers : comp.layers;
    setReveal((r) => {
      const next = add ? { ...r } : {};
      for (const l of targets) {
        const paths = which === 'u' ? animatedProps(l).map((p) => p.path) : allProps(l).filter((p) => p.key === which).map((p) => p.path);
        const cur = add ? next[l.id] || [] : [];
        const same = !add && r[l.id]?.length === paths.length && paths.every((p) => r[l.id].includes(p));
        next[l.id] = same ? [] : [...new Set([...cur, ...paths])];
      }
      return next;
    });
  };

  // ---------------------------------------------------------------- media, templates, comps
  const media = doc?.media || [];
  const addMediaLayer = (a, at = time) => {
    const kind = a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : 'audio';
    const l = newLayer(kind, comp, { asset: a.id, name: a.name, w: a.width || 640, h: a.height || 360, start: kind === 'image' ? 0 : at, in: kind === 'image' ? 0 : at, duration: a.duration || comp.duration });
    if (a.duration) l.mediaDuration = a.duration;
    if (kind !== 'image') l.out = Math.min(comp.duration, at + (a.duration || comp.duration));
    addLayer(l);
  };
  const importMedia = async () => {
    const list = await pickAssets({ kinds: ['image', 'video', 'audio'], docId: id, title: 'Import into Sora Ugoki' });
    if (!list?.length) return;
    const add = list.filter((a) => !media.some((m) => m.id === a.id)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, width: a.width, height: a.height, duration: a.duration }));
    if (add.length) editProject((d) => ({ ...d, media: [...(d.media || []), ...add] }), 'Import');
    for (const a of list) addMediaLayer(a);
  };
  const applyTemplate = (t) => {
    const layers = t.build(comp);
    editComp((c) => ({ ...c, layers: [...layers, ...c.layers] }), `Template: ${t.name}`);
    setSel([]); setTime(0);
    toast(`Added “${t.name}” — edit the text and colours in the Properties panel`, { type: 'success' });
  };
  const newComp = () => setCompDialog({ new: true, ...emptyComp({ width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration, name: `Comp ${doc.comps.length + 1}` }) });
  const saveComp = (c) => {
    if (c.new) { const { new: _n, ...rest } = c; editProject((d) => ({ ...d, comps: [...d.comps, { ...rest, work: [0, rest.duration] }] }), 'New composition'); setCompId(rest.id); return; } // eslint-disable-line no-unused-vars
    editProject((d) => ({ ...d, comps: d.comps.map((x) => (x.id === c.id ? { ...x, ...c, work: [Math.min(x.work?.[0] || 0, c.duration), Math.min(x.work?.[1] ?? c.duration, c.duration) || c.duration] } : x)) }), 'Composition settings');
  };
  const addPrecompOf = (sub) => {
    if (compContains(doc, sub.id, comp.id)) { toast('That would put the composition inside itself.', { type: 'error' }); return; }
    addLayer(newLayer('precomp', comp, { sub }));
  };
  const newSolid = () => addLayer(newLayer('solid', comp, { name: `Solid ${comp.layers.filter((l) => l.type === 'solid').length + 1}`, color: newFill }));

  // ---------------------------------------------------------------- export
  const drawAt = useCallback((d, c) => async (ctx, t) => { await prepareFrame(d, c, t, { wait: true }); renderFrame(d, c, t, ctx, { scale: ctx.canvas.width / c.width, wait: true }); }, []);
  const [mp4Note, setMp4Note] = useState('');
  useEffect(() => { videoSupport().then((s) => setMp4Note(s.h264 ? 'H.264 + AAC where supported.' : 'This browser has no H.264 encoder, so the MP4 uses VP9 video (plays in browsers, VLC and ffmpeg). Pick WebM for the widest web support.')); }, []);
  const range = (c, opt) => (opt === 'work' ? c.work || [0, c.duration] : [0, c.duration]);
  const rangeOpt = { key: 'range', label: 'Range', type: 'select', default: 'work', choices: [['work', 'Work area'], ['all', 'Whole composition']] };
  const exportConfig = comp && {
    formats: [
      { id: 'webm', label: 'WebM video (VP9 + Opus)', ext: 'webm', kind: 'video', options: [rangeOpt, { key: 'quality', label: 'Quality', type: 'select', default: 'high', choices: [['high', 'High'], ['medium', 'Medium'], ['low', 'Small file']] }] },
      { id: 'mp4', label: 'MP4 video', ext: 'mp4', kind: 'video', note: mp4Note, options: [rangeOpt, { key: 'quality', label: 'Quality', type: 'select', default: 'high', choices: [['high', 'High'], ['medium', 'Medium'], ['low', 'Small file']] }] },
      { id: 'gif', label: 'Animated GIF', ext: 'gif', kind: 'image', options: [rangeOpt, { key: 'fps', label: 'Frame rate', type: 'select', default: 15, choices: [[10, '10 fps'], [15, '15 fps'], [24, '24 fps'], [30, '30 fps']] }, { key: 'scale', label: 'Size', type: 'select', default: 0.5, choices: [[1, '100%'], [0.5, '50%'], [0.33, '33%'], [0.25, '25%']] }, { key: 'loop', label: 'Loop forever', type: 'toggle', default: true }] },
      { id: 'pngseq', label: 'PNG sequence (ZIP)', ext: 'zip', kind: 'image', options: [rangeOpt, { key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '100%'], [0.5, '50%']] }] },
      { id: 'png', label: 'PNG still (current frame)', ext: 'png', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '100%'], [2, '200%'], [0.5, '50%']] }] },
    ],
    render: async (fid, o, { onProgress }) => {
      stop();
      const d = h.get(); const c = compById(d, comp.id);
      const [a, b] = range(c, o.range);
      const draw = drawAt(d, c);
      if (fid === 'webm' || fid === 'mp4') return exportVideo({ width: c.width, height: c.height, fps: c.fps, start: a, duration: b - a, draw, container: fid, quality: o.quality, onProgress, audio: async () => { const clips = audioClips(d, c).map((x) => ({ ...x, at: x.at - a, from: x.from - a, to: x.to - a })); return mixAudio(clips, b - a); } });
      if (fid === 'gif') return exportGif({ width: c.width, height: c.height, fps: o.fps, start: a, duration: b - a, draw, scale: o.scale, loop: o.loop, onProgress });
      if (fid === 'pngseq') return exportPngSequence({ width: c.width, height: c.height, fps: c.fps, start: a, duration: b - a, draw, scale: o.scale, name: c.name.replace(/\W+/g, '_'), onProgress });
      return exportPng({ width: c.width, height: c.height, t: time, draw, scale: o.scale });
    },
  };
  const sendToCut = async () => {
    stop();
    const d = h.get(); const c = compById(d, comp.id); const [a, b] = c.work || [0, c.duration];
    setSending({ p: 0, label: 'Rendering…' });
    try {
      const blob = await exportVideo({ width: c.width, height: c.height, fps: c.fps, start: a, duration: b - a, draw: drawAt(d, c), container: 'webm', onProgress: (p, label) => setSending({ p, label }), audio: async () => mixAudio(audioClips(d, c).map((x) => ({ ...x, at: x.at - a, from: x.from - a, to: x.to - a })), b - a) });
      setSending({ p: 0, label: 'Saving to Files…' });
      const asset = await saveBlob(blob, `${project.doc.name} – ${c.name}.webm`, { docId: id, isExport: true, onProgress: (p) => setSending({ p, label: 'Saving to Files…' }) });
      setSending(null);
      toast('Rendered and saved to Files → Exports. In Sora Eizō, use Import → Files to place it.', { type: 'success', action: { label: 'Open Sora Eizō', onClick: () => nav('/cut') } });
      return asset;
    } catch (e) { setSending(null); toastError(e, 'Couldn’t send to Cut'); return null; }
  };

  // ---------------------------------------------------------------- saving
  const getData = useCallback(async () => {
    const d = h.get();
    if (!d) return null;
    const main = compById(d, d.main) || d.comps[0];
    const c = compById(d, comp?.id) || main;
    const s = Math.min(1, 640 / c.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(c.width * s); canvas.height = Math.round(c.height * s);
    const t = Math.min(time, c.duration - 1 / c.fps);
    try { await prepareFrame(d, c, t, { wait: true }); renderFrame(d, c, t, canvas.getContext('2d'), { scale: s, wait: true }); } catch { /* thumbnail is optional */ }
    return { data: d, thumb: canvas, width: main.width, height: main.height, duration: main.duration, meta: { fps: main.fps, duration: main.duration } };
  }, [h, comp?.id, time]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- shortcuts
  const ifEdit = (f) => () => { if (canEdit) f(); };
  useShortcuts(comp ? {
    v: () => setTool('select'), h: () => setTool('hand'), z: () => setTool('zoom'), w: () => setTool('rotate'), y: ifEdit(() => setTool('anchor')), g: ifEdit(() => setTool('pen')),
    q: ifEdit(() => { const n = SHAPE_TOOLS.includes(tool) ? SHAPE_TOOLS[(SHAPE_TOOLS.indexOf(tool) + 1) % SHAPE_TOOLS.length] : lastShape; setTool(n); setLastShape(n); }),
    'mod+t': ifEdit(() => setTool('text')),
    space: togglePlay, home: () => seek(0), end: () => seek(comp.duration - frame),
    pageup: () => seek(time - frame), pagedown: () => seek(Math.min(comp.duration - frame, time + frame)),
    'mod+arrowleft': () => seek(time - frame), 'mod+arrowright': () => seek(Math.min(comp.duration - frame, time + frame)),
    'shift+home': () => seek((comp.work || [0])[0]), 'shift+end': () => seek((comp.work || [0, comp.duration])[1] - frame),
    p: () => revealProps('p'), s: () => revealProps('s'), r: () => revealProps('r'), t: () => revealProps('t'), a: () => revealProps('a'), u: () => revealProps('u'),
    'shift+p': () => revealProps('p', true), 'shift+s': () => revealProps('s', true), 'shift+r': () => revealProps('r', true), 'shift+t': () => revealProps('t', true), 'shift+a': () => revealProps('a', true),
    '[': ifEdit(() => moveToPlayhead('in')), ']': ifEdit(() => moveToPlayhead('out')), 'alt+[': ifEdit(() => trimToPlayhead('in')), 'alt+]': ifEdit(() => trimToPlayhead('out')),
    j: () => jumpKey(-1), k: () => jumpKey(1),
    'mod+d': ifEdit(duplicate), 'shift+mod+d': ifEdit(splitLayers),
    delete: ifEdit(deleteSelection), backspace: ifEdit(deleteSelection),
    'mod+c': copy, 'mod+v': ifEdit(paste), 'mod+x': ifEdit(() => { copy(); deleteSelection(); }),
    'mod+a': () => setSel(comp.layers.map((l) => l.id)), 'shift+mod+a': () => { setSel([]); setSelKeys([]); },
    f9: ifEdit(() => easeSelected('easy')), 'shift+f9': ifEdit(() => easeSelected('in')), 'shift+mod+f9': ifEdit(() => easeSelected('out')), 'alt+mod+h': ifEdit(() => easeSelected('hold')),
    'mod+y': ifEdit(newSolid), 'alt+mod+y': ifEdit(() => addLayer(newLayer('adjustment', comp))), 'shift+alt+mod+y': ifEdit(() => addLayer(newLayer('null', comp))),
    'shift+mod+c': ifEdit(precompose), 'mod+k': ifEdit(() => setCompDialog(comp)), 'mod+n': ifEdit(newComp), 'mod+i': ifEdit(importMedia),
    b: ifEdit(() => editComp((c) => ({ ...c, work: [Math.min(time, (c.work || [0, c.duration])[1] - frame), (c.work || [0, c.duration])[1]] }), 'Work area start')),
    n: ifEdit(() => editComp((c) => ({ ...c, work: [(c.work || [0])[0], Math.max(time + frame, (c.work || [0])[0] + frame)] }), 'Work area end')),
    "'": () => setGuides((g) => !g),
    'mod+]': ifEdit(() => reorder('up')), 'mod+[': ifEdit(() => reorder('down')), 'shift+mod+]': ifEdit(() => reorder('front')), 'shift+mod+[': ifEdit(() => reorder('back')),
    'alt+mod+home': ifEdit(centerAnchor), 'alt+mod+f': ifEdit(fitToComp),
    '.': () => setZoom((z) => Math.min(16, (z === 'fit' ? 0.5 : z) * 1.5)), ',': () => setZoom((z) => Math.max(0.05, (z === 'fit' ? 0.5 : z) / 1.5)), 'shift+/': () => setZoom('fit'),
    escape: () => { setSelKeys([]); if (tool !== 'select') setTool('select'); },
  } : {}, [comp, time, sel, selKeys, tool, playing, canEdit, doc]);

  if (!doc || !comp) return <EditorShell app="motion" project={project} history={h}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;

  const toolDefs = [
    { id: 'select', label: 'Selection', key: 'v', icon: 'select' },
    { id: 'hand', label: 'Hand', key: 'h', icon: 'hand' },
    { id: 'zoom', label: 'Zoom', key: 'z', icon: 'zoom' },
    { id: 'rotate', label: 'Rotation', key: 'w', icon: 'rotate', edit: true },
    { id: 'anchor', label: 'Pan Behind (anchor point)', key: 'y', Svg: AnchorSvg, edit: true },
    { divider: true },
    { id: 'shape', label: `${{ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' }[SHAPE_TOOLS.includes(tool) ? tool : lastShape]} tool — draws a shape, or a mask on a selected layer`, key: 'q', icon: { rect: 'rect', ellipse: 'ellipse', polygon: 'polygon', star: 'starShape' }[SHAPE_TOOLS.includes(tool) ? tool : lastShape], edit: true },
    { id: 'pen', label: 'Pen (click points, drag for curves, Enter to finish)', key: 'g', Svg: PenSvg, edit: true },
    { id: 'text', label: 'Horizontal Type', key: 'mod+t', icon: 'text', edit: true },
  ];
  const tools = toolDefs.map((t, i) => (t.divider ? <ToolDivider key={i} /> : (
    <Tool key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={t.id === 'shape' ? SHAPE_TOOLS.includes(tool) : tool === t.id}
      onClick={() => { if (t.edit && !canEdit) return; if (t.id === 'shape') { setTool(SHAPE_TOOLS.includes(tool) ? tool : lastShape); return; } setTool(t.id); }}>
      {t.Svg ? <t.Svg /> : null}
    </Tool>
  )));

  const transport = (
    <div className="flex items-center gap-0.5 ml-auto">
      <IconButton icon="skipBack" label="First frame" shortcut="Home" size={28} onClick={() => seek(0)} />
      <IconButton icon="chevronLeft" label="Previous frame" shortcut="Page Up" size={28} onClick={() => seek(time - frame)} />
      <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Preview'} shortcut="Space" size={30} onClick={togglePlay} data-testid="play" />
      <IconButton icon="chevronRight" label="Next frame" shortcut="Page Down" size={28} onClick={() => seek(Math.min(comp.duration - frame, time + frame))} />
      <IconButton icon="skipForward" label="Last frame" shortcut="End" size={28} onClick={() => seek(comp.duration - frame)} />
      <IconButton icon="loop" label="Loop preview" size={28} active={loop} onClick={() => setLoop(!loop)} />
    </div>
  );
  const options = (
    <>
      {SHAPE_TOOLS.includes(tool) || tool === 'pen' ? (
        <>
          <span className="text-xs text-fg2">Fill</span>
          <ColorSwatch value={newFill || '#00000000'} none onChange={setNewFill} size={22} />
          <span className="text-xs text-fg2 ml-2">Stroke</span>
          <ColorSwatch value={newStroke || '#00000000'} none onChange={setNewStroke} size={22} />
          <NumberInput value={strokeWidth} onChange={setStrokeWidth} min={0} max={200} width={44} unit="px" />
          <span className="text-[11px] text-fg3 ml-2">{primary && primary.type !== 'shape' && primary.type !== 'null' && primary.type !== 'audio' ? `Draws a mask on “${primary.name}”` : primary?.type === 'shape' ? `Adds to “${primary.name}”` : 'Draws a new shape layer'}</span>
          {SHAPE_TOOLS.includes(tool) && <Segmented className="ml-2" value={tool} onChange={(v) => { setTool(v); setLastShape(v); }} options={[{ value: 'rect', icon: 'rect', title: 'Rectangle' }, { value: 'ellipse', icon: 'ellipse', title: 'Ellipse' }, { value: 'polygon', icon: 'polygon', title: 'Polygon' }, { value: 'star', icon: 'starShape', title: 'Star' }]} />}
        </>
      ) : (
        <>
          <span className="text-xs text-fg2">{comp.name}</span>
          <span className="text-[11px] text-fg3">{comp.width}×{comp.height} · {comp.fps} fps · {comp.duration}s</span>
        </>
      )}
      <div className="w-px h-5 bg-line mx-1" />
      <Select small value={String(zoom)} onChange={(v) => setZoom(v === 'fit' ? 'fit' : Number(v))} title="Magnification" options={[{ value: 'fit', label: 'Fit' }, ...(zoom !== 'fit' && ![0.25, 0.5, 1, 2].includes(zoom) ? [{ value: String(zoom), label: `${Math.round(zoom * 100)}%` }] : []), { value: '0.25', label: '25%' }, { value: '0.5', label: '50%' }, { value: '1', label: '100%' }, { value: '2', label: '200%' }]} />
      <Select small value={String(res)} onChange={(v) => setRes(v === 'auto' ? 'auto' : Number(v))} title="Resolution" data-testid="resolution" options={[{ value: 'auto', label: 'Auto' }, { value: '1', label: 'Full' }, { value: '0.5', label: 'Half' }, { value: '0.25', label: 'Quarter' }]} />
      <IconButton icon="guides" label="Title/action safe" shortcut="'" size={28} active={guides} onClick={() => setGuides(!guides)} />
      {transport}
    </>
  );

  const menus = [
    { label: 'Composition', items: () => [
      { label: 'New composition…', icon: 'plus', shortcut: keyLabel('mod+n'), onClick: newComp, disabled: !canEdit },
      { label: 'Composition settings…', icon: 'settings', shortcut: keyLabel('mod+k'), onClick: () => setCompDialog(comp), disabled: !canEdit },
      { label: 'Pre-compose…', icon: 'layers', shortcut: keyLabel('shift+mod+c'), onClick: precompose, disabled: !canEdit || !sel.length },
      { divider: true },
      { label: 'Set work area to whole comp', onClick: () => editComp((c) => ({ ...c, work: [0, c.duration] }), 'Work area'), disabled: !canEdit },
      { label: 'Trim comp to work area', onClick: () => { const [a, b] = comp.work || [0, comp.duration]; editComp((c) => ({ ...c, duration: +(b - a).toFixed(4), work: [0, +(b - a).toFixed(4)], layers: c.layers.map((l) => shiftLayer(l, -a)) }), 'Trim comp to work area'); }, disabled: !canEdit },
      { label: 'Motion blur (comp switch)', checked: !!comp.motionBlur, onClick: () => editComp((c) => ({ ...c, motionBlur: !c.motionBlur }), 'Motion blur'), disabled: !canEdit },
      { divider: true },
      { label: 'Send to Cut (render to Files)', icon: 'video', onClick: sendToCut },
    ] },
    { label: 'Layer', items: () => [
      { label: 'New', icon: 'plus', items: [
        { label: 'Text', icon: 'text', onClick: () => { const l = newLayer('text', comp, { size: Math.round(comp.height / 11) }); addLayer(l); setEditingText(l.id); }, disabled: !canEdit },
        { label: 'Solid…', icon: 'square', shortcut: keyLabel('mod+y'), onClick: newSolid, disabled: !canEdit },
        { label: 'Shape layer', icon: 'shapes', onClick: () => addLayer(newLayer('shape', comp, { shapes: [], fill: newFill })), disabled: !canEdit },
        { label: 'Null object', icon: 'frame', shortcut: keyLabel('shift+alt+mod+y'), onClick: () => addLayer(newLayer('null', comp)), disabled: !canEdit },
        { label: 'Adjustment layer', icon: 'adjust', shortcut: keyLabel('alt+mod+y'), onClick: () => addLayer(newLayer('adjustment', comp)), disabled: !canEdit },
        { label: 'Composition (precomp)', icon: 'layers', items: doc.comps.filter((c) => c.id !== comp.id).map((c) => ({ label: c.name, onClick: () => addPrecompOf(c) })), disabled: !canEdit || doc.comps.length < 2 },
      ] },
      { label: 'Import media…', icon: 'import', shortcut: keyLabel('mod+i'), onClick: importMedia, disabled: !canEdit },
      { divider: true },
      { label: 'Mask', icon: 'mask', disabled: !canEdit || !primary || ['audio', 'null', 'shape'].includes(primary.type), items: [
        { label: 'New mask (layer bounds)', onClick: () => { const b = { x: 0, y: 0, w: primary.w || comp.width, h: primary.h || comp.height }; editLayer(primary.id, (l) => ({ ...l, masks: [...l.masks, { ...newMask('rect', [b.x, b.y, b.w, b.h]), name: `Mask ${l.masks.length + 1}` }] }), 'New mask'); } },
        { label: 'Draw with the Rectangle / Ellipse / Pen tools', disabled: true },
      ] },
      { label: 'Duplicate', icon: 'duplicate', shortcut: keyLabel('mod+d'), onClick: duplicate, disabled: !canEdit || !sel.length },
      { label: 'Split layer', icon: 'scissors', shortcut: keyLabel('shift+mod+d'), onClick: splitLayers, disabled: !canEdit || !sel.length },
      { label: 'Delete', icon: 'trash', shortcut: 'Del', onClick: deleteSelection, disabled: !canEdit || (!sel.length && !selKeys.length) },
      { divider: true },
      { label: 'Arrange', icon: 'bringFront', disabled: !canEdit || !sel.length, items: [
        { label: 'Bring to front', shortcut: keyLabel('shift+mod+]'), onClick: () => reorder('front') }, { label: 'Bring forward', shortcut: keyLabel('mod+]'), onClick: () => reorder('up') },
        { label: 'Send backward', shortcut: keyLabel('mod+['), onClick: () => reorder('down') }, { label: 'Send to back', shortcut: keyLabel('shift+mod+['), onClick: () => reorder('back') },
      ] },
      { label: 'Transform', icon: 'transform', disabled: !canEdit || !sel.length, items: [
        { label: 'Centre anchor point in content', shortcut: keyLabel('alt+mod+home'), onClick: centerAnchor },
        { label: 'Fit to comp', shortcut: keyLabel('alt+mod+f'), onClick: fitToComp },
        { label: 'Reset', onClick: () => selLayers.forEach((l) => editLayer(l.id, (x) => ({ ...x, tr: { anchor: { v: boxCenter(doc, x, time, comp) }, position: { v: [comp.width / 2, comp.height / 2] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } } }), 'Reset transform')) },
      ] },
      { label: 'Motion blur', checked: !!primary?.motionBlur, disabled: !canEdit || !sel.length, onClick: () => selLayers.forEach((l) => editLayer(l.id, (x) => ({ ...x, motionBlur: !primary.motionBlur }), 'Motion blur')) },
      { label: 'Move in point to playhead', shortcut: '[', onClick: () => moveToPlayhead('in'), disabled: !canEdit || !sel.length },
      { label: 'Move out point to playhead', shortcut: ']', onClick: () => moveToPlayhead('out'), disabled: !canEdit || !sel.length },
      { label: 'Trim in point to playhead', shortcut: keyLabel('alt+['), onClick: () => trimToPlayhead('in'), disabled: !canEdit || !sel.length },
      { label: 'Trim out point to playhead', shortcut: keyLabel('alt+]'), onClick: () => trimToPlayhead('out'), disabled: !canEdit || !sel.length },
    ] },
    { label: 'Effect', items: () => [
      ...Object.entries({ blur: 'Gaussian Blur', dropShadow: 'Drop Shadow', glow: 'Glow', fill: 'Fill', tint: 'Tint', brightnessContrast: 'Brightness & Contrast', hueSaturation: 'Hue/Saturation', gradientRamp: 'Gradient Ramp', noise: 'Noise', turbulentDisplace: 'Turbulent Displace' })
        .map(([fx, l]) => ({ label: l, icon: 'fx', disabled: !canEdit || !primary || ['audio', 'null'].includes(primary.type), onClick: () => editLayer(primary.id, (x) => ({ ...x, effects: [...x.effects, newEffect(fx, comp)] }), `Add ${l}`) })),
      { divider: true },
      { label: 'Remove all effects', disabled: !canEdit || !primary?.effects?.length, onClick: () => editLayer(primary.id, (x) => ({ ...x, effects: [] }), 'Remove effects') },
    ] },
    { label: 'Animation', items: () => [
      { label: 'Easy Ease', shortcut: 'F9', onClick: () => easeSelected('easy'), disabled: !canEdit || !selKeys.length },
      { label: 'Easy Ease In', shortcut: keyLabel('shift+f9'), onClick: () => easeSelected('in'), disabled: !canEdit || !selKeys.length },
      { label: 'Easy Ease Out', shortcut: keyLabel('shift+mod+f9'), onClick: () => easeSelected('out'), disabled: !canEdit || !selKeys.length },
      { label: 'Linear', onClick: () => easeSelected('linear'), disabled: !canEdit || !selKeys.length },
      { label: 'Toggle hold keyframe', shortcut: keyLabel('alt+mod+h'), onClick: () => easeSelected('hold'), disabled: !canEdit || !selKeys.length },
      { divider: true },
      { label: 'Previous keyframe', shortcut: 'J', onClick: () => jumpKey(-1) },
      { label: 'Next keyframe', shortcut: 'K', onClick: () => jumpKey(1) },
      { divider: true },
      { label: 'Add expression: wiggle', disabled: !canEdit || !selProp, onClick: () => editLayer(selProp.lid, (l) => updatePath(l, selProp.path, (p) => ({ ...p, x: 'wiggle(2, 20)' })), 'Add expression') },
      { label: 'Add expression: loopOut()', disabled: !canEdit || !selProp, onClick: () => editLayer(selProp.lid, (l) => updatePath(l, selProp.path, (p) => ({ ...p, x: 'loopOut()' })), 'Add expression') },
      { label: 'Add expression: time × 90', disabled: !canEdit || !selProp, onClick: () => editLayer(selProp.lid, (l) => updatePath(l, selProp.path, (p) => ({ ...p, x: 'time * 90' })), 'Add expression') },
      { label: 'Remove expression', disabled: !canEdit || !selProp, onClick: () => editLayer(selProp.lid, (l) => updatePath(l, selProp.path, ({ x, ...p }) => p), 'Remove expression') }, // eslint-disable-line no-unused-vars
      { divider: true },
      { label: 'Show animated properties', shortcut: 'U', onClick: () => revealProps('u') },
    ] },
    { label: 'View', items: () => [
      { label: 'Fit', shortcut: '?', onClick: () => setZoom('fit') },
      { label: 'Zoom in', shortcut: '.', onClick: () => setZoom((z) => Math.min(16, (z === 'fit' ? 0.5 : z) * 1.5)) },
      { label: 'Zoom out', shortcut: ',', onClick: () => setZoom((z) => Math.max(0.05, (z === 'fit' ? 0.5 : z) / 1.5)) },
      { divider: true },
      ...[['auto', 'Auto resolution'], [1, 'Full resolution'], [0.5, 'Half resolution'], [0.25, 'Quarter resolution']].map(([v, l]) => ({ label: l, checked: res === v, onClick: () => setRes(v) })),
      { divider: true },
      { label: 'Title/action safe', shortcut: "'", checked: guides, onClick: () => setGuides(!guides) },
    ] },
  ];

  const panels = (
    <>
      <LayerPanel project={doc} comp={comp} layer={primary} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} selKeys={selKeys} />
      <EffectsPanel layer={primary} comp={comp} editLayer={editLayer} canEdit={canEdit} />
      <ProjectPanel project={doc} comp={comp} setCompId={setCompId} canEdit={canEdit} editProject={editProject} onCompSettings={(c) => setCompDialog(c)} onNewComp={newComp}
        media={media} onImport={importMedia} onAddMedia={(a) => addMediaLayer(a)} onTemplate={applyTemplate} />
    </>
  );

  const bottom = (
    <Timeline project={doc} comp={comp} time={time} seek={seek} sel={sel} setSel={setSel} selKeys={selKeys} setSelKeys={setSelKeys} twirl={twirl} setTwirl={setTwirl}
      reveal={reveal} editComp={editComp} editLayer={editLayer} canEdit={canEdit} selProp={selProp} setSelProp={setSelProp} height={tlHeight} setHeight={setTlHeight}
      endMerge={endMerge} playing={playing} />
  );

  return (
    <EditorShell app="motion" project={project} history={h} getData={getData} menus={menus} exportConfig={exportConfig} tools={tools} options={options} panels={panels} bottom={bottom} panelWidth={300}
      fileItems={[{ label: 'Import media…', icon: 'import', shortcut: keyLabel('mod+i'), onClick: importMedia, disabled: !canEdit }, { label: 'Send to Cut (render to Files)', icon: 'video', onClick: sendToCut }]}
      commentAnchor={() => ({ t: time, comp: comp.id })} anchorLabel={(a) => fmtTC(a.t || 0, fps)} onJumpToComment={(a) => { if (a.comp) setCompId(a.comp); seek(a.t || 0); }}
      status={<><span>{comp.name}</span><span>{fmtTC(time, fps)}</span><span>{sel.length ? `${sel.length} selected` : 'Nothing selected'}</span>{!canEdit && <span className="text-warn">View only</span>}</>}>
      <Viewer project={doc} comp={comp} time={time} res={res} zoom={zoom} setZoom={setZoom} guides={guides} sel={sel} setSel={setSel} tool={tool} setTool={setTool}
        canEdit={canEdit} playing={playing} editLayer={editLayer} addLayer={addLayer} newFill={newFill} newStroke={newStroke} strokeWidth={strokeWidth}
        editingText={editingText} setEditingText={setEditingText} renderRef={renderRef} />
      {canEdit && !comp.layers.length && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center pointer-events-none">
          <div className="pointer-events-auto rounded-xl bg-panel/95 border border-line shadow-xl p-3 flex items-center gap-2 text-[12px]">
            <span className="text-fg2 mr-1">Start with</span>
            {TEMPLATES.slice(0, 4).map((t) => <Button key={t.id} size="sm" icon={t.icon} onClick={() => applyTemplate(t)}>{t.name}</Button>)}
            <span className="text-fg3 mx-1">or</span>
            <Button size="sm" icon="import" onClick={importMedia}>Import media</Button>
          </div>
        </div>
      )}
      {compDialog && <CompSettings comp={compDialog} onClose={() => setCompDialog(null)} onSave={(c) => { saveComp(c); setCompDialog(null); }} />}
      {sending && (
        <Modal title="Send to Cut" onClose={null} width={420}>
          <div className="text-sm text-fg2 mb-2">{sending.label}</div>
          <ProgressBar value={sending.p} />
        </Modal>
      )}
    </EditorShell>
  );
}

/** Moves a layer (and all its keyframes) in time. */
export function shiftLayer(l, dt) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (Array.isArray(v.k) && 'v' in v) return { ...v, k: v.k.map((k) => ({ ...k, t: +(k.t + dt).toFixed(5) })) };
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(l);
  return { ...out, id: l.id, in: +(l.in + dt).toFixed(5), out: +(l.out + dt).toFixed(5), start: +(l.start + dt).toFixed(5) };
}

function CompSettings({ comp, onClose, onSave }) {
  const [c, setC] = useState(comp);
  const set = (p) => setC((x) => ({ ...x, ...p }));
  return (
    <Modal title={comp.new ? 'New composition' : 'Composition settings'} onClose={onClose} width={440}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave({ ...c, width: Math.max(16, Math.round(c.width)), height: Math.max(16, Math.round(c.height)), duration: Math.max(1 / c.fps, c.duration) })}>OK</Button></>}>
      <div className="grid grid-cols-[120px_1fr] gap-3 items-center text-sm">
        <span className="text-fg2">Name</span><TextInput value={c.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="text-fg2">Size</span>
        <div className="flex items-center gap-2"><NumberInput value={c.width} onChange={(v) => set({ width: v })} min={16} max={8192} width={70} />×<NumberInput value={c.height} onChange={(v) => set({ height: v })} min={16} max={8192} width={70} />
          <Select small value="" onChange={(v) => { const [a, b] = v.split('x').map(Number); set({ width: a, height: b }); }} options={[{ value: '', label: 'Preset…' }, ...['1920x1080', '3840x2160', '1280x720', '1080x1920', '1080x1080', '1080x1350'].map((x) => ({ value: x, label: x.replace('x', '×') }))]} /></div>
        <span className="text-fg2">Frame rate</span>
        <Select value={String(c.fps)} onChange={(v) => set({ fps: Number(v) })} options={['12', '15', '23.976', '24', '25', '29.97', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))} />
        <span className="text-fg2">Duration</span><NumberInput value={c.duration} onChange={(v) => set({ duration: v })} min={0.1} max={3600} step={0.1} unit="s" width={80} />
        <span className="text-fg2">Background</span><ColorSwatch value={c.bg} onChange={(v) => set({ bg: v })} alpha={false} />
        <span className="text-fg2">Motion blur</span><Toggle checked={!!c.motionBlur} onChange={(v) => set({ motionBlur: v })} label="Enable for layers that ask for it" />
      </div>
    </Modal>
  );
}
