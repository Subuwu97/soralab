// Files (like Adobe Bridge + the Creative Cloud files view): every project, upload and export in one place.
// Grid or list, search and sort, multi-select with bulk actions, a preview pane with metadata and players,
// and per-file actions (download, rename, Cloud, Tsunami, "Open in…" an app).
//   /files?tab=projects|uploads|exports   &app=<app id>   &view=recent|starred|shared|trash
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, uploadFiles, fmtBytes, fmtTime, ago } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { APPS, appById } from '../lib/apps.js';
import { createProject } from '../lib/doc.js';
import { PageLayout } from '../components/Header.jsx';
import { AppTile } from '../components/Brand.jsx';
import { Icon } from '../components/Icons.jsx';
import { projectMenu } from '../components/ProjectCard.jsx';
import { shareDialog } from '../components/ProjectDialogs.jsx';
import { pickCloudFiles, saveToCloud } from '../components/Pickers.jsx';
import {
  Button, IconButton, Select, Segmented, Tabs, Spinner, EmptyState, ProgressBar, Modal, Field, TextInput,
  openMenu, promptDialog, confirmDialog, toast, toastError, cx,
} from '../components/ui.jsx';
import { PageHero, useDropAnywhere, useStored, useWide, PdfPreview } from './_shared/index.jsx';

const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', font: 'font' };
const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', font: 'Font', other: 'File' };
const SORTS = [{ value: 'date', label: 'Date modified' }, { value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'type', label: 'Type' }];

// Projects and assets look the same to the grid: { key, type: 'doc'|'asset', name, date, size, typeLabel, raw }.
const fromDoc = (d) => ({ key: `d:${d.id}`, type: 'doc', id: d.id, name: d.name, date: d.updated_at, size: d.size || 0, typeLabel: appById(d.app)?.name || d.app, raw: d });
const fromAsset = (a) => ({ key: `a:${a.id}`, type: 'asset', id: a.id, name: a.name, date: a.created_at, size: a.size || 0, typeLabel: KIND_LABEL[a.kind] || 'File', raw: a });

/** Which apps can open an asset ("Open in…"), and how each starts its project. */
function openTargets(a) {
  const base = a.name.replace(/\.[^.]+$/, '');
  const dims = { width: a.width || 1920, height: a.height || 1080 };
  if (a.kind === 'image') {
    return [
      { app: 'photo', make: () => ({ name: base, ...dims, meta: { import: [a.id] } }) },
      { app: 'develop', make: () => ({ name: base, ...dims, meta: { import: [a.id] } }) },
    ];
  }
  if (a.kind === 'video') return [{ app: 'cut', make: () => ({ name: base, ...dims, duration: a.duration || undefined, meta: { fps: Math.round(a.fps || 30), import: [a.id] } }) }];
  if (a.kind === 'audio') return [{ app: 'audio', make: () => ({ name: base, duration: a.duration || undefined, meta: { sampleRate: 48000, import: [a.id] } }) }];
  if (a.kind === 'pdf') return [{ app: 'pdf', make: () => ({ name: base, meta: { source: a.id }, data: { source: a.id, annotations: [] } }) }];
  return [];
}

async function openIn(a, target, nav) {
  try {
    const d = await createProject(target.app, target.make());
    nav(`/${target.app}/${d.id}`);
  } catch (e) { toastError(e, 'Couldn’t start the project'); }
}

const publishTsunami = (a) => new Promise((resolve) => {
  // Rendered by the page (see TsunamiDialog) through a tiny event so it can use the page's state.
  window.dispatchEvent(new CustomEvent('sl-files-tsunami', { detail: { asset: a, resolve } }));
});

function assetMenu(a, { nav, reload, setPreview }) {
  const targets = openTargets(a);
  return [
    ...(targets.length ? [{ label: 'Open in…', icon: 'external', items: targets.map((t) => ({ label: appById(t.app)?.name || t.app, onClick: () => openIn(a, t, nav) })) }, { divider: true }] : []),
    { label: 'Preview', icon: 'eye', onClick: () => setPreview?.(a) },
    { label: 'Download', icon: 'download', onClick: () => { location.href = `${a.url}?download=1`; } },
    { label: 'Rename…', icon: 'edit', onClick: async () => {
      const n = await promptDialog({ title: 'Rename file', label: 'Name', value: a.name });
      if (n && n !== a.name) { await api.patch(`/api/assets/${a.id}`, { name: n }).catch(toastError); reload(); }
    } },
    { label: 'Save to Minami Cloud…', icon: 'cloud', onClick: async () => {
      try { const r = await saveToCloud({ assetId: a.id, name: a.name }); if (r) toast('Saved to Minami Cloud', { type: 'success' }); } catch (e) { toastError(e); }
    } },
    ...(['video', 'audio'].includes(a.kind) ? [{ label: 'Publish to Tsunami…', icon: 'play', onClick: () => publishTsunami(a) }] : []),
    { divider: true },
    { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
      if (await confirmDialog({ title: `Delete “${a.name}”?`, message: a.doc_id ? 'It’s used in a project, which will no longer be able to show it. This can’t be undone.' : 'This can’t be undone.', confirm: 'Delete', danger: true })) {
        await api.del(`/api/assets/${a.id}`).catch(toastError); reload();
      }
    } },
  ];
}

// ---------------------------------------------------------------- thumbnails

