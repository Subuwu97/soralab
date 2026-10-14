// Cut (Sora Eizō) — a Premiere-style video editor: Project panel, Source and Program monitors, a multitrack timeline,
// Effect Controls with keyframes, effects, transitions, titles, captions, an audio mixer, and server-side export.
// The document lives in useHistory (every edit is undoable); the playhead, selection and tool are local state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { Spinner, Toggle, Button, Modal, NumberInput, Select, promptDialog, toast, toastError, confirmDialog, cx } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { exportDialog } from '../../components/ProjectDialogs.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts } from '../../lib/shortcuts.js';
import { api, uploadFiles, download } from '../../lib/api.js';
import { appById } from '../../lib/apps.js';
import {
  fromSaved, emptyDoc, hasContent, addMedia, clipsForMedia, overwrite, insertAt, deleteClips, closeGap, razorAt, rippleTrimTo, editPoints,
  tracksOf, trackById, clipsOn, clipEnd, seqDuration, newTrack, normClip, uid, clamp, newEffect, setValueAt, toggleAnimate, toggleKeyAt as toggleKey,
  nextAdjacent, prevAdjacent, clipAt, clearRange, TITLE_DEFAULT, CAPTION_DEFAULT, parseSrt, toSrt, buildSpec, timecode, STILL_DURATION, EPS,
} from './model.js';
import { Engine } from './engine.js';
import { titleAsset } from './titles.js';
import Timeline from './Timeline.jsx';
import { ProgramMonitor, SourceMonitor } from './Monitors.jsx';
import ProjectPanel from './ProjectPanel.jsx';
import { RightPanels, Meter } from './Panels.jsx';

// Tool icons the shared set doesn't have.
const RollIcon = () => <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h7v12H3zM14 6h7v12h-7z" /><path d="M12 3v18M9 12h6" /></svg>;
const SlideIcon = () => <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h4v8H2zM18 8h4v8h-4zM8 6h8v12H8z" /><path d="M10 12h4M10 12l1.5-1.5M14 12l-1.5 1.5" /></svg>;

const TOOLS = [
  { id: 'select', label: 'Selection', key: 'v', icon: 'select' },
  { id: 'ripple', label: 'Ripple Edit', key: 'b', icon: 'ripple' },
  { id: 'roll', label: 'Rolling Edit', key: 'n', Svg: RollIcon },
  { id: 'razor', label: 'Razor', key: 'c', icon: 'razor' },
  { id: 'slip', label: 'Slip', key: 'y', icon: 'slip' },
  { id: 'slide', label: 'Slide', key: 'u', Svg: SlideIcon },
  { id: 'hand', label: 'Hand', key: 'h', icon: 'hand' },
  { id: 'zoom', label: 'Zoom', key: 'z', icon: 'zoom' },
];
const CURSORS = { razor: 'crosshair', hand: 'grab', zoom: 'zoom-in', slip: 'ew-resize', slide: 'ew-resize' };

let clipboard = null; // copied clips (offsets from the earliest), shared between Cut projects in this tab

function SequenceSettings({ doc, onSave, onClose }) {
  const [w, setW] = useState(doc.width); const [hh, setH] = useState(doc.height); const [fps, setFps] = useState(doc.fps);
  return (
    <Modal title="Sequence settings" onClose={onClose} width={400}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { onSave({ width: Math.round(w / 2) * 2, height: Math.round(hh / 2) * 2, fps }); onClose(); }}>Save</Button></>}>
      <div className="grid grid-cols-[110px_1fr] gap-3 items-center text-sm">
        <span className="text-fg2">Frame size</span>
        <div className="flex items-center gap-2"><NumberInput value={w} onChange={setW} min={16} max={8192} width={70} />×<NumberInput value={hh} onChange={setH} min={16} max={8192} width={70} /></div>
        <span className="text-fg2">Presets</span>
        <Select value="" onChange={(v) => { const [a, b] = v.split('x').map(Number); setW(a); setH(b); }} options={[{ value: '', label: 'Choose…' }, ...['1920x1080', '3840x2160', '1280x720', '1080x1920', '1080x1080', '1080x1350'].map((x) => ({ value: x, label: x.replace('x', ' × ') }))]} />
        <span className="text-fg2">Frame rate</span>
        <Select value={String(fps)} onChange={(v) => setFps(Number(v))} options={['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'].map((v) => ({ value: v, label: `${v} fps` }))} />
      </div>
    </Modal>
  );
}

