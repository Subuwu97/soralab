// A project in a grid (Home, app pages, Files): thumbnail, app tile, name, when it changed, and a menu.
import { Link, useNavigate } from 'react-router-dom';
import { api, ago, fmtTime } from '../lib/api.js';
import { appById } from '../lib/apps.js';
import { AppTile } from './Brand.jsx';
import { Icon } from './Icons.jsx';
import { IconButton, openMenu, promptDialog, confirmDialog, toast, toastError } from './ui.jsx';
import { shareDialog } from './ProjectDialogs.jsx';
import { saveToCloud } from './Pickers.jsx';

export function projectMenu(d, { nav, onChange }) {
  const owner = d.role === 'owner';
  if (d.trashed_at) {
    return [
      { label: 'Restore', icon: 'refresh', onClick: async () => { await api.post(`/api/docs/${d.id}/restore`).catch(toastError); onChange?.(); } },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Delete “${d.name}” forever?`, message: 'This can’t be undone. Files used only by this project are deleted too.', confirm: 'Delete forever', danger: true })) {
          await api.del(`/api/docs/${d.id}?permanent=1`).catch(toastError); onChange?.();
        }
      } },
    ];
  }
  return [
    { label: 'Open', icon: 'external', onClick: () => nav(`/${d.app}/${d.id}`) },
    { label: 'Open in new tab', icon: 'external', onClick: () => window.open(`/${d.app}/${d.id}`, '_blank') },
    { divider: true },
    ...(owner ? [{ label: d.starred ? 'Remove star' : 'Star', icon: 'star', onClick: async () => { await api.patch(`/api/docs/${d.id}`, { starred: !d.starred }).catch(toastError); onChange?.(); } }] : []),
    { label: 'Rename…', icon: 'edit', disabled: !['owner', 'editor'].includes(d.role), onClick: async () => {
      const n = await promptDialog({ title: 'Rename', label: 'Name', value: d.name });
      if (n) { await api.patch(`/api/docs/${d.id}`, { name: n }).catch(toastError); onChange?.(); }
    } },
    { label: 'Make a copy', icon: 'duplicate', onClick: async () => { await api.post(`/api/docs/${d.id}/duplicate`).catch(toastError); toast('Copy made'); onChange?.(); } },
    { label: 'Share…', icon: 'share', onClick: () => shareDialog(d) },
    { label: 'Save to Minami Cloud…', icon: 'cloud', onClick: async () => { const r = await saveToCloud({ docId: d.id, name: `${d.name}.sora` }).catch(toastError); if (r) toast('Saved to Minami Cloud', { type: 'success' }); } },
    { divider: true },
    owner ? { label: 'Move to trash', icon: 'trash', danger: true, onClick: async () => { await api.del(`/api/docs/${d.id}`).catch(toastError); toast(`Moved “${d.name}” to the trash`); onChange?.(); } }
      : { label: 'Remove from my list', icon: 'close', onClick: async () => { await api.del(`/api/docs/${d.id}/shares/me`).catch(() => {}); onChange?.(); } },
  ];
}

export default function ProjectCard({ d, onChange }) {
  const nav = useNavigate();
  const app = appById(d.app);
  const info = d.duration ? fmtTime(d.duration) : d.pages ? `${d.pages} page${d.pages > 1 ? 's' : ''}` : d.width ? `${d.width}×${d.height}` : '';
  return (
    <div className="group relative rounded-xl bg-surface border border-line hover:border-accent/40 transition overflow-hidden"
      onContextMenu={(e) => openMenu(e, projectMenu(d, { nav, onChange }))}>
      <Link to={d.trashed_at ? '#' : `/${d.app}/${d.id}`} className="block">
        <div className="aspect-[4/3] bg-panel-2 grid place-items-center overflow-hidden">
          {d.thumb ? <img src={d.thumb} alt="" loading="lazy" className="max-w-full max-h-full object-contain" /> : <AppTile app={app} size={56} />}
        </div>
        <div className="flex items-center gap-2.5 p-3">
          <AppTile app={app} size={26} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{d.name}</div>
            <div className="text-xs text-fg3 truncate">{d.owner ? `${d.owner.name} · ` : ''}{ago(d.updated_at)}{info ? ` · ${info}` : ''}</div>
          </div>
        </div>
      </Link>
      {d.starred && <Icon name="star" size={16} fill="#FFC36B" className="absolute top-2 left-2 text-sun drop-shadow" />}
      {d.shared && <span title="Shared" className="absolute top-2 left-8 text-fg bg-black/40 rounded-full p-1"><Icon name="users" size={12} /></span>}
      <IconButton icon="more" label="More" size={28} className="!absolute top-2 right-2 bg-black/40 !text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={(e) => openMenu(e.currentTarget, projectMenu(d, { nav, onChange }), { align: 'end' })} />
    </div>
  );
}