function Thumb({ item, big }) {
  const [failed, setFailed] = useState(false);
  if (item.type === 'doc') {
    const d = item.raw;
    return d.thumb ? <img src={d.thumb} alt="" loading="lazy" draggable={false} className="max-w-full max-h-full object-contain" /> : <AppTile app={d.app} size={big ? 56 : 30} />;
  }
  const a = item.raw;
  if (a.kind === 'pdf') return <PdfPreview fill url={a.url} width={big ? 240 : 60} className="shadow-md bg-white" />;
  if (a.thumb && !failed) return <img src={a.thumb} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className={cx('max-w-full max-h-full', big ? 'object-contain' : 'w-full h-full object-cover')} />;
  return <Icon name={KIND_ICON[a.kind] || 'file'} size={big ? 34 : 18} className="text-fg3" />;
}

function Badge({ item }) {
  if (item.type === 'doc') return null;
  const a = item.raw;
  const t = a.duration ? fmtTime(a.duration) : null;
  return (
    <span className="absolute bottom-2 left-2 flex items-center gap-1 h-5 px-1.5 rounded bg-black/60 text-white text-[10.5px] font-medium">
      <Icon name={KIND_ICON[a.kind] || 'file'} size={11} />{t || KIND_LABEL[a.kind] || 'File'}
    </span>
  );
}

const subline = (item) => {
  if (item.type === 'doc') {
    const d = item.raw;
    const info = d.duration ? fmtTime(d.duration) : d.pages ? `${d.pages} page${d.pages > 1 ? 's' : ''}` : d.width ? `${d.width}×${d.height}` : '';
    return `${d.owner ? `${d.owner.name} · ` : ''}${ago(d.trashed_at || d.updated_at)}${info ? ` · ${info}` : ''}`;
  }
  const a = item.raw;
  return `${fmtBytes(a.size)}${a.width ? ` · ${a.width}×${a.height}` : ''} · ${ago(a.created_at)}`;
};

// ---------------------------------------------------------------- grid / list items

function SelectBox({ checked, onClick, className }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={checked ? 'Deselect' : 'Select'} onClick={onClick}
      className={cx('w-5 h-5 rounded-md border grid place-items-center transition shrink-0', checked ? 'bg-accent border-accent text-[#06121f]' : 'bg-black/35 border-white/60 text-transparent hover:border-white', className)}>
      <Icon name="check" size={13} stroke={3} />
    </button>
  );
}

function GridItem({ item, selected, anySelected, current, onSelect, onOpen, onMenu }) {
  return (
    <div role="option" aria-selected={selected} tabIndex={0}
      onClick={(e) => onSelect(e)} onDoubleClick={onOpen} onContextMenu={onMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); if (e.key === ' ') { e.preventDefault(); onSelect({ ctrlKey: true }); } }}
      className={cx('group relative rounded-xl bg-surface border overflow-hidden cursor-default select-none outline-none transition',
        selected ? 'border-accent ring-2 ring-accent/35' : current ? 'border-accent/50' : 'border-line hover:border-accent/40 focus-visible:border-accent/60')}>
      <div className="aspect-[4/3] bg-panel-2 grid place-items-center overflow-hidden relative">
        <Thumb item={item} big />
        <Badge item={item} />
        {item.type === 'doc' && item.raw.starred && <Icon name="star" size={16} fill="#FFC36B" className="absolute top-2 right-10 text-sun drop-shadow" />}
      </div>
      <div className="flex items-center gap-2.5 p-3">
        {item.type === 'doc' ? <AppTile app={item.raw.app} size={26} /> : <span className="w-[26px] h-[26px] rounded-md bg-chip grid place-items-center text-fg2 shrink-0"><Icon name={KIND_ICON[item.raw.kind] || 'file'} size={15} /></span>}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" title={item.name}>{item.name}</div>
          <div className="text-xs text-fg3 truncate">{subline(item)}</div>
        </div>
      </div>
      <SelectBox checked={selected} onClick={(e) => { e.stopPropagation(); onSelect({ ctrlKey: true, shiftKey: e.shiftKey }); }}
        className={cx('absolute top-2 left-2', selected || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')} />
      <IconButton icon="more" label="More" size={28} className="!absolute top-2 right-2 bg-black/40 !text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={(e) => { e.stopPropagation(); onMenu(e); }} />
    </div>
  );
}

function ListRow({ item, selected, current, onSelect, onOpen, onMenu }) {
  return (
    <div role="option" aria-selected={selected} tabIndex={0}
      onClick={(e) => onSelect(e)} onDoubleClick={onOpen} onContextMenu={onMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); if (e.key === ' ') { e.preventDefault(); onSelect({ ctrlKey: true }); } }}
      className={cx('group grid grid-cols-[auto_44px_minmax(0,1fr)_auto] md:grid-cols-[auto_44px_minmax(0,1fr)_140px_90px_130px_auto] items-center gap-3 px-3 h-14 border-b border-line last:border-b-0 cursor-default select-none outline-none',
        selected ? 'bg-active' : current ? 'bg-hover' : 'hover:bg-hover focus-visible:bg-hover')}>
      <span onClick={(e) => { e.stopPropagation(); onSelect({ ctrlKey: true, shiftKey: e.shiftKey }); }}>
        <input type="checkbox" readOnly checked={selected} aria-label="Select" className="accent-[#5AB4FF] w-4 h-4 pointer-events-none" />
      </span>
      <span className="w-11 h-10 rounded-md bg-panel-2 grid place-items-center overflow-hidden"><Thumb item={item} /></span>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate flex items-center gap-1.5">
          {item.type === 'doc' && item.raw.starred && <Icon name="star" size={13} fill="#FFC36B" className="text-sun" />}
          <span className="truncate" title={item.name}>{item.name}</span>
        </div>
        <div className="text-xs text-fg3 truncate md:hidden">{subline(item)}</div>
      </div>
      <span className="hidden md:flex items-center gap-2 text-[13px] text-fg2 min-w-0">
        {item.type === 'doc' ? <AppTile app={item.raw.app} size={20} /> : <Icon name={KIND_ICON[item.raw.kind] || 'file'} size={15} />}
        <span className="truncate">{item.typeLabel}</span>
      </span>
      <span className="hidden md:block text-[13px] text-fg2 tabular-nums">{fmtBytes(item.size)}</span>
      <span className="hidden md:block text-[13px] text-fg2 truncate">{ago(item.date)}</span>
      <IconButton icon="more" label="More" size={30} onClick={(e) => { e.stopPropagation(); onMenu(e); }} />
    </div>
  );
}

