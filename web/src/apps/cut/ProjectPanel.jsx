// Project panel: the media bin. Import (device / Files / Minami Cloud), bins (folders), search, list or thumbnail view.
// Drag items to the timeline; double-click to open one in the Source monitor.
import { useMemo, useState } from 'react';
import { IconButton, TextInput, Spinner, openMenu, promptDialog, confirmDialog, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { fmtDur } from '../_media/media.js';

const kindIcon = { video: 'video', audio: 'audio', image: 'image' };

function Item({ m, depth, P }) {
const { ed, view, sel, used, startDrag, click, itemMenu } = P;
  const status = ed.assets[m.id]?.web_status;
  const common = {
    draggable: true, onDragStart: (e) => startDrag(e, m), onClick: (e) => click(e, m), onDoubleClick: () => ed.openSource(m.id), onContextMenu: (e) => itemMenu(e, m), title: m.name,
  };
  if (view === 'grid') {
    return (
      <div {...common} className={cx('rounded-md overflow-hidden border cursor-pointer', sel.has(m.id) ? 'border-accent' : 'border-transparent hover:border-line')}>
        <div className="aspect-video bg-panel-2 grid place-items-center relative overflow-hidden">
          {m.kind !== 'audio' ? <img src={`/api/assets/${m.id}/thumb`} alt="" draggable={false} loading="lazy" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <Icon name="wave" size={28} className="text-ok" />}
          {status === 'processing' && <span className="absolute inset-0 grid place-items-center bg-black/50"><Spinner /></span>}
          {m.duration > 0 && <span className="absolute right-1 bottom-1 px-1 rounded bg-black/70 text-[10px] text-white tabular-nums">{fmtDur(m.duration)}</span>}
          {used.has(m.id) && <span className="absolute left-1 top-1 w-1.5 h-1.5 rounded-full bg-accent" title="In the timeline" />}
        </div>
        <div className="px-1 py-0.5 text-[11px] truncate">{m.name}</div>
      </div>
    );
  }
  return (
    <div {...common} className={cx('flex items-center gap-2 h-8 pr-2 cursor-pointer text-[12px]', sel.has(m.id) ? 'bg-active' : 'hover:bg-hover')} style={{ paddingLeft: 8 + depth * 14 }}>
      <div className="w-11 h-[25px] rounded-sm bg-panel-2 overflow-hidden grid place-items-center shrink-0 relative">
        {m.kind !== 'audio' ? <img src={`/api/assets/${m.id}/thumb`} alt="" draggable={false} loading="lazy" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <Icon name="wave" size={16} className="text-ok" />}
        {status === 'processing' && <span className="absolute inset-0 grid place-items-center bg-black/50"><Spinner size={12} /></span>}
      </div>
      <Icon name={kindIcon[m.kind] || 'file'} size={13} className="text-fg3 shrink-0" />
      <span className="flex-1 truncate">{m.name}</span>
      {used.has(m.id) && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="In the timeline" />}
      <span className="text-fg3 tabular-nums text-[11px]">{m.duration ? fmtDur(m.duration) : m.width ? `${m.width}×${m.height}` : ''}</span>
    </div>
  );
}

function Bin({ b, depth, P }) {
const { view, open, setOpen, items, bins, over, dropOn, dropBin, readOnly, ed } = P;
  const isOpen = open[b.id] ?? true;
  const contents = items(b.id);
  return (
    <div onDragOver={(e) => over(e, b.id)} onDrop={(e) => dropOn(e, b.id)}>
      <div className={cx('flex items-center gap-1.5 h-7 pr-2 text-[12px] cursor-pointer hover:bg-hover', dropBin === b.id && 'bg-accent/20')} style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => setOpen({ ...open, [b.id]: !isOpen })}
        onContextMenu={(e) => openMenu(e, [
          { label: 'Rename bin…', icon: 'edit', disabled: readOnly, onClick: async () => { const n = await promptDialog({ title: 'Rename bin', label: 'Name', value: b.name }); if (n) ed.renameBin(b.id, n); } },
          { label: 'New bin inside', icon: 'folder', disabled: readOnly, onClick: () => ed.newBin(b.id) },
          { label: 'Delete bin (keeps its clips)', icon: 'trash', danger: true, disabled: readOnly, onClick: () => ed.deleteBin(b.id) },
        ])}>
        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} className="text-fg3" />
        <Icon name="folder" size={14} className="text-sun" />
        <span className="flex-1 truncate">{b.name}</span>
        <span className="text-[10.5px] text-fg3">{contents.length}</span>
      </div>
      {isOpen && (
        <>
          {bins(b.id).map((x) => <Bin key={x.id} b={x} depth={depth + 1} P={P} />)}
          {view === 'grid' ? <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5 p-1.5" style={{ paddingLeft: 8 + depth * 14 }}>{contents.map((m) => <Item key={m.id} m={m} depth={depth + 1} P={P} />)}</div>
            : contents.map((m) => <Item key={m.id} m={m} depth={depth + 1} P={P} />)}
        </>
      )}
    </div>
  );
}


