// Pickers shared by every app: files from Minami Cloud, a Cloud folder to save into, files to place (upload / Files / Cloud),
// and fonts. Each has a promise-based helper so editors can simply `const assets = await pickAssets({ kinds: ['image'] })`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, uploadFiles, fmtBytes, fmtTime } from '../lib/api.js';
import { useFonts, ensureFont, WEIGHT_NAMES } from '../lib/fonts.js';
import { Modal, Button, IconButton, Spinner, TextInput, Tabs, EmptyState, ProgressBar, Popover, toastError, cx } from './ui.jsx';
import { Icon } from './Icons.jsx';

/** Renders a modal outside React trees (used by the promise helpers). */
function mount(render) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { setTimeout(() => { root.unmount(); host.remove(); }, 0); };
  root.render(render(close));
}

const kindIcon = (f) => (f.folder ? 'folder' : f.kind === 'image' ? 'image' : f.kind === 'video' ? 'video' : f.kind === 'audio' ? 'audio' : f.mime === 'application/pdf' ? 'pdf' : 'file');

// ---------------------------------------------------------------- Minami Cloud browser

function CloudBrowser({ kinds, mode, multiple, onPick, selected, setSelected, folder, setFolder }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  useEffect(() => {
    let off = false;
    setData(null); setError(null);
    api.get(`/api/cloud/folders/${encodeURIComponent(folder)}?kind=${encodeURIComponent((kinds || []).join(','))}`)
      .then((d) => { if (!off) setData(d); }).catch((e) => { if (!off) setError(e); });
    return () => { off = true; };
  }, [folder, kinds]);
  useEffect(() => {
    if (!q.trim()) { setResults(null); return undefined; }
    const t = setTimeout(() => api.get(`/api/cloud/search?q=${encodeURIComponent(q)}&kind=${kinds?.length === 1 ? kinds[0] : ''}`).then((r) => setResults(r.items)).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, kinds]);
  if (error) return <EmptyState icon="cloud" title="Minami Cloud isn’t available">{error.message}</EmptyState>;
  const items = (results || data?.items || []).filter((f) => mode !== 'folder' || f.folder);
  return (
    <div className="flex flex-col h-[52vh] min-h-72">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-1 text-sm min-w-0 flex-1 overflow-x-auto no-scrollbar">
          {(data?.path || [{ id: 'root', name: 'My Drive' }]).map((p, i, a) => (
            <span key={p.id} className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => { setQ(''); setFolder(p.id); }} className={cx('hover:underline', i === a.length - 1 ? 'text-fg font-medium' : 'text-fg2')}>{p.name}</button>
              {i < a.length - 1 && <Icon name="chevronRight" size={13} className="text-fg3" />}
            </span>
          ))}
        </div>
        {mode !== 'folder' && <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Cloud" className="!w-44 !h-7 text-[13px]" />}
      </div>
      <div className="flex-1 overflow-auto scroll-thin rounded-lg border border-line bg-panel-2/40">
        {!data && !results ? <div className="grid place-items-center h-full"><Spinner /></div>
          : !items.length ? <EmptyState icon="folder" title={mode === 'folder' ? 'No folders here' : 'Nothing here'}>{mode === 'folder' ? 'You can save right here.' : kinds?.length ? `No ${kinds.join(' or ')} files in this folder.` : ''}</EmptyState>
            : items.map((f) => {
              const sel = selected.some((s) => s.id === f.id);
              return (
                <button key={f.id} type="button"
                  onClick={() => (f.folder ? (setQ(''), setFolder(f.id)) : setSelected(multiple ? (sel ? selected.filter((s) => s.id !== f.id) : [...selected, f]) : [f]))}
                  onDoubleClick={() => !f.folder && onPick([f])}
                  className={cx('w-full flex items-center gap-3 px-3 h-10 text-left text-sm border-b border-line/60', sel ? 'bg-active' : 'hover:bg-hover')}>
                  <Icon name={kindIcon(f)} size={18} className={f.folder ? 'text-accent' : 'text-fg2'} />
                  <span className="flex-1 truncate">{f.name}</span>
                  {!f.folder && <span className="text-xs text-fg3">{fmtBytes(f.size)}</span>}
                </button>
              );
            })}
      </div>
    </div>
  );
}

/** Pick files from Minami Cloud. Resolves to Cloud file objects, or null if cancelled. */
export function pickCloudFiles({ kinds, multiple = false, title = 'Open from Minami Cloud' } = {}) {
  return new Promise((resolve) => mount((close) => <CloudFilesDialog title={title} kinds={kinds} multiple={multiple} done={(r) => { resolve(r); close(); }} />));
}
function CloudFilesDialog({ title, kinds, multiple, done }) {
  const [folder, setFolder] = useState('root');
  const [selected, setSelected] = useState([]);
  return (
    <Modal title={title} onClose={() => done(null)} width={620}
      footer={<><Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" disabled={!selected.length} onClick={() => done(selected)}>Open{selected.length > 1 ? ` ${selected.length}` : ''}</Button></>}>
      <CloudBrowser kinds={kinds} multiple={multiple} folder={folder} setFolder={setFolder} selected={selected} setSelected={setSelected} onPick={done} />
    </Modal>
  );
}

/** Choose a Cloud folder and file name to save into. Resolves to { folder_id, name } or null. */
export function pickCloudFolder({ name = '', title = 'Save to Minami Cloud', confirm = 'Save' } = {}) {
  return new Promise((resolve) => mount((close) => <CloudFolderDialog title={title} name={name} confirm={confirm} done={(r) => { resolve(r); close(); }} />));
}
function CloudFolderDialog({ title, name, confirm, done }) {
  const [folder, setFolder] = useState('root');
  const [n, setN] = useState(name);
  const [selected, setSelected] = useState([]);
  return (
    <Modal title={title} onClose={() => done(null)} width={620}
      footer={<><Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" disabled={n !== null && !n.trim()} onClick={() => done({ folder_id: folder, name: n?.trim() ?? null })}>{confirm}</Button></>}>
      {name !== null && <label className="block mb-3"><span className="text-xs text-fg2 block mb-1">File name</span><TextInput value={n} onChange={(e) => setN(e.target.value)} /></label>}
      <CloudBrowser mode="folder" folder={folder} setFolder={setFolder} selected={selected} setSelected={setSelected} onPick={() => {}} />
    </Modal>
  );
}

/** Saves an asset (export) or a project to Cloud, asking where. Returns the Cloud file, or null. */
export async function saveToCloud({ assetId, docId, name }) {
  const where = await pickCloudFolder({ name });
  if (!where) return null;
  return api.post('/api/cloud/save', { asset_id: assetId, doc_id: docId, folder_id: where.folder_id, name: where.name });
}

// ---------------------------------------------------------------- place / import files

/**
 * Pick files to use in a project: upload from this device, choose from Files (things already in SoraLab), or copy from Cloud.
 * Resolves to an array of SoraLab assets (already uploaded), or null.
 * kinds: ['image'] | ['video','audio'] | ['pdf'] …   docId: attach uploads to this project.
 */
export function pickAssets({ kinds, multiple = true, docId, title = 'Place files' } = {}) {
  return new Promise((resolve) => mount((close) => <AssetDialog title={title} kinds={kinds} multiple={multiple} docId={docId} done={(r) => { resolve(r); close(); }} />));
}

const ACCEPT = { image: 'image/*,.heic,.heif,.tif,.tiff,.psd,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2', video: 'video/*,.mkv,.mov,.avi,.mts,.m2ts', audio: 'audio/*,.flac,.opus,.aif,.aiff', pdf: 'application/pdf,.pdf', font: '.ttf,.otf,.woff,.woff2' };
export const acceptFor = (kinds) => (kinds?.length ? kinds.map((k) => ACCEPT[k] || '').join(',') : '');

function AssetDialog({ title, kinds, multiple, docId, done }) {
  const [tab, setTab] = useState('device');
  const [mine, setMine] = useState(null);
  const [selected, setSelected] = useState([]);
  const [folder, setFolder] = useState('root');
  const [busy, setBusy] = useState(null);
  const input = useRef(null);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (tab !== 'files' || mine) return;
    api.get(`/api/assets?limit=400${kinds?.length === 1 ? `&kind=${kinds[0]}` : ''}`).then((l) => setMine(l.filter((a) => !kinds?.length || kinds.includes(a.kind)))).catch(() => setMine([]));
  }, [tab, mine, kinds]);
  const upload = async (files) => {
    const list = [...files].filter((f) => !kinds?.length || kinds.some((k) => f.type.startsWith(`${k}/`) || (k === 'pdf' && f.type === 'application/pdf') || new RegExp(`\\.(${(ACCEPT[k] || '').replace(/[^a-z0-9,]/gi, '').split(',').filter(Boolean).join('|')})$`, 'i').test(f.name)));
    if (!list.length) return;
    setBusy({ label: `Uploading ${list.length} file${list.length > 1 ? 's' : ''}…`, p: 0 });
    try { done(await uploadFiles(multiple ? list : list.slice(0, 1), { docId, onProgress: (p) => setBusy((b) => ({ ...b, p })) })); }
    catch (e) { toastError(e); setBusy(null); }
  };
  const fromCloud = async () => {
    setBusy({ label: 'Copying from Minami Cloud…', p: null });
    try {
      const out = [];
      for (const f of selected) out.push(await api.post('/api/cloud/import', { file_id: f.id, doc_id: docId }));
      done(out);
    } catch (e) { toastError(e); setBusy(null); }
  };
  const fromFiles = async () => {
    // Files already in SoraLab are linked to this project so people it's shared with can see them.
    // (keep: deleting the project later won't delete a file that was in Files on its own.)
    const out = [];
    for (const a of selected) out.push(docId && !a.doc_id ? await api.patch(`/api/assets/${a.id}`, { doc_id: docId, keep: true }).catch(() => a) : a);
    done(out);
  };
  return (
    <Modal title={title} onClose={() => done(null)} width={680}
      footer={busy ? <div className="flex-1 flex items-center gap-3 text-sm text-fg2"><Spinner />{busy.label}{busy.p !== null && <ProgressBar value={busy.p} className="flex-1" />}</div>
        : tab === 'device' ? <Button variant="ghost" onClick={() => done(null)}>Cancel</Button>
          : <><Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" disabled={!selected.length} onClick={tab === 'cloud' ? fromCloud : fromFiles}>Place{selected.length > 1 ? ` ${selected.length}` : ''}</Button></>}>
      <Tabs className="mb-3 -mt-1" value={tab} onChange={(t) => { setTab(t); setSelected([]); }} tabs={[{ value: 'device', label: 'This device' }, { value: 'files', label: 'Files' }, { value: 'cloud', label: 'Minami Cloud' }]} />
      {tab === 'device' && (
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
          className={cx('h-[44vh] min-h-64 rounded-xl border-2 border-dashed grid place-items-center text-center transition', drag ? 'border-accent bg-accent/10' : 'border-line')}>
          <div>
            <Icon name="upload" size={34} className="mx-auto text-fg2 mb-3" />
            <div className="font-medium">Drop files here</div>
            <div className="text-sm text-fg2 mb-4">{kinds?.length ? `${kinds.join(', ')} files` : 'Any image, video, audio or PDF'}</div>
            <Button variant="primary" icon="folder" onClick={() => input.current.click()}>Choose files</Button>
            <input ref={input} type="file" hidden multiple={multiple} accept={acceptFor(kinds)} onChange={(e) => upload(e.target.files)} />
          </div>
        </div>
      )}
      {tab === 'files' && (
        <div className="h-[44vh] min-h-64 overflow-auto scroll-thin">
          {!mine ? <div className="grid place-items-center h-full"><Spinner /></div> : !mine.length ? <EmptyState icon="file" title="Nothing yet">Files you upload or export appear here.</EmptyState> : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
              {mine.map((a) => {
                const sel = selected.some((s) => s.id === a.id);
                return (
                  <button key={a.id} type="button" onClick={() => setSelected(multiple ? (sel ? selected.filter((s) => s.id !== a.id) : [...selected, a]) : [a])} onDoubleClick={() => done([a])}
                    className={cx('rounded-lg overflow-hidden text-left border-2 transition', sel ? 'border-accent' : 'border-transparent hover:border-line')}>
                    <div className="aspect-[4/3] bg-panel-2 grid place-items-center overflow-hidden">
                      {a.thumb ? <img src={a.thumb} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Icon name={kindIcon(a)} size={28} className="text-fg3" />}
                    </div>
                    <div className="px-1.5 py-1 text-xs truncate">{a.name}</div>
                    <div className="px-1.5 pb-1 text-[10.5px] text-fg3">{a.duration ? fmtTime(a.duration) : a.width ? `${a.width}×${a.height}` : fmtBytes(a.size)}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {tab === 'cloud' && <CloudBrowser kinds={kinds} multiple={multiple} folder={folder} setFolder={setFolder} selected={selected} setSelected={setSelected} onPick={() => {}} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- fonts

/** Font family dropdown with live previews. value: family name. */
export function FontPicker({ value, onChange, weight = 400, className, width = 190 }) {
  const fonts = useFonts();
  const [anchor, setAnchor] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { if (value) ensureFont(value, weight); }, [value, weight]);
  const list = useMemo(() => fonts.filter((f) => !q || f.family.toLowerCase().includes(q.toLowerCase())), [fonts, q]);
  return (
    <>
      <button type="button" onClick={(e) => setAnchor(e.currentTarget)} style={{ width }}
        className={cx('h-7 rounded bg-input border border-line text-[13px] px-2 flex items-center gap-1 text-left', className)}>
        <span className="flex-1 truncate" style={{ fontFamily: `"${value}"` }}>{value || 'Font'}</span>
        <Icon name="chevronDown" size={13} className="text-fg3" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-72">
          <div className="p-2 border-b border-line"><TextInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fonts" className="!h-7" /></div>
          <div className="max-h-80 overflow-auto scroll-thin py-1">
            {list.map((f, i) => (
              <div key={f.family}>
                {(i === 0 || list[i - 1].category !== f.category) && <div className="px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-fg3">{f.category}</div>}
                <FontRow f={f} active={f.family === value} onPick={() => { onChange(f.family); setAnchor(null); }} />
              </div>
            ))}
            {!list.length && <div className="p-4 text-sm text-fg2">No fonts match. Add your own on the Fonts page.</div>}
          </div>
        </Popover>
      )}
    </>
  );
}
function FontRow({ f, active, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { ensureFont(f.family, f.weights.includes(400) ? 400 : f.weights[0]); io.disconnect(); } });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [f]);
  return (
    <button ref={ref} type="button" onClick={onPick} className={cx('w-full px-3 h-9 flex items-center text-left text-[15px] truncate', active ? 'bg-active' : 'hover:bg-hover')} style={{ fontFamily: `"${f.family}"` }}>
      {f.family}
    </button>
  );
}

/** Weight dropdown for a family. */
export function WeightPicker({ family, value, onChange, className }) {
  const fonts = useFonts();
  const f = fonts.find((x) => x.family === family);
  const weights = f?.weights || [400, 700];
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={cx('h-7 rounded bg-input border border-line text-[13px] px-1.5', className)}>
      {weights.map((w) => <option key={w} value={w}>{WEIGHT_NAMES[w] || w}</option>)}
    </select>
  );
}

