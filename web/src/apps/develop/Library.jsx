// Library module: the grid, the filmstrip, the filter bar, the catalog / collections list and the metadata panel.
import { memo, useEffect, useRef, useState } from 'react';
import { Button, IconButton, Select, Segmented, Slider, Spinner, PanelSection, TextInput, EmptyState, openMenu, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { fmtBytes } from '../../lib/api.js';
import { COLOR_LABELS, SORTS, isEdited, isRaw } from './model.js';
import { usePhotoThumb } from './media.js';

const labelColor = (id) => COLOR_LABELS.find((c) => c.id === id)?.color;

export function Stars({ value, onChange, size = 12, readOnly, className }) {
  return (
    <span className={cx('inline-flex items-center', className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={readOnly} title={`${n} star${n > 1 ? 's' : ''} (${n})`}
          onClick={(e) => { e.stopPropagation(); onChange?.(value === n ? 0 : n); }} className="p-[1px] disabled:cursor-default">
          <svg viewBox="0 0 24 24" width={size} height={size} fill={n <= value ? '#f5c518' : 'none'} stroke={n <= value ? '#f5c518' : 'currentColor'} strokeWidth={1.6} className={n <= value ? '' : 'text-fg3'}>
            <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
          </svg>
        </button>
      ))}
    </span>
  );
}
const FlagIcon = ({ flag, size = 13 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={flag === 1 ? '#fff' : 'none'} stroke={flag === -1 ? '#ff5a5a' : 'currentColor'} strokeWidth={1.8} strokeLinecap="round">
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />{flag === -1 && <path d="M3 3l18 18" />}
  </svg>
);

function Thumb({ photo, className }) {
  const t = usePhotoThumb(photo, isEdited(photo.settings));
  if (t.processing) return <div className={cx('grid place-items-center text-[11px] text-fg2 gap-1', className)}><div className="flex flex-col items-center gap-1"><Spinner size={14} />Processing…</div></div>;
  if (t.failed) return <div className={cx('grid place-items-center text-fg3', className)}><Icon name="warning" size={20} /></div>;
  if (!t.url) return <div className={cx('grid place-items-center', className)}><Spinner size={14} className="text-fg3" /></div>;
  return <img src={t.url} alt="" draggable={false} loading="lazy" className={cx('object-contain', className)} />;
}

export const Cell = memo(function Cell({ photo, size, selected, current, readOnly, onClick, onDouble, onRate, onContext, index }) {
  const lc = labelColor(photo.color_label);
  return (
    <div data-photo={photo.id} onClick={onClick} onDoubleClick={onDouble} onContextMenu={onContext}
      className={cx('relative rounded-md flex flex-col overflow-hidden cursor-default border-2 transition-colors', current ? 'border-accent bg-active' : selected ? 'border-accent/50 bg-active/70' : 'border-transparent bg-panel-2 hover:bg-hover', photo.flag === -1 && 'opacity-45')}
      style={{ width: size, height: size + 30 }}>
      <div className="flex items-center h-5 px-1.5 text-[10px] text-fg3 gap-1">
        <span className="tabular-nums">{index + 1}</span>
        <span className="flex-1" />
        {isRaw(photo) && <span className="px-1 rounded bg-chip text-fg2">RAW</span>}
        {isEdited(photo.settings) && <span title="Edited"><Icon name="sliders" size={11} /></span>}
        {photo.flag !== 0 && <span className={photo.flag === 1 ? 'text-fg' : ''}><FlagIcon flag={photo.flag} size={11} /></span>}
      </div>
      <div className="flex-1 min-h-0 grid place-items-center px-1.5">
        <Thumb photo={photo} className="max-w-full max-h-full w-full h-full" />
      </div>
      <div className="h-[22px] flex items-center px-1.5 gap-1" style={lc ? { boxShadow: `inset 0 -3px 0 ${lc}` } : undefined}>
        <Stars value={photo.rating} onChange={onRate} readOnly={readOnly} size={11} />
        <span className="flex-1" />
        {lc && <span className="w-2.5 h-2.5 rounded-full" style={{ background: lc }} />}
      </div>
    </div>
  );
});

export function FilterBar({ filter, setFilter, sort, setSort, count, total, thumbSize, setThumbSize }) {
  const f = filter;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-line bg-panel text-[13px] shrink-0">
      <div className="relative">
        <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg3" />
        <TextInput value={f.text} onChange={(e) => setFilter({ ...f, text: e.target.value })} placeholder="Name or keyword" className="!h-7 !w-40 !pl-7 text-[13px]" />
      </div>
      <span className="text-fg3 text-xs">Rating</span>
      <Select small value={f.ratingOp} onChange={(v) => setFilter({ ...f, ratingOp: v })} options={[{ value: 'gte', label: '≥' }, { value: 'eq', label: '=' }, { value: 'lte', label: '≤' }]} />
      <Stars value={f.rating} onChange={(v) => setFilter({ ...f, rating: v })} size={13} />
      <span className="text-fg3 text-xs ml-1">Flag</span>
      <Select small value={f.flag} onChange={(v) => setFilter({ ...f, flag: v })} options={[{ value: 'all', label: 'All' }, { value: 'picked', label: 'Picked' }, { value: 'unflagged', label: 'Unflagged' }, { value: 'rejected', label: 'Rejected' }, { value: 'notrejected', label: 'Not rejected' }]} />
      <span className="text-fg3 text-xs ml-1">Label</span>
      <div className="flex items-center gap-1">
        {COLOR_LABELS.map((c) => (
          <button key={c.id} type="button" title={c.label} onClick={() => setFilter({ ...f, label: f.label === c.id ? 'any' : c.id })}
            className={cx('w-4 h-4 rounded-sm border', f.label === c.id ? 'border-white scale-110' : 'border-transparent opacity-70 hover:opacity-100')} style={{ background: c.color }} />
        ))}
        <button type="button" title="No label" onClick={() => setFilter({ ...f, label: f.label === 'none' ? 'any' : 'none' })}
          className={cx('w-4 h-4 rounded-sm border text-[9px] leading-none text-fg2', f.label === 'none' ? 'border-white' : 'border-line')}>∅</button>
      </div>
      <Select small value={f.edited} onChange={(v) => setFilter({ ...f, edited: v })} options={[{ value: 'all', label: 'Any edit state' }, { value: 'edited', label: 'Edited' }, { value: 'unedited', label: 'Unedited' }]} />
      <span className="flex-1" />
      <span className="text-fg3 text-xs whitespace-nowrap">{count === total ? `${total} photo${total === 1 ? '' : 's'}` : `${count} of ${total}`}</span>
      <span className="text-fg3 text-xs ml-2">Sort</span>
      <Select small value={sort.by} onChange={(v) => setSort({ ...sort, by: v })} options={SORTS.map((x) => ({ value: x.id, label: x.label }))} />
      <IconButton icon="sort" label={sort.desc ? 'Descending' : 'Ascending'} size={26} active={sort.desc} onClick={() => setSort({ ...sort, desc: !sort.desc })} />
      {setThumbSize && <div className="w-24 shrink-0"><Slider value={thumbSize} min={110} max={320} onChange={setThumbSize} showNumber={false} /></div>}
    </div>
  );
}