export default function ProjectPanel({ ed }) {
  const { doc, readOnly } = ed;
  const [q, setQ] = useState('');
  const [view, setView] = useState(() => { try { return localStorage.getItem('cut-bin-view') || 'list'; } catch { return 'list'; } });
  const [open, setOpen] = useState({});
  const [sel, setSel] = useState(new Set());
  const [dropBin, setDropBin] = useState(undefined);
  const setV = (v) => { setView(v); try { localStorage.setItem('cut-bin-view', v); } catch { /* private mode */ } };

  const used = useMemo(() => new Set(doc.clips.map((c) => c.asset_id)), [doc.clips]);
  const match = (m) => !q || m.name.toLowerCase().includes(q.toLowerCase());
  const items = (bin) => doc.media.filter((m) => (m.bin || null) === bin && match(m));
  const bins = (parent) => doc.bins.filter((b) => (b.parent || null) === parent);

  const startDrag = (e, m) => {
    const ids = sel.has(m.id) ? [...sel] : [m.id];
    e.dataTransfer.setData('application/x-cut-media', JSON.stringify({ ids }));
    e.dataTransfer.setData('application/x-cut-bin-item', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'copyMove';
    ed.dragInfo.current = { duration: ids.reduce((n, id) => { const x = doc.media.find((y) => y.id === id); return n + (x?.kind === 'image' ? 5 : (x?.mark_out ?? x?.duration ?? 5) - (x?.mark_in ?? 0)); }, 0) };
  };
  const click = (e, m) => {
    const next = new Set(e.shiftKey || e.metaKey || e.ctrlKey ? sel : []);
    if (next.has(m.id) && (e.metaKey || e.ctrlKey)) next.delete(m.id); else next.add(m.id);
    setSel(next);
  };
  const itemMenu = (e, m) => openMenu(e, [
    { label: 'Open in Source monitor', icon: 'video', onClick: () => ed.openSource(m.id) },
    { label: 'Insert at playhead', icon: 'import', disabled: readOnly, onClick: () => { ed.openSource(m.id); setTimeout(() => ed.sourceEdit('insert', m.id), 0); } },
    { label: 'Overwrite at playhead', icon: 'download', disabled: readOnly, onClick: () => { ed.openSource(m.id); setTimeout(() => ed.sourceEdit('overwrite', m.id), 0); } },
    { divider: true },
    { label: 'Rename…', icon: 'edit', disabled: readOnly, onClick: async () => { const n = await promptDialog({ title: 'Rename clip', label: 'Name', value: m.name }); if (n) ed.renameMedia(m.id, n); } },
    { label: 'Move to bin', icon: 'folder', disabled: readOnly, items: [{ label: '(Top level)', onClick: () => ed.moveToBin([m.id], null) }, ...doc.bins.map((b) => ({ label: b.name, onClick: () => ed.moveToBin(sel.has(m.id) ? [...sel] : [m.id], b.id) }))] },
    { divider: true },
    { label: used.has(m.id) ? 'Remove from project (and timeline)…' : 'Remove from project', icon: 'trash', danger: true, disabled: readOnly, onClick: async () => {
      if (used.has(m.id) && !await confirmDialog({ title: 'Remove this clip?', message: 'It’s used in the timeline — those clips will be removed too.', confirm: 'Remove', danger: true })) return;
      ed.removeMedia(sel.has(m.id) ? [...sel] : [m.id]);
    } },
  ]);

  const dropOn = (e, bin) => {
    e.preventDefault(); e.stopPropagation(); setDropBin(undefined);
    const ids = e.dataTransfer.getData('application/x-cut-bin-item');
    if (ids) { ed.moveToBin(JSON.parse(ids), bin); return; }
    if (e.dataTransfer.files?.length) ed.uploadFiles(e.dataTransfer.files, bin);
  };
  const over = (e, bin) => { if (readOnly) return; e.preventDefault(); e.stopPropagation(); setDropBin(bin); };

  const P = { ed, view, sel, used, startDrag, click, itemMenu, open, setOpen, items, bins, over, dropOn, dropBin, readOnly };
  const top = items(null);
  return (
    <div className="h-full flex flex-col min-h-0 bg-panel">
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-line">
        <span className="text-[12px] font-medium flex-1 truncate">Project <span className="text-fg3 font-normal">· {doc.media.length} items</span></span>
        <IconButton icon="list" label="List view" size={22} active={view === 'list'} onClick={() => setV('list')} />
        <IconButton icon="grid" label="Thumbnail view" size={22} active={view === 'grid'} onClick={() => setV('grid')} />
      </div>
      <div className="p-1.5 flex gap-1 shrink-0">
        <div className="relative flex-1">
          <Icon name="search" size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg3" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="!h-7 !pl-7 text-[12px]" />
        </div>
      </div>
      <div className={cx('flex-1 min-h-0 overflow-auto scroll-thin', dropBin === null && 'bg-accent/10')}
        onDragOver={(e) => over(e, null)} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropBin(undefined); }} onDrop={(e) => dropOn(e, null)}
        onClick={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}>
        {bins(null).map((b) => <Bin key={b.id} b={b} depth={0} P={P} />)}
        {view === 'grid' ? <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5 p-1.5">{top.map((m) => <Item key={m.id} m={m} depth={0} P={P} />)}</div>
          : top.map((m) => <Item key={m.id} m={m} depth={0} P={P} />)}
        {!doc.media.length && (
          <div className="p-4 text-center text-[12px] text-fg2">
            <Icon name="import" size={24} className="mx-auto mb-2 text-fg3" />
            Import media to start.<br /><span className="text-fg3">Drop files here, or use Import.</span>
          </div>
        )}
      </div>
      <div className="h-8 shrink-0 flex items-center gap-1 px-1.5 border-t border-line">
        <IconButton icon="import" label="Import media (Ctrl+I)" size={26} disabled={readOnly} onClick={() => ed.importMedia()} />
        <IconButton icon="folder" label="New bin" size={26} disabled={readOnly} onClick={() => ed.newBin(null)} />
        <IconButton icon="plus" label="New item" size={26} disabled={readOnly} onClick={(e) => openMenu(e, [
          { label: 'Title', icon: 'title', onClick: () => ed.newTitle() },
          { label: 'Color Matte', icon: 'color', onClick: () => ed.newMatte() },
          { label: 'Captions from SRT…', icon: 'comment', onClick: () => ed.importSrt() },
        ])} />
        <span className="flex-1" />
        <IconButton icon="trash" label="Remove selected from project" size={26} disabled={readOnly || !sel.size} onClick={async () => {
          const ids = [...sel];
          if (ids.some((id) => used.has(id)) && !await confirmDialog({ title: 'Remove these clips?', message: 'Some are used in the timeline — those clips will be removed too.', confirm: 'Remove', danger: true })) return;
          ed.removeMedia(ids); setSel(new Set());
        }} />
      </div>
    </div>
  );
}
