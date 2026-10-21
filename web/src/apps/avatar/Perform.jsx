// Perform mode, shared by every kind of avatar: the webcam drives the model live. Camera face tracking (MediaPipe),
// mic lip-sync, a mouse/keyboard puppet when there's no camera, calibration ("Set neutral"), per-value tuning,
// expression hotkeys, a background (colour, chroma green or transparent), PNG snapshots and WebM recording, and the
// output link for OBS (a Browser Source page that receives the pose through the server relay) or a pop-out window.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Select, Slider, Toggle, Segmented, ColorSwatch, NumberInput, PanelSection, TextInput, Checkbox, toast, toastError, confirmDialog, cx } from '../../components/ui.jsx';
import { api, download, saveBlob } from '../../lib/api.js';
import { useSize } from '../../components/ui.jsx';
import { POSE_KEYS } from './contract.js';
import { Tracker, withTrackingDefaults, KEY_INFO, packPose } from './tracking/index.js';
import { createStage } from './stage.js';
import { relaySender } from './relay.js';
import { HotkeyInput } from './two/Panels2D.jsx';

export const defaultPerform = () => ({ bg: { mode: 'color', color: '#1d1f26' }, framing: { zoom: 1, x: 0, y: 0 }, hotkeys: {}, output: { width: 1920, height: 1080 } });
export const withPerformDefaults = (p) => { const d = defaultPerform(); return { ...d, ...p, bg: { ...d.bg, ...p?.bg }, framing: { ...d.framing, ...p?.framing }, output: { ...d.output, ...p?.output }, hotkeys: { ...p?.hotkeys } }; };
export const bgCss = (bg) => (bg.mode === 'transparent' ? null : bg.mode === 'green' ? '#00ff00' : bg.color || '#1d1f26');
export const outputUrl = (id, key, extra = {}) => `${location.origin}/avatar/${id}/output?${new URLSearchParams({ key, ...extra })}`;

