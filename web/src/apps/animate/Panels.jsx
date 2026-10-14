// Sora ANI panels: Properties (selection, keyframe/tween, document) and the Library (symbols and imported bitmaps).
import { PanelSection, NumberInput, Slider, ColorSwatch, Select, Button, IconButton, Toggle, openMenu, promptDialog, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { FontPicker } from '../../components/Pickers.jsx';
import { keyAt, worldBounds, timelineLength } from '../_anim/stage.js';

const Row = ({ label, children }) => <div className="flex items-center gap-2 min-h-8"><span className="text-xs text-fg2 w-20 shrink-0">{label}</span><div className="flex-1 flex items-center gap-1.5 flex-wrap">{children}</div></div>;

export function PropertiesPanel({ doc, layer, frame, selEls, canEdit, editSel, editKey, editDoc, endMerge, symbols }) {
  const key = layer ? keyAt(layer, frame) : null;
  const one = selEls.length === 1 ? selEls[0] : null;
  const setAll = (patch, label, merge) => editSel((e) => ({ ...e, ...(typeof patch === 'function' ? patch(e) : patch) }), label, merge);
  return (
    <>
      {selEls.length > 0 && (
        <PanelSection title={one ? { shape: 'Shape', bitmap: 'Bitmap', symbol: 'Movie clip instance', text: 'Text' }[one.type] : `${selEls.length} objects`} id="an-sel">
          {one && (
            <>
              <Row label="Position">
                <NumberInput label="X" value={+(one.x || 0).toFixed(1)} onChange={(v) => setAll({ x: v }, 'Move', 'pos')} onCommit={endMerge} width={60} disabled={!canEdit} />
                <NumberInput label="Y" value={+(one.y || 0).toFixed(1)} onChange={(v) => setAll({ y: v }, 'Move', 'pos')} onCommit={endMerge} width={60} disabled={!canEdit} />
              </Row>
              <Row label="Scale">
                <NumberInput label="W" value={+((one.sx ?? 1) * 100).toFixed(1)} unit="%" onChange={(v) => setAll({ sx: v / 100 }, 'Scale', 'sc')} onCommit={endMerge} width={64} disabled={!canEdit} />
                <NumberInput label="H" value={+((one.sy ?? 1) * 100).toFixed(1)} unit="%" onChange={(v) => setAll({ sy: v / 100 }, 'Scale', 'sc')} onCommit={endMerge} width={64} disabled={!canEdit} />
              </Row>
              <Row label="Rotation"><NumberInput value={+(one.r || 0).toFixed(1)} unit="°" onChange={(v) => setAll({ r: v }, 'Rotate', 'rot')} onCommit={endMerge} width={70} disabled={!canEdit} /></Row>
              <div className="text-[10.5px] text-fg3 mb-1">{(() => { const b = worldBounds(doc, one); return `${Math.round(b.w)} × ${Math.round(b.h)} px`; })()}</div>
            </>
          )}
          {selEls.some((e) => e.type === 'shape') && (
            <>
              <Row label="Fill"><ColorSwatch none value={selEls.find((e) => e.type === 'shape').fill || '#00000000'} onChange={(c) => editSel((e) => (e.type === 'shape' ? { ...e, fill: c && c !== 'transparent' ? c : null } : e), 'Fill colour', 'fill')} onCommit={endMerge} /></Row>
              <Row label="Stroke">
                <ColorSwatch none value={selEls.find((e) => e.type === 'shape').stroke || '#00000000'} onChange={(c) => editSel((e) => (e.type === 'shape' ? { ...e, stroke: c && c !== 'transparent' ? c : null } : e), 'Stroke colour', 'stroke')} onCommit={endMerge} />
                <NumberInput value={selEls.find((e) => e.type === 'shape').sw || 0} min={0} max={200} step={0.5} width={52} unit="px" onChange={(v) => editSel((e) => (e.type === 'shape' ? { ...e, sw: v } : e), 'Stroke width', 'sw')} onCommit={endMerge} disabled={!canEdit} />
              </Row>
            </>
          )}
          {one?.type === 'text' && (
            <>
              <Row label="Font"><FontPicker value={one.font || 'Inter'} weight={one.weight || 400} onChange={(f) => canEdit && setAll({ font: f }, 'Font')} width={150} /></Row>
              <Row label="Size"><NumberInput value={one.size || 48} min={4} max={1000} width={60} onChange={(v) => setAll({ size: v }, 'Font size', 'fs')} onCommit={endMerge} disabled={!canEdit} />
                <ColorSwatch value={one.color || '#000'} onChange={(c) => setAll({ color: c }, 'Text colour', 'tc')} onCommit={endMerge} /></Row>
            </>
          )}
          {one?.type === 'symbol' && (
            <>
              <Row label="Symbol"><span className="text-xs">{symbols.find((s) => s.id === one.symbol)?.name || '—'}</span></Row>
              <Row label="Looping"><Select small value={one.loop || 'loop'} onChange={(v) => setAll({ loop: v }, 'Looping')} disabled={!canEdit} options={[{ value: 'loop', label: 'Loop' }, { value: 'once', label: 'Play once' }, { value: 'single', label: 'Single frame' }]} />
                <NumberInput label="First" value={(one.first || 0) + 1} min={1} max={timelineLength(symbols.find((s) => s.id === one.symbol)?.timeline || { layers: [] })} width={44} onChange={(v) => setAll({ first: v - 1 }, 'First frame')} disabled={!canEdit} /></Row>
            </>
          )}
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg3 mt-3 mb-1">Colour effect</div>
          <Slider label="Alpha" value={Math.round((one ? one.alpha ?? 1 : 1) * 100)} min={0} max={100} onChange={(v) => setAll({ alpha: v / 100 }, 'Alpha', 'alpha')} onCommit={endMerge} disabled={!canEdit} />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-fg2">Tint</span>
            <ColorSwatch value={one?.tint?.color || '#ff4f7b'} onChange={(c) => setAll((e) => ({ tint: { color: c, amount: e.tint?.amount ?? 0.5 } }), 'Tint', 'tint')} onCommit={endMerge} alpha={false} />
            <Slider className="flex-1" value={Math.round((one?.tint?.amount || 0) * 100)} min={0} max={100} onChange={(v) => setAll((e) => ({ tint: { color: e.tint?.color || '#ff4f7b', amount: v / 100 } }), 'Tint', 'tint')} onCommit={endMerge} disabled={!canEdit} />
          </div>
        </PanelSection>
      )}
      {layer && key && (
        <PanelSection title={`Frame ${frame + 1} · ${layer.name}`} id="an-frame">
          <Row label="Keyframe"><span className="text-xs text-fg2">starts at frame {key.i + 1}, {key.len} frame{key.len > 1 ? 's' : ''}, {key.els.length} object{key.els.length === 1 ? '' : 's'}</span></Row>
          <Row label="Tween">
            <Select small value={key.tween || ''} disabled={!canEdit} data-testid="tween-select" onChange={(v) => editKey((k) => ({ ...k, tween: v || null }), v ? 'Create tween' : 'Remove tween')}
              options={[{ value: '', label: 'None' }, { value: 'motion', label: 'Classic / motion' }, { value: 'shape', label: 'Shape' }]} />
          </Row>
          {key.tween && (
            <>
              <Slider label="Ease (in −100 … out +100)" value={key.ease || 0} min={-100} max={100} onChange={(v) => editKey((k) => ({ ...k, ease: v, bz: undefined }), 'Ease', 'ease')} onCommit={endMerge} disabled={!canEdit} reset={0} />
              <div className="flex gap-1 mt-1 flex-wrap">
                {[['Ease in', [0.42, 0, 1, 1]], ['Ease out', [0, 0, 0.58, 1]], ['Ease in-out', [0.42, 0, 0.58, 1]], ['Back', [0.34, 1.56, 0.64, 1]]].map(([l, bz]) => (
                  <Button key={l} size="xs" disabled={!canEdit} onClick={() => editKey((k) => ({ ...k, bz }), l)} className={cx(JSON.stringify(key.bz) === JSON.stringify(bz) && 'ring-1 ring-accent')}>{l}</Button>
                ))}
                {key.bz && <Button size="xs" variant="ghost" onClick={() => editKey((k) => ({ ...k, bz: undefined }), 'Clear ease curve')}>Clear curve</Button>}
              </div>
              {!layer.frames.some((x) => x.i === key.i + key.len) && <p className="text-[11px] text-warn mt-2">This tween has no end keyframe — press F6 later on this layer to give it one.</p>}
            </>
          )}
        </PanelSection>
      )}
      <PanelSection title="Document" id="an-doc" defaultOpen={!selEls.length}>
        <Row label="Stage"><NumberInput value={doc.width} min={16} max={7680} width={60} onChange={(v) => editDoc({ width: Math.round(v) }, 'Stage size')} disabled={!canEdit} />×<NumberInput value={doc.height} min={16} max={4320} width={60} onChange={(v) => editDoc({ height: Math.round(v) }, 'Stage size')} disabled={!canEdit} /></Row>
        <Row label="Frame rate"><Select small value={String(doc.fps)} disabled={!canEdit} onChange={(v) => editDoc({ fps: Number(v) }, 'Frame rate')} options={['6', '8', '12', '15', '24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))} /></Row>
        <Row label="Background"><ColorSwatch value={doc.bg} alpha={false} onChange={(c) => editDoc({ bg: c }, 'Stage colour', 'bg')} onCommit={endMerge} /></Row>
      </PanelSection>
    </>
  );
}

export function LibraryPanel({ doc, canEdit, onPlace, onEdit, onRename, onDelete, onImport, editing }) {
  return (
    <PanelSection title="Library" id="an-lib" actions={canEdit && <IconButton icon="import" size={22} label="Import to library" onClick={onImport} />}>
      {!doc.symbols.length && !doc.library.length && <p className="text-[11px] text-fg3">Select drawings and press F8 to make a movie-clip symbol. Imported images appear here too.</p>}
      {doc.symbols.map((s) => (
        <div key={s.id} className={cx('flex items-center gap-2 h-7 px-1.5 rounded text-[12px]', editing === s.id ? 'bg-active' : 'hover:bg-hover')} data-testid={`lib-${s.name}`}
          onDoubleClick={() => onEdit(s.id)} onContextMenu={(e) => { e.preventDefault(); openMenu(e, [
            { label: 'Edit symbol', icon: 'edit', onClick: () => onEdit(s.id) },
            { label: 'Place on stage', icon: 'plus', disabled: !canEdit, onClick: () => onPlace({ symbol: s.id }) },
            { label: 'Rename…', disabled: !canEdit, onClick: async () => { const n = await promptDialog({ title: 'Rename symbol', label: 'Name', value: s.name }); if (n) onRename(s.id, n); } },
            { divider: true },
            { label: 'Delete', icon: 'trash', danger: true, disabled: !canEdit, onClick: () => onDelete(s.id) },
          ]); }}>
          <Icon name="component" size={14} className="text-accent" />
          <span className="flex-1 truncate">{s.name}</span>
          <span className="text-[10.5px] text-fg3">{timelineLength(s.timeline)}f</span>
          <IconButton icon="plus" size={20} label="Place instance" disabled={!canEdit} onClick={() => onPlace({ symbol: s.id })} />
        </div>
      ))}
      {doc.library.map((b) => (
        <div key={b.id} className="flex items-center gap-2 h-7 px-1.5 rounded text-[12px] hover:bg-hover">
          <Icon name="image" size={14} className="text-fg3" />
          <span className="flex-1 truncate">{b.name}</span>
          <span className="text-[10.5px] text-fg3">{b.w}×{b.h}</span>
          <IconButton icon="plus" size={20} label="Place on stage" disabled={!canEdit} onClick={() => onPlace({ bitmap: b })} />
        </div>
      ))}
    </PanelSection>
  );
}
export { Toggle };