// ---------------------------------------------------------------- preview pane

function Waveform({ asset, audio }) {
  const ref = useRef(null);
  const [peaks, setPeaks] = useState(null);
  const [t, setT] = useState(0);
  useEffect(() => {
    let off = false;
    setPeaks(null);
    api.get(`/api/assets/${asset.id}/peaks?n=400`).then((r) => { if (!off) setPeaks(r.peaks); }).catch(() => { if (!off) setPeaks([]); });
    return () => { off = true; };
  }, [asset.id]);
  useEffect(() => {
    const el = audio.current;
    if (!el) return undefined;
    const f = () => setT(el.duration ? el.currentTime / el.duration : 0);
    el.addEventListener('timeupdate', f);
    return () => el.removeEventListener('timeupdate', f);
  }, [audio, peaks]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = c.clientWidth; const h = c.clientHeight; const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const n = peaks.length || 1; const bw = w / n;
    // Scale to the loudest peak so quiet recordings still read.
    const k = 0.92 / Math.max(0.05, ...peaks.map(([lo, hi]) => Math.max(-lo, hi)));
    peaks.forEach(([lo, hi], i) => {
      g.fillStyle = i / n < t ? '#5AB4FF' : 'rgba(139,124,255,.55)';
      const y0 = h / 2 - Math.max(0.5, hi * k * h / 2); const y1 = h / 2 - lo * k * h / 2;
      g.fillRect(i * bw, y0, Math.max(1, bw - 0.6), Math.max(1, y1 - y0));
    });
  }, [peaks, t]);
  return (
    <div className="relative h-24 rounded-lg bg-panel-2 overflow-hidden">
      {!peaks && <div className="absolute inset-0 grid place-items-center"><Spinner /></div>}
      <canvas ref={ref} className="w-full h-full cursor-pointer" aria-label="Waveform — click to seek"
        onClick={(e) => { const el = audio.current; if (!el?.duration) return; const r = e.currentTarget.getBoundingClientRect(); el.currentTime = ((e.clientX - r.left) / r.width) * el.duration; el.play().catch(() => {}); }} />
    </div>
  );
}

function MetaRow({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return <div className="flex gap-3 py-1.5 border-b border-line/70 last:border-b-0 text-[13px]"><span className="text-fg3 w-24 shrink-0">{label}</span><span className="text-fg min-w-0 break-words">{children}</span></div>;
}

function AssetPreview({ a, nav, reload }) {
  const audio = useRef(null);
  const [pdfInfo, setPdfInfo] = useState(null);
  const m = a.meta || {};
  const src = a.web_url;
  return (
    <>
      <div className="rounded-xl bg-panel-2 overflow-hidden flex items-center justify-center min-h-40 min-w-0">
        {a.kind === 'image' && <img src={src || a.thumb} alt="" className="max-w-full max-h-[360px] object-contain" />}
        {a.kind === 'video' && (src ? <video key={a.id} src={src} poster={a.thumb} controls playsInline preload="metadata" className="w-full max-h-[360px] bg-black" />
          : <div className="relative w-full"><img src={a.thumb} alt="" className="w-full" /><span className="absolute inset-0 grid place-items-center bg-black/40 text-white text-sm gap-2"><span className="flex items-center gap-2"><Spinner />Preparing a playable copy…</span></span></div>)}
        {a.kind === 'audio' && <div className="w-full p-4 flex flex-col gap-3"><Waveform asset={a} audio={audio} />{src ? <audio ref={audio} key={a.id} src={src} controls preload="metadata" className="w-full" /> : <div className="text-sm text-fg2 flex items-center gap-2"><Spinner />Preparing a playable copy…</div>}</div>}
        {a.kind === 'pdf' && <div className="p-4 w-full grid place-items-center min-h-60"><PdfPreview key={a.id} url={a.url} width={300} onInfo={setPdfInfo} className="max-w-full shadow-lg bg-white" /></div>}
        {!['image', 'video', 'audio', 'pdf'].includes(a.kind) && <div className="py-10"><Icon name="file" size={40} className="text-fg3" /></div>}
      </div>
      <AssetActions a={a} nav={nav} reload={reload} />
      <div className="mt-4">
        <MetaRow label="Type">{KIND_LABEL[a.kind] || 'File'} · <span className="text-fg2">{a.mime}</span></MetaRow>
        <MetaRow label="Size">{fmtBytes(a.size)}</MetaRow>
        <MetaRow label="Dimensions">{a.width ? `${a.width} × ${a.height} px` : null}</MetaRow>
        <MetaRow label="Duration">{a.duration ? fmtTime(a.duration) : null}</MetaRow>
        <MetaRow label="Frame rate">{a.kind === 'video' && a.fps ? `${+Number(a.fps).toFixed(3)} fps` : null}</MetaRow>
        <MetaRow label="Video codec">{a.kind === 'video' ? m.vcodec?.toUpperCase() : null}</MetaRow>
        <MetaRow label="Audio codec">{['video', 'audio'].includes(a.kind) ? (m.acodec ? m.acodec.toUpperCase() : a.kind === 'video' && a.has_audio === false ? 'No sound' : null) : null}</MetaRow>
        <MetaRow label="Container">{['video', 'audio'].includes(a.kind) ? m.format : null}</MetaRow>
        <MetaRow label="Pages">{pdfInfo?.pages}</MetaRow>
        <MetaRow label="Page size">{pdfInfo ? `${pdfInfo.width} × ${pdfInfo.height} pt` : null}</MetaRow>
        <MetaRow label="Added">{new Date(a.created_at).toLocaleString()}</MetaRow>
        <MetaRow label="Source">{a.is_export ? 'Export' : a.source?.includes('cloud:') ? 'Minami Cloud' : 'Upload'}</MetaRow>
        <MetaRow label="Browser copy">{a.web_status === 'processing' ? 'Converting…' : a.web_status === 'failed' ? 'Couldn’t convert' : null}</MetaRow>
      </div>
    </>
  );
}

function AssetActions({ a, nav, reload }) {
  const targets = openTargets(a);
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {targets.length === 1 && <Button size="sm" variant="primary" icon="external" onClick={() => openIn(a, targets[0], nav)}>Open in {appById(targets[0].app)?.name}</Button>}
      {targets.length > 1 && <Button size="sm" variant="primary" icon="external" iconRight="chevronDown" onClick={(e) => openMenu(e.currentTarget, targets.map((t) => ({ label: appById(t.app)?.name, onClick: () => openIn(a, t, nav) })))}>Open in…</Button>}
      <Button size="sm" icon="download" onClick={() => { location.href = `${a.url}?download=1`; }}>Download</Button>
      <IconButton icon="more" label="More actions" size={28} className="bg-chip" onClick={(e) => openMenu(e.currentTarget, assetMenu(a, { nav, reload }), { align: 'end' })} />
    </div>
  );
}