export default function Perform({ project, h, doc, canEdit, ui }) {
  const id = project.doc.id;
  const tracking = useMemo(() => withTrackingDefaults(doc.tracking), [doc.tracking]);
  const perform = useMemo(() => withPerformDefaults(doc.perform), [doc.perform]);
  const edit = (fn, label, merge) => { if (canEdit) h.set((d) => fn(d), label, merge ? { merge } : undefined); };
  const setTracking = (patch, label = 'Tracking settings', merge) => edit((d) => ({ ...d, tracking: { ...withTrackingDefaults(d.tracking), ...patch } }), label, merge);
  const setKey = (k, patch) => edit((d) => { const t = withTrackingDefaults(d.tracking); return { ...d, tracking: { ...t, keys: { ...t.keys, [k]: { ...t.keys[k], ...patch } } } }; }, 'Tracking settings', `tk-${k}`);
  const setPerform = (patch, label = 'Perform settings', merge) => edit((d) => ({ ...d, perform: { ...withPerformDefaults(d.perform), ...patch } }), label, merge);

  const box = useRef(null); const canvas = useRef(null); const preview = useRef(null);
  const size = useSize(box);
  const stage = useRef(null); const tracker = useRef(null); const relay = useRef(null);
  const [stageErr, setStageErr] = useState(null);
  const [status, setStatus] = useState({ camera: 'off' });
  const [readout, setReadout] = useState({});
  const [key, setKey_] = useState(null);
  const [watchers, setWatchers] = useState(0);
  const [exprOn, setExprOn] = useState({});
  const [recording, setRecording] = useState(null);
  const [devices, setDevices] = useState({ video: [], audio: [] });
  const [cam, setCam] = useState(''); const [micDev, setMicDev] = useState('');
  const [showCam, setShowCam] = useState(true);
  const [exprList, setExprList] = useState([]);
  const lastPose = useRef({});

  // ---------------------------------------------------------------- the stage (re-made when the model changes)
  // a Live2D stage is re-made when its model changes; the 2D and 3D stages take document updates in place (setDoc)
  const kindDocKey = doc.kind === 'live2d' ? JSON.stringify(doc.model || null) : doc.kind;
  useEffect(() => {
    let off = false; let made = null;
    setStageErr(null);
    createStage(doc, canvas.current, { assetUrl: (a) => `/api/assets/${a}/file`, coreUrl: '/api/avatar/cubism-core.js' })
      .then((s) => { if (off) { s.dispose(); return; } made = s; stage.current = s; window.__avatarStage = s; s.setBackground(bgCss(perform.bg)); s.setFraming?.(perform.framing); fit(); setExprList(s.expressions?.() || []); })
      .catch((e) => { if (!off) setStageErr(e); });
    return () => { off = true; made?.dispose(); if (stage.current === made) stage.current = null; };
  }, [kindDocKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (doc.kind !== 'live2d') { stage.current?.setDoc?.(doc); setExprList(stage.current?.expressions?.() || []); } }, [doc]);
  useEffect(() => { stage.current?.setBackground(bgCss(perform.bg)); stage.current?.setFraming?.(perform.framing); }, [perform.bg, perform.framing]);
  const fit = () => { const s = stage.current; if (!s || !box.current) return; const r = box.current.getBoundingClientRect(); s.resize(Math.round(r.width * devicePixelRatio), Math.round(r.height * devicePixelRatio)); };
  useEffect(fit, [size.width, size.height]);

  // ---------------------------------------------------------------- tracking
  useEffect(() => {
    const t = new Tracker({
      onPose: (pose) => {
        lastPose.current = pose;
        stage.current?.setPose(pose);
        // ~30 poses a second to the OBS output
        const now = performance.now();
        if (relay.current && now - (relay.current.at || 0) > 32) { relay.current.at = now; relay.current.send({ t: 'pose', p: packPose(pose) }); }
      },
      onStatus: setStatus,
    });
    tracker.current = t;
    window.__avatarTracker = t; // handy for tests and debugging
    const iv = setInterval(() => setReadout({ ...lastPose.current }), 120);
    navigator.mediaDevices?.enumerateDevices?.().then((list) => setDevices({ video: list.filter((d) => d.kind === 'videoinput'), audio: list.filter((d) => d.kind === 'audioinput') })).catch(() => {});
    return () => { clearInterval(iv); t.dispose(); tracker.current = null; };
  }, []);
  useEffect(() => { if (tracker.current) { tracker.current.settings = tracking; tracker.current.syncHands?.(); } }, [tracking]);
  // camera preview with the face landmarks on top
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = preview.current; const t = tracker.current; const v = t?.video;
      if (!c || !v || !v.videoWidth || !showCam) return;
      const ctx = c.getContext('2d');
      c.width = 200; c.height = Math.round((200 * v.videoHeight) / v.videoWidth);
      ctx.save(); if (tracking.mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const lm = t.landmarks;
      if (lm) { ctx.fillStyle = 'rgba(90,180,255,.95)'; for (let i = 0; i < lm.length; i += 3 * 2) ctx.fillRect(lm[i] * c.width - 1, lm[i + 1] * c.height - 1, 2, 2); }
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [showCam, tracking.mirror]);

  const startCam = async () => { if (await tracker.current.startCamera(cam || undefined)) navigator.mediaDevices.enumerateDevices().then((list) => setDevices({ video: list.filter((d) => d.kind === 'videoinput'), audio: list.filter((d) => d.kind === 'audioinput') })); };
  const toggleMic = async () => { if (status.mic) tracker.current.stopMic(); else if (!(await tracker.current.startMic(micDev || undefined))) toast('Couldn’t open the microphone (the browser needs HTTPS or localhost, and permission).', { type: 'error' }); else setTracking({ mic: { ...tracking.mic, on: true } }); };
  const setNeutral = () => {
    const n = tracker.current?.neutral();
    if (!n) { toast('Start the camera and look at the screen normally first.'); return; }
    setTracking({ neutral: n }, 'Set neutral'); toast('Neutral set: this is your resting pose now.', { type: 'success' });
  };

  // ---------------------------------------------------------------- expression hotkeys
  useEffect(() => {
    const hk = perform.hotkeys;
    const match = (e) => { const k = `${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.key.toLowerCase()}`; return Object.entries(hk).find(([, v]) => v.key && v.key === k); };
    const down = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
      const m = match(e); if (!m || e.repeat) return;
      const [xid, v] = m; const t = tracker.current; e.preventDefault();
      if (v.mode === 'hold') t.expr[xid] = 1; else if (t.expr[xid]) delete t.expr[xid]; else t.expr[xid] = 1;
      setExprOn({ ...t.expr });
    };
    const up = (e) => { const m = match(e); if (!m) return; const [xid, v] = m; if (v.mode === 'hold') { delete tracker.current.expr[xid]; setExprOn({ ...tracker.current.expr }); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [perform.hotkeys]);
  const toggleExpr = (xid) => { const t = tracker.current; if (t.expr[xid]) delete t.expr[xid]; else t.expr[xid] = 1; setExprOn({ ...t.expr }); };

  // ---------------------------------------------------------------- OBS output
  useEffect(() => {
    if (!canEdit) return undefined;
    let off = false;
    api.get(`/api/avatar/${id}/output-key`).then((r) => { if (!off) setKey_(r.key); }).catch(() => {});
    return () => { off = true; };
  }, [id, canEdit]);
  useEffect(() => {
    if (!key) return undefined;
    const r = relaySender(id, key, { onWatchers: setWatchers });
    relay.current = r;
    return () => { r.close(); relay.current = null; };
  }, [id, key]);
  const resetKey = async () => {
    if (!(await confirmDialog({ title: 'Make a new output link?', message: 'The old link stops working: OBS scenes using it need the new one.', confirm: 'New link' }))) return;
    const r = await api.post(`/api/avatar/${id}/output-key/reset`).catch(toastError); if (r) { setKey_(r.key); toast('New link made. Paste it into OBS.', { type: 'success' }); }
  };
  const link = key ? outputUrl(id, key) : '';
  const popout = () => {
    if (!key) return;
    const { width, height } = perform.output;
    const w = window.open(outputUrl(id, key, { bg: bgCss(perform.bg.mode === 'transparent' ? { mode: 'green' } : perform.bg) || '#00ff00' }), `avatar-${id}`, `popup,width=${Math.round(width / 2)},height=${Math.round(height / 2)}`);
    if (!w) toast('The browser blocked the pop-up. Allow pop-ups for this site.', { type: 'error' });
  };

  // ---------------------------------------------------------------- snapshot and recording
  const snap = async () => {
    const b = await stage.current?.snapshot().catch(toastError); if (!b) return;
    download(b, `${project.doc.name}.png`);
    saveBlob(b, `${project.doc.name}.png`, { docId: id }).catch(() => {});
  };
  const record = () => {
    if (recording) { recording.stop(); return; }
    const c = canvas.current; const stream = c.captureStream(30);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      setRecording(null);
      const blob = new Blob(chunks, { type: 'video/webm' });
      const name = `${project.doc.name} performance.webm`;
      download(blob, name);
      saveBlob(blob, name, { docId: id }).then(() => toast('Recording saved to Files → Exports too.', { type: 'success' })).catch(() => {});
    };
    rec.start(500); setRecording(rec);
    toast(perform.bg.mode === 'transparent' ? 'Recording with a transparent background (WebM with alpha).' : 'Recording…');
  };

  // ---------------------------------------------------------------- slots
  // (3D projects keep the thumbnail their editor saves)
  useEffect(() => { ui.set({ menus: [], fileItems: [], exportConfig: null, thumb: doc.kind === '3d' ? null : async () => stage.current?.snapshot() }); });
  const camOn = status.camera !== 'off' && status.camera !== 'error';
  const bgMode = perform.bg.mode;
  const options = (
    <>
      <Button size="sm" variant={camOn ? 'primary' : 'secondary'} icon="camera" onClick={() => (camOn ? tracker.current.stopCamera() : startCam())} data-testid="av-cam">{camOn ? 'Camera on' : 'Start camera'}</Button>
      <Button size="sm" variant={status.mic ? 'primary' : 'secondary'} icon="mic" onClick={toggleMic}>{status.mic ? 'Mic on' : 'Mic lip-sync'}</Button>
      <Button size="sm" variant={status.puppet ? 'primary' : 'secondary'} icon="hand" onClick={() => tracker.current.setPuppet(!status.puppet)} title="No camera? The mouse moves the head and eyes; hold the mouse button on the stage to talk; B blinks.">Puppet</Button>
      <Button size="sm" icon="adjust" onClick={setNeutral} disabled={!canEdit} data-testid="av-neutral">Set neutral</Button>
      <span className="w-px h-5 bg-line mx-1" />
      <Segmented value={bgMode} onChange={(v) => setPerform({ bg: { ...perform.bg, mode: v } }, 'Background')} options={[{ value: 'color', label: 'Colour' }, { value: 'green', label: 'Green' }, { value: 'transparent', label: 'Transparent' }]} />
      {bgMode === 'color' && <ColorSwatch value={perform.bg.color} onChange={(c) => setPerform({ bg: { ...perform.bg, color: c } }, 'Background', 'bgc')} size={22} alpha={false} />}
      <span className="w-px h-5 bg-line mx-1" />
      <IconButton icon="camera" label="Snapshot (PNG)" size={28} onClick={snap} />
      <Button size="sm" variant={recording ? 'danger' : 'secondary'} icon="record" onClick={record}>{recording ? 'Stop recording' : 'Record'}</Button>
      <span className={cx('ml-auto text-[11px] whitespace-nowrap', status.camera === 'tracking' ? 'text-ok' : status.camera === 'error' ? 'text-danger' : 'text-fg3')}>
        {status.camera === 'tracking' ? `Tracking · ${status.fps || 0} fps${status.delegate ? ` · ${status.delegate}` : ''}` : status.message || (status.puppet ? 'Puppet mode' : 'Camera off')}
      </span>
    </>
  );
  const t = tracking;
  const panels = (
    <div>
      <PanelSection title="Output for OBS" id="avp-obs">
        {!canEdit ? <p className="text-xs text-fg3">Only editors of this project can stream it.</p> : (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-fg3">In OBS add a <b>Browser Source</b> with this link (width {perform.output.width}, height {perform.output.height}). It has a transparent background and follows this page live. Anyone with the link can watch, so keep it private.</p>
            <div className="flex gap-1"><TextInput readOnly value={link} className="!h-7 text-[11px] font-mono" onFocus={(e) => e.target.select()} data-testid="av-link" />
              <IconButton icon="copy" label="Copy link" size={28} onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied'))} /></div>
            <div className="flex items-center gap-2 text-[12px]">
              <span className={cx('w-2 h-2 rounded-full', watchers ? 'bg-ok' : 'bg-fg3')} />
              <span className="flex-1" data-testid="av-watchers">{watchers ? `${watchers} output${watchers > 1 ? 's' : ''} connected` : 'No output connected'}</span>
              {project.doc.role === 'owner' && <Button size="sm" variant="ghost" icon="refresh" onClick={resetKey}>New link</Button>}
            </div>
            <div className="flex items-center gap-1.5">
              <NumberInput label="Size" value={perform.output.width} width={56} min={64} max={7680} onChange={(v) => setPerform({ output: { ...perform.output, width: v } }, 'Output size', 'ow')} />
              <span className="text-fg3">×</span>
              <NumberInput value={perform.output.height} width={56} min={64} max={4320} onChange={(v) => setPerform({ output: { ...perform.output, height: v } }, 'Output size', 'oh')} />
            </div>
            <Button size="sm" icon="external" onClick={popout}>Pop-out window</Button>
            <p className="text-[11px] text-fg3">The pop-out is for OBS “Window Capture” (no transparency there, so it uses your colour or green for chroma key).</p>
          </div>
        )}
      </PanelSection>
      <PanelSection title="Framing" id="avp-frame">
        <Slider label="Zoom" value={Math.round(perform.framing.zoom * 100)} min={20} max={400} unit="%" onChange={(v) => setPerform({ framing: { ...perform.framing, zoom: v / 100 } }, 'Framing', 'fz')} />
        <Slider label="Left / right" value={Math.round(perform.framing.x * 100)} min={-100} max={100} onChange={(v) => setPerform({ framing: { ...perform.framing, x: v / 100 } }, 'Framing', 'fx')} />
        <Slider label="Up / down" value={Math.round(perform.framing.y * 100)} min={-100} max={100} onChange={(v) => setPerform({ framing: { ...perform.framing, y: v / 100 } }, 'Framing', 'fy')} />
      </PanelSection>
      <PanelSection title="Sources" id="avp-src">
        <div className="flex flex-col gap-1.5">
          <Select small value={cam} onChange={setCam} options={[{ value: '', label: 'Default camera' }, ...devices.video.filter((d) => d.deviceId).map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` }))]} />
          <Select small value={micDev} onChange={setMicDev} options={[{ value: '', label: 'Default microphone' }, ...devices.audio.filter((d) => d.deviceId).map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]} />
          <Toggle label="Show camera preview" checked={showCam} onChange={setShowCam} />
          <Toggle label="Track hands too" checked={t.hands} onChange={(v) => setTracking({ hands: v })} />
          <div className="text-[11px] text-fg3">Mic level <span className="inline-block align-middle w-24 h-1.5 bg-chip rounded overflow-hidden"><span className="block h-full bg-ok" style={{ width: `${Math.min(100, (tracker.current?.mic.level || 0) * 600)}%` }} /></span></div>
          <Slider label="Mic sensitivity" value={Math.round(t.mic.gain * 100)} min={10} max={400} unit="%" onChange={(v) => setTracking({ mic: { ...t.mic, gain: v / 100 } }, 'Mic', 'mg')} />
          <Slider label="Mic noise gate" value={Math.round(t.mic.threshold * 1000)} min={0} max={200} onChange={(v) => setTracking({ mic: { ...t.mic, threshold: v / 1000 } }, 'Mic', 'mt')} />
          <Checkbox label="Vowel shapes (A I U E O) from the mic" checked={t.mic.visemes} onChange={(v) => setTracking({ mic: { ...t.mic, visemes: v } })} />
        </div>
      </PanelSection>
      <PanelSection title="Expressions" id="avp-expr">
        {!exprList.length && <p className="text-[11px] text-fg3">This model has no expressions{doc.kind === '2d' ? ' yet — make some in Edit → Face' : ''}.</p>}
        {exprList.map((x) => (
          <div key={x.id} className="flex items-center gap-1.5 h-8">
            <Toggle checked={!!exprOn[x.id]} onChange={() => toggleExpr(x.id)} />
            <span className="flex-1 truncate text-[13px]">{x.name}</span>
            <HotkeyInput value={perform.hotkeys[x.id]?.key || ''} disabled={!canEdit} onChange={(k) => setPerform({ hotkeys: { ...perform.hotkeys, [x.id]: { mode: 'toggle', ...perform.hotkeys[x.id], key: k } } }, 'Expression hotkey')} />
            <Select small value={perform.hotkeys[x.id]?.mode || 'toggle'} onChange={(v) => setPerform({ hotkeys: { ...perform.hotkeys, [x.id]: { key: '', ...perform.hotkeys[x.id], mode: v } } }, 'Expression hotkey')} options={[{ value: 'toggle', label: 'Toggle' }, { value: 'hold', label: 'Hold' }]} />
          </div>
        ))}
      </PanelSection>
      <PanelSection title="Tracking" id="avp-track">
        <div className="flex flex-col gap-1.5">
          <Toggle label="Mirror (move like your reflection)" checked={t.mirror} onChange={(v) => setTracking({ mirror: v })} />
          <Slider label="Smoothing" value={Math.round((3 - Math.min(3, t.smoothing.minCutoff)) * 33)} min={0} max={100} onChange={(v) => setTracking({ smoothing: { ...t.smoothing, minCutoff: Math.max(0.05, 3 - v / 33) } }, 'Smoothing', 'sm')} />
          <Slider label="Responsiveness" value={Math.round(t.smoothing.beta * 100)} min={0} max={200} onChange={(v) => setTracking({ smoothing: { ...t.smoothing, beta: v / 100 } }, 'Smoothing', 'sb')} />
          <Slider label="Body follows head" value={Math.round(t.bodyFollow * 100)} min={0} max={100} unit="%" onChange={(v) => setTracking({ bodyFollow: v / 100 }, 'Body follow', 'bf')} />
          <Slider label="Breaths per minute" value={t.breathRate} min={0} max={30} onChange={(v) => setTracking({ breathRate: v }, 'Breathing', 'br')} />
          <Toggle label="Blink now and then (puppet)" checked={t.autoBlink} onChange={(v) => setTracking({ autoBlink: v })} />
          {Object.keys(t.neutral || {}).length > 0 && <Button size="sm" variant="ghost" onClick={() => setTracking({ neutral: {} }, 'Clear neutral')}>Clear neutral</Button>}
        </div>
      </PanelSection>
      <PanelSection title="Fine-tune each value" id="avp-keys" defaultOpen={false}>
        <p className="text-[11px] text-fg3 mb-2">Sensitivity multiplies the movement; the dead zone ignores small movements around neutral; min/max clip the range; invert flips the direction; smooth steadies jittery values.</p>
        {POSE_KEYS.filter((k) => k !== 'breath').map((k) => {
          const ks = t.keys[k]; const v = readout[k];
          return (
            <div key={k} className="py-1 border-b border-line/60">
              <div className="flex items-center gap-1.5 text-[12px]">
                <span className="flex-1 truncate">{KEY_INFO[k].label}</span>
                <span className="text-[10px] tabular-nums text-fg3 w-10 text-right">{Number.isFinite(v) ? v.toFixed(KEY_INFO[k].kind === 'angle' ? 0 : 2) : '–'}</span>
                <Checkbox label="Invert" checked={ks.invert} onChange={(x) => setKey(k, { invert: x })} />
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <NumberInput label="×" title="Sensitivity" value={ks.sens} step={0.05} min={0} max={5} width={40} onChange={(x) => setKey(k, { sens: x })} />
                <NumberInput label="dz" title="Dead zone" value={ks.dead} step={KEY_INFO[k].kind === 'angle' ? 0.5 : 0.01} min={0} max={20} width={38} onChange={(x) => setKey(k, { dead: x })} />
                <NumberInput label="min" value={ks.min} step={KEY_INFO[k].kind === 'angle' ? 1 : 0.05} width={38} onChange={(x) => setKey(k, { min: x })} />
                <NumberInput label="max" value={ks.max} step={KEY_INFO[k].kind === 'angle' ? 1 : 0.05} width={38} onChange={(x) => setKey(k, { max: x })} />
                <NumberInput label="sm" title="Smoothing (1 = normal, higher = steadier)" value={ks.smooth} step={0.1} min={0.1} max={5} width={34} onChange={(x) => setKey(k, { smooth: x })} />
              </div>
            </div>
          );
        })}
      </PanelSection>
    </div>
  );

  return (
    <>
      {ui.portal('options', options)}
      {ui.portal('panels', panels)}
      {ui.portal('status', <><span>Perform</span><span>{status.camera === 'tracking' ? 'Face tracked' : status.puppet ? 'Puppet' : 'Idle'}</span>{status.mic && <span>Mic lip-sync</span>}{watchers > 0 && <span className="text-ok">OBS output live</span>}</>)}
      <div ref={box} className="absolute inset-0" data-puppet-area="1"
        style={bgMode === 'transparent' ? { background: 'repeating-conic-gradient(#2a2b31 0% 25%, #1f2026 0% 50%) 50% / 24px 24px' } : undefined}>
        <canvas ref={canvas} className="absolute inset-0 w-full h-full" data-testid="av-stage" />
        {stageErr && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-md bg-panel/95 border border-line rounded-xl p-5">
              <div className="font-head font-semibold mb-1">{stageErr.code === 'no3d' ? '3D is coming' : 'Can’t show this avatar yet'}</div>
              <p className="text-sm text-fg2">{stageErr.message}</p>
            </div>
          </div>
        )}
        {showCam && camOn && <canvas ref={preview} className="absolute left-3 bottom-3 rounded-lg border border-line shadow-lg w-[200px]" />}
        {recording && <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[12px] bg-black/60 text-white rounded-full px-2.5 py-1"><span className="w-2 h-2 rounded-full bg-danger animate-pulse" />Recording</div>}
      </div>
    </>
  );
}
