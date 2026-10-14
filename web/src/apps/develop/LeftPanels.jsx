// Develop's left column: Presets (built-in looks and your own, saved to Libraries), Snapshots and History.
import { useState } from 'react';
import { PanelSection, IconButton, openMenu, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { BUILTIN_PRESETS, compact } from './model.js';

export default function LeftPanels({ photo, userPresets, readOnly, ed, onHoverPreset }) {
  const groups = [...new Set(BUILTIN_PRESETS.map((p) => p.group))];
  const [open, setOpen] = useState(() => new Set(['Yours', 'Color']));
  const toggle = (g) => setOpen((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const cur = JSON.stringify(compact(photo.settings));
  const preset = (p, user) => (
    <div key={p.id} role="button" tabIndex={-1}
      onClick={() => !readOnly && ed.applyPreset(p.name, user ? p.data.settings : p.s)}
      onMouseEnter={() => onHoverPreset(user ? p.data.settings : p.s)} onMouseLeave={() => onHoverPreset(null)}
      onContextMenu={user && !readOnly ? (e) => openMenu(e, [{ label: 'Delete preset', icon: 'trash', danger: true, onClick: () => ed.deletePreset(p) }]) : undefined}
      className={cx('flex items-center gap-2 h-7 pl-6 pr-2 rounded text-[13px] text-fg2 hover:bg-hover hover:text-fg', readOnly ? 'cursor-default' : 'cursor-pointer')}>
      <span className="flex-1 truncate">{p.name}</span>
    </div>
  );
  const groupRow = (g, children, n) => (
    <div key={g}>
      <button type="button" onClick={() => toggle(g)} className="w-full flex items-center gap-1 h-7 px-1 text-[13px] text-fg hover:bg-hover rounded">
        <Icon name={open.has(g) ? 'chevronDown' : 'chevronRight'} size={13} className="text-fg3" /><Icon name="folder" size={14} className="text-fg3" />
        <span className="flex-1 text-left truncate">{g}</span><span className="text-[11px] text-fg3">{n}</span>
      </button>
      {open.has(g) && children}
    </div>
  );
  return (
    <div className="w-[236px] shrink-0 h-full overflow-y-auto scroll-thin bg-panel border-r border-line">
      <PanelSection title="Presets" id="hk-presets" actions={!readOnly && <IconButton icon="plus" label="Create preset from these settings" size={22} onClick={ed.savePreset} />}>
        <div className="-mx-1">
          {groupRow('Yours', userPresets.length ? userPresets.map((p) => preset(p, true)) : <p className="pl-7 pr-2 py-1 text-[11px] text-fg3">Save the current look with +. Your presets live in Libraries, so every project can use them.</p>, userPresets.length)}
          {groups.map((g) => { const list = BUILTIN_PRESETS.filter((p) => p.group === g); return groupRow(g, list.map((p) => preset(p, false)), list.length); })}
        </div>
        <p className="text-[11px] text-fg3 mt-1">Hover to preview, click to apply.</p>
      </PanelSection>
      <PanelSection title="Snapshots" id="hk-snaps" actions={!readOnly && <IconButton icon="plus" label="New snapshot" size={22} onClick={ed.newSnapshot} />}>
        {!photo.snapshots.length && <p className="text-[11px] text-fg3">Snapshots save this photo’s settings so you can come back to them.</p>}
        {photo.snapshots.map((sn) => (
          <div key={sn.id} onClick={() => !readOnly && ed.applySnapshot(sn)} onMouseEnter={() => onHoverPreset(sn.s, true)} onMouseLeave={() => onHoverPreset(null)}
            className={cx('group flex items-center gap-2 h-7 px-2 rounded text-[13px] hover:bg-hover cursor-pointer', JSON.stringify(sn.s) === cur ? 'text-fg' : 'text-fg2')}>
            <Icon name="camera" size={13} className="text-fg3" />
            <span className="flex-1 truncate">{sn.name}</span>
            {!readOnly && <IconButton icon="trash" label="Delete snapshot" size={20} className="opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); ed.deleteSnapshot(sn.id); }} />}
          </div>
        ))}
      </PanelSection>
      <PanelSection title="History" id="hk-history" actions={!readOnly && photo.history.length > 0 && <IconButton icon="trash" label="Clear history" size={22} onClick={ed.clearHistory} />}>
        {!photo.history.length && <p className="text-[11px] text-fg3">Every change you make to this photo is listed here. Click a step to go back to it.</p>}
        <div className="flex flex-col-reverse">
          <div onClick={() => !readOnly && ed.applyHistory({ label: 'Import', s: {} })} className={cx('h-6 px-2 flex items-center rounded text-[12px] cursor-pointer hover:bg-hover', cur === '{}' && !photo.history.length ? 'text-fg' : 'text-fg3')}>Import</div>
          {photo.history.map((e, i) => {
            const isCur = i === photo.history.length - 1 ? JSON.stringify(e.s) === cur : false;
            return (
              <div key={i} onClick={() => !readOnly && ed.applyHistory(e)} onMouseEnter={() => onHoverPreset(e.s, true)} onMouseLeave={() => onHoverPreset(null)}
                className={cx('h-6 px-2 flex items-center rounded text-[12px] cursor-pointer hover:bg-hover', isCur ? 'bg-active text-fg' : 'text-fg2')}>
                <span className="flex-1 truncate">{e.label}</span>
              </div>
            );
          })}
        </div>
      </PanelSection>
    </div>
  );
}