function DocPreview({ d, nav, reload }) {
  const app = appById(d.app);
  return (
    <>
      <div className="rounded-xl bg-panel-2 overflow-hidden grid place-items-center min-h-40 aspect-[4/3]">
        {d.thumb ? <img src={d.thumb} alt="" className="max-w-full max-h-full object-contain" /> : <AppTile app={d.app} size={72} />}
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {!d.trashed_at && <Button size="sm" variant="primary" icon="external" onClick={() => nav(`/${d.app}/${d.id}`)}>Open</Button>}
        {d.trashed_at && <Button size="sm" variant="primary" icon="refresh" onClick={async () => { await api.post(`/api/docs/${d.id}/restore`).catch(toastError); reload(); }}>Restore</Button>}
        {!d.trashed_at && <Button size="sm" icon="share" onClick={() => shareDialog(d)}>Share</Button>}
        <IconButton icon="more" label="More actions" size={28} className="bg-chip" onClick={(e) => openMenu(e.currentTarget, projectMenu(d, { nav, onChange: reload }), { align: 'end' })} />
      </div>
      <div className="mt-4">
        <MetaRow label="App"><span className="inline-flex items-center gap-1.5"><AppTile app={d.app} size={18} />{app?.name}</span></MetaRow>
        <MetaRow label="Owner">{d.owner ? d.owner.name : 'You'}</MetaRow>
        <MetaRow label="Size">{d.width ? `${d.width} × ${d.height}` : null}</MetaRow>
        <MetaRow label="Duration">{d.duration ? fmtTime(d.duration) : null}</MetaRow>
        <MetaRow label="Pages">{d.pages}</MetaRow>
        <MetaRow label="Modified">{new Date(d.updated_at).toLocaleString()}</MetaRow>
        <MetaRow label="Created">{new Date(d.created_at).toLocaleString()}</MetaRow>
        <MetaRow label="In trash since">{d.trashed_at ? new Date(d.trashed_at).toLocaleString() : null}</MetaRow>
        <MetaRow label="Shared">{d.shared ? 'Yes' : null}</MetaRow>
        <MetaRow label="Saved data">{fmtBytes(d.size)}</MetaRow>
      </div>
    </>
  );
}

