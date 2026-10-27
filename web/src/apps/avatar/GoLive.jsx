// "Go live on Tsunami" (Perform → panel): streams the avatar straight from the browser, no OBS needed.
// The stage canvas is drawn onto a background (a colour or a picture: video has no transparency) at the chosen size,
// captured with captureStream, mixed with the mic and optional tab/desktop audio through Web Audio, recorded with
// MediaRecorder in 250 ms chunks and sent over a WebSocket to the SoraLab server (server/src/api/golive.js), which
// encodes it and pushes it to Tsunami's live ingest. The server reports back: connecting, live, health, why it ended.
import { useEffect, useRef, useState } from 'react';
import { Button, Select, Segmented, ColorSwatch, TextInput, Toggle, PanelSection, toast, cx } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { pickAssets } from '../../components/Pickers.jsx';
import { assetSrc, loadImage } from '../../lib/doc.js';

const QUALITY = { '720p': { width: 1280, height: 720, kbps: 3000 }, '1080p': { width: 1920, height: 1080, kbps: 6000 } };
const FPS = 30;
const wsUrl = (doc) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/avatar/golive?${new URLSearchParams({ doc })}`;
// H.264 is sent as it is (less work for the server); otherwise VP8/VP9, which the server re-encodes.
const pickMime = () => ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
  .find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
const fmtClock = (s) => { const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = Math.floor(s % 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
const HEALTH = { starting: ['Starting…', 'bg-fg3'], good: ['Good', 'bg-ok'], poor: ['Unsteady', 'bg-warn'], bad: ['Poor', 'bg-danger'] };

// Choices are remembered per project in this browser (a convenience; nothing breaks without storage).
const store = {
  get(id) { try { return JSON.parse(localStorage.getItem(`sl-golive-${id}`) || 'null'); } catch { return null; } },
  set(id, v) { try { localStorage.setItem(`sl-golive-${id}`, JSON.stringify(v)); } catch { /* private window */ } },
};

/**
 * props: docId, name (project name, the default title), stage (ref to the stage API), canvas (ref to the stage canvas),
 * onLive({ on, background }) — Perform hides the stage's own background while live so the avatar sits on this one.
 */
export default function GoLivePanel({ docId, name, stage, canvas, onLive }) {
  const [info, setInfo] = useState(null);       // GET /api/avatar/:id/golive
  const [opts, setOpts] = useState(() => ({ channel: '', title: name || 'Live', visibility: 'public', chat: true, quality: '720p',
    bg: { mode: 'color', color: '#1d1f26', asset: null }, mic: true, micDev: '', ...store.get(docId) }));
  const [state, setState] = useState('idle');   // idle | connecting | ready | live | stopping
  const [msg, setMsg] = useState('');
  const [stats, setStats] = useState(null);
  const [liveUrl, setLiveUrl] = useState(null);
  const [since, setSince] = useState(0); const [, tick] = useState(0);
  const [mics, setMics] = useState([]);
  const [desktop, setDesktop] = useState(null); // the tab/desktop capture stream
  const [ended, setEnded] = useState(null);     // { reason, error } of the last stream
  const [hidden, setHidden] = useState(document.hidden);
  const s = useRef({});                         // the running stream's pieces: ws, rec, audio graph, loop
  const preview = useRef(null);
  const bgImg = useRef(null);
  const set = (patch) => setOpts((o) => { const n = { ...o, ...patch }; store.set(docId, { ...n, title: undefined }); return n; });

  const refresh = () => api.get(`/api/avatar/${docId}/golive`).then((r) => {
    setInfo(r);
    if (r.channels?.length) setOpts((o) => (r.channels.some((c) => c.id === o.channel) ? o : { ...o, channel: r.channels[0].id }));
  }).catch((e) => setInfo({ enabled: true, error: e.message, channels: [] }));
  useEffect(() => {
    let off = false;
    api.get('/api/config').then((c) => { if (!off && c.tsunami) refresh(); else if (!off) setInfo({ enabled: false }); }).catch(() => {});
    navigator.mediaDevices?.enumerateDevices?.().then((l) => setMics(l.filter((d) => d.kind === 'audioinput' && d.deviceId))).catch(() => {});
    const vis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => { off = true; document.removeEventListener('visibilitychange', vis); teardown(); };
  }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the background picture, ready to draw
  useEffect(() => {
    bgImg.current = null;
    if (opts.bg.mode === 'image' && opts.bg.asset) loadImage(assetSrc(opts.bg.asset)).then((img) => { bgImg.current = img; }).catch(() => toast('Couldn’t load the background picture.', { type: 'error' }));
  }, [opts.bg.mode, opts.bg.asset]);
  const bgCss = opts.bg.mode === 'image' && opts.bg.asset ? `#000 url("${assetSrc(opts.bg.asset)}") center / cover no-repeat` : opts.bg.color;
  useEffect(() => { if (state !== 'idle') onLive?.({ on: true, background: bgCss }); }, [bgCss, state]); // eslint-disable-line react-hooks/exhaustive-deps

  // the clock and leaving the page while live
  useEffect(() => {
    if (state !== 'live') return undefined;
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(iv); window.removeEventListener('beforeunload', warn); };
  }, [state]);

  // ---------------------------------------------------------------- audio: mic + tab/desktop, mixed into one track
  const audio = () => {
    const x = s.current;
    if (!x.ctx) {
      x.ctx = new AudioContext({ sampleRate: 48000 }); x.dest = x.ctx.createMediaStreamDestination();
      // A silent source keeps the audio track running with the mic off; otherwise the recording never starts.
      const quiet = x.ctx.createConstantSource(); quiet.offset.value = 0; quiet.connect(x.dest); quiet.start();
    }
    return x;
  };
  async function openMic(deviceId) {
    const x = audio();
    x.mic?.src.disconnect(); x.mic?.stream.getTracks().forEach((t) => t.stop()); x.mic = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true } });
      const src = x.ctx.createMediaStreamSource(stream); src.connect(x.dest);
      x.mic = { stream, src };
      navigator.mediaDevices.enumerateDevices().then((l) => setMics(l.filter((d) => d.kind === 'audioinput' && d.deviceId))).catch(() => {});
      return true;
    } catch { toast('Couldn’t open the microphone (the browser needs HTTPS or localhost, and permission).', { type: 'error' }); return false; }
  }
  const closeMic = () => { const x = s.current; x.mic?.src.disconnect(); x.mic?.stream.getTracks().forEach((t) => t.stop()); x.mic = null; };
  async function addDesktop() {
    if (desktop) { stopDesktop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' }); } catch { return; }
    if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); toast('No sound was shared. Choose a tab (or the screen) and tick “Share audio”.', { type: 'error' }); return; }
    stream.getVideoTracks().forEach((t) => { t.enabled = false; }); // only the sound is used
    const x = audio();
    const src = x.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())); src.connect(x.dest);
    x.desk = { stream, src };
    stream.getAudioTracks()[0].onended = () => stopDesktop();
    setDesktop(stream);
  }
  function stopDesktop() { const x = s.current; x.desk?.src.disconnect(); x.desk?.stream.getTracks().forEach((t) => t.stop()); x.desk = null; setDesktop(null); }
  // mic on/off and the mic picker work while live too
  const toggleMic = async (on) => { set({ mic: on }); if (state === 'idle') return; if (on) await openMic(opts.micDev); else closeMic(); };
  const chooseMic = async (dev) => { set({ micDev: dev }); if (state !== 'idle' && opts.mic) await openMic(dev); };

  // ---------------------------------------------------------------- the picture: stage on the background
  function startLoop(out) {
    const x = s.current; const ctx = out.getContext('2d');
    let frames = 0; let t0 = performance.now();
    const draw = () => {
      x.raf = requestAnimationFrame(draw);
      const W = out.width; const H = out.height;
      const img = x.bgMode === 'image' ? bgImg.current : null;
      if (img) { const k = Math.max(W / img.width, H / img.height); ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k); }
      else { ctx.fillStyle = x.bgColor || '#1d1f26'; ctx.fillRect(0, 0, W, H); }
      // The stage draws earlier in the same animation frame, so its WebGL picture is still there to copy.
      const c = canvas.current;
      if (c?.width && c.height) { const k = Math.min(W / c.width, H / c.height); ctx.drawImage(c, (W - c.width * k) / 2, (H - c.height * k) / 2, c.width * k, c.height * k); }
      const p = preview.current;
      if (p) { const pc = p.getContext('2d'); if (p.width !== 240) { p.width = 240; p.height = Math.round((240 * H) / W); } pc.drawImage(out, 0, 0, p.width, p.height); }
      frames++;
      const now = performance.now();
      if (now - t0 > 2000) { x.ws?.readyState === 1 && x.ws.send(JSON.stringify({ t: 'client', fps: Math.round((frames * 1000) / (now - t0)) })); frames = 0; t0 = now; }
    };
    x.raf = requestAnimationFrame(draw);
  }
  useEffect(() => { s.current.bgColor = opts.bg.color; s.current.bgMode = opts.bg.mode; }, [opts.bg.color, opts.bg.mode]);

  // ---------------------------------------------------------------- start / stop
  async function start() {
    if (state !== 'idle') return;
    const mime = pickMime();
    if (!mime || !canvas.current?.captureStream) { toast('This browser can’t record video for streaming. Use a current Chrome, Edge or Firefox.', { type: 'error' }); return; }
    if (!opts.title.trim()) { toast('Give the stream a title.', { type: 'error' }); return; }
    setEnded(null); setStats(null); setLiveUrl(null); setState('connecting'); setMsg('Connecting…');
    const q = QUALITY[opts.quality] || QUALITY['720p'];
    const x = audio();
    if (x.ctx.state === 'suspended') await x.ctx.resume().catch(() => {});
    if (opts.mic && !x.mic) await openMic(opts.micDev);
    const out = document.createElement('canvas'); out.width = q.width; out.height = q.height;
    x.out = out; x.bgColor = opts.bg.color; x.bgMode = opts.bg.mode; x.ended = false;
    onLive?.({ on: true, background: bgCss });
    startLoop(out);
    const media = new MediaStream([...out.captureStream(FPS).getVideoTracks(), ...x.dest.stream.getAudioTracks()]);
    const ws = new WebSocket(wsUrl(docId)); ws.binaryType = 'arraybuffer'; x.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'start', channel_id: opts.channel, title: opts.title.trim(), visibility: opts.visibility, chat: opts.chat, quality: opts.quality, mime }));
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'state') {
        setMsg(m.message || '');
        if (m.state === 'ready' && !x.rec) {
          const h264 = /h264|avc1/.test(mime);
          // VP8/VP9 is re-encoded on the server, so it gets a little more than the stream's own bitrate.
          const rec = new MediaRecorder(media, { mimeType: mime, videoBitsPerSecond: (h264 ? q.kbps : q.kbps * 1.6) * 1000, audioBitsPerSecond: 128000,
            ...(h264 ? { videoKeyFrameIntervalDuration: 2000 } : {}) });
          rec.ondataavailable = (ev) => {
            if (!ev.data.size || ws.readyState !== 1) return;
            // A slow connection to the server: the page can't send fast enough, so stop rather than fall minutes behind.
            if (ws.bufferedAmount > 16 * 1024 * 1024) { finish({ reason: 'Your connection to the SoraLab server is too slow for this quality. Try 720p.', error: true }); return; }
            ws.send(ev.data);
          };
          rec.start(250); x.rec = rec; setState('ready');
        }
        if (m.state === 'live') { setState('live'); setLiveUrl(m.url); setSince(Date.now()); refresh(); }
      } else if (m.t === 'stats') setStats(m);
      else if (m.t === 'ended') finish({ reason: m.reason, error: m.error });
    };
    ws.onclose = () => { if (!x.ended) finish({ reason: 'Lost the connection to the SoraLab server.', error: true }); };
    ws.onerror = () => {};
  }
  function stop() {
    const x = s.current;
    if (!x.ws) return;
    setState('stopping'); setMsg('Ending the stream…');
    try { x.rec?.state !== 'inactive' && x.rec?.requestData(); } catch { /* not recording */ }
    // the last chunk goes out before "stop"
    setTimeout(() => { try { x.rec?.state !== 'inactive' && x.rec?.stop(); } catch { /* done */ } if (x.ws?.readyState === 1) x.ws.send(JSON.stringify({ t: 'stop' })); }, 300);
  }
  function teardown() {
    const x = s.current;
    x.ended = true;
    cancelAnimationFrame(x.raf);
    try { x.rec?.state !== 'inactive' && x.rec?.stop(); } catch { /* done */ }
    x.rec = null;
    if (x.ws && x.ws.readyState <= 1) x.ws.close();
    x.ws = null;
    closeMic();
  }
  function finish({ reason, error }) {
    if (s.current.ended) return;
    teardown();
    setState('idle'); setMsg(''); setEnded({ reason, error }); onLive?.({ on: false });
    if (error) toast(reason, { type: 'error' }); else toast(reason || 'The stream has ended.', { type: 'success' });
    setTimeout(refresh, 1500);
  }

  // ---------------------------------------------------------------- the panel
  if (!info || info.enabled === false) return null; // Tsunami isn't connected to this server: no panel
  const busy = state !== 'idle';
  const channels = info.channels || [];
  const ch = channels.find((c) => c.id === opts.channel);
  const otherLive = !busy && ch?.live; // e.g. OBS is streaming to this channel now
  const [hLabel, hDot] = HEALTH[stats?.health] || HEALTH.starting;
  const canStart = !busy && ch?.can_go_live && info.live_enabled !== false;
  return (
    <PanelSection title="Go live on Tsunami" id="avp-golive">
    <div className="flex flex-col gap-2" data-testid="golive">
      {info.error && <p className="text-[11px] text-danger">{info.error}</p>}
      {!info.error && info.live_enabled === false && <p className="text-[11px] text-fg3">Live streaming is turned off on Tsunami.</p>}
      {!info.error && !channels.length && <p className="text-[11px] text-fg3">You don’t have a Tsunami channel yet. Open Tsunami once to make one.</p>}
      {channels.length > 0 && (
        <>
          <Select small value={opts.channel} disabled={busy} onChange={(v) => set({ channel: v })} data-testid="golive-channel"
            options={channels.map((c) => ({ value: c.id, label: `${c.name} (@${c.handle})${c.live ? ' · live now' : c.status === 'suspended' ? ' · suspended' : ''}` }))} />
          {ch?.reason && !busy && <p className="text-[11px] text-fg3">{ch.reason}</p>}
          <TextInput value={opts.title} maxLength={100} disabled={busy} placeholder="Stream title" onChange={(e) => setOpts((o) => ({ ...o, title: e.target.value }))} className="!h-7 text-[12px]" data-testid="golive-title" />
          <div className="flex items-center gap-1.5">
            <Select small value={opts.visibility} disabled={busy} onChange={(v) => set({ visibility: v })} className="flex-1 min-w-0" data-testid="golive-visibility"
              options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }]} />
            <Select small value={opts.quality} disabled={busy} onChange={(v) => set({ quality: v })} className="flex-1 min-w-0" data-testid="golive-quality"
              options={[{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }]} />
          </div>
          <p className="text-[11px] text-fg3 -mt-1">{{ public: 'Anyone can find it; subscribers are told.', unlisted: 'Only people with the link can watch.', private: 'Only you (and Tsunami staff) can watch.' }[opts.visibility]} {opts.quality === '1080p' ? '1080p at 6 Mbps' : '720p at 3 Mbps'}, 30 fps.</p>
          <Toggle label="Live chat" checked={opts.chat} disabled={busy} onChange={(v) => set({ chat: v })} />
          <div className="text-[11px] text-fg3 -mb-1">Background (video can’t be transparent)</div>
          <div className="flex items-center gap-1.5">
            <Segmented value={opts.bg.mode} onChange={(v) => set({ bg: { ...opts.bg, mode: v } })} options={[{ value: 'color', label: 'Colour' }, { value: 'image', label: 'Picture' }]} />
            {opts.bg.mode === 'color' && <ColorSwatch value={opts.bg.color} onChange={(c) => set({ bg: { ...opts.bg, color: c } })} size={22} alpha={false} />}
            {opts.bg.mode === 'image' && <Button size="sm" variant="ghost" icon="folder" onClick={async () => { const a = await pickAssets({ kinds: ['image'], multiple: false, docId, title: 'Background picture' }); if (a?.[0]) set({ bg: { ...opts.bg, asset: a[0].id } }); }}>{opts.bg.asset ? 'Change…' : 'Choose…'}</Button>}
          </div>
          <div className="flex items-center gap-1.5">
            <Toggle label="Mic" checked={opts.mic} onChange={toggleMic} />
            <Select small value={opts.micDev} onChange={chooseMic} className="flex-1 min-w-0" options={[{ value: '', label: 'Default microphone' }, ...mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]} />
          </div>
          <Button size="sm" variant={desktop ? 'primary' : 'ghost'} icon="volume" onClick={addDesktop}>{desktop ? 'Stop sharing tab or desktop sound' : 'Add tab or desktop sound…'}</Button>

          {busy && <canvas ref={preview} className="w-full rounded border border-line bg-black" data-testid="golive-preview" />}
          {busy && (
            <div className="flex flex-col gap-1 text-[12px]" data-testid="golive-status">
              <div className="flex items-center gap-2">
                {state === 'live' ? <span className="px-1.5 rounded bg-danger text-white text-[10px] font-semibold tracking-wide">LIVE</span> : <span className="w-2 h-2 rounded-full bg-fg3 animate-pulse" />}
                <span className="flex-1 truncate">{state === 'live' ? fmtClock((Date.now() - since) / 1000) : msg}</span>
                {stats && state === 'live' && <span className="flex items-center gap-1 text-[11px]" title="Stream health" data-testid="golive-health"><span className={cx('w-2 h-2 rounded-full', hDot)} />{hLabel}</span>}
              </div>
              {stats && <div className="text-[11px] text-fg3 tabular-nums" data-testid="golive-stats">{stats.kbps} kbps · {stats.fps} fps{stats.dropped ? ` · ${stats.dropped} frames dropped` : ''}{stats.viewers ? ` · ${stats.viewers} watching` : ''}</div>}
              {hidden && <div className="text-[11px] text-warn">This tab is in the background: browsers pause the picture there, so keep it visible while you’re live.</div>}
            </div>
          )}
          {liveUrl && busy && <a href={liveUrl} target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline" data-testid="golive-link">Open the live page on Tsunami ↗</a>}
          {otherLive && <p className="text-[11px] text-fg3">This channel is live now{otherLive.url ? <> (<a className="text-accent" href={otherLive.url} target="_blank" rel="noreferrer">watch</a>)</> : ''}.</p>}
          {ended && !busy && <p className={cx('text-[11px]', ended.error ? 'text-danger' : 'text-fg3')} data-testid="golive-ended">{ended.reason}</p>}
          {!busy ? <Button size="sm" variant="primary" icon="record" disabled={!canStart} onClick={start} data-testid="golive-start">Go live</Button>
            : <Button size="sm" variant="danger" icon="stop" disabled={state === 'stopping'} onClick={stop} data-testid="golive-stop">{state === 'stopping' ? 'Ending…' : state === 'live' ? 'End stream' : 'Cancel'}</Button>}
        </>
      )}
    </div>
    </PanelSection>
  );
}
