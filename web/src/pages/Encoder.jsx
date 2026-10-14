// Encoder (Media Encoder): a queue of files to convert with presets and optional output tweaks, and the render list —
// every job on the server (Cut exports too) with live progress, the encoder used, and its result.
// /encoder?job=<id> highlights one job (notification links use it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageLayout } from '../components/Header.jsx';
import { Button, IconButton, Select, NumberInput, TextInput, Segmented, ProgressBar, EmptyState, Spinner, toast, toastError, confirmDialog, cx } from '../components/ui.jsx';
import { Icon } from '../components/Icons.jsx';
import { pickAssets, pickCloudFolder, saveToCloud } from '../components/Pickers.jsx';
import { api, download, ago } from '../lib/api.js';
import { appById } from '../lib/apps.js';
import { fmtDur } from '../apps/_media/media.js';

// Output formats you can switch a preset to (server/src/render.js PRESETS use the same fields).
const FORMATS = [
  { id: 'mp4-h264', label: 'MP4 · H.264', output: { container: 'mp4', vcodec: 'h264' }, video: true },
  { id: 'mp4-hevc', label: 'MP4 · HEVC (H.265)', output: { container: 'mp4', vcodec: 'hevc' }, video: true, codec: 'hevc' },
  { id: 'mp4-av1', label: 'MP4 · AV1', output: { container: 'mp4', vcodec: 'av1' }, video: true, codec: 'av1' },
  { id: 'webm-vp9', label: 'WebM · VP9', output: { container: 'webm', vcodec: 'vp9' }, video: true, codec: 'vp9' },
  { id: 'mov-prores', label: 'MOV · ProRes 422 HQ', output: { container: 'mov', vcodec: 'prores', audio_codec: 'pcm' }, video: true, codec: 'prores' },
  { id: 'gif', label: 'Animated GIF', output: { container: 'gif', vcodec: 'gif' }, video: true, noAudio: true },
  { id: 'mp3', label: 'MP3', output: { container: 'mp3', audio_codec: 'mp3' }, codec: 'mp3' },
  { id: 'm4a', label: 'AAC (M4A)', output: { container: 'm4a', audio_codec: 'aac' } },
  { id: 'wav', label: 'WAV', output: { container: 'wav', audio_codec: 'pcm' }, lossless: true },
  { id: 'flac', label: 'FLAC', output: { container: 'flac', audio_codec: 'flac' }, lossless: true },
  { id: 'opus', label: 'Opus (OGG)', output: { container: 'ogg', audio_codec: 'opus' }, codec: 'opus' },
];
const formatOf = (o) => FORMATS.find((f) => f.output.container === o.container && (f.output.vcodec || null) === (o.vcodec || null) && (!f.output.audio_codec || f.output.audio_codec === (o.audio_codec || f.output.audio_codec)))
  || FORMATS.find((f) => f.output.container === o.container) || FORMATS[0];
const SIZES = [['source', 'Same as source'], ['3840x2160', '3840×2160 (4K)'], ['2560x1440', '2560×1440'], ['1920x1080', '1920×1080'], ['1280x720', '1280×720'], ['854x480', '854×480'], ['1080x1920', '1080×1920 (vertical)'], ['1080x1080', '1080×1080 (square)'], ['custom', 'Custom…']];
const STATUS = { queued: ['Queued', 'text-fg2 bg-chip'], running: ['Encoding', 'text-[#06121f] bg-accent'], done: ['Done', 'text-[#06231a] bg-ok'], failed: ['Failed', 'text-white bg-danger'], cancelled: ['Cancelled', 'text-fg2 bg-chip'] };

function parseTime(s) {
  if (s === '' || s === null || s === undefined) return null;
  const p = String(s).trim().split(':').map(Number);
  if (p.some((n) => !Number.isFinite(n))) return null;
  return p.reduce((a, n) => a * 60 + n, 0);
}
const showTime = (t) => (t === null || t === undefined ? '' : fmtDur(t) || '0:00.0');

