// Sora Audio — an Audition-style audio editor: a multitrack session (tracks with effect racks, clips with fades,
// crossfades and volume envelopes, ducking, markers, loop, recording) and a Waveform editor for destructive edits,
// noise reduction and a spectral display. Mixdown renders in the browser; compressed formats are encoded by the server.
// The session lives in useHistory (every change is undoable); selection, playhead, zoom and tool are local state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { Button, IconButton, Segmented, Spinner, promptDialog, confirmDialog, toast, toastError, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { api, saveBlob, uploadFiles } from '../../lib/api.js';
import {
  fromSaved, hasContent, newTrack, newClip, fileOf, addFiles, addClip, deleteClips, splitAt, findClip, allClips, clipEnd, sessionEnd, updateTrack,
  repointClip, fileById, uid, clamp, sortClips, fmtDb,
} from './model.js';
import { FX, FX_ORDER, PRESETS, newEffect } from './effects.js';
import { Engine } from './engine.js';
import { encodeWav, toBuffer, fromBuffer, integratedLoudness } from './dsp.js';
import { exportConfig } from './exportAudio.js';
import Timeline from './Timeline.jsx';
import Panels from './Panels.jsx';
import WaveEditor from './WaveEditor.jsx';
import { Meter, useFrame, fmtClock, AIcon } from './parts.jsx';
import { fmtDur } from '../_media/media.js';

let clipboard = null; // copied clips: [{ clip, trackIndex }] with starts relative to the earliest