export function Grid({ photos, all, sel, cur, onSelect, onOpen, onRate, onContext, size, readOnly, onImport, filtered }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.querySelector(`[data-photo="${cur}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cur]);
  if (!all.length) {
    return (
      <EmptyState icon="image" title="This catalog is empty" className="h-full"
        action={!readOnly && <Button variant="primary" icon="import" onClick={onImport}>Import photos</Button>}>
        Import photos from this device, Files or Minami Cloud (Mirai Photos lives there). Edits never change the originals.
      </EmptyState>
    );
  }
  if (!photos.length) return <EmptyState icon="filter" title="No photos match the filter" className="h-full">{filtered}</EmptyState>;
  return (
    <div ref={ref} className="h-full overflow-y-auto scroll-thin p-3" onClick={(e) => { if (e.target === e.currentTarget) onSelect(null, e); }}>
      <div className="flex flex-wrap gap-2" onClick={(e) => { if (e.target === e.currentTarget) onSelect(null, e); }}>
        {photos.map((p, i) => (
          <Cell key={p.id} photo={p} index={i} size={size} selected={sel.has(p.id)} current={p.id === cur} readOnly={readOnly}
            onClick={(e) => onSelect(p.id, e)} onDouble={() => onOpen(p.id)} onRate={(v) => onRate(p.id, v)} onContext={(e) => onContext(e, p)} />
        ))}
      </div>
    </div>
  );
}

export function Filmstrip({ photos, sel, cur, onSelect, onOpen, onContext, info }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector(`[data-photo="${cur}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [cur]);
  return (
    <div>
      <div className="h-6 flex items-center px-3 text-[11px] text-fg2 gap-3 border-b border-line">{info}</div>
      <div ref={ref} className="h-[92px] flex items-center gap-1.5 px-2 overflow-x-auto scroll-thin">
        {photos.map((p) => {
          const lc = labelColor(p.color_label);
          return (
            <button key={p.id} type="button" data-photo={p.id} onClick={(e) => onSelect(p.id, e)} onDoubleClick={() => onOpen(p.id)} onContextMenu={(e) => onContext(e, p)}
              className={cx('relative shrink-0 h-[78px] w-[96px] rounded border-2 overflow-hidden bg-panel-2', p.id === cur ? 'border-accent' : sel.has(p.id) ? 'border-accent/45' : 'border-transparent hover:border-line', p.flag === -1 && 'opacity-45')}>
              <Thumb photo={p} className="w-full h-full" />
              {(p.rating > 0 || p.flag || lc) && (
                <span className="absolute left-0 right-0 bottom-0 h-4 bg-black/55 flex items-center px-1 gap-1 text-[9px] text-[#f5c518]">
                  {p.rating > 0 && '★'.repeat(p.rating)}<span className="flex-1" />
                  {p.flag !== 0 && <span className="text-white"><FlagIcon flag={p.flag} size={9} /></span>}
                  {lc && <span className="w-2 h-2 rounded-full" style={{ background: lc }} />}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CatalogPanel({ doc, filter, setFilter, readOnly, onImport, ed }) {
  const picks = doc.photos.filter((p) => p.flag === 1).length;
  const row = (id, label, n, icon, extra) => (
    <div key={id} onClick={() => setFilter({ ...filter, collection: id })} onContextMenu={extra}
      className={cx('flex items-center gap-2 h-7 px-2 rounded text-[13px] cursor-default', filter.collection === id ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover hover:text-fg')}>
      <Icon name={icon} size={14} /><span className="flex-1 truncate">{label}</span><span className="text-[11px] text-fg3 tabular-nums">{n}</span>
    </div>
  );
  return (
    <div className="flex flex-col">
      {!readOnly && <div className="p-3 border-b border-line"><Button variant="primary" icon="import" className="w-full" onClick={onImport}>Import photos…</Button></div>}
      <PanelSection title="Catalog" id="hk-catalog">
        {row('all', 'All photographs', doc.photos.length, 'image')}
        <div onClick={() => setFilter({ ...filter, collection: 'all', flag: 'picked' })} className="flex items-center gap-2 h-7 px-2 rounded text-[13px] text-fg2 hover:bg-hover hover:text-fg cursor-default">
          <FlagIcon flag={1} size={14} /><span className="flex-1">Picks</span><span className="text-[11px] text-fg3 tabular-nums">{picks}</span>
        </div>
      </PanelSection>
      <PanelSection title="Collections" id="hk-coll" actions={!readOnly && <IconButton icon="plus" label="New collection (from selection)" size={22} onClick={ed.newCollection} />}>
        {!doc.collections.length && <p className="text-xs text-fg3 py-1">Group photos without moving them. Select photos, then +.</p>}
        {doc.collections.map((c) => row(c.id, c.name, c.photo_ids.filter((id) => doc.photos.some((p) => p.id === id)).length, 'folder', (e) => {
          if (readOnly) return;
          openMenu(e, [
            { label: 'Add selected photos', icon: 'plus', onClick: () => ed.addToCollection(c.id) },
            { label: 'Remove selected photos', icon: 'minus', onClick: () => ed.removeFromCollection(c.id) },
            { label: 'Rename…', icon: 'edit', onClick: () => ed.renameCollection(c.id) },
            { divider: true },
            { label: 'Delete collection', icon: 'trash', danger: true, onClick: () => ed.deleteCollection(c.id) },
          ]);
        }))}
      </PanelSection>
    </div>
  );
}

export function MetadataPanel({ photos, readOnly, ed, asset }) {
  const [kw, setKw] = useState('');
  if (!photos.length) return <div className="p-4 text-sm text-fg2">Select a photo to see its details.</div>;
  const one = photos.length === 1 ? photos[0] : null;
  const same = (k) => (photos.every((p) => JSON.stringify(p[k]) === JSON.stringify(photos[0][k])) ? photos[0][k] : null);
  const rating = same('rating') ?? 0; const flag = same('flag'); const label = same('color_label');
  const keywords = [...new Set(photos.flatMap((p) => p.keywords))];
  const addKw = () => { const list = kw.split(',').map((x) => x.trim()).filter(Boolean); if (list.length) ed.addKeywords(list); setKw(''); };
  return (
    <div>
      {one && (
        <div className="p-3 border-b border-line">
          <div className="aspect-[4/3] rounded bg-panel-2 overflow-hidden grid place-items-center"><Thumb photo={one} className="w-full h-full" /></div>
        </div>
      )}
      <PanelSection title={one ? 'Metadata' : `${photos.length} photos selected`} id="hk-meta">
        <div className="flex items-center justify-between mb-2"><span className="text-xs text-fg2">Rating</span><Stars value={rating} onChange={(v) => ed.rate(v)} readOnly={readOnly} size={15} /></div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg2">Flag</span>
          <Segmented value={String(flag)} onChange={(v) => !readOnly && ed.flag(Number(v))} options={[{ value: '1', label: 'Pick (P)' }, { value: '0', label: 'None (U)' }, { value: '-1', label: 'Reject (X)' }]} />
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg2">Label</span>
          <div className="flex gap-1">
            {COLOR_LABELS.map((c) => (
              <button key={c.id} type="button" disabled={readOnly} title={`${c.label}${c.key ? ` (${c.key})` : ''}`} onClick={() => ed.label(label === c.id ? null : c.id)}
                className={cx('w-5 h-5 rounded-sm border-2', label === c.id ? 'border-white' : 'border-transparent')} style={{ background: c.color }} />
            ))}
          </div>
        </div>
        {one && (
          <dl className="grid grid-cols-[88px_1fr] gap-y-1 text-[12px] mt-3">
            <dt className="text-fg3">File name</dt><dd className="truncate" title={one.name}>{one.name}</dd>
            <dt className="text-fg3">Dimensions</dt><dd>{one.width && one.height ? `${one.width} × ${one.height}` : '—'}</dd>
            <dt className="text-fg3">Megapixels</dt><dd>{one.width && one.height ? ((one.width * one.height) / 1e6).toFixed(1) : '—'}</dd>
            <dt className="text-fg3">File size</dt><dd>{fmtBytes(one.size) || '—'}</dd>
            <dt className="text-fg3">Type</dt><dd className="truncate">{one.mime || '—'}</dd>
            <dt className="text-fg3">Added</dt><dd>{new Date(one.created).toLocaleString()}</dd>
            <dt className="text-fg3">Edited</dt><dd>{isEdited(one.settings) ? `Yes · ${one.history.length} step${one.history.length === 1 ? '' : 's'}` : 'No'}</dd>
            {asset?.web_status === 'processing' && <><dt className="text-fg3">Status</dt><dd className="text-warn">Processing…</dd></>}
          </dl>
        )}
        {one && isRaw(one) && <p className="text-[11px] text-fg3 mt-2">RAW file: decoded on the server with ffmpeg, so quality depends on its support for this camera.</p>}
      </PanelSection>
      <PanelSection title="Keywords" id="hk-kw">
        <div className="flex flex-wrap gap-1 mb-2">
          {!keywords.length && <span className="text-xs text-fg3">No keywords</span>}
          {keywords.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-chip text-xs">
              {k}{!readOnly && <button type="button" onClick={() => ed.removeKeyword(k)} className="text-fg3 hover:text-fg" aria-label={`Remove ${k}`}><Icon name="close" size={11} /></button>}
            </span>
          ))}
        </div>
        {!readOnly && (
          <div className="flex gap-1">
            <TextInput value={kw} onChange={(e) => setKw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addKw(); }} placeholder="Add keywords, comma-separated" className="!h-7 text-[13px]" />
            <Button size="sm" onClick={addKw} disabled={!kw.trim()}>Add</Button>
          </div>
        )}
      </PanelSection>
    </div>
  );
}