/** One file waiting in the queue, with its preset and output tweaks. */
function QueueItem({ item, info, update, remove }) {
  const a = item.asset;
  const audioOnly = a.kind === 'audio';
  const presets = info.presets.filter((p) => !audioOnly || p.group === 'Audio');
  const preset = info.presets.find((p) => p.id === item.preset);
  const out = { ...(preset?.output || {}), ...item.output };
  const fmt = formatOf(out);
  const isVideoOut = fmt.video;
  const set = (patch) => update({ ...item, ...patch });
  const setOut = (patch) => set({ output: { ...item.output, ...patch } });
  const size = item.size || (preset?.width && preset?.height ? `${preset.width}x${preset.height}` : preset?.width ? 'source' : 'source');
  const groups = [...new Set(presets.map((p) => p.group))].map((g) => ({ group: g, options: presets.filter((p) => p.group === g).map((p) => ({ value: p.id, label: p.label })) }));
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-3 p-3">
        <div className="w-24 h-14 rounded-md bg-panel-2 overflow-hidden grid place-items-center shrink-0">
          {a.kind === 'video' ? <img src={a.thumb} alt="" className="w-full h-full object-cover" /> : <Icon name="wave" size={24} className="text-ok" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{a.name}</div>
          <div className="text-xs text-fg3">{[a.width && `${a.width}×${a.height}`, a.fps && `${a.fps} fps`, a.duration && fmtDur(a.duration), a.meta?.vcodec, a.meta?.acodec].filter(Boolean).join(' · ')}</div>
        </div>
        <Select value={item.preset} onChange={(v) => set({ preset: v, output: {}, size: null })} options={groups} className="max-w-[260px]" aria-label="Preset" />
        <IconButton icon="sliders" label="Output settings" active={item.open} onClick={() => set({ open: !item.open })} />
        <IconButton icon="close" label="Remove from queue" onClick={remove} />
      </div>
      {item.open && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-5 gap-y-3 px-3 pb-3 pt-1 border-t border-line text-sm">
          <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Format</span>
            <Select value={fmt.id} onChange={(v) => { const f = FORMATS.find((x) => x.id === v); set({ output: { ...f.output, ...(item.output.quality ? { quality: item.output.quality } : {}) } }); }}
              options={FORMATS.filter((f) => !audioOnly || !f.video).map((f) => ({ value: f.id, label: f.label + (f.codec && info.codecs[f.codec] === false ? ' (not on this server)' : ''), disabled: f.codec && info.codecs[f.codec] === false }))} />
          </label>
          {isVideoOut && (
            <>
              <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Resolution</span>
                <Select value={size} onChange={(v) => set({ size: v, ...(v === 'custom' ? { cw: item.cw || a.width || 1920, ch: item.ch || a.height || 1080 } : {}) })} options={SIZES.map(([v, l]) => ({ value: v, label: l }))} />
                {size === 'custom' && <span className="flex items-center gap-1"><NumberInput value={item.cw} onChange={(v) => set({ cw: v })} min={16} max={8192} width={64} />×<NumberInput value={item.ch} onChange={(v) => set({ ch: v })} min={0} max={8192} width={64} title="0 keeps the aspect ratio" /></span>}
              </label>
              <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Frame rate</span>
                <Select value={String(item.fps || '')} onChange={(v) => set({ fps: v ? Number(v) : null })} options={[{ value: '', label: 'Same as source' }, ...['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'].map((v) => ({ value: v, label: `${v} fps` }))]} />
              </label>
              {fmt.id !== 'mov-prores' && fmt.id !== 'gif' && (
                <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Quality</span>
                  <span className="flex items-center gap-2">
                    <Segmented value={item.output.video_bitrate ? 'bitrate' : out.quality || 'high'} onChange={(v) => setOut(v === 'bitrate' ? { video_bitrate: item.output.video_bitrate || 8000, quality: undefined } : { quality: v, video_bitrate: undefined })}
                      options={[{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }, { value: 'bitrate', label: 'Bitrate' }]} />
                    {item.output.video_bitrate ? <NumberInput value={item.output.video_bitrate} onChange={(v) => setOut({ video_bitrate: v })} min={200} max={200000} step={100} unit="kbps" width={92} /> : null}
                  </span>
                </label>
              )}
            </>
          )}
          {!fmt.noAudio && !fmt.lossless && fmt.id !== 'mov-prores' && (
            <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Audio bitrate</span>
              <Select value={String(out.audio_bitrate || '')} onChange={(v) => setOut({ audio_bitrate: v ? Number(v) : undefined })} options={[{ value: '', label: 'Default' }, ...[96, 128, 160, 192, 256, 320].map((v) => ({ value: String(v), label: `${v} kbps` }))]} />
            </label>
          )}
          {a.duration > 0 && (
            <label className="flex flex-col gap-1"><span className="text-xs text-fg2">Trim (start – end)</span>
              <span className="flex items-center gap-1.5">
                <TextInput value={item.trimIn ?? ''} placeholder="0:00" onChange={(e) => set({ trimIn: e.target.value })} className="!w-20" />–
                <TextInput value={item.trimOut ?? ''} placeholder={showTime(a.duration)} onChange={(e) => set({ trimOut: e.target.value })} className="!w-20" />
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/** The job spec for a queue item (POST /api/jobs, kind transcode). */
function specOf(item, info) {
  const preset = info.presets.find((p) => p.id === item.preset);
  const spec = { asset_id: item.asset.id, preset: item.preset };
  const o = Object.fromEntries(Object.entries(item.output || {}).filter(([, v]) => v !== undefined && v !== null));
  if (Object.keys(o).length) spec.output = o;
  const size = item.size;
  if (size === 'source') { spec.width = 0; spec.height = 0; }
  else if (size === 'custom') { spec.width = item.cw || 0; spec.height = item.ch || 0; }
  else if (size) { const [w, h] = size.split('x').map(Number); spec.width = w; spec.height = h; }
  else if (preset?.width && !preset?.height) spec.width = preset.width;
  if (item.fps) spec.fps = item.fps;
  const s = parseTime(item.trimIn); const e = parseTime(item.trimOut);
  if (s !== null || e !== null) spec.trim = { start: s ?? 0, ...(e !== null ? { end: e } : {}) };
  if ((spec.output?.container || preset?.output.container) === 'gif') spec.fit = 'contain';
  return spec;
}

function JobRow({ j, highlight, reload }) {
  const ref = useRef(null);
  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlight]);
  const [label, cls] = STATUS[j.status] || [j.status, 'bg-chip'];
  const f = j.format || {};
  const act = (p) => p.then(reload).catch(toastError);
  const elapsed = j.started_at ? ((j.finished_at || Date.now()) - j.started_at) / 1000 : null;
  return (
    <div ref={ref} className={cx('rounded-xl border p-3 flex flex-col gap-2 transition', highlight ? 'border-accent ring-2 ring-accent/40 bg-accent/5' : 'border-line bg-surface')}>
      <div className="flex items-center gap-3 flex-wrap">
        <Icon name={j.kind === 'timeline' ? 'video' : 'render'} size={18} className="text-fg2" />
        <div className="flex-1 min-w-48">
          <div className="font-medium truncate">{j.name}</div>
          <div className="text-xs text-fg3 truncate">
            {j.kind === 'timeline' ? `${appById('cut')?.name || 'Cut'} export` : `From ${j.source?.name || 'a file'}`} · {[f.container?.toUpperCase(), f.vcodec, f.quality, f.video_bitrate && `${f.video_bitrate} kbps`].filter(Boolean).join(' · ')}
            {j.settings?.width ? ` · ${j.settings.width}×${j.settings.height || 'auto'}` : ''} · {ago(j.created_at)}
          </div>
        </div>
        <span className={cx('text-[11px] font-semibold px-2 h-5 rounded-full grid place-items-center', cls)}>{label}</span>
        {j.encoder && <span className="text-[11px] text-fg2 flex items-center gap-1" title="Encoder used"><Icon name="settings" size={12} />{j.encoder}</span>}
        {elapsed !== null && <span className="text-[11px] text-fg3 tabular-nums">{fmtDur(elapsed) || '0:00'}</span>}
        <span className="flex items-center gap-1">
          {['queued', 'running'].includes(j.status) && <Button size="sm" variant="outline" icon="stop" onClick={() => act(api.post(`/api/jobs/${j.id}/cancel`))}>Cancel</Button>}
          {['failed', 'cancelled'].includes(j.status) && <Button size="sm" variant="outline" icon="refresh" onClick={() => act(api.post(`/api/jobs/${j.id}/retry`))}>Retry</Button>}
          {j.status === 'done' && j.output && (
            <>
              <Button size="sm" variant="primary" icon="download" onClick={() => download(`${j.output.url}?download=1`, j.output.name)}>Download</Button>
              <Link to="/files?tab=exports"><Button size="sm" variant="outline" icon="folder">Files</Button></Link>
              <IconButton icon="cloud" label="Save to Minami Cloud" onClick={async () => { const r = await saveToCloud({ assetId: j.output.id, name: j.output.name }).catch(toastError); if (r) toast('Saved to Minami Cloud', { type: 'success' }); }} />
              {j.doc_id && <Link to={`/cut/${j.doc_id}`} title="Open the project"><IconButton icon="external" label="Open the project" /></Link>}
            </>
          )}
          <IconButton icon="trash" label="Remove from the list" onClick={() => act(api.del(`/api/jobs/${j.id}`))} />
        </span>
      </div>
      {['queued', 'running'].includes(j.status) && (
        <div className="flex items-center gap-3"><ProgressBar value={j.progress} indeterminate={j.status === 'queued'} className="flex-1" /><span className="text-xs tabular-nums w-10 text-right">{Math.round((j.progress || 0) * 100)}%</span></div>
      )}
      {j.status === 'failed' && j.error && <div className="text-xs text-danger break-words">{j.error}</div>}
      {j.status === 'done' && j.output && <div className="text-xs text-fg2">{j.output.name} · {[j.output.width && `${j.output.width}×${j.output.height}`, j.output.duration && fmtDur(j.output.duration)].filter(Boolean).join(' · ')}</div>}
      {j.after_result && (
        <div className="text-xs flex gap-3">
          {j.after_result.cloud && <span className={j.after_result.cloud.error ? 'text-danger' : 'text-ok'}><Icon name="cloud" size={12} className="inline mr-1" />{j.after_result.cloud.error || 'Saved to Minami Cloud'}</span>}
          {j.after_result.tsunami && <span className={j.after_result.tsunami.error ? 'text-danger' : 'text-ok'}><Icon name="video" size={12} className="inline mr-1" />{j.after_result.tsunami.error || 'Sent to Tsunami'}</span>}
        </div>
      )}
    </div>
  );
}

export default function Encoder() {
  const app = appById('encoder');
  const [params] = useSearchParams();
  const focusJob = params.get('job');
  const [info, setInfo] = useState(null);
  const [config, setConfig] = useState({});
  const [queue, setQueue] = useState([]);
  const [jobs, setJobs] = useState(null);
  const [dest, setDest] = useState('none');
  const [cloudFolder, setCloudFolder] = useState(null);
  const [tsu, setTsu] = useState({ visibility: 'private' });
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  useEffect(() => { document.title = `${app?.name || 'Encoder'} — SoraLab`; }, [app]);
  useEffect(() => {
    api.get('/api/render/info').then(setInfo).catch((e) => { toastError(e); setInfo({ presets: [], codecs: {}, encoder: null }); });
    api.get('/api/config').then(setConfig).catch(() => {});
  }, []);
  const load = useCallback(() => api.get('/api/jobs').then(setJobs).catch(() => setJobs((j) => j || [])), []);
  // Live progress: poll quickly while something is rendering.
  const active = (jobs || []).some((j) => ['queued', 'running'].includes(j.status));
  useEffect(() => { load(); const t = setInterval(load, active ? 1000 : 5000); return () => clearInterval(t); }, [load, active]);

  const add = async () => {
    const list = await pickAssets({ kinds: ['video', 'audio'], title: 'Add files to the queue' });
    if (!list?.length) return;
    setQueue((q) => [...q, ...list.filter((a) => ['video', 'audio'].includes(a.kind)).map((a) => ({
      key: `${a.id}-${Math.random().toString(36).slice(2, 6)}`, asset: a, preset: a.kind === 'audio' ? 'mp3' : 'h264-1080p', output: {}, open: false,
    }))]);
  };
  const start = async () => {
    if (!queue.length) return;
    let after;
    if (dest === 'cloud') {
      const f = cloudFolder || await pickCloudFolder({ name: null, title: 'Send the results to…', confirm: 'Choose' });
      if (!f) return;
      setCloudFolder(f);
      after = { cloud: { folder_id: f.folder_id } };
    }
    if (dest === 'tsunami') after = { tsunami: { visibility: tsu.visibility, description: tsu.description || '' } };
    setBusy(true);
    let n = 0;
    try {
      for (const item of queue) {
        const name = item.asset.name.replace(/\.[^.]+$/, '');
        await api.post('/api/jobs', { kind: 'transcode', name, spec: specOf(item, info), after: after?.tsunami ? { tsunami: { ...after.tsunami, title: name } } : after });
        n++;
      }
      setQueue([]);
      toast(`Started ${n} render${n > 1 ? 's' : ''}`, { type: 'success' });
    } catch (e) { toastError(e, 'Couldn’t start'); setQueue((q) => q.slice(n)); }
    finally { setBusy(false); load(); }
  };
  const clearFinished = async () => { await api.post('/api/jobs/clear').catch(toastError); load(); };
  const shown = useMemo(() => (jobs || []).filter((j) => filter === 'all' || (filter === 'active' ? ['queued', 'running'].includes(j.status) : j.status === filter)), [jobs, filter]);
  const enc = info?.encoder;

  return (
    <PageLayout wide>
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-xl grid place-items-center shrink-0" style={{ background: `linear-gradient(135deg, ${app?.colors?.[0]}, ${app?.colors?.[1]})` }}><Icon name="render" size={24} className="text-white" /></div>
        <div className="flex-1 min-w-56">
          <h1 className="font-head font-bold text-2xl">{app?.name || 'Encoder'}</h1>
          <p className="text-fg2 text-sm">{app?.tagline}</p>
        </div>
        <div className="flex items-center gap-2 px-3 h-9 rounded-full border border-line bg-surface text-sm" title="The video encoder this server uses">
          <Icon name="settings" size={15} className={enc?.gpu ? 'text-ok' : 'text-fg2'} />
          {enc ? <span><span className="text-fg2">Encoder:</span> {enc.label}{enc.gpu ? ' (GPU)' : ''}</span> : <Spinner size={14} />}
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 items-start">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="font-head font-semibold text-lg flex-1">Queue <span className="text-fg3 font-normal text-sm">{queue.length || ''}</span></h2>
            {queue.length > 1 && info && <Select small value="" onChange={(v) => v && setQueue((q) => q.map((x) => (x.asset.kind === 'audio' && info.presets.find((p) => p.id === v)?.group !== 'Audio' ? x : { ...x, preset: v, output: {}, size: null })))}
              options={[{ value: '', label: 'Apply preset to all…' }, ...info.presets.map((p) => ({ value: p.id, label: p.label }))]} />}
            <Button icon="plus" onClick={add}>Add files</Button>
          </div>
          {!info ? <Spinner /> : !queue.length ? (
            <div className="rounded-xl border-2 border-dashed border-line"><EmptyState icon="queue" title="Nothing in the queue" action={<Button variant="primary" icon="plus" onClick={add}>Add files</Button>}>Add video or audio from this device, Files or Minami Cloud, pick a preset, then start the queue.</EmptyState></div>
          ) : (
            <div className="flex flex-col gap-2">
              {queue.map((item) => <QueueItem key={item.key} item={item} info={info} update={(x) => setQueue((q) => q.map((y) => (y.key === item.key ? x : y)))} remove={() => setQueue((q) => q.filter((y) => y.key !== item.key))} />)}
              <div className="rounded-xl border border-line bg-surface p-3 flex flex-wrap items-center gap-3 mt-1">
                <span className="text-sm text-fg2">When done, also</span>
                <Segmented size="md" value={dest} onChange={setDest} options={[{ value: 'none', label: 'Keep in Files' }, ...(config.cloud ? [{ value: 'cloud', label: 'Save to Cloud', icon: 'cloud' }] : []), ...(config.tsunami ? [{ value: 'tsunami', label: 'Send to Tsunami', icon: 'video' }] : [])]} />
                {dest === 'cloud' && <Button size="sm" variant="ghost" icon="folder" onClick={async () => { const f = await pickCloudFolder({ name: null, title: 'Send the results to…', confirm: 'Choose' }); if (f) setCloudFolder(f); }}>{cloudFolder ? 'Folder chosen' : 'Choose folder'}</Button>}
                {dest === 'tsunami' && <Segmented value={tsu.visibility} onChange={(v) => setTsu({ ...tsu, visibility: v })} options={[{ value: 'private', label: 'Private' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'public', label: 'Public' }]} />}
                <span className="flex-1" />
                <Button variant="primary" icon="play" busy={busy} onClick={start}>Start queue</Button>
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="font-head font-semibold text-lg flex-1">Renders</h2>
            <Select small value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'In progress' }, { value: 'done', label: 'Done' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }]} />
            <Button size="sm" variant="outline" icon="trash" disabled={!(jobs || []).some((j) => ['done', 'failed', 'cancelled'].includes(j.status))} onClick={async () => { if (await confirmDialog({ title: 'Clear finished renders?', message: 'They leave this list; the exported files stay in Files → Exports.', confirm: 'Clear' })) clearFinished(); }}>Clear finished</Button>
          </div>
          {!jobs ? <Spinner /> : !shown.length ? <div className="rounded-xl border border-line"><EmptyState icon="render" title="No renders yet">Conversions and exports from {appById('cut')?.name || 'Cut'} show up here while they run.</EmptyState></div>
            : <div className="flex flex-col gap-2">{shown.map((j) => <JobRow key={j.id} j={j} highlight={j.id === focusJob} reload={load} />)}</div>}
        </section>
      </div>
    </PageLayout>
  );
}