export default function AudioEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const engine = useMemo(() => new Engine(), []);
  engine.docId = id;
  useEffect(() => () => engine.dispose(), [engine]);

  const [sel, setSel] = useState(() => new Set());
  const [selTrack, setSelTrack] = useState(null);
  const [timeSel, setTimeSel] = useState(null);
  const [tool, setTool] = useState('move');
  const [snap, setSnap] = useState(true);
  const [pps, setPps] = useState(40);
  const [armed, setArmed] = useState(() => new Set());
  const [view, setView] = useState('multi');
  const [waveClip, setWaveClip] = useState(null);
  const [tab, setTab] = useState('track');
  const [, setTick] = useState(0);
  const [binOpen, setBinOpen] = useState(true);
  const tl = useRef({});
  const canEdit = project.canEdit;

  // ------------------------------------------------------------ open
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    (async () => {
      const data = project.data instanceof Blob ? {} : project.data;
      let d = fromSaved(data, project.doc.meta || {});
      // "Open in Audio" from Files: a new, empty session listing assets to start with — one track each, at 0.
      const imports = project.doc.meta?.import;
      if (!hasContent(data) && Array.isArray(imports) && imports.length) {
        const list = (await Promise.all(imports.map((a) => api.get(`/api/assets/${a}`).catch(() => null)))).filter((a) => a && ['audio', 'video'].includes(a.kind));
        const files = list.map(fileOf);
        d = addFiles(d, files);
        files.forEach((f, i) => {
          if (!d.tracks[i] || d.tracks[i].clips.length) d = { ...d, tracks: [...d.tracks.slice(0, i), newTrack(d), ...d.tracks.slice(i)] };
          d = updateTrack(d, d.tracks[i].id, { name: d.tracks[i].name.startsWith('Track ') ? f.name.replace(/\.[^.]+$/, '') : d.tracks[i].name });
          d = addClip(d, d.tracks[i].id, newClip(f, 0));
        });
      }
      if (off) return;
      h.reset(d);
      setSelTrack(d.tracks[0]?.id || null);
      if (d.tracks.some((t) => t.clips.length)) requestAnimationFrame(() => tl.current.fit?.());
    })();
    return () => { off = true; };
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = h.state;
  useEffect(() => { if (doc) engine.setDoc(doc); }, [doc, engine]);
  useEffect(() => engine.on((w) => { if (w === 'state' || w === 'input') setTick((x) => x + 1); }), [engine]);
  const docRef = useRef(doc); docRef.current = doc;
  const timeSelRef = useRef(timeSel); timeSelRef.current = timeSel;

  const edit = useCallback((next, label, opts) => { if (canEdit && next) h.set(next, label, opts); }, [h, canEdit]);
  const commit = useCallback(() => h.commit(), [h]);

  // Clips whose asset vanished from the selection set after undo etc.
  useEffect(() => {
    if (!doc) return;
    const ids = new Set(allClips(doc).map((x) => x.clip.id));
    if ([...sel].some((x) => !ids.has(x))) setSel(new Set([...sel].filter((x) => ids.has(x))));
    if (selTrack && !doc.tracks.some((t) => t.id === selTrack)) setSelTrack(doc.tracks[0]?.id || null);
    if (view === 'wave' && waveClip && !ids.has(waveClip)) { setView('multi'); setWaveClip(null); }
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ actions
  const placeFile = (d, file, trackId, t) => {
    d = addFiles(d, [file]);
    let tid = trackId;
    if (!tid || !d.tracks.some((x) => x.id === tid)) { const nt = newTrack(d, file.name.replace(/\.[^.]+$/, '')); d = { ...d, tracks: [...d.tracks, nt] }; tid = nt.id; }
    return addClip(d, tid, newClip(file, Math.max(0, t)));
  };
  const ensureDuration = async (f) => {
    if (f.duration) return f;
    const a = await api.get(`/api/assets/${f.id}`).catch(() => null);
    if (a?.duration) return fileOf(a);
    const b = await engine.load(f.id).catch(() => null);
    return { ...f, duration: b?.duration || 1 };
  };
  const actions = {
    openClip: (cid) => { const f = findClip(docRef.current, cid); if (!f) return; engine.stop(); setWaveClip(cid); setView('wave'); },
    split: (ids) => {
      const d = docRef.current; const at = engine.position;
      const list = ids?.length ? ids : sel.size ? [...sel] : null;
      const [nd, n] = splitAt(d, at, list);
      if (n) edit(nd, 'Split'); else toast('Nothing to split at the playhead.');
    },
    del: (ids) => { if (ids.length) { edit(deleteClips(docRef.current, ids), ids.length > 1 ? 'Delete clips' : 'Delete clip'); setSel(new Set()); } },
    copy: (ids) => {
      const d = docRef.current; const items = d.tracks.flatMap((t, ti) => t.clips.filter((c) => ids.includes(c.id)).map((c) => ({ clip: c, ti })));
      if (!items.length) return;
      const t0 = Math.min(...items.map((x) => x.clip.start)); const ti0 = Math.min(...items.map((x) => x.ti));
      clipboard = items.map((x) => ({ clip: { ...x.clip, start: x.clip.start - t0 }, dt: x.ti - ti0, files: d.files.filter((f) => f.id === x.clip.asset) }));
      toast(`Copied ${items.length} clip${items.length > 1 ? 's' : ''}`);
    },
    canPaste: () => !!clipboard?.length,
    paste: (t = engine.position, trackId = selTrack) => {
      if (!clipboard?.length) return;
      let d = docRef.current;
      const base = Math.max(0, d.tracks.findIndex((x) => x.id === trackId));
      const ids = [];
      for (const it of clipboard) {
        d = addFiles(d, it.files);
        while (d.tracks.length <= base + it.dt) d = { ...d, tracks: [...d.tracks, newTrack(d)] };
        const c = { ...it.clip, id: uid('c'), start: t + it.clip.start }; ids.push(c.id);
        d = addClip(d, d.tracks[base + it.dt].id, c);
      }
      edit(d, 'Paste'); setSel(new Set(ids));
    },
    duplicate: (ids) => {
      let d = docRef.current; const out = [];
      for (const { track, clip } of allClips(d).filter((x) => ids.includes(x.clip.id))) { const c = { ...clip, id: uid('c'), start: clipEnd(clip) }; out.push(c.id); d = addClip(d, track.id, c); }
      edit(d, 'Duplicate'); setSel(new Set(out));
    },
    addMarker: (t = engine.position) => {
      const d = docRef.current;
      edit({ ...d, markers: [...d.markers, { id: uid('m'), t, name: `Marker ${d.markers.length + 1}` }].sort((a, b) => a.t - b.t) }, 'Add marker');
    },
    addTrack: () => { const d = docRef.current; const t = newTrack(d); edit({ ...d, tracks: [...d.tracks, t] }, 'Add track'); setSelTrack(t.id); },
    deleteTrack: async (tid) => {
      const d = docRef.current; const t = d.tracks.find((x) => x.id === tid);
      if (t.clips.length && !await confirmDialog({ title: `Delete “${t.name}”?`, message: `Its ${t.clips.length} clip(s) go too (Undo brings them back).`, confirm: 'Delete', danger: true })) return;
      edit({ ...d, tracks: d.tracks.filter((x) => x.id !== tid), duck: d.duck?.target === tid ? null : d.duck && { ...d.duck, sources: d.duck.sources.filter((s) => s !== tid) } }, 'Delete track');
    },
    duplicateTrack: (tid) => {
      const d = docRef.current; const i = d.tracks.findIndex((x) => x.id === tid); const t = d.tracks[i];
      const copy = { ...t, id: uid('t'), name: `${t.name} copy`, solo: false, effects: t.effects.map((e) => ({ ...e, id: uid('fx') })), clips: t.clips.map((c) => ({ ...c, id: uid('c') })) };
      edit({ ...d, tracks: [...d.tracks.slice(0, i + 1), copy, ...d.tracks.slice(i + 1)] }, 'Duplicate track');
    },
    moveTrack: (tid, dir) => {
      const d = docRef.current; const i = d.tracks.findIndex((x) => x.id === tid); const j = i + dir;
      if (j < 0 || j >= d.tracks.length) return;
      const l = [...d.tracks]; [l[i], l[j]] = [l[j], l[i]]; edit({ ...d, tracks: l }, 'Move track');
    },
    renameTrack: async (tid) => {
      const t = docRef.current.tracks.find((x) => x.id === tid);
      const n = await promptDialog({ title: 'Rename track', label: 'Name', value: t.name });
      if (n) edit(updateTrack(docRef.current, tid, { name: n }), 'Rename track');
    },
    place: async (file, trackId, t) => { const f = await ensureDuration(file); edit(placeFile(docRef.current, f, trackId, t), 'Add clip'); },
    uploadAndPlace: async (list, trackId, t) => {
      try {
        toast(`Uploading ${list.length} file${list.length > 1 ? 's' : ''}…`);
        const assets = (await uploadFiles(list, { docId: id })).filter((a) => ['audio', 'video'].includes(a.kind));
        let d = docRef.current; let tt = t;
        for (const a of assets) { const f = await ensureDuration(fileOf(a)); d = placeFile(d, f, trackId, tt); tt += f.duration; }
        edit(d, 'Add clips');
      } catch (e) { toastError(e, 'Upload failed'); }
    },
    importFiles: async () => {
      const assets = await pickAssets({ kinds: ['audio', 'video'], docId: id, title: 'Import audio' });
      if (!assets?.length) return;
      const files = await Promise.all(assets.filter((a) => ['audio', 'video'].includes(a.kind)).map((a) => ensureDuration(fileOf(a))));
      edit(addFiles(docRef.current, files), files.length > 1 ? 'Import files' : 'Import file');
      setBinOpen(true);
      toast(`${files.length} file${files.length > 1 ? 's' : ''} in the Files panel — drag onto a track, or double-click to insert at the playhead.`);
    },
    insertFile: (f) => actions.place(f, selTrack, engine.position),
    matchLoudness: async () => {
      const d0 = docRef.current;
      if (!sessionEnd(d0)) { toast('Add some clips first.'); return; }
      const id0 = toast('Measuring the mix…', { duration: 20000 });
      try {
        // A safety limiter on the master, then measure and set the master gain; a second pass corrects for the limiter.
        let d = d0;
        if (!d.master.effects.some((e) => e.type === 'limiter' && e.on)) d = { ...d, master: { ...d.master, effects: [...d.master.effects, newEffect('limiter', { ceiling: -1 })] } };
        let vol = d.master.volume; let L = -Infinity;
        for (let pass = 0; pass < 2; pass++) {
          L = integratedLoudness(fromBuffer(await engine.render({ ...d, master: { ...d.master, volume: vol } })));
          if (!Number.isFinite(L)) throw new Error('The mix is silent.');
          vol = clamp(vol + (-16 - L), -40, 24);
        }
        edit({ ...d, master: { ...d.master, volume: Math.round(vol * 10) / 10 } }, 'Match loudness');
        toast(`Master set to ${fmtDb(vol)} dB → about −16 LUFS (was ${(L - (vol - d.master.volume)).toFixed(1)}).`, { type: 'success' });
      } catch (e) { toastError(e, 'Couldn’t match loudness'); }
      void id0;
    },
  };

  // ------------------------------------------------------------ transport & recording
  const togglePlay = () => { if (engine.recording) { stopRecording(); return; } if (engine.playing) engine.stop(); else engine.play(engine.position).catch(toastError); };
  const toggleArm = async (tid) => {
    const next = new Set(armed);
    if (next.has(tid)) next.delete(tid); else next.add(tid);
    setArmed(next);
    if (next.size) engine.openInput().catch((e) => { toastError(e, 'Microphone unavailable'); setArmed(new Set()); });
    else engine.closeInput();
  };
  const startRecording = async () => {
    if (!canEdit) return;
    let targets = armed;
    if (!targets.size) { const t = selTrack || docRef.current.tracks[0]?.id; if (!t) return; targets = new Set([t]); setArmed(targets); }
    try { await engine.record(engine.position); } catch (e) { toastError(e, 'Couldn’t start recording'); }
  };
  const stopRecording = async () => {
    const res = await engine.stopRecording();
    if (!res) { toast('Nothing was recorded.'); return; }
    const d0 = docRef.current;
    const n = d0.files.filter((f) => /^Recording /.test(f.name)).length + 1;
    const name = `Recording ${n}.wav`;
    try {
      const asset = await saveBlob(encodeWav(res.audio, 24), name, { docId: id, isExport: false });
      const dur = res.audio.channels[0].length / res.audio.sampleRate;
      engine.putBuffer(asset.id, toBuffer(res.audio));
      const file = { ...fileOf(asset), duration: asset.duration || dur };
      let d = addFiles(docRef.current, [file]);
      for (const tid of armed.size ? armed : [selTrack]) if (d.tracks.some((t) => t.id === tid)) d = addClip(d, tid, newClip(file, res.from, { name: name.replace('.wav', '') }));
      edit(d, 'Record');
      toast(`Recorded ${fmtDur(dur)}`, { type: 'success' });
    } catch (e) { toastError(e, 'Couldn’t save the recording'); }
  };
  const record = () => (engine.recording ? stopRecording() : startRecording());

  const loopToSelection = () => { if (timeSel) edit({ ...docRef.current, loop: { start: timeSel.start, end: timeSel.end, on: true } }, 'Loop selection'); };
  const toggleLoop = () => {
    const d = docRef.current;
    if (d.loop) edit({ ...d, loop: { ...d.loop, on: !d.loop.on } }, d.loop.on ? 'Loop off' : 'Loop on');
    else if (timeSel) loopToSelection();
    else toast('Drag in the strip above the ruler (or make a time selection) to set a loop.');
  };

  const multi = view === 'multi';
  useShortcuts({
    space: () => togglePlay(),
    'shift+space': () => record(),
    home: () => engine.seek(0), end: () => engine.seek(sessionEnd(docRef.current)),
    'mod+k': () => canEdit && actions.split(),
    m: () => canEdit && actions.addMarker(),
    delete: () => canEdit && actions.del([...sel]), backspace: () => canEdit && actions.del([...sel]),
    'mod+c': () => actions.copy([...sel]), 'mod+x': () => { actions.copy([...sel]); if (canEdit) actions.del([...sel]); }, 'mod+v': () => canEdit && actions.paste(),
    'mod+d': () => canEdit && actions.duplicate([...sel]),
    'mod+a': () => setSel(new Set(allClips(docRef.current).map((x) => x.clip.id))),
    escape: () => { setSel(new Set()); setTimeSel(null); },
    v: () => setTool('move'), t: () => setTool('time'), r: () => setTool('razor'), s: () => setSnap((x) => !x), l: () => canEdit && toggleLoop(),
    '=': () => tl.current.zoomIn?.(), '-': () => tl.current.zoomOut?.(), '\\': () => tl.current.fit?.(),
    arrowleft: () => engine.seek(Math.max(0, engine.position - 1)), arrowright: () => engine.seek(engine.position + 1),
  }, [sel, canEdit, timeSel, armed, selTrack], { enabled: multi && !!doc });

  // ------------------------------------------------------------ save
  const getData = useCallback(async () => {
    const d = docRef.current;
    return { data: d, duration: sessionEnd(d) || undefined, thumb: thumbnail(d, engine), meta: { ...(project.doc?.meta || {}), sampleRate: d.sampleRate } };
  }, [engine, project.doc]);

  const exp = useMemo(() => (doc ? exportConfig({ engine, getDoc: () => docRef.current, getTimeSel: () => timeSelRef.current, docId: id, name: project.doc?.name }) : null), [engine, id, project.doc?.name, doc?.sampleRate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return <EditorShell app="audio" project={project} history={h}><div className="h-full grid place-items-center"><Spinner size={26} /></div></EditorShell>;

  const selTrackObj = doc.tracks.find((t) => t.id === selTrack);
  const wf = waveClip ? findClip(doc, waveClip) : null;
  const effectsMenu = () => [
    { heading: selTrackObj ? `Add to “${selTrackObj.name}”` : 'Select a track' },
    ...FX_ORDER.map((type) => ({ label: FX[type].name, disabled: !canEdit || !selTrackObj, onClick: () => { edit(updateTrack(doc, selTrack, { effects: [...selTrackObj.effects, newEffect(type)] }), `Add ${FX[type].name}`); setTab('track'); } })),
    { divider: true },
    { label: 'Track presets', icon: 'presets', disabled: !canEdit || !selTrackObj, items: Object.values(PRESETS).map((p) => ({ label: p.name, onClick: () => { edit(updateTrack(doc, selTrack, { effects: p.make() }), `Preset: ${p.name}`); setTab('track'); } })) },
    { label: 'Match loudness (−16 LUFS)', icon: 'normalize', disabled: !canEdit, onClick: actions.matchLoudness },
  ];
  const menus = [
    {
      label: 'Clip', items: () => [
        { label: 'Split at playhead', icon: 'razor', shortcut: keyLabel('mod+k'), disabled: !canEdit, onClick: () => actions.split() },
        { label: 'Duplicate', icon: 'duplicate', shortcut: keyLabel('mod+d'), disabled: !canEdit || !sel.size, onClick: () => actions.duplicate([...sel]) },
        { label: 'Delete', icon: 'trash', shortcut: 'Del', disabled: !canEdit || !sel.size, onClick: () => actions.del([...sel]) },
        { divider: true },
        { label: 'Open in Waveform editor', icon: 'wave', disabled: sel.size !== 1, onClick: () => actions.openClip([...sel][0]) },
        { label: 'Clip properties', icon: 'sliders', disabled: !sel.size, onClick: () => setTab('clip') },
      ],
    },
    {
      label: 'Multitrack', items: () => [
        { label: 'Import audio or video…', icon: 'import', disabled: !canEdit, onClick: actions.importFiles },
        { label: 'Add track', icon: 'plus', disabled: !canEdit, onClick: actions.addTrack },
        { label: 'Add marker', icon: 'marker', shortcut: 'M', disabled: !canEdit, onClick: () => actions.addMarker() },
        { divider: true },
        { label: 'Loop playback', icon: 'loop', shortcut: 'L', checked: !!doc.loop?.on, disabled: !canEdit, onClick: toggleLoop },
        { label: 'Set loop to selection', disabled: !canEdit || !timeSel, onClick: loopToSelection },
        { label: 'Clear loop', disabled: !canEdit || !doc.loop, onClick: () => edit({ ...doc, loop: null }, 'Clear loop') },
        { divider: true },
        { label: engine.recording ? 'Stop recording' : 'Record', icon: 'record', shortcut: keyLabel('shift+space'), disabled: !canEdit, onClick: record },
      ],
    },
    { label: 'Effects', items: effectsMenu },
    {
      label: 'View', items: () => [
        { label: 'Multitrack', checked: multi, onClick: () => setView('multi') },
        { label: 'Waveform editor', checked: !multi, disabled: !wf, onClick: () => setView('wave') },
        { divider: true },
        { label: 'Zoom in', icon: 'zoomIn', shortcut: '=', onClick: () => tl.current.zoomIn?.() },
        { label: 'Zoom out', icon: 'zoomOut', shortcut: '-', onClick: () => tl.current.zoomOut?.() },
        { label: 'Zoom to session', icon: 'fit', shortcut: '\\', onClick: () => tl.current.fit?.() },
        { label: 'Zoom to selection', disabled: !timeSel, onClick: () => tl.current.zoomSel?.(timeSel.start, timeSel.end) },
        { divider: true },
        { label: 'Snapping', icon: 'magnet', shortcut: 'S', checked: snap, onClick: () => setSnap(!snap) },
        { label: 'Files panel', checked: binOpen, onClick: () => setBinOpen(!binOpen) },
      ],
    },
  ];
  const editItems = [
    { label: 'Cut clips', shortcut: keyLabel('mod+x'), disabled: !canEdit || !sel.size || !multi, onClick: () => { actions.copy([...sel]); actions.del([...sel]); } },
    { label: 'Copy clips', icon: 'copy', shortcut: keyLabel('mod+c'), disabled: !sel.size || !multi, onClick: () => actions.copy([...sel]) },
    { label: 'Paste at playhead', shortcut: keyLabel('mod+v'), disabled: !canEdit || !clipboard || !multi, onClick: () => actions.paste() },
    { label: 'Select all clips', shortcut: keyLabel('mod+a'), onClick: () => setSel(new Set(allClips(doc).map((x) => x.clip.id))) },
  ];

  const tools = multi ? (
    <>
      <Tool icon="select" label="Move" shortcut="v" active={tool === 'move'} onClick={() => setTool('move')} />
      <Tool icon="text" label="Time Selection" shortcut="t" active={tool === 'time'} onClick={() => setTool('time')} />
      <Tool icon="razor" label="Razor" shortcut="r" active={tool === 'razor'} onClick={() => setTool('razor')} />
      <ToolDivider />
      <Tool icon="magnet" label="Snapping" shortcut="s" active={snap} onClick={() => setSnap(!snap)} />
    </>
  ) : null;

  const options = (
    <>
      <Segmented value={view} onChange={(v) => (v === 'wave' && !wf ? toast('Double-click a clip to open its file in the Waveform editor.') : setView(v))}
        options={[{ value: 'wave', label: 'Waveform', icon: 'wave' }, { value: 'multi', label: 'Multitrack', icon: 'audio' }]} />
      <span className="w-px h-5 bg-line" />
      <Button size="sm" variant="ghost" icon="import" disabled={!canEdit} onClick={actions.importFiles}>Import</Button>
      <Button size="sm" variant="ghost" icon="plus" disabled={!canEdit} onClick={actions.addTrack}>Track</Button>
      <span className="flex-1" />
      <span className="text-[11px] text-fg3 whitespace-nowrap">{doc.sampleRate / 1000} kHz · {doc.tracks.length} tracks</span>
    </>
  );

  return (
    <EditorShell app="audio" project={project} history={h} getData={getData} menus={menus} editItems={editItems}
      exportConfig={exp} tools={tools} options={options} panelWidth={300}
      panels={multi ? <Panels doc={doc} edit={edit} commit={commit} canEdit={canEdit} engine={engine} selTrack={selTrack} sel={sel} tab={tab} setTab={setTab} actions={actions} /> : null}
      bottom={multi ? <Transport engine={engine} doc={doc} timeSel={timeSel} onPlay={togglePlay} onRecord={record} onLoop={toggleLoop} canEdit={canEdit} tl={tl} armed={armed} /> : null}
      status={<Status doc={doc} sel={sel} engine={engine} armed={armed} />}
      commentAnchor={() => ({ t: engine.position })} anchorLabel={(a) => fmtClock(a.t, false)} onJumpToComment={(a) => { setView('multi'); engine.seek(a.t); }}>
      {multi || !wf ? (
        <div className="h-full flex">
          {binOpen && <MediaBin doc={doc} engine={engine} canEdit={canEdit} actions={actions} onClose={() => setBinOpen(false)} edit={edit} />}
          <div className="flex-1 min-w-0">
            <Timeline engine={engine} doc={doc} edit={edit} commit={commit} canEdit={canEdit} sel={sel} setSel={(s) => { setSel(s); if (s.size) setTab('clip'); }}
              selTrack={selTrack} setSelTrack={setSelTrack} timeSel={timeSel} setTimeSel={setTimeSel} tool={tool} snap={snap} pps={pps} setPps={setPps}
              armed={armed} toggleArm={toggleArm} actions={actions} apiRef={tl} playing={engine.playing} recording={engine.recording} files={doc.files} />
          </div>
        </div>
      ) : (
        <WaveEditor engine={engine} file={fileById(doc, wf.clip.asset) || { id: wf.clip.asset, name: wf.clip.name }} clip={wf.clip} docId={id} canEdit={canEdit}
          onClose={() => setView('multi')}
          onApply={(asset, oldDuration) => {
            const file = fileOf(asset);
            edit(repointClip(addFiles(docRef.current, [file]), wf.clip.id, file, { oldDuration }), 'Edit file (Waveform)');
          }} />
      )}
    </EditorShell>
  );
}

// ---------------------------------------------------------------- transport bar

function Transport({ engine, doc, timeSel, onPlay, onRecord, onLoop, canEdit, tl, armed }) {
  const clock = useRef(null);
  useFrame(() => { if (clock.current) clock.current.textContent = fmtClock(engine.position); }, [engine]);
  const getL = useCallback((lv) => lv.master[0], []); const getR = useCallback((lv) => lv.master[1], []);
  const btn = 'w-9 h-9 rounded-md grid place-items-center transition';
  return (
    <div className="h-14 flex items-center gap-1 px-3">
      <IconButton icon="skipBack" label="Go to start" shortcut="Home" onClick={() => engine.seek(0)} size={34} />
      <button type="button" aria-label={engine.playing ? 'Stop' : 'Play'} title={`${engine.playing ? 'Stop' : 'Play'} (Space)`} onClick={onPlay} data-testid="play"
        className={cx(btn, engine.playing ? 'bg-accent text-[#06121f]' : 'bg-chip hover:bg-chip-hover text-fg')}><Icon name={engine.playing ? 'stop' : 'play'} size={18} /></button>
      <button type="button" aria-label="Record" title={`${engine.recording ? 'Stop recording' : 'Record onto armed tracks'} (${keyLabel('shift+space')})`} onClick={onRecord} disabled={!canEdit} data-testid="record"
        className={cx(btn, engine.recording ? 'bg-[#ff4d5e] text-white animate-pulse' : 'bg-chip hover:bg-chip-hover text-[#ff4d5e]', 'disabled:opacity-40')}><Icon name="record" size={18} fill="currentColor" /></button>
      <IconButton icon="loop" label="Loop playback" shortcut="L" active={!!doc.loop?.on} onClick={onLoop} size={34} disabled={!canEdit} />
      <IconButton icon="skipForward" label="Go to end" shortcut="End" onClick={() => engine.seek(sessionEnd(doc))} size={34} />
      <div className="ml-3 px-3 h-10 rounded-md bg-black/40 border border-line flex items-center">
        <span ref={clock} className="font-mono text-[22px] tabular-nums text-accent tracking-tight" data-testid="clock">0:00.000</span>
      </div>
      <div className="ml-3 grid grid-cols-[auto_auto] gap-x-2 text-[11px] text-fg2 tabular-nums">
        <span>Selection</span><span className="font-mono text-fg">{timeSel ? `${fmtClock(timeSel.start)} – ${fmtClock(timeSel.end)}` : '—'}</span>
        <span>Loop</span><span className="font-mono text-fg">{doc.loop ? `${fmtClock(doc.loop.start)} – ${fmtClock(doc.loop.end)}${doc.loop.on ? '' : ' (off)'}` : '—'}</span>
      </div>
      {armed.size > 0 && <span className="ml-3 text-[11px] text-[#ff7b88] flex items-center gap-1"><Icon name="mic" size={14} />Input monitoring</span>}
      <span className="flex-1" />
      <IconButton icon="zoomOut" label="Zoom out" shortcut="-" onClick={() => tl.current.zoomOut?.()} size={30} />
      <IconButton icon="zoomIn" label="Zoom in" shortcut="=" onClick={() => tl.current.zoomIn?.()} size={30} />
      <IconButton icon="fit" label="Zoom to session" shortcut="\" onClick={() => tl.current.fit?.()} size={30} />
      <div className="ml-3 w-56 flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[9px] text-fg3"><span className="w-2">L</span><Meter engine={engine} get={getL} className="flex-1 h-2" /></div>
        <div className="flex items-center gap-1.5 text-[9px] text-fg3"><span className="w-2">R</span><Meter engine={engine} get={getR} className="flex-1 h-2" /></div>
        <div className="flex justify-between text-[8.5px] text-fg3 pl-3.5"><span>-60</span><span>-40</span><span>-20</span><span>-10</span><span>0</span></div>
      </div>
    </div>
  );
}

function Status({ doc, sel, engine, armed }) {
  const clips = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <>
      <span>{doc.sampleRate / 1000} kHz</span>
      <span>{doc.tracks.length} tracks · {clips} clips</span>
      <span>Length {fmtClock(sessionEnd(doc), false)}</span>
      {sel.size > 0 && <span>{sel.size} selected</span>}
      {engine.recording && <span className="text-[#ff7b88]">● Recording</span>}
      {!engine.recording && armed.size > 0 && <span>{armed.size} armed</span>}
      <span className="flex-1" />
      <span className="text-fg3">Space play · Shift+Space record · Ctrl+K split · M marker · drag empty space to select time</span>
    </>
  );
}

// ---------------------------------------------------------------- media bin

function MediaBin({ doc, engine, canEdit, actions, onClose, edit }) {
  const used = new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.asset)));
  return (
    <aside className="w-56 shrink-0 border-r border-line bg-panel flex flex-col" data-testid="media-bin">
      <div className="h-8 flex items-center gap-1 px-2 border-b border-line">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-fg2">Files</span>
        {canEdit && <IconButton icon="import" label="Import audio or video" size={24} onClick={actions.importFiles} />}
        <IconButton icon="close" label="Hide" size={24} onClick={onClose} />
      </div>
      <div className="flex-1 overflow-auto scroll-thin py-1">
        {!doc.files.length && <p className="p-3 text-xs text-fg3">Import audio or video files; they appear here. Drag them onto a track.</p>}
        {doc.files.map((f) => (
          <div key={f.id} draggable={canEdit} data-file={f.name}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-sl-asset', JSON.stringify(f)); e.dataTransfer.effectAllowed = 'copy'; }}
            onDoubleClick={() => canEdit && actions.insertFile(f)}
            onContextMenu={(e) => { e.preventDefault(); }}
            className="group flex items-center gap-2 px-2 h-9 hover:bg-hover cursor-grab" title={`${f.name} — drag onto a track, or double-click to insert at the playhead`}>
            <Icon name={f.kind === 'video' ? 'video' : 'audio'} size={15} className={used.has(f.id) ? 'text-accent' : 'text-fg3'} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] truncate">{f.name}</div>
              <div className="text-[10px] text-fg3">{fmtDur(f.duration) || '—'}{used.has(f.id) ? '' : ' · unused'}</div>
            </div>
            {canEdit && !used.has(f.id) && <IconButton icon="close" label="Remove from Files panel" size={20} className="opacity-0 group-hover:opacity-100"
              onClick={() => edit({ ...doc, files: doc.files.filter((x) => x.id !== f.id) }, 'Remove file')} />}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- thumbnail

function thumbnail(doc, engine) {
  const W = 640; const H = 360; const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#0f1417'; g.fillRect(0, 0, W, H);
  const end = Math.max(1, sessionEnd(doc)); const tracks = doc.tracks.filter((t) => t.clips.length);
  const lane = H / Math.max(1, tracks.length);
  tracks.forEach((t, i) => {
    for (const cl of t.clips) {
      const x = (cl.start / end) * W; const w = Math.max(2, (cl.dur / end) * W); const y = i * lane;
      g.fillStyle = `${t.color}33`; g.fillRect(x, y + 3, w, lane - 6);
      engine.drawWave(g, cl.asset, cl.in, cl.in + cl.dur, x, y + 6, w, lane - 12, { color: t.color });
    }
  });
  if (!tracks.length) { g.fillStyle = '#00e4bb'; g.font = '600 28px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('Sora Audio', W / 2, H / 2); }
  return c;
}

export { sortClips };