export default function CutEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const engine = useMemo(() => new Engine(), []);
  useEffect(() => { engine.start(); if (import.meta.env.DEV) window.__cutEngine = engine; return () => engine.stop(); }, [engine]);
  const doc = h.state;
  const readOnly = !project.canEdit;
  const titleCache = useRef({});

  const [sel, setSelState] = useState(new Set());
  const [gap, setGap] = useState(null);
  const [selTransition, setSelTransition] = useState(null);
  const [tool, setTool] = useState('select');
  const [snap, setSnap] = useState(true);
  const [linkedSel, setLinkedSel] = useState(true);
  const [quality, setQuality] = useState(1);
  const [safe, setSafe] = useState(false);
  const [pps, setPps] = useState(60);
  const [source, setSource] = useState(null);
  const [focused, setFocused] = useState('timeline');
  const [targets, setTargets] = useState(new Set());
  const [assets, setAssets] = useState({});
  const [panelRequest, setPanelRequest] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bottomH, setBottomH] = useState(() => { try { return Number(localStorage.getItem('cut-bottom-h')) || 340; } catch { return 340; } });
  const timelineApi = useRef({}); const sourceApi = useRef(null); const dragInfo = useRef(null);
  const srtInput = useRef(null);

  // ------------------------------------------------------------ open
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    (async () => {
      const data = project.data instanceof Blob ? {} : project.data;
      titleCache.current = { ...(data?.title_cache || {}) };
      let d = fromSaved(data, project.doc);
      const imports = project.doc.meta?.import;
      // "Open in Cut" from Files: a new project listing assets to start with.
      if (!hasContent(data) && Array.isArray(imports) && imports.length) {
        const list = (await Promise.all(imports.map((a) => api.get(`/api/assets/${a}`).catch(() => null)))).filter(Boolean);
        const firstVideo = list.find((a) => a.kind === 'video' && a.width);
        if (!project.doc.width && firstVideo) d = { ...emptyDoc({ width: Math.round(firstVideo.width / 2) * 2, height: Math.round(firstVideo.height / 2) * 2, fps: Math.round((firstVideo.fps || 30) * 1000) / 1000 }) };
        d = addMedia(d, list);
        attach(list);
        const v1 = tracksOf(d, 'video')[0].id; const a1 = tracksOf(d, 'audio')[0].id;
        let t = 0; const clips = [];
        for (const a of list) {
          const m = d.media.find((x) => x.id === a.id);
          if (!m) continue;
          const cs = clipsForMedia(m, { start: t, vTrack: v1, aTrack: a1 });
          clips.push(...cs);
          t = Math.max(t, ...cs.map(clipEnd));
        }
        d = { ...d, clips };
      }
      if (off) return;
      h.reset(d);
      const v = tracksOf(d, 'video')[0]; const a = tracksOf(d, 'audio')[0];
      setTargets(new Set([v?.id, a?.id].filter(Boolean)));
      requestAnimationFrame(() => timelineApi.current.fit?.());
    })();
    return () => { off = true; };
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (doc) engine.setDoc(doc); }, [doc, engine]);

  // Asset details (browser-copy status) for the bin; polled while conversions run.
  const mediaIds = doc ? doc.media.map((m) => m.id).join(',') : '';
  useEffect(() => {
    if (!doc || !project.doc) return undefined;
    let off = false; let timer;
    const load = async () => {
      const list = await api.get(`/api/assets?doc_id=${project.doc.id}&limit=1000`).catch(() => []);
      const map = Object.fromEntries(list.map((a) => [a.id, a]));
      for (const m of doc.media) if (!map[m.id]) { const a = await api.get(`/api/assets/${m.id}`).catch(() => null); if (a) map[a.id] = a; }
      if (off) return;
      setAssets(map);
      if (Object.values(map).some((a) => a.web_status === 'processing')) timer = setTimeout(load, 3000);
    };
    load();
    return () => { off = true; clearTimeout(timer); };
  }, [mediaIds, project.doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Titles become PNGs for the server render: refresh them a moment after they change.
  const titleSig = doc ? JSON.stringify(doc.clips.filter((c) => c.type === 'title').map((c) => c.title)) + doc.width + doc.height : '';
  useEffect(() => {
    if (!doc || readOnly) return undefined;
    const t = setTimeout(() => {
      for (const c of doc.clips) if (c.type === 'title') titleAsset(c.title, doc.width, doc.height, titleCache.current, project.doc.id).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [titleSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Files picked from Files (or listed by "Open in Cut") belong to no project yet: link them to this one so the people
  // it's shared with can load them too. (They stay in Files — the picker marks them kept.)
  const attach = async (list) => {
    const docId = project.doc?.id;
    if (!docId || readOnly) return;
    await Promise.all(list.filter((a) => !a.doc_id).map((a) => api.patch(`/api/assets/${a.id}`, { doc_id: docId, keep: true }).catch(() => {})));
  };

  // ------------------------------------------------------------ editing helpers
  const set = useCallback((next, label, opts) => { if (!readOnly) h.set(next, label, opts); }, [readOnly, h]);
  const cur = () => h.get();
  const setSel = (ids, { gap: g = null } = {}) => { setSelState(ids); setGap(g); if (ids.size) setSelTransition(null); };
  const fps = doc?.fps || 30;
  const applyLive = (next, label, key, commit) => { set(next, label, { merge: key }); if (commit) h.commit(); };

  const ed = {
    doc, engine, readOnly, sel, setSel, gap, selTransition, setSelTransition, tool, setTool, snap, linkedSel, quality, setQuality, safe, setSafe,
    pps, setPps, source, focused, focus: setFocused, targets, assets, panelRequest, timelineApi, sourceApi, dragInfo, docId: project.doc?.id,
    duration: doc ? seqDuration(doc) : 0,
    set, commit: () => h.commit(),

    // tracks
    updateTrack: (tid, patch, label = 'Track', opts) => set({ ...cur(), tracks: cur().tracks.map((t) => (t.id === tid ? { ...t, ...patch } : t)) }, label, opts),
    addTrack: (kind) => {
      const d = cur(); const n = tracksOf(d, kind).length + 1;
      const t = newTrack(kind, n);
      const last = d.tracks.map((x) => x.kind).lastIndexOf(kind);
      const tracks = [...d.tracks]; tracks.splice(last + 1, 0, t);
      set({ ...d, tracks }, `Add ${kind} track`);
      return t;
    },
    deleteTrack: async (tid) => {
      const d = cur(); const t = trackById(d, tid);
      if (d.clips.some((c) => c.track === tid) && !await confirmDialog({ title: `Delete ${t.name}?`, message: 'Its clips are deleted too.', confirm: 'Delete', danger: true })) return;
      set({ ...d, tracks: d.tracks.filter((x) => x.id !== tid), clips: d.clips.filter((c) => c.track !== tid) }, 'Delete track');
    },
    toggleTarget: (tid) => {
      const d = cur(); const kind = trackById(d, tid).kind;
      const next = new Set([...targets].filter((x) => trackById(d, x) && trackById(d, x).kind !== kind));
      if (!targets.has(tid)) next.add(tid);
      setTargets(next);
    },

    // media
    importMedia: async () => {
      const list = await pickAssets({ kinds: ['video', 'audio', 'image'], docId: project.doc.id, title: 'Import media' });
      if (list?.length) { attach(list); set(addMedia(cur(), list), 'Import media'); toast(`Imported ${list.length} item${list.length > 1 ? 's' : ''}`, { type: 'success' }); }
    },
    uploadFiles: async (files, bin = null) => {
      const ok = [...files].filter((f) => /^(video|audio|image)\//.test(f.type) || /\.(mkv|mov|avi|mts|flac|opus|aiff?|heic)$/i.test(f.name));
      if (!ok.length) return;
      const id0 = toast(`Uploading ${ok.length} file${ok.length > 1 ? 's' : ''}…`);
      try { const list = await uploadFiles(ok, { docId: project.doc.id }); set(addMedia(cur(), list, bin), 'Import media'); toast('Imported', { type: 'success' }); }
      catch (e) { toastError(e, 'Upload failed'); }
      return id0;
    },
    openSource: (mid) => { setSource(mid); setFocused('source'); },
    renameMedia: (mid, name) => set({ ...cur(), media: cur().media.map((m) => (m.id === mid ? { ...m, name } : m)) }, 'Rename clip'),
    moveToBin: (ids, bin) => set({ ...cur(), media: cur().media.map((m) => (ids.includes(m.id) ? { ...m, bin } : m)) }, 'Move to bin'),
    removeMedia: (ids) => { const d = cur(); set({ ...d, media: d.media.filter((m) => !ids.includes(m.id)), clips: d.clips.filter((c) => !ids.includes(c.asset_id)) }, 'Remove from project'); if (ids.includes(source)) setSource(null); },
    newBin: async (parent) => { const n = await promptDialog({ title: 'New bin', label: 'Name', value: 'Bin' }); if (n) set({ ...cur(), bins: [...cur().bins, { id: uid('b'), name: n, parent }] }, 'New bin'); },
    renameBin: (bid, name) => set({ ...cur(), bins: cur().bins.map((b) => (b.id === bid ? { ...b, name } : b)) }, 'Rename bin'),
    deleteBin: (bid) => {
      const d = cur(); const b = d.bins.find((x) => x.id === bid);
      set({ ...d, bins: d.bins.filter((x) => x.id !== bid).map((x) => (x.parent === bid ? { ...x, parent: b.parent || null } : x)), media: d.media.map((m) => (m.bin === bid ? { ...m, bin: b.parent || null } : m)) }, 'Delete bin');
    },
    markSource: (which, t) => {
      const d = cur(); if (!source) return;
      set({ ...d, media: d.media.map((m) => (m.id === source ? { ...m, [which === 'in' ? 'mark_in' : 'mark_out']: t } : m)) }, which === 'in' ? 'Mark In' : 'Mark Out');
    },

    /** Places media at t on a track (from a drag, or Insert / Overwrite). */
    placeMedia: ({ ids, only, range }, { track, t, insert }) => {
      let d = cur();
      const tr = trackById(d, track);
      const idx = tracksOf(d, tr.kind).findIndex((x) => x.id === track);
      const pick = (kind) => {
        if (tr.kind === kind) return track;
        const list = tracksOf(d, kind);
        const want = targets.size ? [...targets].find((x) => trackById(d, x)?.kind === kind) : null;
        return want || list[Math.min(idx, list.length - 1)]?.id || list[0]?.id;
      };
      const created = []; let at = t;
      for (const mid of ids) {
        const m = d.media.find((x) => x.id === mid);
        if (!m) continue;
        const vTrack = only === 'audio' || (tr.kind === 'audio' && m.kind === 'audio') ? null : pick('video');
        const aTrack = only === 'video' ? null : pick('audio');
        const cs = clipsForMedia(m, { start: at, vTrack, aTrack, range });
        created.push(...cs);
        at = Math.max(at, ...cs.map(clipEnd));
      }
      if (!created.length) return;
      if ([...new Set(created.map((c) => c.track))].some((x) => trackById(d, x)?.lock)) { toast('That track is locked', { type: 'error' }); return; }
      d = insert ? insertAt(d, created, t, at - t) : overwrite(d, created);
      set(d, insert ? 'Insert' : 'Overwrite');
      setSel(new Set(created.map((c) => c.id)));
      return at;
    },
    sourceEdit: (mode, mid = source) => {
      const d = cur(); const m = d.media.find((x) => x.id === mid);
      if (!m) return;
      const v = [...targets].find((x) => trackById(d, x)?.kind === 'video') || tracksOf(d, 'video')[0]?.id;
      const a = [...targets].find((x) => trackById(d, x)?.kind === 'audio');
      const track = m.kind === 'audio' ? (a || tracksOf(d, 'audio')[0].id) : v;
      const end = ed.placeMedia({ ids: [m.id], only: m.kind === 'video' && !a ? 'video' : undefined }, { track, t: engine.t, insert: mode === 'insert' });
      if (end) engine.seek(end);
    },

    // clips
    razor: (t, ids) => { set(razorAt(cur(), Math.round(t * fps) / fps, ids), 'Razor'); },
    updateClip: (cid, patch, label = 'Edit clip', commit = true) => applyLive({ ...cur(), clips: cur().clips.map((c) => (c.id === cid ? { ...c, ...patch } : c)) }, label, `clip-${cid}-${label}`, commit),
    setProp: (cid, prop, v, ct, commit) => {
      const d = cur(); const c = d.clips.find((x) => x.id === cid);
      const next = setValueAt(c, prop, clamp(ct, 0, c.duration), v);
      applyLive({ ...d, clips: d.clips.map((x) => (x.id === cid ? next : x)) }, prop === 'volume' ? 'Volume' : 'Motion', `prop-${cid}-${prop}`, commit);
    },
    toggleAnimate: (cid, prop, ct) => { const d = cur(); set({ ...d, clips: d.clips.map((x) => (x.id === cid ? toggleAnimate(x, prop, clamp(ct, 0, x.duration)) : x)) }, 'Toggle animation'); },
    toggleKey: (cid, prop, ct) => { const d = cur(); set({ ...d, clips: d.clips.map((x) => (x.id === cid ? toggleKey(x, prop, clamp(ct, 0, x.duration)) : x)) }, 'Keyframe'); },
    setSpeed: (cid, s) => {
      let d = cur(); const c = d.clips.find((x) => x.id === cid);
      const ids = new Set([cid, ...(c.link ? d.clips.filter((x) => x.link === c.link).map((x) => x.id) : [])]);
      const changed = d.clips.filter((x) => ids.has(x.id)).map((x) => ({ ...x, speed: s, duration: Math.max(1 / fps, (x.duration * (x.speed || 1)) / s) }));
      let clips = d.clips.filter((x) => !ids.has(x.id));
      for (const x of changed) clips = clearRange(clips, x.track, x.start, clipEnd(x));
      d = { ...d, clips: [...clips, ...changed] };
      set(d, 'Speed');
    },
    updateTitle: (cid, patch, commit = true) => applyLive({ ...cur(), clips: cur().clips.map((c) => (c.id === cid ? { ...c, title: { ...c.title, ...patch }, name: patch.text !== undefined ? patch.text.split('\n')[0].slice(0, 40) || 'Title' : c.name } : c)) }, 'Edit title', `title-${cid}`, commit),
    addEffect: (ids, type) => {
      const d = cur();
      const targets2 = d.clips.filter((c) => ids.includes?.(c.id) || (ids instanceof Set && ids.has(c.id))).filter((c) => c.type !== 'audio');
      if (!targets2.length) { toast('Select a video clip first'); return; }
      set({ ...d, clips: d.clips.map((c) => (targets2.includes(c) ? { ...c, effects: [...(c.effects || []), newEffect(type)] } : c)) }, 'Add effect');
      setSel(new Set(targets2.map((c) => c.id))); setPanelRequest({ tab: 'controls', n: Date.now() });
    },
    removeEffect: (cid, eid) => set({ ...cur(), clips: cur().clips.map((c) => (c.id === cid ? { ...c, effects: c.effects.filter((e) => e.id !== eid) } : c)) }, 'Remove effect'),
    updateEffect: (cid, eid, patch, commit) => applyLive({ ...cur(), clips: cur().clips.map((c) => (c.id === cid ? { ...c, effects: c.effects.map((e) => (e.id === eid ? { ...e, ...patch } : e)) } : c)) }, 'Effect', `fx-${eid}`, commit),

    // transitions
    setTransition: (cid, tr) => { set({ ...cur(), clips: cur().clips.map((c) => (c.id === cid ? { ...c, transition_in: tr } : c)) }, tr ? 'Transition' : 'Remove transition'); if (!tr) setSelTransition(null); },
    applyTransition: (c, side, type, duration = 1) => {
      const d = cur();
      const audioT = type === 'crossfade';
      if (audioT !== (c.type === 'audio')) { toast(audioT ? 'Audio transitions go on audio clips' : 'Video transitions go on video clips'); return; }
      const target = side === 'in' ? c : nextAdjacent(d, c);
      if (!target) { set({ ...d, clips: d.clips.map((x) => (x.id === c.id ? { ...x, fade_out: Math.min(duration, x.duration / 2) } : x)) }, 'Fade out'); return; }
      set({ ...d, clips: d.clips.map((x) => (x.id === target.id ? { ...x, transition_in: { type, duration: Math.min(duration, x.duration) } } : x)) }, 'Add transition');
      setSelTransition(target.id); setSelState(new Set());
    },
    applyToSelection: (type) => {
      const d = cur();
      const c = d.clips.find((x) => sel.has(x.id) && (type === 'crossfade') === (x.type === 'audio'));
      if (!c) { toast('Select a clip first'); return; }
      ed.applyTransition(c, engine.t > c.start + c.duration / 2 ? 'out' : 'in', type);
    },
    defaultTransition: (audio) => {
      const d = cur(); const t = engine.t;
      let c = d.clips.find((x) => sel.has(x.id) && (x.type === 'audio') === audio);
      if (!c) {
        const tr = [...targets].map((x) => trackById(d, x)).find((x) => x && (x.kind === 'audio') === audio) || tracksOf(d, audio ? 'audio' : 'video')[0];
        c = tr && (clipAt(d, tr.id, t) || clipAt(d, tr.id, t - 0.05));
      }
      if (!c) { toast('Put the playhead over a clip, or select one'); return; }
      ed.applyTransition(c, t > c.start + c.duration / 2 ? 'out' : 'in', audio ? 'crossfade' : 'dissolve');
    },

    // markers and In/Out
    addMarker: () => { const d = cur(); const t = Math.round(engine.t * fps) / fps; set({ ...d, markers: [...(d.markers || []), { id: uid('m'), t, name: '', color: '#3ccf8e' }] }, 'Add marker'); },
    editMarker: async (m) => {
      if (readOnly) return;
      const n = await promptDialog({ title: 'Marker', label: 'Name', value: m.name || '', allowEmpty: true });
      if (n !== null) set({ ...cur(), markers: cur().markers.map((x) => (x.id === m.id ? { ...x, name: n } : x)) }, 'Edit marker');
    },
    deleteMarker: (mid) => set({ ...cur(), markers: cur().markers.filter((x) => x.id !== mid) }, 'Delete marker'),
    markIO: (which) => {
      if (focused === 'source' && sourceApi.current) { ed.markSource(which, sourceApi.current.t()); return; }
      const d = cur(); const t = Math.round(engine.t * fps) / fps;
      const io = { ...(d.io || {}), [which]: t };
      if (io.in != null && io.out != null && io.out <= io.in) io[which === 'in' ? 'out' : 'in'] = null;
      set({ ...d, io }, which === 'in' ? 'Mark In' : 'Mark Out');
    },
    jumpEdit: (dir) => {
      const pts = editPoints(cur()); const t = engine.t;
      const next = dir > 0 ? pts.find((p) => p > t + 1e-3) : [...pts].reverse().find((p) => p < t - 1e-3);
      if (next !== undefined) { engine.pause(); engine.seek(next); timelineApi.current.reveal?.(next); }
    },

    // titles, mattes, captions
    newTitle: (caption = false) => {
      let d = cur(); const t = Math.round(engine.t * fps) / fps; const len = caption ? 3 : STILL_DURATION;
      let track = [...tracksOf(d, 'video')].reverse().find((x) => !x.lock && !d.clips.some((c) => c.track === x.id && c.start < t + len && clipEnd(c) > t));
      if (!track) { track = newTrack('video', tracksOf(d, 'video').length + 1); const last = d.tracks.map((x) => x.kind).lastIndexOf('video'); const tracks = [...d.tracks]; tracks.splice(last + 1, 0, track); d = { ...d, tracks }; }
      const c = normClip({ id: uid('c'), track: track.id, type: 'title', name: 'Title', start: t, duration: len, title: { ...(caption ? CAPTION_DEFAULT : TITLE_DEFAULT) } });
      set(overwrite(d, [c]), 'New title');
      setSel(new Set([c.id])); setPanelRequest({ tab: 'controls', n: Date.now() });
    },
    newMatte: () => {
      let d = cur(); const t = Math.round(engine.t * fps) / fps;
      let track = tracksOf(d, 'video').find((x) => !x.lock && !d.clips.some((c) => c.track === x.id && c.start < t + STILL_DURATION && clipEnd(c) > t));
      if (!track) { track = newTrack('video', tracksOf(d, 'video').length + 1); const last = d.tracks.map((x) => x.kind).lastIndexOf('video'); const tracks = [...d.tracks]; tracks.splice(last + 1, 0, track); d = { ...d, tracks }; }
      const c = normClip({ id: uid('c'), track: track.id, type: 'color', name: 'Color Matte', color: '#1d2b64', start: t, duration: STILL_DURATION });
      set(overwrite(d, [c]), 'Color matte');
      setSel(new Set([c.id])); setPanelRequest({ tab: 'controls', n: Date.now() });
    },
    importSrt: () => srtInput.current?.click(),
    exportSrt: () => {
      const d = cur(); const tr = d.tracks.find((x) => x.captions);
      const items = tr ? clipsOn(d, tr.id).filter((c) => c.type === 'title').map((c) => ({ start: c.start, end: clipEnd(c), text: c.title?.text || '' })) : [];
      if (!items.length) { toast('No captions track yet — import an SRT or add captions first'); return; }
      download(new Blob([toSrt(items)], { type: 'application/x-subrip' }), `${project.doc.name}.srt`);
    },
    addCaption: () => {
      let d = cur(); let tr = d.tracks.find((x) => x.captions);
      if (!tr) { tr = newTrack('video', 0, { name: 'Captions', captions: true }); d = { ...d, tracks: [...d.tracks.filter((x) => x.kind === 'video'), tr, ...d.tracks.filter((x) => x.kind !== 'video')] }; }
      const t = Math.round(engine.t * fps) / fps;
      const c = normClip({ id: uid('c'), track: tr.id, type: 'title', name: 'Caption', start: t, duration: 3, title: { ...CAPTION_DEFAULT } });
      set(overwrite(d, [c]), 'Add caption');
      setSel(new Set([c.id])); setPanelRequest({ tab: 'controls', n: Date.now() });
    },

    // selection-wide
    deleteSelection: (ripple) => {
      const d = cur();
      if (selTransition) { ed.setTransition(selTransition, null); return; }
      if (gap) { set(closeGap(d, gap.track, gap.a, gap.b), 'Delete gap'); setGap(null); return; }
      const ids = new Set([...sel].filter((x) => { const c = d.clips.find((y) => y.id === x); return c && !trackById(d, c.track)?.lock; }));
      if (!ids.size) return;
      set(deleteClips(d, ids, { ripple }), ripple ? 'Ripple delete' : 'Delete');
      setSel(new Set());
    },
    copy: (cut2) => {
      const d = cur(); const cs = d.clips.filter((c) => sel.has(c.id));
      if (!cs.length) return;
      const t0 = Math.min(...cs.map((c) => c.start));
      clipboard = cs.map((c) => ({ ...c, start: c.start - t0 }));
      if (cut2) ed.deleteSelection(false);
    },
    paste: () => {
      if (!clipboard?.length) return;
      const d = cur(); const t = engine.t; const links = {};
      const cs = clipboard.filter((c) => trackById(d, c.track)).map((c) => ({ ...c, id: uid('c'), start: c.start + t, link: c.link ? (links[c.link] ||= uid('l')) : undefined }));
      if (!cs.length) return;
      set(overwrite(d, cs), 'Paste');
      setSel(new Set(cs.map((c) => c.id)));
      engine.seek(Math.max(...cs.map(clipEnd)));
    },
    link: () => {
      const d = cur(); const cs = d.clips.filter((c) => sel.has(c.id));
      if (!cs.length) return;
      const linked = cs.some((c) => c.link);
      const L = uid('l');
      set({ ...d, clips: d.clips.map((c) => (sel.has(c.id) ? { ...c, link: linked ? undefined : L } : c)) }, linked ? 'Unlink' : 'Link');
    },
    exportFrame: () => exportDialog({ name: `${project.doc?.name || 'Frame'} ${timecode(engine.t, fps).replace(/:/g, '-')}`, docId: project.doc?.id, formats: formats.filter((f) => f.id === 'png'), render, title: 'Export frame' }),
  };

  // ------------------------------------------------------------ export
  const [codecs, setCodecs] = useState(null);
  useEffect(() => { api.get('/api/render/info').then((r) => setCodecs(r.codecs)).catch(() => setCodecs({})); }, []);
  const hasIO = doc && (doc.io?.in != null || doc.io?.out != null);
  const rangeOpt = { key: 'range', label: 'Range', type: 'select', default: hasIO ? 'io' : 'all', choices: [['all', 'Entire sequence'], ['io', 'In to Out']] };
  const sizeOpt = { key: 'size', label: 'Size', type: 'select', default: 0, choices: [[0, doc ? `Sequence (${doc.width}×${doc.height})` : 'Sequence'], [2160, '2160p (4K)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']] };
  const qOpt = { key: 'quality', label: 'Quality', type: 'select', default: 'high', choices: [['high', 'High'], ['medium', 'Medium (smaller)'], ['low', 'Low (smallest)']] };
  const formats = [
    { id: 'h264', label: 'H.264 (MP4)', ext: 'mp4', kind: 'video', options: [rangeOpt, sizeOpt, qOpt, { key: 'bitrate', label: 'Bitrate', type: 'select', default: 0, choices: [[0, 'Automatic (by quality)'], [4000, '4 Mbps'], [8000, '8 Mbps'], [16000, '16 Mbps'], [35000, '35 Mbps']] }], note: 'Rendered on the server with the fastest encoder it has (GPU when available).' },
    { id: 'hevc', label: 'HEVC / H.265 (MP4)', ext: 'mp4', kind: 'video', options: [rangeOpt, sizeOpt, qOpt], note: codecs && !codecs.hevc ? 'This server can’t encode HEVC.' : 'Smaller files at the same quality; newer devices only.' },
    { id: 'prores', label: 'Apple ProRes 422 HQ (MOV)', ext: 'mov', kind: 'video', options: [rangeOpt, sizeOpt], note: 'Large master files for editing elsewhere, with uncompressed sound.' },
    { id: 'webm', label: 'WebM (VP9)', ext: 'webm', kind: 'video', options: [rangeOpt, sizeOpt, qOpt] },
    { id: 'gif', label: 'Animated GIF', ext: 'gif', kind: 'image', options: [rangeOpt, { key: 'width', label: 'Width', type: 'select', default: 640, choices: [[320, '320 px'], [480, '480 px'], [640, '640 px'], [960, '960 px']] }] },
    { id: 'mp3', label: 'MP3 audio', ext: 'mp3', kind: 'audio', options: [rangeOpt, { key: 'bitrate', label: 'Bitrate', type: 'select', default: 320, choices: [[128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']] }] },
    { id: 'wav', label: 'WAV audio (uncompressed)', ext: 'wav', kind: 'audio', options: [rangeOpt] },
    { id: 'png', label: 'PNG still (current frame)', ext: 'png', kind: 'image', note: 'The frame under the playhead, at full sequence size.' },
  ];
  const render = async (fid, o, { onProgress }) => {
    const d = cur();
    if (!d.clips.length) throw new Error('The timeline is empty — add some clips first.');
    onProgress?.(null, 'Preparing titles…');
    const titleIds = {};
    for (const c of d.clips) if (c.type === 'title') titleIds[c.id] = await titleAsset(c.title, d.width, d.height, titleCache.current, project.doc.id);
    let width = d.width; let height = d.height;
    if (o.size) { height = Number(o.size); width = Math.round((d.width * height) / d.height / 2) * 2; }
    let range;
    if (fid === 'png') range = { start: engine.t, end: engine.t + 1 / fps };
    else if (o.range === 'io' && (d.io?.in != null || d.io?.out != null)) range = { start: d.io.in ?? 0, end: d.io.out ?? seqDuration(d) };
    const output = {
      h264: { container: 'mp4', vcodec: 'h264', quality: o.quality, ...(o.bitrate ? { video_bitrate: o.bitrate } : {}) },
      hevc: { container: 'mp4', vcodec: 'hevc', quality: o.quality },
      prores: { container: 'mov', vcodec: 'prores', audio_codec: 'pcm' },
      webm: { container: 'webm', vcodec: 'vp9', quality: o.quality },
      gif: { container: 'gif', vcodec: 'gif', width: o.width },
      mp3: { container: 'mp3', audio_codec: 'mp3', audio_bitrate: o.bitrate },
      wav: { container: 'wav', audio_codec: 'pcm' },
      png: { container: 'png', vcodec: 'png' },
    }[fid];
    const spec = buildSpec(d, { width, height, range, output, titleAsset: (c) => titleIds[c.id] });
    return { job: { kind: 'timeline', name: project.doc.name, spec } };
  };
  const exportConfig = { formats, render };

  // ------------------------------------------------------------ keyboard
  const step = (n) => {
    if (focused === 'source' && sourceApi.current) { sourceApi.current.step(n); return; }
    engine.pause(); const t = Math.max(0, Math.round((engine.t + n / fps) * fps) / fps); engine.seek(t); timelineApi.current.reveal?.(t);
  };
  const play = (fn) => (focused === 'source' && sourceApi.current ? fn(sourceApi.current) : null);
  useShortcuts(doc ? {
    space: () => play((s) => s.toggle()) ?? engine.toggle(),
    j: () => play((s) => s.shuttle(-1)) ?? engine.shuttle(-1),
    k: () => play((s) => s.shuttle(0)) ?? engine.shuttle(0),
    l: () => play((s) => s.shuttle(1)) ?? engine.shuttle(1),
    i: () => ed.markIO('in'), o: () => ed.markIO('out'),
    'shift+i': () => { if (doc.io?.in != null) engine.seek(doc.io.in); },
    'shift+o': () => { if (doc.io?.out != null) engine.seek(doc.io.out); },
    'shift+mod+x': () => set({ ...cur(), io: { in: null, out: null } }, 'Clear In/Out'),
    'mod+k': () => ed.razor(engine.t, sel.size ? new Set([...sel].filter((x) => { const c = doc.clips.find((y) => y.id === x); return c && engine.t > c.start && engine.t < clipEnd(c); })) : null),
    'shift+mod+k': () => ed.razor(engine.t, null),
    q: () => set(rippleTrimTo(cur(), Math.round(engine.t * fps) / fps, 'head'), 'Ripple trim previous'),
    w: () => set(rippleTrimTo(cur(), Math.round(engine.t * fps) / fps, 'tail'), 'Ripple trim next'),
    delete: () => ed.deleteSelection(false), backspace: () => ed.deleteSelection(false),
    'shift+delete': () => ed.deleteSelection(true), 'shift+backspace': () => ed.deleteSelection(true),
    arrowleft: () => step(-1), arrowright: () => step(1), 'shift+arrowleft': () => step(-5), 'shift+arrowright': () => step(5),
    arrowup: () => ed.jumpEdit(-1), arrowdown: () => ed.jumpEdit(1),
    'alt+arrowleft': () => nudge(-1), 'alt+arrowright': () => nudge(1),
    home: () => engine.seek(0), end: () => engine.seek(seqDuration(doc)),
    m: () => ed.addMarker(),
    plus: () => timelineApi.current.zoom(1.5), '=': () => timelineApi.current.zoom(1.5), '-': () => timelineApi.current.zoom(1 / 1.5), '\\': () => timelineApi.current.fit(),
    ...Object.fromEntries(TOOLS.map((t) => [t.key, () => setTool(t.id)])),
    t: () => ed.newTitle(),
    s: () => setSnap((x) => !x),
    ',': () => ed.sourceEdit('insert'), '.': () => ed.sourceEdit('overwrite'),
    'mod+d': () => ed.defaultTransition(false), 'shift+mod+d': () => ed.defaultTransition(true),
    'mod+l': () => ed.link(),
    'mod+c': () => ed.copy(false), 'mod+x': () => ed.copy(true), 'mod+v': () => ed.paste(),
    'mod+a': () => setSel(new Set(doc.clips.map((c) => c.id))), 'shift+mod+a': () => setSel(new Set()), escape: () => { setSel(new Set()); setSelTransition(null); },
    'mod+i': () => ed.importMedia(),
  } : {}, [doc, sel, focused, gap, selTransition, targets, tool]);
  function nudge(n) {
    const d = cur(); const ids = new Set(sel); if (!ids.size) return;
    const dt = n / fps;
    if (d.clips.some((c) => ids.has(c.id) && c.start + dt < -EPS)) return;
    let clips = d.clips.filter((c) => !ids.has(c.id));
    const moved = d.clips.filter((c) => ids.has(c.id)).map((c) => ({ ...c, start: c.start + dt }));
    for (const c of moved) clips = clearRange(clips, c.track, c.start, clipEnd(c));
    set({ ...d, clips: [...clips, ...moved] }, 'Nudge', { merge: 'nudge' });
  }

  // ------------------------------------------------------------ layout
  const resizeBottom = (e) => {
    e.preventDefault();
    const y0 = e.clientY; const h0 = bottomH;
    const mv = (ev) => setBottomH(clamp(h0 - (ev.clientY - y0), 180, window.innerHeight - 220));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); try { localStorage.setItem('cut-bottom-h', String(bottomH)); } catch { /* private mode */ } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const getData = useCallback(async () => {
    const d = h.get();
    if (!d) return null;
    return { data: { ...d, title_cache: titleCache.current }, thumb: engine.canvas && engine.canvas.width > 2 ? engine.canvas : undefined, width: d.width, height: d.height, duration: seqDuration(d), meta: { fps: d.fps } };
  }, [h, engine]);

  if (!doc) {
    return <EditorShell app="cut" project={project}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;
  }
  const app = appById('cut');
  const selClips = doc.clips.filter((c) => sel.has(c.id));

  const menus = [
    { label: 'Clip', items: () => [
      { label: 'Add Edit', shortcut: 'Ctrl+K', icon: 'razor', disabled: readOnly, onClick: () => ed.razor(engine.t, null) },
      { label: selClips.some((c) => c.link) ? 'Unlink' : 'Link', shortcut: 'Ctrl+L', icon: 'link', disabled: readOnly || !selClips.length, onClick: ed.link },
      { label: 'Speed / Duration…', icon: 'clock', disabled: readOnly || selClips.length !== 1 || !['video', 'audio'].includes(selClips[0]?.type), onClick: async () => {
        const v = await promptDialog({ title: 'Speed', label: 'Speed (%)', value: String(Math.round((selClips[0].speed || 1) * 100)) });
        const n = Number(v); if (n >= 5 && n <= 1600) ed.setSpeed(selClips[0].id, n / 100);
      } },
      { divider: true },
      { label: 'Apply Cross Dissolve', shortcut: 'Ctrl+D', icon: 'transition', disabled: readOnly, onClick: () => ed.defaultTransition(false) },
      { label: 'Apply audio crossfade', shortcut: 'Ctrl+Shift+D', icon: 'wave', disabled: readOnly, onClick: () => ed.defaultTransition(true) },
      { divider: true },
      { label: 'Ripple Delete', shortcut: 'Shift+Del', icon: 'trash', disabled: readOnly || (!sel.size && !gap), onClick: () => ed.deleteSelection(true) },
    ] },
    { label: 'Sequence', items: () => [
      { label: 'Sequence settings…', icon: 'settings', disabled: readOnly, onClick: () => setSettingsOpen(true) },
      { divider: true },
      { label: 'Mark In', shortcut: 'I', onClick: () => ed.markIO('in') },
      { label: 'Mark Out', shortcut: 'O', onClick: () => ed.markIO('out') },
      { label: 'Clear In and Out', shortcut: 'Ctrl+Shift+X', disabled: readOnly, onClick: () => set({ ...cur(), io: { in: null, out: null } }, 'Clear In/Out') },
      { label: 'Add Marker', shortcut: 'M', icon: 'marker', disabled: readOnly, onClick: ed.addMarker },
      { divider: true },
      { label: 'Add video track', icon: 'plus', disabled: readOnly, onClick: () => ed.addTrack('video') },
      { label: 'Add audio track', icon: 'plus', disabled: readOnly, onClick: () => ed.addTrack('audio') },
      { divider: true },
      { label: 'Snapping', shortcut: 'S', checked: snap, onClick: () => setSnap(!snap) },
      { label: 'Linked selection', checked: linkedSel, onClick: () => setLinkedSel(!linkedSel) },
      { label: 'Zoom to fit', shortcut: '\\', icon: 'fit', onClick: () => timelineApi.current.fit() },
    ] },
    { label: 'Graphics', items: () => [
      { label: 'New title', shortcut: 'T', icon: 'title', disabled: readOnly, onClick: () => ed.newTitle() },
      { label: 'New color matte', icon: 'color', disabled: readOnly, onClick: ed.newMatte },
      { divider: true },
      { label: 'Add caption at playhead', icon: 'comment', disabled: readOnly, onClick: ed.addCaption },
      { label: 'Import captions (SRT)…', icon: 'import', disabled: readOnly, onClick: ed.importSrt },
      { label: 'Export captions (SRT)', icon: 'export', onClick: ed.exportSrt },
    ] },
  ];
  const editItems = [
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: readOnly || !sel.size, onClick: () => ed.copy(true) },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !sel.size, onClick: () => ed.copy(false) },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: readOnly || !clipboard, onClick: ed.paste },
    { label: 'Clear', shortcut: 'Del', disabled: readOnly || (!sel.size && !gap && !selTransition), onClick: () => ed.deleteSelection(false) },
    { label: 'Ripple Delete', shortcut: 'Shift+Del', disabled: readOnly || (!sel.size && !gap), onClick: () => ed.deleteSelection(true) },
    { divider: true },
    { label: 'Select All', shortcut: 'Ctrl+A', onClick: () => setSel(new Set(doc.clips.map((c) => c.id))) },
    { label: 'Deselect All', shortcut: 'Ctrl+Shift+A', onClick: () => setSel(new Set()) },
    { divider: true },
    { label: 'Import media…', shortcut: 'Ctrl+I', icon: 'import', disabled: readOnly, onClick: ed.importMedia },
  ];

  const tools = (
    <>
      {TOOLS.map((t) => (
        <Tool key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={tool === t.id} onClick={() => setTool(t.id)}>{t.Svg && <t.Svg />}</Tool>
      ))}
      <ToolDivider />
      <Tool icon="text" label="New title" shortcut="t" onClick={() => ed.newTitle()} />
    </>
  );
  const options = (
    <>
      <Button size="sm" icon="import" disabled={readOnly} onClick={ed.importMedia}>Import</Button>
      <Button size="sm" icon="title" disabled={readOnly} onClick={() => ed.newTitle()}>Title</Button>
      <Button size="sm" icon="color" disabled={readOnly} onClick={ed.newMatte}>Color matte</Button>
      <span className="w-px h-5 bg-line mx-1" />
      <Toggle checked={snap} onChange={setSnap} label="Snap (S)" />
      <Toggle checked={linkedSel} onChange={setLinkedSel} label="Linked selection" />
      <span className="w-px h-5 bg-line mx-1" />
      <span className="text-[12px] text-fg2">{TOOLS.find((t) => t.id === tool)?.label} tool</span>
      <span className="flex-1" />
      {readOnly && <span className="text-[12px] text-warn">View only</span>}
    </>
  );
  const status = (
    <>
      <span>{doc.width}×{doc.height} · {doc.fps} fps</span>
      <span>Duration {timecode(seqDuration(doc), fps)}</span>
      {(doc.io?.in != null || doc.io?.out != null) && <span>In {timecode(doc.io.in ?? 0, fps)} · Out {timecode(doc.io.out ?? seqDuration(doc), fps)}</span>}
      <span>{sel.size ? `${sel.size} clip${sel.size > 1 ? 's' : ''} selected` : gap ? 'Gap selected — Delete closes it' : ''}</span>
      <span className="flex-1" />
      <span className="text-fg3">{app?.name}</span>
    </>
  );
  const bottom = (
    <div className="flex flex-col" style={{ height: bottomH }}>
      <div className="h-1.5 shrink-0 cursor-row-resize hover:bg-accent/40 bg-panel-2" onPointerDown={resizeBottom} title="Drag to resize" />
      <div className="flex-1 min-h-0 flex">
        <div className="w-[280px] shrink-0 border-r border-line"><ProjectPanel ed={ed} /></div>
        <div className="flex-1 min-w-0" style={{ cursor: CURSORS[tool] }}><Timeline ed={ed} /></div>
        <div className="w-9 shrink-0 border-l border-line bg-panel flex flex-col items-center pt-2 gap-1" title="Master level">
          <span className="text-[9px] text-fg3">dB</span>
          <Meter engine={engine} height={Math.max(60, bottomH - 60)} width={16} />
        </div>
      </div>
    </div>
  );

  return (
    <EditorShell app="cut" project={project} history={h} getData={getData} menus={menus} editItems={editItems} exportConfig={exportConfig}
      tools={tools} options={options} panels={<RightPanels ed={{ ...ed, panelRequest }} />} panelWidth={316} bottom={bottom} status={status}
      commentAnchor={() => ({ t: engine.t })} anchorLabel={(a) => timecode(a.t, fps)} onJumpToComment={(a) => engine.seek(a.t)}>
      <div className={cx('h-full flex gap-px bg-line')}>
        <div className="flex-1 min-w-0 bg-panel"><SourceMonitor ed={ed} /></div>
        <div className="flex-[1.25] min-w-0 bg-panel"><ProgramMonitor ed={ed} /></div>
      </div>
      <input ref={srtInput} type="file" accept=".srt,application/x-subrip,text/plain" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        const items = parseSrt(await f.text());
        if (!items.length) { toast('No captions found in that file', { type: 'error' }); return; }
        let d = cur(); let tr = d.tracks.find((x) => x.captions);
        if (!tr) { tr = newTrack('video', 0, { name: 'Captions', captions: true }); d = { ...d, tracks: [...d.tracks.filter((x) => x.kind === 'video'), tr, ...d.tracks.filter((x) => x.kind !== 'video')] }; }
        const cs = items.map((x) => normClip({ id: uid('c'), track: tr.id, type: 'title', name: x.text.split('\n')[0].slice(0, 40), start: x.start, duration: x.end - x.start, title: { ...CAPTION_DEFAULT, text: x.text } }));
        set(overwrite(d, cs), 'Import captions');
        toast(`Imported ${cs.length} captions`, { type: 'success' });
      }} />
      {settingsOpen && <SequenceSettings doc={doc} onClose={() => setSettingsOpen(false)} onSave={(s) => set({ ...cur(), ...s }, 'Sequence settings')} />}
    </EditorShell>
  );
}
