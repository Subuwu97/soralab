// The frame every editor lives in: app menu bar, project name, save status, undo/redo, Share and Export,
// a left tool strip, a contextual options bar, the workspace, right-hand panels, an optional bottom area
// (timeline), and drawers for Version history and Comments. It also autosaves.
//
//   <EditorShell app="photo" project={project} history={h}
//     getData={async () => ({ data, thumb: canvas, width, height })}   // what to save (called by autosave / Ctrl+S)
//     menus={[{ label: 'Image', items: [...] }, …]}                     // after File and Edit
//     fileItems={[...]} editItems={[...]}                               // extra items for File / Edit
//     exportConfig={{ formats, render }}                                // Export button + File → Export
//     tools={<ToolStrip/>} options={<OptionsBar/>} panels={<Panels/>} bottom={<Timeline/>} status={<span/>}
//     commentAnchor={() => ({ t })} anchorLabel={(a) => fmtTime(a.t)} onJumpToComment={(a) => seek(a.t)}>
//     <Canvas/>
//   </EditorShell>
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { appById } from '../lib/apps.js';
import { api, ago } from '../lib/api.js';
import { useShortcuts, keyLabel } from '../lib/shortcuts.js';
import { MenuBar, IconButton, Button, Spinner, promptDialog, toast, toastError, cx } from './ui.jsx';
import { Icon } from './Icons.jsx';
import { AppTile } from './Brand.jsx';
import { shareDialog, exportDialog, VersionsPanel, CommentsPanel } from './ProjectDialogs.jsx';
import { saveToCloud } from './Pickers.jsx';
import { useApp } from '../lib/app.jsx';

const AUTOSAVE_MS = 1500;