function PreviewPane({ item, onClose, nav, reload }) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="font-head font-semibold text-[15px] flex-1 min-w-0 truncate" title={item.name}>{item.name}</h2>
        <IconButton icon="close" label="Close preview" size={28} onClick={onClose} />
      </div>
      {item.type === 'doc' ? <DocPreview d={item.raw} nav={nav} reload={reload} /> : <AssetPreview a={item.raw} nav={nav} reload={reload} />}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function TsunamiDialog({ asset, onClose }) {
  const [title, setTitle] = useState(asset.name.replace(/\.[^.]+$/, ''));
  const [desc, setDesc] = useState('');
  const [vis, setVis] = useState('private');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/tsunami/publish', { asset_id: asset.id, title, description: desc, visibility: vis });
      toast('Published to Tsunami', { type: 'success', action: r.url ? { label: 'Watch', onClick: () => window.open(r.url, '_blank') } : undefined });
      onClose(r);
    } catch (e) { toastError(e, 'Couldn’t publish'); setBusy(false); }
  };
  return (
    <Modal title="Publish to Tsunami" onClose={() => onClose(null)} width={460}
      footer={<><Button variant="ghost" onClick={() => onClose(null)}>Cancel</Button><Button variant="primary" icon="upload" busy={busy} disabled={!title.trim()} onClick={go}>Publish</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Title"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} /></Field>
        <Field label="Description"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className="w-full px-2.5 py-2 rounded-md bg-input border border-line text-sm text-fg outline-none focus:border-accent/70 resize-y" /></Field>
        <Field label="Who can watch">
          <Segmented size="md" value={vis} onChange={setVis} options={[{ value: 'private', label: 'Private', icon: 'lock' }, { value: 'unlisted', label: 'Unlisted', icon: 'link' }, { value: 'public', label: 'Public', icon: 'users' }]} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- storage

function StorageCard({ storage, onFreed }) {
  // Old copies of layers and edits that no project or version uses any more (the server also clears them every few hours).
  const [unused, setUnused] = useState(null);
  const [freeing, setFreeing] = useState(false);
  const total = storage?.total;
  useEffect(() => { if (total !== undefined) api.get('/api/storage/unused').then(setUnused).catch(() => setUnused(null)); }, [total]);
  const freeUp = async () => {
    if (!(await confirmDialog({
      title: 'Free up space?',
      message: `This removes ${unused.files} unused file${unused.files === 1 ? '' : 's'} (${fmtBytes(unused.bytes)}): old copies of layers and edits that your editors saved along the way, which no project or saved version uses any more and which are over ${unused.grace_hours} hours old. Your projects, their versions, uploads, library items and exports stay as they are.`,
      confirm: 'Free up space',
    }))) return;
    setFreeing(true);
    try {
      const r = await api.post('/api/storage/cleanup', {});
      toast(r.files ? `Freed ${fmtBytes(r.bytes)} (${r.files} file${r.files === 1 ? '' : 's'})` : 'Nothing to free up', { type: 'success' });
      onFreed?.();
    } catch (e) { toastError(e); }
    setFreeing(false);
  };
  if (!storage) return null;
  const parts = [
    { key: 'assets', label: 'Files', color: '#5AB4FF' }, { key: 'docs', label: 'Projects', color: '#8B7CFF' },
    { key: 'versions', label: 'Versions', color: '#FF8FB1' }, { key: 'fonts', label: 'Fonts', color: '#FFC36B' },
  ];
  const cap = storage.quota || Math.max(1, storage.total);
  return (
    <div className="w-full sm:w-72 text-sm">
      <div className="flex justify-between text-fg2 mb-1.5"><span>Storage</span><span className="text-fg">{fmtBytes(storage.total)}{storage.quota ? <span className="text-fg2"> of {fmtBytes(storage.quota)}</span> : ''}</span></div>
      <div className="h-2 rounded-full bg-chip overflow-hidden flex" role="img" aria-label={`Storage used: ${fmtBytes(storage.total)}`}>
        {parts.map((p) => <span key={p.key} style={{ width: `${(storage[p.key] / cap) * 100}%`, background: p.color }} className="h-full" />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11.5px] text-fg2">
        {parts.map((p) => <span key={p.key} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: p.color }} />{p.label} {fmtBytes(storage[p.key])}</span>)}
      </div>
      {!storage.quota && <div className="text-[11.5px] text-fg3 mt-1">No limit on this server</div>}
      {unused?.files > 0 && (
        <div className="flex items-center gap-2 mt-1.5 text-[11.5px] text-fg2" data-testid="storage-unused">
          <span className="truncate">Unused: {unused.files} file{unused.files === 1 ? '' : 's'}, {fmtBytes(unused.bytes)}</span>
          <Button size="sm" variant="ghost" icon="trash" busy={freeing} onClick={freeUp}>Free up space</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function Files() {
  const nav = useNavigate();
  const { setMe } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = ['projects', 'uploads', 'exports'].includes(params.get('tab')) ? params.get('tab') : 'projects';
  const appFilter = params.get('app') || '';
  const view = ['recent', 'starred', 'shared', 'trash'].includes(params.get('view')) ? params.get('view') : 'recent';
  const setParam = (patch) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });

  const [layout, setLayout] = useStored('sl-files-layout', 'grid');
  const [sort, setSort] = useStored('sl-files-sort', { key: 'date', dir: 'desc' });
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const [sel, setSel] = useState(() => new Set());
  const lastClicked = useRef(null);
  const [previewKey, setPreviewKey] = useState(null);
  const [storage, setStorage] = useState(null);
  const [upload, setUpload] = useState(null); // { label, p, xhr }
  const [tsunami, setTsunami] = useState(null);
  const wide = useWide(1024);
  const fileInput = useRef(null);

  useEffect(() => { document.title = 'Files — SoraLab'; }, []);
  useEffect(() => {
    const f = (e) => setTsunami(e.detail);
    window.addEventListener('sl-files-tsunami', f);
    return () => window.removeEventListener('sl-files-tsunami', f);
  }, []);

  const loadStorage = useCallback(() => api.get('/api/me').then((m) => { setStorage(m.storage); setMe((x) => (x ? { ...x, storage: m.storage } : x)); }).catch(() => {}), [setMe]);
  const load = useCallback(async () => {
    try {
      if (tab === 'projects') {
        const list = await api.get(`/api/docs?view=${view}${appFilter ? `&app=${appFilter}` : ''}`);
        setItems(list.map(fromDoc));
      } else {
        const list = await api.get(`/api/assets?limit=1000${tab === 'exports' ? '&exports=1' : ''}`);
        setItems((tab === 'uploads' ? list.filter((a) => !a.is_export) : list).map(fromAsset));
      }
    } catch (e) { toastError(e); setItems([]); }
  }, [tab, view, appFilter]);
  const loadCounts = useCallback(async () => {
    try {
      const [docs, assets] = await Promise.all([api.get('/api/docs?view=recent'), api.get('/api/assets?limit=1000')]);
      setCounts({ projects: docs.length, uploads: assets.filter((a) => !a.is_export).length, exports: assets.filter((a) => a.is_export).length });
    } catch { /* counts are a nicety */ }
  }, []);
  const reload = useCallback(() => { load(); loadCounts(); loadStorage(); }, [load, loadCounts, loadStorage]);

  useEffect(() => { setItems(null); setSel(new Set()); setPreviewKey(null); load(); }, [load]);
  useEffect(() => { loadCounts(); loadStorage(); }, [loadCounts, loadStorage]);
  // Files still being converted for the browser: check back until they're ready.
  useEffect(() => {
    if (!items?.some((i) => i.type === 'asset' && i.raw.web_status === 'processing')) return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [items, load]);

  const shown = useMemo(() => {
    if (!items) return null;
    const needle = q.trim().toLowerCase();
    const list = items.filter((i) => (!needle || i.name.toLowerCase().includes(needle)) && (!kind || tab === 'projects' || i.raw.kind === kind));
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      date: (a, b) => a.date - b.date, size: (a, b) => a.size - b.size,
      type: (a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name),
    }[sort.key] || (() => 0);
    return [...list].sort((a, b) => cmp(a, b) * dir);
  }, [items, q, kind, sort, tab]);

  const preview = shown?.find((i) => i.key === previewKey) || null;
  const selectedItems = shown ? shown.filter((i) => sel.has(i.key)) : [];

  const select = (item, e = {}) => {
    const keys = shown.map((i) => i.key);
    if (e.shiftKey && lastClicked.current && keys.includes(lastClicked.current)) {
      const [a, b] = [keys.indexOf(lastClicked.current), keys.indexOf(item.key)].sort((x, y) => x - y);
      setSel(new Set([...(e.ctrlKey || e.metaKey ? sel : []), ...keys.slice(a, b + 1)]));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel);
      if (n.has(item.key)) n.delete(item.key); else n.add(item.key);
      setSel(n);
      lastClicked.current = item.key;
    } else {
      setSel(new Set([item.key]));
      lastClicked.current = item.key;
      setPreviewKey(item.key);
    }
  };
  const openItem = (item) => {
    if (item.type === 'doc') { if (!item.raw.trashed_at) nav(`/${item.raw.app}/${item.raw.id}`); }
    else setPreviewKey(item.key);
  };
  const menuFor = (item) => (item.type === 'doc' ? projectMenu(item.raw, { nav, onChange: reload }) : assetMenu(item.raw, { nav, reload, setPreview: () => setPreviewKey(item.key) }));

  // ---- bulk actions
  const bulkDelete = async () => {
    const list = selectedItems;
    if (!list.length) return;
    const docs = list.filter((i) => i.type === 'doc');
    const assets = list.filter((i) => i.type === 'asset');
    const forever = view === 'trash';
    if (assets.length || forever) {
      const ok = await confirmDialog({
        title: `Delete ${list.length} item${list.length > 1 ? 's' : ''}${forever ? ' forever' : ''}?`,
        message: forever ? 'These projects will be deleted for good. This can’t be undone.' : 'Files are deleted for good. This can’t be undone.',
        confirm: 'Delete', danger: true,
      });
      if (!ok) return;
    }
    let failed = 0;
    for (const i of docs) {
      const d = i.raw;
      const url = forever ? `/api/docs/${d.id}?permanent=1` : d.role === 'owner' ? `/api/docs/${d.id}` : `/api/docs/${d.id}/shares/me`;
      await api.del(url).catch(() => { failed++; });
    }
    for (const i of assets) await api.del(`/api/assets/${i.id}`).catch(() => { failed++; });
    toast(failed ? `${failed} couldn’t be deleted` : docs.length && !forever && !assets.length ? `Moved ${docs.length} to the trash` : 'Deleted', { type: failed ? 'error' : 'info' });
    setSel(new Set());
    reload();
  };
  const bulkRestore = async () => {
    for (const i of selectedItems) await api.post(`/api/docs/${i.id}/restore`).catch(toastError);
    setSel(new Set()); reload();
  };
  const bulkDownload = () => {
    // One at a time, a moment apart, so the browser doesn't block them as a pop-up storm.
    selectedItems.filter((i) => i.type === 'asset').forEach((i, n) => setTimeout(() => {
      const a = document.createElement('a'); a.href = `${i.raw.url}?download=1`; a.download = i.name; document.body.appendChild(a); a.click(); a.remove();
    }, n * 400));
  };
  const emptyTrash = async () => {
    if (!(await confirmDialog({ title: 'Empty the trash?', message: 'Every project in the trash is deleted for good. This can’t be undone.', confirm: 'Empty trash', danger: true }))) return;
    try { await api.post('/api/docs/trash/empty'); toast('Trash emptied'); } catch (e) { toastError(e); }
    reload();
  };

  // ---- adding files
  const doUpload = async (files) => {
    const list = [...files];
    if (!list.length) return;
    setUpload({ label: `Uploading ${list.length} file${list.length > 1 ? 's' : ''}`, p: 0 });
    try {
      const out = await uploadFiles(list, { onProgress: (p) => setUpload((u) => (u ? { ...u, p } : u)), onStart: (xhr) => setUpload((u) => ({ ...u, xhr })) });
      toast(`Uploaded ${out.length} file${out.length > 1 ? 's' : ''}`, { type: 'success' });
      if (tab !== 'uploads') setParam({ tab: 'uploads', app: '', view: '' });
      else reload();
      loadCounts(); loadStorage();
    } catch (e) { if (!e.cancelled) toastError(e, 'Upload failed'); }
    setUpload(null);
  };
  const dropOverlay = useDropAnywhere(doUpload, { label: 'Drop to upload to Files', hint: 'Images, video, audio and PDFs' });
  const importCloud = async () => {
    const files = await pickCloudFiles({ multiple: true, title: 'Import from Minami Cloud' });
    if (!files?.length) return;
    setUpload({ label: `Copying ${files.length} file${files.length > 1 ? 's' : ''} from Minami Cloud`, p: null });
    let n = 0;
    for (const f of files) {
      try { await api.post('/api/cloud/import', { file_id: f.id }); n++; } catch (e) { toastError(e, f.name); }
      setUpload((u) => ({ ...u, p: n / files.length }));
    }
    setUpload(null);
    if (n) toast(`Imported ${n} file${n > 1 ? 's' : ''}`, { type: 'success' });
    if (tab !== 'uploads') setParam({ tab: 'uploads', app: '', view: '' }); else reload();
  };
  const openSora = async () => {
    const [f] = (await pickCloudFiles({ title: 'Open a SoraLab project (.sora)' })) || [];
    if (!f) return;
    try { const d = await api.post('/api/cloud/open', { file_id: f.id }); nav(`/${d.app}/${d.id}`); } catch (e) { toastError(e); }
  };

  // ---- keyboard: Ctrl+A selects all, Delete deletes, Escape clears
  useEffect(() => {
    const key = (e) => {
      if (e.target.closest?.('input,textarea,select,[contenteditable=true],[role=dialog]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && shown?.length) { e.preventDefault(); setSel(new Set(shown.map((i) => i.key))); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); bulkDelete(); }
      else if (e.key === 'Escape' && sel.size) setSel(new Set());
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const tabs = [
    { value: 'projects', label: 'Projects', count: counts.projects },
    { value: 'uploads', label: 'Uploads', count: counts.uploads },
    { value: 'exports', label: 'Exports', count: counts.exports },
  ];
  const allSelected = shown?.length > 0 && shown.every((i) => sel.has(i.key));
  const docApps = APPS.filter((a) => a.doc);

  const content = !shown ? <div className="py-16 grid place-items-center"><Spinner size={22} /></div>
    : !shown.length ? (
      q || kind ? <EmptyState icon="search" title="Nothing matches">Try a different search or filter.</EmptyState>
        : tab === 'projects' ? (
          <EmptyState icon={{ starred: 'star', shared: 'users', trash: 'trash' }[view] || 'sparkles'}
            title={{ starred: 'No starred projects', shared: 'Nothing shared with you yet', trash: 'The trash is empty' }[view] || (appFilter ? `No ${appById(appFilter)?.name} projects yet` : 'No projects yet')}>
            {{ starred: 'Star projects you come back to often.', shared: 'When someone shares a project with you, it shows up here.', trash: 'Projects you delete stay here until you empty the trash.' }[view] || 'Start one from Home or an app’s page.'}
          </EmptyState>
        ) : tab === 'exports' ? <EmptyState icon="export" title="No exports yet">When you export to Files from any app, it lands here.</EmptyState>
          : <EmptyState icon="upload" title="No uploads yet" action={<Button variant="primary" icon="upload" onClick={() => fileInput.current.click()}>Upload files</Button>}>Drop files anywhere on this page, or import them from Minami Cloud.</EmptyState>
    ) : layout === 'grid' ? (
      <div role="listbox" aria-multiselectable="true" aria-label="Files" className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 sm:gap-4">
        {shown.map((i) => (
          <GridItem key={i.key} item={i} selected={sel.has(i.key)} anySelected={sel.size > 1} current={previewKey === i.key}
            onSelect={(e) => select(i, e)} onOpen={() => openItem(i)} onMenu={(e) => openMenu(e.type === 'contextmenu' ? e : e.currentTarget, menuFor(i), { align: 'end' })} />
        ))}
      </div>
    ) : (
      <div role="listbox" aria-multiselectable="true" aria-label="Files" className="rounded-xl border border-line bg-surface overflow-hidden">
        <div className="hidden md:grid grid-cols-[auto_44px_minmax(0,1fr)_140px_90px_130px_auto] items-center gap-3 px-3 h-9 border-b border-line text-[11.5px] uppercase tracking-wider text-fg3">
          <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(shown.map((i) => i.key)))} aria-label="Select all" className="accent-[#5AB4FF] w-4 h-4" />
          <span />
          {[['name', 'Name'], ['type', 'Type'], ['size', 'Size'], ['date', 'Modified']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setSort({ key: k, dir: sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc' })} className={cx('flex items-center gap-1 text-left hover:text-fg', sort.key === k && 'text-fg')}>
              {l}{sort.key === k && <Icon name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={12} />}
            </button>
          ))}
          <span className="w-[30px]" />
        </div>
        {shown.map((i) => (
          <ListRow key={i.key} item={i} selected={sel.has(i.key)} current={previewKey === i.key}
            onSelect={(e) => select(i, e)} onOpen={() => openItem(i)} onMenu={(e) => openMenu(e.type === 'contextmenu' ? e : e.currentTarget, menuFor(i), { align: 'end' })} />
        ))}
      </div>
    );

  return (
    <PageLayout wide>
      <PageHero icon="folder" title="Files" subtitle="Every project, upload and export in one place.">
        <StorageCard storage={storage} onFreed={loadStorage} />
      </PageHero>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Button variant="primary" icon="upload" onClick={() => fileInput.current.click()}>Upload</Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { doUpload(e.target.files); e.target.value = ''; }} />
        <Button icon="cloud" onClick={importCloud}>Import from Minami Cloud</Button>
        <Button variant="ghost" icon="folder" onClick={openSora}><span className="hidden sm:inline">Open .sora from Cloud</span><span className="sm:hidden">Open .sora</span></Button>
      </div>

      {upload && (
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl border border-line bg-surface text-sm sl-pop">
          <Spinner />
          <span className="shrink-0">{upload.label}{upload.p !== null && upload.p !== undefined ? ` · ${Math.round(upload.p * 100)}%` : '…'}</span>
          <ProgressBar value={upload.p ?? 0} indeterminate={upload.p === null} className="flex-1" />
          {upload.xhr && <Button size="sm" variant="ghost" onClick={() => upload.xhr.abort()}>Cancel</Button>}
        </div>
      )}

      <Tabs value={tab} onChange={(t) => setParam({ tab: t === 'projects' ? '' : t, app: '', view: '' })} tabs={tabs} className="mb-3 overflow-x-auto no-scrollbar" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {tab === 'projects' ? (
          <>
            <Segmented value={view} onChange={(v) => setParam({ view: v === 'recent' ? '' : v })} className="max-w-full overflow-x-auto no-scrollbar"
              options={[{ value: 'recent', label: 'Recent', icon: 'clock' }, { value: 'starred', label: 'Starred', icon: 'star' }, { value: 'shared', label: 'Shared', icon: 'users' }, { value: 'trash', label: 'Trash', icon: 'trash' }]} />
            <Select small value={appFilter} onChange={(v) => setParam({ app: v })} aria-label="App"
              options={[{ value: '', label: 'All apps' }, ...docApps.map((a) => ({ value: a.id, label: a.name }))]} />
            {view === 'trash' && items?.length > 0 && <Button size="sm" variant="ghost" icon="trash" className="!text-danger" onClick={emptyTrash}>Empty trash</Button>}
          </>
        ) : (
          <Segmented value={kind} onChange={setKind} className="max-w-full overflow-x-auto no-scrollbar"
            options={[{ value: '', label: 'All' }, { value: 'image', label: 'Images', icon: 'image' }, { value: 'video', label: 'Video', icon: 'video' }, { value: 'audio', label: 'Audio', icon: 'audio' }, { value: 'pdf', label: 'PDF', icon: 'pdf' }]} />
        )}
        <div className="flex-1" />
        <div className="relative w-full sm:w-56 order-last sm:order-none">
          <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tab}`} aria-label="Search"
            className="w-full h-8 pl-8 pr-2.5 rounded-md bg-input border border-line text-sm text-fg placeholder:text-fg3 outline-none focus:border-accent/70" />
        </div>
        <Select small value={sort.key} onChange={(k) => setSort({ key: k, dir: k === 'name' || k === 'type' ? 'asc' : 'desc' })} options={SORTS} aria-label="Sort by" />
        <IconButton icon="sort" label={sort.dir === 'asc' ? 'Ascending' : 'Descending'} size={32} className={cx('bg-chip', sort.dir === 'asc' && 'rotate-180')} onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })} />
        <Segmented value={layout} onChange={setLayout} options={[{ value: 'grid', icon: 'grid', title: 'Grid' }, { value: 'list', icon: 'list', title: 'List' }]} />
      </div>

      {(sel.size > 1 || (sel.size === 1 && !sel.has(previewKey))) && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-xl border border-accent/40 bg-menu shadow-[0_8px_30px_rgba(0,0,0,.25)] sl-pop">
          <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(shown.map((i) => i.key)))} aria-label="Select all" className="accent-[#5AB4FF] w-4 h-4" />
          <span className="text-sm font-medium mr-2">{sel.size} selected</span>
          {tab !== 'projects' && <Button size="sm" icon="download" onClick={bulkDownload}>Download</Button>}
          {view === 'trash' && tab === 'projects' && <Button size="sm" icon="refresh" onClick={bulkRestore}>Restore</Button>}
          <Button size="sm" variant="danger" icon="trash" onClick={bulkDelete}>{tab === 'projects' && view !== 'trash' ? 'Move to trash' : 'Delete'}</Button>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
      )}

      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0 pb-10">{content}</div>
        {preview && wide && (
          <aside className="w-[340px] shrink-0 sticky top-0 max-h-[calc(100vh-6.5rem)] overflow-auto scroll-thin rounded-xl border border-line bg-surface p-4 sl-pop" aria-label="Preview">
            <PreviewPane item={preview} onClose={() => setPreviewKey(null)} nav={nav} reload={reload} />
          </aside>
        )}
      </div>
      {preview && !wide && (
        <Modal onClose={() => setPreviewKey(null)} width={520} bodyClassName="!p-4">
          <PreviewPane item={preview} onClose={() => setPreviewKey(null)} nav={nav} reload={reload} />
        </Modal>
      )}
      {tsunami && <TsunamiDialog asset={tsunami.asset} onClose={(r) => { tsunami.resolve(r); setTsunami(null); }} />}
      {dropOverlay}
    </PageLayout>
  );
}
