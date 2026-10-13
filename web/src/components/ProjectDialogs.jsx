// Project dialogs and side panels used by every editor: Share, Version history, Comments, Export.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, saveBlob, download, uploadWithProgress, ago, fmtBytes } from '../lib/api.js';
import { Modal, Button, IconButton, Spinner, TextInput, Select, Field, Segmented, Toggle, Slider, NumberInput, ProgressBar, EmptyState, confirmDialog, promptDialog, toast, toastError, cx } from './ui.jsx';
import { Icon } from './Icons.jsx';
import { pickCloudFolder } from './Pickers.jsx';

function mount(render) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => setTimeout(() => { root.unmount(); host.remove(); }, 0);
  root.render(render(close));
}

let configCache = null;
const getConfig = () => (configCache ||= api.get('/api/config').catch(() => ({})));

// ---------------------------------------------------------------- share

export const shareDialog = (doc) => new Promise((resolve) => mount((close) => <ShareDialog doc={doc} onClose={() => { resolve(); close(); }} />));

function ShareDialog({ doc, onClose }) {
  const [data, setData] = useState(null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/api/docs/${doc.id}/shares`).then(setData).catch(toastError);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const owner = doc.role === 'owner';
  const add = async () => {
    setBusy(true);
    try { await api.post(`/api/docs/${doc.id}/shares`, { username: who, role }); setWho(''); load(); toast('Shared', { type: 'success' }); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const link = `${location.origin}/${doc.app}/${doc.id}`;
  return (
    <Modal title={`Share “${doc.name}”`} onClose={onClose} width={520}>
      {owner && (
        <div className="flex gap-2 mb-4">
          <TextInput value={who} onChange={(e) => setWho(e.target.value)} placeholder="Username or email" onKeyDown={(e) => { if (e.key === 'Enter' && who.trim()) add(); }} />
          <Select value={role} onChange={setRole} options={[{ value: 'editor', label: 'Can edit' }, { value: 'commenter', label: 'Can comment' }, { value: 'viewer', label: 'Can view' }]} />
          <Button variant="primary" onClick={add} busy={busy} disabled={!who.trim()}>Invite</Button>
        </div>
      )}
      {!data ? <Spinner /> : (
        <div className="flex flex-col gap-1">
          <Person p={data.owner} label="Owner" />
          {data.people.map((p) => (
            <Person key={p.id} p={p} label={owner ? null : { editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' }[p.role]}>
              {owner && (
                <>
                  <Select small value={p.role} onChange={async (r) => { await api.post(`/api/docs/${doc.id}/shares`, { username: p.username, role: r }).catch(toastError); load(); }}
                    options={[{ value: 'editor', label: 'Can edit' }, { value: 'commenter', label: 'Can comment' }, { value: 'viewer', label: 'Can view' }]} />
                  <IconButton icon="close" label={`Remove ${p.name}`} size={28} onClick={async () => { await api.del(`/api/docs/${doc.id}/shares/${p.id}`).catch(toastError); load(); }} />
                </>
              )}
            </Person>
          ))}
        </div>
      )}
      <div className="mt-5 pt-4 border-t border-line flex items-center gap-2">
        <Icon name="link" size={16} className="text-fg2" />
        <span className="text-xs text-fg2 flex-1 truncate">{link}</span>
        <Button size="sm" icon="copy" onClick={() => { navigator.clipboard?.writeText(link); toast('Link copied'); }}>Copy link</Button>
      </div>
      <p className="text-[11px] text-fg3 mt-2">Only people you invite can open the link. They need to have opened SoraLab once with their {location.hostname} account.</p>
    </Modal>
  );
}
function Person({ p, label, children }) {
  if (!p) return null;
  return (
    <div className="flex items-center gap-3 h-11">
      {p.picture ? <img src={p.picture} alt="" className="w-8 h-8 rounded-full object-cover" /> : <span className="w-8 h-8 rounded-full sora-sky grid place-items-center text-white text-sm font-semibold">{p.name?.[0]}</span>}
      <div className="flex-1 min-w-0"><div className="text-sm truncate">{p.name}</div><div className="text-xs text-fg3 truncate">@{p.username}</div></div>
      {label && <span className="text-xs text-fg2">{label}</span>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- versions

export function VersionsPanel({ doc, onRestored, onPreview }) {
  const [data, setData] = useState(null);
  const load = () => api.get(`/api/docs/${doc.id}/versions`).then(setData).catch(toastError);
  useEffect(() => { load(); }, [doc.id, doc.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = ['owner', 'editor'].includes(doc.role);
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-line flex items-center gap-2">
        <span className="text-sm font-medium flex-1">Version history</span>
        {canEdit && <Button size="sm" icon="bookmark" onClick={async () => {
          const label = await promptDialog({ title: 'Name this version', label: 'Name', value: `Version ${new Date().toLocaleDateString()}` });
          if (label) { await api.post(`/api/docs/${doc.id}/versions`, { label }).catch(toastError); load(); }
        }}>Save version</Button>}
      </div>
      <div className="flex-1 overflow-auto scroll-thin">
        {!data ? <div className="p-4"><Spinner /></div> : (
          <>
            <div className="px-3 py-2.5 border-b border-line bg-active/40">
              <div className="text-sm font-medium">Current</div>
              <div className="text-xs text-fg2">Saved {ago(data.current.updated_at)} · {fmtBytes(data.current.size)}</div>
            </div>
            {!data.versions.length && <p className="p-4 text-sm text-fg2">Earlier versions are kept automatically as you work (every 10 minutes), and whenever you save a named version.</p>}
            {data.versions.map((v) => (
              <div key={v.id} className="group px-3 py-2.5 border-b border-line hover:bg-hover">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{v.label || new Date(v.created_at).toLocaleString()}</div>
                    <div className="text-xs text-fg2">{v.label ? `${new Date(v.created_at).toLocaleString()} · ` : ''}{v.author || ''}</div>
                  </div>
                  {onPreview && <IconButton icon="eye" label="Preview" size={26} onClick={() => onPreview(v)} />}
                  {canEdit && <IconButton icon="history" label="Restore this version" size={26} onClick={async () => {
                    if (!await confirmDialog({ title: 'Restore this version?', message: 'The current version is kept in the history, so you can come back to it.', confirm: 'Restore' })) return;
                    await api.post(`/api/docs/${doc.id}/versions/${v.id}/restore`).catch(toastError);
                    onRestored?.();
                  }} />}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- comments

/**
 * Review comments. getAnchor() (optional) returns where a new comment is pinned (e.g. { t } in a timeline,
 * { page } in a document, { x, y } on a canvas); onJump(anchor) moves the editor there when a comment is clicked.
 */
export function CommentsPanel({ doc, getAnchor, onJump, anchorLabel, focusId }) {
  const [list, setList] = useState(null);
  const [text, setText] = useState('');
  const [pin, setPin] = useState(!!getAnchor);
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const load = () => api.get(`/api/docs/${doc.id}/comments`).then(setList).catch(toastError);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const canComment = doc.role !== 'viewer';
  const post = async () => {
    try {
      await api.post(`/api/docs/${doc.id}/comments`, { body: text, anchor: pin && getAnchor && !replyTo ? getAnchor() : undefined, parent_id: replyTo?.id });
      setText(''); setReplyTo(null); load();
    } catch (e) { toastError(e); }
  };
  const roots = (list || []).filter((c) => !c.parent_id && (showResolved || !c.resolved));
  const replies = (id) => (list || []).filter((c) => c.parent_id === id);
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-line flex items-center gap-2">
        <span className="text-sm font-medium flex-1">Comments</span>
        <Toggle checked={showResolved} onChange={setShowResolved} label="Resolved" />
      </div>
      <div className="flex-1 overflow-auto scroll-thin">
        {!list ? <div className="p-4"><Spinner /></div> : !roots.length ? <EmptyState icon="comment" title="No comments yet">Comments are a quick way to give and get feedback.</EmptyState> : roots.map((c) => (
          <div key={c.id} className={cx('px-3 py-3 border-b border-line', c.id === focusId && 'bg-accent/10', c.resolved && 'opacity-60')}>
            <Comment c={c} doc={doc} onJump={onJump} anchorLabel={anchorLabel} reload={load} />
            {replies(c.id).map((r) => <div key={r.id} className="ml-6 mt-2"><Comment c={r} doc={doc} reload={load} /></div>)}
            {canComment && <button type="button" onClick={() => setReplyTo(c)} className="ml-8 mt-1 text-xs text-fg2 hover:text-fg">Reply</button>}
          </div>
        ))}
      </div>
      {canComment && (
        <div className="p-3 border-t border-line">
          {replyTo && <div className="text-xs text-fg2 mb-1 flex items-center gap-1">Replying to {replyTo.author.name}<button type="button" className="underline" onClick={() => setReplyTo(null)}>cancel</button></div>}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Add a comment…"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) post(); }}
            className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 resize-none" />
          <div className="flex items-center gap-2 mt-2">
            {getAnchor && !replyTo && <Toggle checked={pin} onChange={setPin} label={anchorLabel ? `Pin to ${anchorLabel(getAnchor())}` : 'Pin to this spot'} />}
            <span className="flex-1" />
            <Button size="sm" variant="primary" onClick={post} disabled={!text.trim()}>Post</Button>
          </div>
        </div>
      )}
    </div>
  );
}
function Comment({ c, doc, onJump, anchorLabel, reload }) {
  return (
    <div className="flex gap-2.5">
      {c.author.picture ? <img src={c.author.picture} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" /> : <span className="w-6 h-6 rounded-full sora-sky grid place-items-center text-white text-xs font-semibold shrink-0">{c.author.name?.[0]}</span>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs"><span className="font-medium text-fg">{c.author.name}</span><span className="text-fg3">{ago(c.created_at)}</span></div>
        {c.anchor && onJump && <button type="button" onClick={() => onJump(c.anchor)} className="text-[11px] text-accent hover:underline">{anchorLabel ? anchorLabel(c.anchor) : 'Show spot'}</button>}
        <p className="text-sm text-fg whitespace-pre-wrap break-words">{c.body}</p>
      </div>
      {!c.parent_id && doc.role !== 'viewer' && (
        <IconButton icon={c.resolved ? 'refresh' : 'check'} label={c.resolved ? 'Reopen' : 'Resolve'} size={24} onClick={async () => { await api.patch(`/api/docs/${doc.id}/comments/${c.id}`, { resolved: !c.resolved }).catch(toastError); reload(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- export

/**
 * Export dialog: pick a format and its options, then where it goes — this device, Files, Minami Cloud, or Tsunami.
 *
 *   exportDialog({
 *     name: 'Poster', docId,
 *     formats: [
 *       { id: 'png', label: 'PNG', ext: 'png', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1,'1×'],[2,'2×']] }] },
 *       { id: 'mp4', label: 'MP4 video', ext: 'mp4', kind: 'video' },
 *     ],
 *     render: async (formatId, options, { onProgress }) => Blob  — or  { job: { kind: 'timeline', spec } } to render on the server,
 *   })
 * Option types: select (choices: [[value, label]]), number (min, max, step, unit), range, toggle, text.
 */
export const exportDialog = (opts) => new Promise((resolve) => mount((close) => <ExportDialog {...opts} onClose={(r) => { resolve(r); close(); }} />));

function ExportDialog({ name: initialName, docId, formats, render, onClose, title = 'Export', defaultFormat }) {
  const [config, setConfig] = useState({});
  useEffect(() => { getConfig().then(setConfig); }, []);
  const [fid, setFid] = useState(() => { try { return localStorage.getItem(`sl-export-${formats.map((f) => f.id).join()}`) || defaultFormat || formats[0].id; } catch { return defaultFormat || formats[0].id; } });
  const format = formats.find((f) => f.id === fid) || formats[0];
  const [values, setValues] = useState({});
  const opt = (o) => values[`${format.id}.${o.key}`] ?? o.default;
  const [name, setName] = useState(initialName || 'Export');
  const [dest, setDest] = useState('download');
  const [tsu, setTsu] = useState({ title: initialName || '', description: '', visibility: 'private' });
  const [state, setState] = useState(null); // { label, p }
  const canTsunami = config.tsunami && ['video', 'audio'].includes(format.kind);
  const dests = [
    { value: 'download', label: 'This device', icon: 'download' },
    { value: 'files', label: 'Files', icon: 'folder' },
    ...(config.cloud ? [{ value: 'cloud', label: 'Minami Cloud', icon: 'cloud' }] : []),
    ...(canTsunami ? [{ value: 'tsunami', label: 'Tsunami', icon: 'video' }] : []),
  ];
  useEffect(() => { if (!dests.some((d) => d.value === dest)) setDest('download'); }, [dests, dest]);
  const fileName = `${name || 'Export'}.${format.ext}`;

  const go = async () => {
    try { localStorage.setItem(`sl-export-${formats.map((f) => f.id).join()}`, format.id); } catch { /* private mode */ }
    const options = Object.fromEntries((format.options || []).map((o) => [o.key, opt(o)]));
    let cloudDest = null;
    if (dest === 'cloud') { cloudDest = await pickCloudFolder({ name: fileName }); if (!cloudDest) return; }
    try {
      setState({ label: 'Preparing…', p: null });
      const out = await render(format.id, options, { onProgress: (p, label) => setState({ label: label || 'Rendering…', p }) });
      if (out?.job) {
        // Rendered on the server (Cut, Encoder): queue it, then follow it.
        const after = dest === 'cloud' ? { cloud: { folder_id: cloudDest.folder_id } } : dest === 'tsunami' ? { tsunami: tsu } : undefined;
        let job = await api.post('/api/jobs', { ...out.job, name: name || out.job.name, doc_id: docId, after });
        setState({ label: 'Rendering on the server…', p: 0, job: job.id });
        while (['queued', 'running'].includes(job.status)) {
          await new Promise((r) => setTimeout(r, 1000));
          job = await api.get(`/api/jobs/${job.id}`);
          setState({ label: job.status === 'queued' ? 'Waiting in the render queue…' : `Rendering${job.encoder ? ` (${job.encoder})` : ''}…`, p: job.progress, job: job.id });
        }
        if (job.status !== 'done') throw new Error(job.error || 'The render was cancelled.');
        if (dest === 'download') download(`${job.output.url}?download=1`, job.output.name);
        finish(dest, job.output, job.after_result);
        return;
      }
      const blob = out;
      if (dest === 'download') { download(blob, fileName); toast(`Exported ${fileName}`, { type: 'success' }); onClose({ dest, blob }); return; }
      setState({ label: 'Saving…', p: 0 });
      const asset = await saveBlob(blob, fileName, { docId, onProgress: (p) => setState({ label: 'Saving…', p }) });
      let result = null;
      if (dest === 'cloud') result = { cloud: await api.post('/api/cloud/save', { asset_id: asset.id, folder_id: cloudDest.folder_id, name: cloudDest.name }) };
      if (dest === 'tsunami') { setState({ label: 'Sending to Tsunami…', p: null }); result = { tsunami: await api.post('/api/tsunami/publish', { asset_id: asset.id, ...tsu }) }; }
      finish(dest, asset, result);
    } catch (e) { setState(null); toastError(e, 'Export failed'); }
  };
  const finish = (d, asset, result) => {
    if (result?.cloud?.error || result?.tsunami?.error) toast(result.cloud?.error || result.tsunami?.error, { type: 'error' });
    else if (d === 'tsunami') toast('Sent to Tsunami — it’s processing there now', { type: 'success', action: result?.tsunami?.studio_url ? { label: 'Open Studio', onClick: () => window.open(result.tsunami.studio_url, '_blank') } : undefined });
    else if (d === 'cloud') toast('Saved to Minami Cloud', { type: 'success' });
    else if (d === 'files') toast('Saved to Files → Exports', { type: 'success', action: { label: 'Open', onClick: () => window.open('/files?tab=exports', '_blank') } });
    else toast(`Exported ${asset.name}`, { type: 'success' });
    onClose({ dest: d, asset, result });
  };

  return (
    <Modal title={title} onClose={() => !state && onClose(null)} width={560}
      footer={state ? (
        <div className="flex-1 flex items-center gap-3 text-sm text-fg2">
          <Spinner /> <span className="shrink-0">{state.label}</span>
          {state.p !== null && <ProgressBar value={state.p} className="flex-1" />}
          {state.p !== null && <span className="tabular-nums w-10 text-right">{Math.round((state.p || 0) * 100)}%</span>}
          {state.job && <Button size="sm" variant="ghost" onClick={async () => { await api.post(`/api/jobs/${state.job}/cancel`).catch(() => {}); }}>Cancel</Button>}
        </div>
      ) : <><Button variant="ghost" onClick={() => onClose(null)}>Cancel</Button><Button variant="primary" icon="export" onClick={go}>Export</Button></>}>
      <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 items-center">
        <span className="text-sm text-fg2">Format</span>
        <Select value={format.id} onChange={setFid} options={formats.map((f) => ({ value: f.id, label: f.label }))} />
        {(format.options || []).map((o) => (
          <OptionRow key={`${format.id}.${o.key}`} o={o} value={opt(o)} set={(v) => setValues((s) => ({ ...s, [`${format.id}.${o.key}`]: v }))} />
        ))}
        <span className="text-sm text-fg2">File name</span>
        <div className="flex items-center gap-1"><TextInput value={name} onChange={(e) => setName(e.target.value)} /><span className="text-sm text-fg3">.{format.ext}</span></div>
        <span className="text-sm text-fg2">Save to</span>
        <Segmented size="md" value={dest} onChange={setDest} options={dests} />
        {dest === 'tsunami' && (
          <>
            <span className="text-sm text-fg2">Title</span>
            <TextInput value={tsu.title} onChange={(e) => setTsu({ ...tsu, title: e.target.value })} />
            <span className="text-sm text-fg2 self-start mt-1.5">Description</span>
            <textarea value={tsu.description} onChange={(e) => setTsu({ ...tsu, description: e.target.value })} rows={3} className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70" />
            <span className="text-sm text-fg2">Visibility</span>
            <Segmented value={tsu.visibility} onChange={(v) => setTsu({ ...tsu, visibility: v })} options={[{ value: 'private', label: 'Private' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'public', label: 'Public' }]} />
          </>
        )}
      </div>
      {format.note && <p className="text-xs text-fg3 mt-4">{format.note}</p>}
    </Modal>
  );
}

function OptionRow({ o, value, set }) {
  return (
    <>
      <span className="text-sm text-fg2">{o.label}</span>
      <div>
        {o.type === 'select' && <Select value={String(value)} onChange={(v) => set(typeof o.default === 'number' ? Number(v) : v)} options={o.choices.map(([v, l]) => ({ value: String(v), label: l }))} />}
        {o.type === 'number' && <NumberInput value={value} onChange={set} min={o.min} max={o.max} step={o.step || 1} unit={o.unit} width={90} />}
        {o.type === 'range' && <Slider value={value} onChange={set} min={o.min} max={o.max} step={o.step || 1} unit={o.unit} />}
        {o.type === 'toggle' && <Toggle checked={value} onChange={set} />}
        {o.type === 'text' && <TextInput value={value} onChange={(e) => set(e.target.value)} />}
        {o.hint && <div className="text-[11px] text-fg3 mt-1">{o.hint}</div>}
      </div>
    </>
  );
}