export default function EditorShell({
  app: appId, project, history, getData, menus = [], fileItems = [], editItems = [], exportConfig, tools, options, panels, bottom, status, children,
  commentAnchor, anchorLabel, onJumpToComment, panelWidth = 280, dirty: dirtyProp, toolbarExtra, className,
}) {
  const app = appById(appId);
  const nav = useNavigate();
  const { theme, setTheme } = useApp();
  const { doc } = project;
  const [drawer, setDrawer] = useState(() => (new URLSearchParams(location.search).get('comment') ? 'comments' : null));
  const savedVersion = useRef(history?.version ?? 0);
  const [dirty, setDirty] = useState(false);
  const saving = useRef(false);
  const again = useRef(false);

  useEffect(() => { if (doc) document.title = `${doc.name} — ${app.name} — SoraLab`; }, [doc?.name, app.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Something changed since the last save?
  const isDirty = dirtyProp ?? (history ? history.version !== savedVersion.current : false);
  useEffect(() => setDirty(isDirty), [isDirty]);

  const doSave = useCallback(async ({ quiet = true } = {}) => {
    if (!project.canEdit || !getData) return;
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    const v = history?.version;
    try {
      const out = await getData();
      if (out) {
        const { data, ...opts } = out;
        await project.save(data, opts);
        savedVersion.current = v;
        setDirty(history ? history.version !== v : false);
        if (!quiet) toast('Saved', { type: 'success' });
      }
    } catch (e) { toastError(e, 'Couldn’t save'); }
    finally {
      saving.current = false;
      if (again.current) { again.current = false; doSave(); }
    }
  }, [project, getData, history]);

  // Autosave a moment after the last change.
  useEffect(() => {
    if (!isDirty || !project.canEdit) return undefined;
    const t = setTimeout(() => doSave(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [isDirty, history?.version, project.canEdit, doSave]);
  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const f = (e) => { if (dirty && project.canEdit) { e.preventDefault(); e.returnValue = ''; doSave(); } };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty, project.canEdit, doSave]);

  const openExport = useCallback(() => exportConfig && exportDialog({ name: doc?.name, docId: doc?.id, ...exportConfig }), [exportConfig, doc]);
  const rename = async () => {
    const n = await promptDialog({ title: 'Rename', label: 'Name', value: doc.name });
    if (n && n !== doc.name) project.rename(n).catch(toastError);
  };
  const close = async () => { if (dirty) await doSave(); nav('/'); };

  useShortcuts({
    'mod+s': () => doSave({ quiet: false }),
    'mod+z': () => history?.undo(),
    'shift+mod+z': () => history?.redo(),
    'mod+y': () => history?.redo(),
    'shift+mod+e': () => openExport(),
    'alt+mod+e': () => openExport(),
  }, [doSave, history, openExport]);

  const fileMenu = {
    label: 'File',
    items: () => [
      { label: `New ${app.name} project…`, icon: 'plus', onClick: () => nav(`/new/${app.id}`) },
      { label: 'Open…', icon: 'folder', onClick: () => nav(`/files?app=${app.id}`) },
      { divider: true },
      { label: 'Save', icon: 'save', shortcut: keyLabel('mod+s'), onClick: () => doSave({ quiet: false }), disabled: !project.canEdit },
      { label: 'Save a named version…', icon: 'bookmark', disabled: !project.canEdit, onClick: async () => {
        const label = await promptDialog({ title: 'Name this version', label: 'Name', value: `Version ${new Date().toLocaleDateString()}` });
        if (label) { await doSave(); await api.post(`/api/docs/${doc.id}/versions`, { label }).then(() => toast('Version saved', { type: 'success' })).catch(toastError); }
      } },
      { label: 'Version history', icon: 'history', onClick: () => setDrawer('versions') },
      { label: 'Make a copy', icon: 'duplicate', onClick: async () => { const d = await api.post(`/api/docs/${doc.id}/duplicate`).catch(toastError); if (d) nav(`/${d.app}/${d.id}`); } },
      { label: 'Rename…', icon: 'edit', onClick: rename, disabled: !project.canEdit },
      { divider: true },
      ...fileItems,
      ...(fileItems.length ? [{ divider: true }] : []),
      ...(exportConfig ? [{ label: 'Export…', icon: 'export', shortcut: keyLabel('shift+mod+e'), onClick: openExport }] : []),
      { label: 'Save project to Minami Cloud…', icon: 'cloud', onClick: async () => { await doSave(); const r = await saveToCloud({ docId: doc.id, name: `${doc.name}.sora` }).catch(toastError); if (r) toast('Saved to Minami Cloud', { type: 'success' }); } },
      { label: 'Share…', icon: 'share', onClick: () => shareDialog(doc) },
      { divider: true },
      { label: 'Close', icon: 'close', onClick: close },
    ],
  };
  const editMenu = {
    label: 'Edit',
    items: () => [
      { label: history?.undoLabel ? `Undo ${history.undoLabel}` : 'Undo', icon: 'undo', shortcut: keyLabel('mod+z'), onClick: () => history?.undo(), disabled: !history?.canUndo },
      { label: history?.redoLabel ? `Redo ${history.redoLabel}` : 'Redo', icon: 'redo', shortcut: keyLabel('shift+mod+z'), onClick: () => history?.redo(), disabled: !history?.canRedo },
      ...(editItems.length ? [{ divider: true }, ...editItems] : []),
    ],
  };
  const viewExtras = {
    label: 'Window',
    items: () => [
      { label: 'Comments', icon: 'comment', checked: drawer === 'comments', onClick: () => setDrawer(drawer === 'comments' ? null : 'comments') },
      { label: 'Version history', icon: 'history', checked: drawer === 'versions', onClick: () => setDrawer(drawer === 'versions' ? null : 'versions') },
      { divider: true },
      { label: 'Dark theme', checked: theme === 'dark', onClick: () => setTheme('dark') },
      { label: 'Light theme', checked: theme === 'light', onClick: () => setTheme('light') },
      { label: 'Match system', checked: theme === 'system', onClick: () => setTheme('system') },
    ],
  };

  if (project.error) {
    return (
      <div className="h-full grid place-items-center text-center p-6">
        <div>
          <Icon name="warning" size={36} className="mx-auto text-warn mb-3" />
          <div className="font-head font-semibold text-lg">Couldn’t open this project</div>
          <p className="text-fg2 text-sm mt-1">{project.error.status === 404 ? 'It was deleted, or it isn’t shared with you.' : project.error.message}</p>
          <Link to="/" className="inline-block mt-4"><Button variant="primary" icon="home">Back to SoraLab</Button></Link>
        </div>
      </div>
    );
  }
  if (!doc) return <div className="h-full grid place-items-center"><Spinner size={28} /></div>;

  const saveLabel = !project.canEdit ? (doc.role === 'commenter' ? 'Can comment' : 'View only')
    : project.saveError ? 'Couldn’t save' : project.saving ? 'Saving…' : dirty ? 'Unsaved changes' : project.savedAt ? `Saved ${ago(project.savedAt)}` : 'Saved';

  return (
    <div className={cx('h-full flex flex-col bg-work text-fg overflow-hidden select-none', className)}>
      {/* top bar */}
      <header className="h-10 shrink-0 flex items-center gap-1 px-1.5 bg-panel border-b border-line">
        <Link to="/" title="SoraLab home" className="p-1 rounded-md hover:bg-hover"><AppTile app={app} size={26} /></Link>
        <MenuBar menus={[fileMenu, editMenu, ...menus, viewExtras]} />
        <div className="flex-1 min-w-0 flex items-center justify-center gap-2 px-2">
          <button type="button" onClick={project.canEdit ? rename : undefined} className="text-[13px] font-medium truncate max-w-[30vw] hover:bg-hover rounded px-1.5 h-7" title="Rename">{doc.name}</button>
          <span className={cx('text-[11px] whitespace-nowrap', project.saveError ? 'text-danger' : 'text-fg3')}>
            {project.saveError ? <button type="button" className="underline" onClick={() => doSave({ quiet: false })}>{saveLabel} — retry</button> : saveLabel}
          </span>
          {doc.owner && <span className="text-[11px] text-fg3 truncate">· {doc.owner.name}’s project</span>}
        </div>
        {toolbarExtra}
        {history && (
          <>
            <IconButton icon="undo" label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'} shortcut={keyLabel('mod+z')} size={30} disabled={!history.canUndo} onClick={history.undo} />
            <IconButton icon="redo" label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'} shortcut={keyLabel('shift+mod+z')} size={30} disabled={!history.canRedo} onClick={history.redo} />
          </>
        )}
        <IconButton icon="comment" label="Comments" size={30} active={drawer === 'comments'} onClick={() => setDrawer(drawer === 'comments' ? null : 'comments')} />
        <IconButton icon="history" label="Version history" size={30} active={drawer === 'versions'} onClick={() => setDrawer(drawer === 'versions' ? null : 'versions')} />
        <Button size="sm" variant="secondary" icon="share" onClick={() => shareDialog(doc)} className="ml-1">Share</Button>
        {exportConfig && <Button size="sm" variant="primary" icon="export" onClick={openExport} className="ml-1 mr-1">Export</Button>}
      </header>
      {options && <div className="h-10 shrink-0 flex items-center gap-2 px-2 bg-panel border-b border-line overflow-x-auto no-scrollbar">{options}</div>}
      <div className="flex-1 min-h-0 flex">
        {tools && <aside className="w-11 shrink-0 bg-panel border-r border-line flex flex-col items-center py-1.5 gap-0.5 overflow-y-auto no-scrollbar">{tools}</aside>}
        <div className="flex-1 min-w-0 flex flex-col">
          <main className="flex-1 min-h-0 relative overflow-hidden">{children}</main>
          {bottom && <div className="shrink-0 border-t border-line bg-panel">{bottom}</div>}
        </div>
        {panels && <aside style={{ width: panelWidth }} className="shrink-0 bg-panel border-l border-line overflow-y-auto scroll-thin">{panels}</aside>}
        {drawer && (
          <aside className="w-80 shrink-0 bg-panel border-l border-line flex flex-col">
            <div className="flex justify-end p-1 border-b border-line"><IconButton icon="close" label="Close" size={26} onClick={() => setDrawer(null)} /></div>
            <div className="flex-1 min-h-0">
              {drawer === 'versions' && <VersionsPanel doc={doc} onRestored={() => location.reload()} />}
              {drawer === 'comments' && <CommentsPanel doc={doc} getAnchor={commentAnchor} anchorLabel={anchorLabel} onJump={onJumpToComment} focusId={new URLSearchParams(location.search).get('comment')} />}
            </div>
          </aside>
        )}
      </div>
      {status && <footer className="h-6 shrink-0 flex items-center gap-4 px-3 bg-panel border-t border-line text-[11px] text-fg2 overflow-hidden whitespace-nowrap">{status}</footer>}
    </div>
  );
}

/** A tool button for the left strip. */
export function Tool({ icon, label, shortcut, active, onClick, children }) {
  return (
    <IconButton icon={icon} label={label} shortcut={shortcut ? keyLabel(shortcut) : undefined} active={active} onClick={onClick} size={32} iconSize={18}>{children}</IconButton>
  );
}
export const ToolDivider = () => <div className="w-6 h-px bg-line my-1 shrink-0" />;
