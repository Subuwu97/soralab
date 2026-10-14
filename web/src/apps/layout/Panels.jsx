// Layout panels: the Control bar (options), Pages, Properties (transform, frame, character, paragraph, wrap),
// Paragraph/Character Styles, Swatches, Preflight, Document Setup and Find/Change.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, IconButton, NumberInput, Select, Segmented, Toggle, Checkbox, PanelSection, Popover, ColorPicker, Modal, TextInput, Field, Tabs, openMenu, promptDialog, confirmDialog, toast, toastError, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { FontPicker, WeightPicker } from '../../components/Pickers.jsx';
import { useApp } from '../../lib/app.jsx';
import { api } from '../../lib/api.js';
import { pageNumber, pageSide, spreads, masterLabel, colorOf, findItem, pageIndexOf, pick, CHAR_KEYS, PARA_KEYS, charStyleAttrs, uid, bounds, DEFAULT_CHAR } from './model.js';
import { renderPageCanvas, getImage } from './render.js';
import { insertText, deleteRange, formatParas, formatChars } from './text.js';
import * as ops from './ops.js';

const Row = ({ children, className }) => <div className={cx('flex items-center gap-1.5 flex-wrap', className)}>{children}</div>;
const Lbl = ({ children }) => <span className="text-[11px] text-fg3 w-14 shrink-0">{children}</span>;

// ---------------------------------------------------------------- colour / swatch chooser

/** A colour chip that opens the document swatches (plus None and a custom colour). value: swatch id, hex or null. */
export function SwatchButton({ ed, value, onChange, none = true, label, size = 24 }) {
  const [anchor, setAnchor] = useState(null);
  const [custom, setCustom] = useState(false);
  const hex = colorOf(ed.doc, value);
  return (
    <>
      <button type="button" title={label} aria-label={label} onClick={(e) => { setCustom(false); setAnchor(e.currentTarget); }} disabled={!ed.canEdit}
        className="rounded border border-line shrink-0 relative overflow-hidden checker" style={{ width: size, height: size }}>
        {hex ? <span className="absolute inset-0" style={{ background: hex }} /> : <span className="absolute inset-0 bg-white"><span className="absolute left-0 top-1/2 w-[150%] h-[2px] bg-danger -rotate-45 origin-left translate-y-[8px]" /></span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-64">
          {!custom ? (
            <div className="p-1.5 max-h-80 overflow-auto scroll-thin">
              {none && <SwatchRow name="[None]" onClick={() => { onChange(null); setAnchor(null); }} active={!value} />}
              {ed.doc.swatches.map((s) => <SwatchRow key={s.id} hex={s.hex} name={s.name} active={value === s.id} onClick={() => { onChange(s.id); setAnchor(null); }} />)}
              <button type="button" className="w-full text-left px-2 h-7 text-[13px] text-accent hover:bg-hover rounded" onClick={() => setCustom(true)}>Custom colour…</button>
            </div>
          ) : <ColorPicker value={hex || '#000000'} alpha={false} onCommit={(v) => onChange(v)} />}
        </Popover>
      )}
    </>
  );
}
const SwatchRow = ({ hex, name, onClick, active, onDoubleClick, children }) => (
  <button type="button" onClick={onClick} onDoubleClick={onDoubleClick} className={cx('w-full flex items-center gap-2 px-2 h-7 text-[12.5px] rounded text-left', active ? 'bg-active' : 'hover:bg-hover')}>
    <span className="w-4 h-4 rounded-sm border border-line shrink-0 relative overflow-hidden bg-white">{hex ? <span className="absolute inset-0" style={{ background: hex }} /> : <span className="absolute left-0 top-1/2 w-[150%] h-[2px] bg-danger -rotate-45 origin-left translate-y-[5px]" />}</span>
    <span className="flex-1 truncate">{name}</span>{children}
  </button>
);

// ---------------------------------------------------------------- the Control bar

export function OptionsBar({ ed }) {
  const t = ed.typeInfo;
  const items = ed.selItems;
  if ((ed.edit || items.some((x) => x.type === 'text')) && t) return <TypeControls ed={ed} compact />;
  if (items.length) {
    const it = items[0];
    const b = bounds(it);
    const set = (k) => (v) => ed.updateSel((x) => (items.length === 1 ? { [k]: v } : { [k]: (k === 'x' || k === 'y') ? x[k] + (v - b[k]) : v }), 'Transform', `tf-${k}`);
    return (
      <div className="flex items-center gap-3">
        <NumberInput label="X" value={+b.x.toFixed(2)} onChange={set('x')} step={1} precision={2} unit="pt" width={72} disabled={!ed.canEdit} />
        <NumberInput label="Y" value={+b.y.toFixed(2)} onChange={set('y')} step={1} precision={2} unit="pt" width={72} disabled={!ed.canEdit} />
        {it.type !== 'line' && <NumberInput label="W" value={+b.w.toFixed(2)} min={1} onChange={set('w')} step={1} precision={2} unit="pt" width={72} disabled={!ed.canEdit} />}
        {it.type !== 'line' && <NumberInput label="H" value={+b.h.toFixed(2)} min={1} onChange={set('h')} step={1} precision={2} unit="pt" width={72} disabled={!ed.canEdit} />}
        <span className="w-px h-5 bg-line" />
        <span className="text-xs text-fg2">Fill</span><SwatchButton ed={ed} value={it.fill} label="Fill" onChange={(v) => ed.updateSel({ fill: v }, 'Fill')} />
        <span className="text-xs text-fg2">Stroke</span><SwatchButton ed={ed} value={it.stroke} label="Stroke" onChange={(v) => ed.updateSel({ stroke: v }, 'Stroke')} />
        <NumberInput value={it.sw ?? 1} min={0} max={100} step={0.25} precision={2} unit="pt" width={64} onChange={(v) => ed.updateSel({ sw: v }, 'Stroke weight', 'sw')} title="Stroke weight" disabled={!ed.canEdit} />
        {it.type === 'image' && it.asset && (
          <>
            <span className="w-px h-5 bg-line" />
            <IconButton icon="fit" label="Fit content proportionally" size={28} onClick={() => ed.fitSel('fit')} />
            <IconButton icon="scale" label="Fill frame proportionally" size={28} onClick={() => ed.fitSel('fill')} />
            <IconButton icon="crop" label="Centre content" size={28} onClick={() => ed.fitSel('center')} />
          </>
        )}
      </div>
    );
  }
  const hints = { select: 'Click a frame to select it · double-click text to type · drag from the rulers for guides', direct: 'Drag an image to move it inside its frame', type: 'Click in a text frame to type, or drag to draw a new text frame', frame: 'Drag to draw a frame for an image (then File → Place)', rect: 'Drag to draw a rectangle · Shift for a square', ellipse: 'Drag to draw an ellipse · Shift for a circle', line: 'Drag to draw a line · Shift for 45°', hand: 'Drag to scroll', zoom: 'Click to zoom in · Alt-click to zoom out' };
  return <span className="text-xs text-fg2 px-1">{hints[ed.tool]}</span>;
}

function TypeControls({ ed, compact }) {
  const t = ed.typeInfo;
  const c = t.char; const p = t.para;
  const dis = !ed.canEdit;
  const lead = c.leading ?? Math.round(c.size * 1.2 * 10) / 10;
  return (
    <div className={cx('flex items-center gap-2', !compact && 'flex-wrap')}>
      <Select small value={t.ps} onChange={(v) => ed.applyParaStyle(v)} options={ed.doc.paraStyles.map((s) => ({ value: s.id, label: s.name }))} title="Paragraph style" className="w-36" disabled={dis} />
      <FontPicker value={c.font} weight={c.weight} onChange={(f) => ed.applyChar({ font: f }, 'Font')} width={compact ? 150 : 170} />
      <WeightPicker family={c.font} value={c.weight} onChange={(w) => ed.applyChar({ weight: w }, 'Font weight')} />
      <NumberInput value={c.size} min={1} max={1296} step={0.5} precision={1} unit="pt" width={58} onChange={(v) => ed.applyChar({ size: v }, 'Font size')} title="Font size" disabled={dis} />
      <NumberInput label={<Icon name="sort" size={13} />} value={lead} min={1} max={2000} step={0.5} precision={1} unit="pt" width={58} onChange={(v) => ed.applyChar({ leading: v }, 'Leading')} title="Leading" disabled={dis} />
      <NumberInput label="VA" value={c.tracking || 0} min={-1000} max={10000} step={5} width={52} onChange={(v) => ed.applyChar({ tracking: v }, 'Tracking')} title="Tracking (1/1000 em)" disabled={dis} />
      <span className="flex items-center">
        <IconButton icon="bold" label="Bold" size={26} active={c.weight >= 600} onClick={() => ed.applyChar({ weight: c.weight >= 600 ? 400 : 700 }, 'Bold')} disabled={dis} />
        <IconButton icon="italic" label="Italic" size={26} active={c.italic} onClick={() => ed.applyChar({ italic: !c.italic }, 'Italic')} disabled={dis} />
        <IconButton icon="underline" label="Underline" size={26} active={c.underline} onClick={() => ed.applyChar({ underline: !c.underline }, 'Underline')} disabled={dis} />
        <IconButton label="Strikethrough" size={26} active={c.strike} onClick={() => ed.applyChar({ strike: !c.strike }, 'Strikethrough')} disabled={dis}><span className="text-[13px] line-through">S</span></IconButton>
        <IconButton label="All caps" size={26} active={c.caps} onClick={() => ed.applyChar({ caps: !c.caps }, 'All caps')} disabled={dis}><span className="text-[11px] font-semibold">TT</span></IconButton>
      </span>
      <SwatchButton ed={ed} value={c.color} none={false} label="Text colour" onChange={(v) => ed.applyChar({ color: v }, 'Text colour')} />
      <Segmented value={p.align} onChange={(v) => ed.applyPara({ align: v }, 'Alignment')} options={[
        { value: 'left', icon: 'alignLeft', title: 'Align left' }, { value: 'center', icon: 'alignCenterH', title: 'Align centre' }, { value: 'right', icon: 'alignRight', title: 'Align right' },
        { value: 'justify', icon: 'menu', title: 'Justify with last line aligned left' }, { value: 'justify-all', icon: 'distributeH', title: 'Justify all lines' },
      ]} />
      {!compact && <Select small value={t.cs || ''} onChange={(v) => ed.applyCharStyle(v || null)} options={[{ value: '', label: '[None]' }, ...ed.doc.charStyles.map((s) => ({ value: s.id, label: s.name }))]} title="Character style" />}
    </div>
  );
}

// ---------------------------------------------------------------- the side panels

export default function Panels({ ed }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('sl-layout-tab') || 'props'; } catch { return 'props'; } });
  useEffect(() => { try { localStorage.setItem('sl-layout-tab', tab); } catch { /* private mode */ } }, [tab]);
  const errs = ed.preflight.filter((p) => p.level === 'error').length;
  return (
    <div className="flex flex-col min-h-full">
      <PanelSection title="Pages" id="layout-pages"><PagesPanel ed={ed} /></PanelSection>
      <div className="flex border-b border-line px-1 sticky top-0 bg-panel z-10" role="tablist">
        {[['props', 'Properties'], ['styles', 'Styles'], ['swatches', 'Swatches'], ['preflight', 'Preflight']].map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)}
            className={cx('px-2 h-8 text-[12.5px] border-b-2 -mb-px flex items-center gap-1', tab === v ? 'border-accent text-fg' : 'border-transparent text-fg2 hover:text-fg')}>
            {l}{v === 'preflight' && <span className={cx('w-1.5 h-1.5 rounded-full', errs ? 'bg-danger' : 'bg-ok')} />}
          </button>
        ))}
      </div>
      <div className="flex-1">
        {tab === 'props' && <PropertiesPanel ed={ed} />}
        {tab === 'styles' && <StylesPanel ed={ed} />}
        {tab === 'swatches' && <SwatchesPanel ed={ed} />}
        {tab === 'preflight' && <PreflightPanel ed={ed} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Pages

function PagesPanel({ ed }) {
  const { doc } = ed;
  const [thumbs, setThumbs] = useState({});
  const [picked, setPicked] = useState([]);
  const dragFrom = useRef(null);
  const [dropAt, setDropAt] = useState(null);
  // small page previews, redrawn a moment after changes
  useEffect(() => {
    const t = setTimeout(() => {
      const out = {};
      const sc = 64 / Math.max(doc.width, doc.height);
      doc.pages.slice(0, 300).forEach((p, i) => { try { out[p.id] = renderPageCanvas(doc, i, ed.layout, { scale: sc * 2 }).toDataURL('image/jpeg', 0.7); } catch { /* fonts loading */ } });
      setThumbs(out);
    }, 350);
    return () => clearTimeout(t);
  }, [doc, ed.layout, ed.imgTick]);
  const sel = picked.length ? picked : [ed.curPage];
  const tw = 64 * doc.width / Math.max(doc.width, doc.height); const th = 64 * doc.height / Math.max(doc.width, doc.height);
  const pageMenu = (e, i) => {
    e.preventDefault();
    const idxs = sel.includes(i) ? sel : [i];
    openMenu(e, [
      { label: 'Insert Page After', icon: 'plus', onClick: () => ed.change((d) => ops.addPages(d, i + 1, 1), 'Insert page') },
      { label: idxs.length > 1 ? `Duplicate ${idxs.length} Pages` : 'Duplicate Page', icon: 'duplicate', onClick: () => ed.change((d) => [...idxs].sort((a, b) => b - a).reduce((acc, k) => ops.duplicatePage(acc, k), d), 'Duplicate page') },
      { label: idxs.length > 1 ? `Delete ${idxs.length} Pages` : 'Delete Page', icon: 'trash', danger: true, disabled: idxs.length >= doc.pages.length, onClick: () => { ed.change((d) => ops.deletePages(d, idxs), 'Delete pages'); setPicked([]); } },
      { divider: true },
      { label: 'Apply Parent to Pages', items: [{ label: '[None]', onClick: () => ed.change((d) => ops.applyMaster(d, idxs, null), 'Apply parent') }, ...doc.masters.map((m) => ({ label: masterLabel(m), onClick: () => ed.change((d) => ops.applyMaster(d, idxs, m.id), 'Apply parent') }))] },
    ]);
  };
  const masterMenu = (e, m) => {
    e.preventDefault();
    openMenu(e, [
      { label: 'Edit Parent', icon: 'edit', onClick: () => ed.editMaster(m.id) },
      { label: 'Rename…', onClick: async () => { const n = await promptDialog({ title: 'Parent page name', label: 'Name', value: m.name }); if (n) ed.change((d) => ({ ...d, masters: d.masters.map((x) => (x.id === m.id ? { ...x, name: n } : x)) }), 'Rename parent'); } },
      { label: 'Duplicate Parent', icon: 'duplicate', onClick: () => ed.change((d) => ops.newMaster(d, { name: `${m.name} copy`, basedOnId: m.id }).doc, 'Duplicate parent') },
      { label: 'Apply to Selected Pages', onClick: () => ed.change((d) => ops.applyMaster(d, sel, m.id), 'Apply parent') },
      { divider: true },
      { label: 'Delete Parent', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: `Delete ${masterLabel(m)}?`, message: 'Pages using it will have no parent.', confirm: 'Delete', danger: true })) { if (ed.masterEdit === m.id) ed.setMasterEdit(null); ed.change((d) => ops.deleteMaster(d, m.id), 'Delete parent'); } } },
    ]);
  };
  const dropPages = (to) => {
    const from = dragFrom.current; dragFrom.current = null; setDropAt(null);
    if (!from) return;
    if (from.master) { ed.change((d) => ops.applyMaster(d, [to.page ?? 0], from.master), 'Apply parent'); return; }
    const idxs = from.pages;
    const before = to.before;
    const shift = idxs.filter((k) => k < before).length;
    ed.change((d) => ops.movePages(d, idxs, before - shift), 'Move pages');
    setPicked([]);
  };
  return (
    <div>
      <div className="flex flex-col gap-0.5 mb-2">
        <button type="button" className={cx('flex items-center gap-2 h-7 px-1.5 rounded text-[12.5px]', 'hover:bg-hover')} onDoubleClick={() => ed.goPage(ed.curPage)} title="[None]">
          <span className="w-4 h-5 border border-dashed border-line rounded-sm" /><span className="text-fg2">[None]</span>
        </button>
        {doc.masters.map((m) => (
          <button key={m.id} type="button" draggable={ed.canEdit} onDragStart={() => { dragFrom.current = { master: m.id }; }}
            onDoubleClick={() => ed.editMaster(m.id)} onClick={() => ed.editMaster(m.id)} onContextMenu={(e) => masterMenu(e, m)}
            className={cx('flex items-center gap-2 h-7 px-1.5 rounded text-[12.5px]', ed.masterEdit === m.id ? 'bg-active' : 'hover:bg-hover')} title="Double-click to edit; drag onto a page to apply">
            <span className="w-4 h-5 border border-fg3 rounded-sm grid place-items-center text-[8px] font-bold">{m.id}</span>
            <span className="flex-1 text-left truncate">{masterLabel(m)}</span>
            <span className="text-[10px] text-fg3">{doc.pages.filter((p) => p.master === m.id).length} pg</span>
          </button>
        ))}
        {ed.canEdit && <button type="button" onClick={() => ed.change((d) => ops.newMaster(d).doc, 'New parent')} className="text-left text-[12px] text-accent px-1.5 h-6 hover:underline">+ New parent page</button>}
      </div>
      <div className="max-h-[38vh] overflow-auto scroll-thin -mx-1 px-1 py-1 rounded bg-panel-2/40">
        {spreads(doc).map((sp) => (
          <div key={sp[0]} className={cx('flex mb-2', doc.facing ? 'justify-center' : 'justify-center')}>
            <div className="flex" style={{ marginLeft: doc.facing && sp.length === 1 && pageSide(doc, sp[0]) === 'R' ? tw : 0, marginRight: doc.facing && sp.length === 1 && pageSide(doc, sp[0]) === 'L' ? tw : 0 }}>
              {sp.map((i) => {
                const p = doc.pages[i];
                const active = !ed.masterEdit && (picked.length ? picked.includes(i) : ed.curPage === i);
                return (
                  <div key={p.id} className="flex flex-col items-center relative"
                    onDragOver={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(dragFrom.current?.master ? { page: i } : { before: e.clientX < r.left + r.width / 2 ? i : i + 1 }); }}
                    onDrop={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); dropPages(dragFrom.current?.master ? { page: i } : { before: e.clientX < r.left + r.width / 2 ? i : i + 1 }); }}>
                    {dropAt?.before === i && <span className="absolute -left-0.5 top-0 bottom-4 w-0.5 bg-accent z-10" />}
                    {dropAt?.before === i + 1 && <span className="absolute -right-0.5 top-0 bottom-4 w-0.5 bg-accent z-10" />}
                    <button type="button" draggable={ed.canEdit} data-page={i}
                      onDragStart={() => { dragFrom.current = { pages: sel.includes(i) ? sel : [i] }; }} onDragEnd={() => setDropAt(null)}
                      onClick={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) { const base = picked.length ? picked : [ed.curPage]; setPicked(e.shiftKey ? range(Math.min(base[0], i), Math.max(base[0], i)) : base.includes(i) ? base.filter((x) => x !== i) : [...base, i]); } else { setPicked([]); ed.goPage(i); } }}
                      onContextMenu={(e) => pageMenu(e, i)}
                      className={cx('relative bg-white border-2 overflow-hidden', active ? 'border-accent' : dropAt?.page === i ? 'border-pink' : 'border-transparent hover:border-line')} style={{ width: tw + 4, height: th + 4 }}>
                      {thumbs[p.id] && <img src={thumbs[p.id]} alt="" className="w-full h-full object-contain" draggable={false} />}
                      {p.master && <span className="absolute top-0 left-0.5 text-[8px] font-bold text-[#555]">{p.master}</span>}
                    </button>
                    <span className="text-[10.5px] text-fg2 mt-0.5">{pageNumber(doc, i)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 mt-2">
        <span className="text-[11px] text-fg3 flex-1">{doc.pages.length} pages in {spreads(doc).length} spread{spreads(doc).length > 1 ? 's' : ''}</span>
        {ed.canEdit && <>
          <IconButton icon="plus" label="Add page" size={26} onClick={() => ed.change((d) => ops.addPages(d, (sel[sel.length - 1] ?? d.pages.length - 1) + 1, 1), 'Add page')} />
          <IconButton icon="duplicate" label="Duplicate page" size={26} onClick={() => ed.change((d) => ops.duplicatePage(d, sel[0] ?? 0), 'Duplicate page')} />
          <IconButton icon="trash" label="Delete page" size={26} disabled={doc.pages.length <= sel.length} onClick={() => { ed.change((d) => ops.deletePages(d, sel), 'Delete pages'); setPicked([]); }} />
        </>}
      </div>
    </div>
  );
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

// ---------------------------------------------------------------- Properties

function PropertiesPanel({ ed }) {
  const items = ed.selItems;
  const it = items[0];
  const t = ed.typeInfo;
  const dis = !ed.canEdit;
  if (!items.length && !ed.edit) return <DocProps ed={ed} />;
  return (
    <div>
      {it && (
        <PanelSection title="Transform" id="ly-transform">
          <div className="grid grid-cols-2 gap-2">
            {(() => {
              const b = bounds(it);
              const set = (k) => (v) => ed.updateSel((x) => (items.length === 1 ? (it.type === 'line' && (k === 'w' || k === 'h') ? {} : { [k]: v }) : { [k]: (k === 'x' || k === 'y') ? x[k] + (v - b[k]) : v }), 'Transform', `tf-${k}`);
              return <>
                <NumberInput label="X" value={+b.x.toFixed(2)} onChange={set('x')} precision={2} unit="pt" width={78} disabled={dis} />
                <NumberInput label="Y" value={+b.y.toFixed(2)} onChange={set('y')} precision={2} unit="pt" width={78} disabled={dis} />
                <NumberInput label="W" value={+b.w.toFixed(2)} min={1} onChange={set('w')} precision={2} unit="pt" width={78} disabled={dis || it.type === 'line'} />
                <NumberInput label="H" value={+b.h.toFixed(2)} min={1} onChange={set('h')} precision={2} unit="pt" width={78} disabled={dis || it.type === 'line'} />
              </>;
            })()}
          </div>
          {it.masterRef && <p className="text-[11px] text-fg3 mt-2">Overridden parent item. Object → Remove Overrides puts the parent’s version back.</p>}
        </PanelSection>
      )}
      {it && (
        <PanelSection title="Appearance" id="ly-appearance">
          <div className="flex flex-col gap-2">
            <Row><Lbl>Fill</Lbl><SwatchButton ed={ed} value={it.fill} label="Fill" onChange={(v) => ed.updateSel({ fill: v }, 'Fill')} /><span className="text-[11px] text-fg2 truncate">{swatchName(ed.doc, it.fill)}</span></Row>
            <Row><Lbl>Stroke</Lbl><SwatchButton ed={ed} value={it.stroke} label="Stroke" onChange={(v) => ed.updateSel({ stroke: v }, 'Stroke')} />
              <NumberInput value={it.sw ?? 1} min={0} max={200} step={0.25} precision={2} unit="pt" width={64} onChange={(v) => ed.updateSel({ sw: v }, 'Stroke weight', 'sw')} disabled={dis} />
              <Checkbox label="Dashed" checked={!!it.dash} onChange={(v) => ed.updateSel({ dash: v }, 'Stroke style')} />
            </Row>
            {['rect', 'image', 'text'].includes(it.type) && it.shape !== 'ellipse' && <Row><Lbl>Corners</Lbl><NumberInput value={it.radius || 0} min={0} max={500} unit="pt" width={64} onChange={(v) => ed.updateSel({ radius: v }, 'Corner radius', 'radius')} disabled={dis} /></Row>}
            <Row><Lbl>Opacity</Lbl><NumberInput value={Math.round((it.opacity ?? 1) * 100)} min={0} max={100} unit="%" width={64} onChange={(v) => ed.updateSel({ opacity: v / 100 }, 'Opacity', 'opacity')} disabled={dis} /></Row>
          </div>
        </PanelSection>
      )}
      {it?.type === 'text' && (
        <PanelSection title="Text Frame Options" id="ly-tfo">
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Columns" value={it.cols || 1} min={1} max={20} width={48} onChange={(v) => ed.updateSel({ cols: v }, 'Columns', 'cols')} disabled={dis} />
            <NumberInput label="Gutter" value={it.gutter ?? 12} min={0} max={200} unit="pt" width={58} onChange={(v) => ed.updateSel({ gutter: v }, 'Gutter', 'gutter')} disabled={dis} />
            <NumberInput label="Inset" value={it.inset || 0} min={0} max={200} unit="pt" width={58} onChange={(v) => ed.updateSel({ inset: v }, 'Inset', 'inset')} disabled={dis} />
          </div>
          <ThreadInfo ed={ed} it={it} />
        </PanelSection>
      )}
      {it?.type === 'image' && (
        <PanelSection title="Image" id="ly-image">
          {it.asset ? <ImageInfo ed={ed} it={it} /> : <Button size="sm" icon="image" onClick={ed.place} disabled={dis}>Place image…</Button>}
        </PanelSection>
      )}
      {it && (
        <PanelSection title="Text Wrap" id="ly-wrap">
          <Segmented value={it.wrap?.mode || 'none'} onChange={(v) => ed.updateSel((x) => ({ wrap: { mode: v, off: x.wrap?.off ?? 9 } }), 'Text wrap')} options={[{ value: 'none', label: 'None' }, { value: 'bbox', label: 'Bounding box' }, { value: 'jump', label: 'Jump object' }]} />
          {it.wrap?.mode && it.wrap.mode !== 'none' && <div className="mt-2"><NumberInput label="Offset" value={it.wrap.off ?? 9} min={0} max={200} unit="pt" width={64} onChange={(v) => ed.updateSel((x) => ({ wrap: { ...x.wrap, off: v } }), 'Wrap offset', 'wrapoff')} disabled={dis} /></div>}
        </PanelSection>
      )}
      {t && (
        <>
          <PanelSection title="Character" id="ly-char"><CharPanel ed={ed} /></PanelSection>
          <PanelSection title="Paragraph" id="ly-para"><ParaPanel ed={ed} /></PanelSection>
        </>
      )}
    </div>
  );
}
const swatchName = (doc, v) => (!v ? 'None' : v[0] === '#' ? v.toUpperCase() : doc.swatches.find((s) => s.id === v)?.name || v);

function ThreadInfo({ ed, it }) {
  const s = ed.doc.stories[it.story];
  if (!s) return null;
  const k = s.frames.indexOf(it.id);
  const over = ed.layout.overset[it.story];
  return (
    <div className="mt-3 text-[11.5px] text-fg2 flex flex-col gap-1.5">
      <span>Frame {k + 1} of {s.frames.length} in this story · {s.text.length} characters{over ? <b className="text-danger"> · overset</b> : ''}</span>
      <div className="flex gap-1.5 flex-wrap">
        {k < s.frames.length - 1 && <Button size="xs" variant="outline" onClick={() => ed.change((d) => ops.unthreadAfter(d, it.id), 'Break thread')} disabled={!ed.canEdit}>Break thread</Button>}
        <Button size="xs" variant="outline" onClick={() => ed.setLoaded({ from: it.id })} disabled={!ed.canEdit}>Thread to…</Button>
        {over && <Button size="xs" variant="outline" onClick={ed.autoflow} disabled={!ed.canEdit}>Add pages to fit</Button>}
      </div>
    </div>
  );
}

function ImageInfo({ ed, it }) {
  const img = getImage(it.asset);
  const ppi = Math.round(72 / Math.max(it.cs || 1, it.csy || 0));
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] text-fg2">{it.iw || img?.naturalWidth} × {it.ih || img?.naturalHeight} px · <span className={ppi < 150 ? 'text-warn' : ''}>{ppi} ppi effective</span> · {Math.round((it.cs || 1) * 1000) / 10}% scale</div>
      <div className="grid grid-cols-2 gap-1">
        <Button size="xs" variant="outline" onClick={() => ed.fitSel('fill')} disabled={!ed.canEdit}>Fill proportionally</Button>
        <Button size="xs" variant="outline" onClick={() => ed.fitSel('fit')} disabled={!ed.canEdit}>Fit proportionally</Button>
        <Button size="xs" variant="outline" onClick={() => ed.fitSel('stretch')} disabled={!ed.canEdit}>Content to frame</Button>
        <Button size="xs" variant="outline" onClick={() => ed.fitSel('center')} disabled={!ed.canEdit}>Centre content</Button>
      </div>
      <Toggle checked={!!it.autoFit} onChange={(v) => ed.updateSel({ autoFit: v, fit: it.fit || 'fill' }, 'Auto-fit')} label="Auto-fit when the frame is resized" />
      <div className="flex gap-1.5">
        <Button size="xs" icon="image" onClick={ed.place} disabled={!ed.canEdit}>Replace…</Button>
        <Button size="xs" variant="ghost" onClick={() => ed.setTool('direct')}>Move content (A)</Button>
      </div>
    </div>
  );
}

function CharPanel({ ed }) {
  const t = ed.typeInfo; const c = t.char; const dis = !ed.canEdit;
  return (
    <div className="flex flex-col gap-2">
      <FontPicker value={c.font} weight={c.weight} onChange={(f) => ed.applyChar({ font: f }, 'Font')} width={250} />
      <Row>
        <WeightPicker family={c.font} value={c.weight} onChange={(w) => ed.applyChar({ weight: w }, 'Font weight')} />
        <Checkbox label="Italic" checked={c.italic} onChange={(v) => ed.applyChar({ italic: v }, 'Italic')} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput label="Size" value={c.size} min={1} max={1296} step={0.5} precision={1} unit="pt" width={64} onChange={(v) => ed.applyChar({ size: v }, 'Font size')} disabled={dis} />
        <NumberInput label="Leading" value={c.leading ?? Math.round(c.size * 12) / 10} min={1} max={2000} step={0.5} precision={1} unit="pt" width={60} onChange={(v) => ed.applyChar({ leading: v }, 'Leading')} disabled={dis} />
        <NumberInput label="Track" value={c.tracking || 0} min={-1000} max={10000} step={5} width={60} onChange={(v) => ed.applyChar({ tracking: v }, 'Tracking')} disabled={dis} />
        <NumberInput label="Baseline" value={c.baseline || 0} min={-200} max={200} step={0.5} unit="pt" width={56} onChange={(v) => ed.applyChar({ baseline: v }, 'Baseline shift')} disabled={dis} />
      </div>
      <Row>
        <Lbl>Colour</Lbl><SwatchButton ed={ed} value={c.color} none={false} label="Text colour" onChange={(v) => ed.applyChar({ color: v }, 'Text colour')} /><span className="text-[11px] text-fg2">{swatchName(ed.doc, c.color)}</span>
      </Row>
      <Row>
        <Checkbox label="Underline" checked={c.underline} onChange={(v) => ed.applyChar({ underline: v }, 'Underline')} />
        <Checkbox label="Strike" checked={c.strike} onChange={(v) => ed.applyChar({ strike: v }, 'Strikethrough')} />
        <Checkbox label="All caps" checked={c.caps} onChange={(v) => ed.applyChar({ caps: v }, 'All caps')} />
      </Row>
      <Row><Lbl>Char style</Lbl><Select small value={t.cs || ''} onChange={(v) => ed.applyCharStyle(v || null)} options={[{ value: '', label: '[None]' }, ...ed.doc.charStyles.map((s) => ({ value: s.id, label: s.name }))]} className="flex-1" /></Row>
    </div>
  );
}

function ParaPanel({ ed }) {
  const p = ed.typeInfo.para; const dis = !ed.canEdit;
  const set = (k, label) => (v) => ed.applyPara({ [k]: v }, label);
  return (
    <div className="flex flex-col gap-2">
      <Segmented value={p.align} onChange={set('align', 'Alignment')} options={[
        { value: 'left', icon: 'alignLeft', title: 'Align left' }, { value: 'center', icon: 'alignCenterH', title: 'Align centre' }, { value: 'right', icon: 'alignRight', title: 'Align right' },
        { value: 'justify', icon: 'menu', title: 'Justify' }, { value: 'justify-all', icon: 'distributeH', title: 'Justify all lines' },
      ]} />
      <div className="grid grid-cols-2 gap-2">
        <NumberInput label="Left" value={p.indentL} min={-500} max={1000} unit="pt" width={58} onChange={set('indentL', 'Left indent')} disabled={dis} title="Left indent" />
        <NumberInput label="Right" value={p.indentR} min={-500} max={1000} unit="pt" width={58} onChange={set('indentR', 'Right indent')} disabled={dis} title="Right indent" />
        <NumberInput label="First" value={p.firstIndent} min={-500} max={1000} unit="pt" width={58} onChange={set('firstIndent', 'First line indent')} disabled={dis} title="First line indent" />
        <span />
        <NumberInput label="Before" value={p.spaceBefore} min={0} max={1000} unit="pt" width={58} onChange={set('spaceBefore', 'Space before')} disabled={dis} title="Space before" />
        <NumberInput label="After" value={p.spaceAfter} min={0} max={1000} unit="pt" width={58} onChange={set('spaceAfter', 'Space after')} disabled={dis} title="Space after" />
        <NumberInput label="Drop lines" value={p.dropLines} min={0} max={10} width={40} onChange={set('dropLines', 'Drop cap')} disabled={dis} title="Drop cap number of lines" />
        <NumberInput label="Chars" value={p.dropChars} min={1} max={10} width={40} onChange={set('dropChars', 'Drop cap')} disabled={dis} title="Drop cap number of characters" />
      </div>
      <Row><Lbl>Para style</Lbl><Select small value={ed.typeInfo.ps} onChange={(v) => ed.applyParaStyle(v)} options={ed.doc.paraStyles.map((s) => ({ value: s.id, label: s.name }))} className="flex-1" /></Row>
    </div>
  );
}

function DocProps({ ed }) {
  const { doc } = ed; const dis = !ed.canEdit;
  const m = doc.margins;
  const setDoc = (patch, label, merge) => ed.change((d) => ({ ...d, ...patch }), label, merge);
  return (
    <div>
      <PanelSection title="Document" id="ly-doc">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="W" value={doc.width} min={36} max={15000} unit="pt" width={72} onChange={(v) => setDoc({ width: v }, 'Page size', 'pw')} disabled={dis} />
          <NumberInput label="H" value={doc.height} min={36} max={15000} unit="pt" width={72} onChange={(v) => setDoc({ height: v }, 'Page size', 'ph')} disabled={dis} />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <Toggle checked={doc.facing} onChange={(v) => setDoc({ facing: v }, 'Facing pages')} label="Facing pages" disabled={dis} />
          <NumberInput label="Start page #" value={doc.startPage} min={1} max={9999} width={56} onChange={(v) => setDoc({ startPage: v }, 'Start page number', 'sp')} disabled={dis} />
          <Button size="sm" variant="outline" icon="settings" onClick={() => docSetupDialog(ed)} disabled={dis}>Document Setup…</Button>
        </div>
      </PanelSection>
      <PanelSection title="Margins and Columns" id="ly-margins">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="Top" value={m.top} min={0} max={1000} unit="pt" width={60} onChange={(v) => setDoc({ margins: { ...m, top: v } }, 'Margins', 'mt')} disabled={dis} />
          <NumberInput label="Bottom" value={m.bottom} min={0} max={1000} unit="pt" width={60} onChange={(v) => setDoc({ margins: { ...m, bottom: v } }, 'Margins', 'mb')} disabled={dis} />
          <NumberInput label={doc.facing ? 'Inside' : 'Left'} value={m.inside} min={0} max={1000} unit="pt" width={60} onChange={(v) => setDoc({ margins: { ...m, inside: v } }, 'Margins', 'mi')} disabled={dis} />
          <NumberInput label={doc.facing ? 'Outside' : 'Right'} value={m.outside} min={0} max={1000} unit="pt" width={60} onChange={(v) => setDoc({ margins: { ...m, outside: v } }, 'Margins', 'mo')} disabled={dis} />
          <NumberInput label="Columns" value={doc.columns.count} min={1} max={20} width={44} onChange={(v) => setDoc({ columns: { ...doc.columns, count: v } }, 'Columns', 'cc')} disabled={dis} />
          <NumberInput label="Gutter" value={doc.columns.gutter} min={0} max={200} unit="pt" width={56} onChange={(v) => setDoc({ columns: { ...doc.columns, gutter: v } }, 'Gutter', 'cg')} disabled={dis} />
          <NumberInput label="Bleed" value={doc.bleed} min={0} max={72} unit="pt" width={56} onChange={(v) => setDoc({ bleed: v }, 'Bleed', 'bl')} disabled={dis} />
        </div>
      </PanelSection>
      <div className="p-3 text-[11.5px] text-fg3 leading-relaxed">
        Tips: draw text frames with the Type tool (T); click a frame’s out-port to thread text into another frame; drag from the rulers for guides;
        Ctrl/⌘+Shift-click a parent item to override it on a page; Type → Insert Current Page Number on a parent page numbers every page.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Styles

function StylesPanel({ ed }) {
  const { doc } = ed; const t = ed.typeInfo; const dis = !ed.canEdit;
  const captureChar = () => (t ? pick(t.char, CHAR_KEYS) : {});
  const captureAll = () => (t ? { ...pick(t.char, CHAR_KEYS), ...pick(t.para, PARA_KEYS) } : {});
  const newPara = async () => {
    const name = await promptDialog({ title: 'New Paragraph Style', label: 'Style name', value: `Paragraph Style ${doc.paraStyles.length}` });
    if (!name) return;
    const id = uid('ps');
    ed.change((d) => ({ ...d, paraStyles: [...d.paraStyles, { id, name, basedOn: null, a: captureAll() }] }), 'New paragraph style');
    if (t) setTimeout(() => ed.applyParaStyle(id), 0);
  };
  const newChar = async () => {
    const name = await promptDialog({ title: 'New Character Style', label: 'Style name', value: `Character Style ${doc.charStyles.length + 1}` });
    if (!name) return;
    const id = uid('cs');
    const a = t ? { ...charStyleAttrs(doc, t.cs), ...(t.run?.a || {}) } : {};
    ed.change((d) => ({ ...d, charStyles: [...d.charStyles, { id, name, a }] }), 'New character style');
    if (t) setTimeout(() => ed.applyCharStyle(id, true), 0);
  };
  const redefinePara = (s) => {
    if (!t) return;
    const a = captureAll();
    ed.change((d) => {
      // the style takes the selection's look; that paragraph's local overrides are then cleared
      let out = { ...d, paraStyles: d.paraStyles.map((x) => (x.id === s.id ? { ...x, a: diffFromParent(d, x, a) } : x)) };
      const stories = { ...out.stories };
      for (const tg of ed.edit ? [{ sid: ed.edit.sid, a: ed.range[0], b: ed.range[1] }] : []) stories[tg.sid] = formatParas(stories[tg.sid], tg.a, tg.b, { ps: s.id, clear: true });
      out = { ...out, stories };
      return out;
    }, `Redefine “${s.name}”`);
  };
  const redefineChar = (s) => {
    if (!t) return;
    const a = { ...charStyleAttrs(doc, t.cs), ...(t.run?.a || {}) };
    ed.change((d) => ({ ...d, charStyles: d.charStyles.map((x) => (x.id === s.id ? { ...x, a } : x)) }), `Redefine “${s.name}”`);
  };
  const styleMenu = (e, s, kind) => {
    e.preventDefault();
    openMenu(e, [
      { label: 'Apply', onClick: () => (kind === 'para' ? ed.applyParaStyle(s.id) : ed.applyCharStyle(s.id)) },
      { label: 'Edit…', icon: 'edit', onClick: () => editStyleDialog(ed, s, kind) },
      { label: 'Redefine Style from Selection', disabled: !t, onClick: () => (kind === 'para' ? redefinePara(s) : redefineChar(s)) },
      { label: 'Duplicate', icon: 'duplicate', onClick: () => ed.change((d) => (kind === 'para' ? { ...d, paraStyles: [...d.paraStyles, { ...structuredClone(s), id: uid('ps'), name: `${s.name} copy` }] } : { ...d, charStyles: [...d.charStyles, { ...structuredClone(s), id: uid('cs'), name: `${s.name} copy` }] }), 'Duplicate style') },
      { divider: true },
      { label: 'Delete Style', icon: 'trash', danger: true, disabled: s.id === 'ps-basic', onClick: () => ed.change((d) => {
        const r = ops.replaceStyleRefs(d, kind, s.id, kind === 'para' ? 'ps-basic' : null);
        return kind === 'para' ? { ...r, paraStyles: r.paraStyles.filter((x) => x.id !== s.id).map((x) => (x.basedOn === s.id ? { ...x, basedOn: s.basedOn } : x)) } : { ...r, charStyles: r.charStyles.filter((x) => x.id !== s.id) };
      }, 'Delete style') },
    ]);
  };
  const hasOverride = t && Object.keys(t.rawPara?.a || {}).length > 0;
  return (
    <div>
      <PanelSection title="Paragraph Styles" id="ly-ps" actions={!dis && <IconButton icon="plus" label="New paragraph style from selection" size={24} onClick={newPara} />}>
        {!t && <p className="text-[11px] text-fg3 mb-1.5">Select text or a text frame to apply styles.</p>}
        <div className="flex flex-col">
          {doc.paraStyles.map((s) => (
            <button key={s.id} type="button" disabled={dis || !t} onClick={(e) => ed.applyParaStyle(s.id, e.altKey)} onDoubleClick={() => editStyleDialog(ed, s, 'para')} onContextMenu={(e) => styleMenu(e, s, 'para')}
              className={cx('flex items-center h-7 px-2 rounded text-[12.5px] text-left disabled:opacity-60', t?.ps === s.id ? 'bg-active' : 'hover:bg-hover')}>
              <span className="flex-1 truncate">{s.name}{t?.ps === s.id && hasOverride ? '+' : ''}</span>
              <span className="text-[10px] text-fg3">{s.a.font || ''} {s.a.size ? `${s.a.size}pt` : ''}</span>
            </button>
          ))}
        </div>
        {t && !dis && (
          <div className="flex gap-1 flex-wrap mt-2">
            <Button size="xs" variant="outline" onClick={() => redefinePara(doc.paraStyles.find((x) => x.id === t.ps))}>Redefine from selection</Button>
            <Button size="xs" variant="outline" onClick={() => ed.applyParaStyle(t.ps)} disabled={!hasOverride}>Clear overrides</Button>
            <Button size="xs" variant="ghost" onClick={() => editStyleDialog(ed, doc.paraStyles.find((x) => x.id === t.ps), 'para')}>Edit…</Button>
          </div>
        )}
      </PanelSection>
      <PanelSection title="Character Styles" id="ly-cs" actions={!dis && <IconButton icon="plus" label="New character style from selection" size={24} onClick={newChar} />}>
        <div className="flex flex-col">
          <button type="button" disabled={dis || !t} onClick={() => ed.applyCharStyle(null)} className={cx('flex items-center h-7 px-2 rounded text-[12.5px] text-left disabled:opacity-60', t && !t.cs ? 'bg-active' : 'hover:bg-hover')}>[None]</button>
          {doc.charStyles.map((s) => (
            <button key={s.id} type="button" disabled={dis || !t} onClick={() => ed.applyCharStyle(s.id)} onDoubleClick={() => editStyleDialog(ed, s, 'char')} onContextMenu={(e) => styleMenu(e, s, 'char')}
              className={cx('flex items-center h-7 px-2 rounded text-[12.5px] text-left disabled:opacity-60', t?.cs === s.id ? 'bg-active' : 'hover:bg-hover')}>
              <span className="flex-1 truncate">{s.name}</span>
            </button>
          ))}
        </div>
        {t?.cs && !dis && <div className="mt-2"><Button size="xs" variant="outline" onClick={() => redefineChar(doc.charStyles.find((x) => x.id === t.cs))}>Redefine from selection</Button></div>}
      </PanelSection>
      <p className="p-3 text-[11px] text-fg3">Right-click a style to edit, redefine, duplicate or delete it. Alt-click applies a paragraph style and clears overrides.</p>
    </div>
  );
}

/** Style attributes that differ from what the "based on" style already gives. */
function diffFromParent(doc, style, a) {
  if (!style.basedOn) return a;
  const parent = doc.paraStyles.find((x) => x.id === style.basedOn);
  if (!parent) return a;
  const chain = []; let s = parent; const seen = new Set();
  while (s && !seen.has(s.id)) { seen.add(s.id); chain.unshift(s); s = s.basedOn ? doc.paraStyles.find((x) => x.id === s.basedOn) : null; }
  const inherited = { ...DEFAULT_CHAR, align: 'left', indentL: 0, indentR: 0, firstIndent: 0, spaceBefore: 0, spaceAfter: 0, dropLines: 0, dropChars: 1, ...Object.assign({}, ...chain.map((x) => x.a)) };
  const out = {};
  for (const [k, v] of Object.entries(a)) if (inherited[k] !== v) out[k] = v;
  return out;
}

function mount(render) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => setTimeout(() => { root.unmount(); host.remove(); }, 0);
  root.render(render(close));
}

function editStyleDialog(ed, style, kind) {
  if (!style) return;
  mount((close) => <StyleDialog ed={ed} style={style} kind={kind} onClose={close} />);
}
function StyleDialog({ ed, style, kind, onClose }) {
  const [s, setS] = useState(() => structuredClone(style));
  const a = s.a;
  const set = (k, v) => setS((x) => { const na = { ...x.a }; if (v === undefined || v === '' || v === null) delete na[k]; else na[k] = v; return { ...x, a: na }; });
  const save = () => {
    ed.change((d) => (kind === 'para' ? { ...d, paraStyles: d.paraStyles.map((x) => (x.id === s.id ? s : x)) } : { ...d, charStyles: d.charStyles.map((x) => (x.id === s.id ? s : x)) }), `Edit style “${s.name}”`);
    onClose();
  };
  const num = (k, label, o = {}) => <NumberInput label={label} value={a[k] ?? ''} onChange={(v) => set(k, v)} width={60} {...o} />;
  const lead = a.leading;
  return (
    <Modal title={`${kind === 'para' ? 'Paragraph' : 'Character'} Style Options`} onClose={onClose} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>OK</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Style name"><TextInput value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
        {kind === 'para' && (
          <Field label="Based on">
            <Select value={s.basedOn || ''} onChange={(v) => setS({ ...s, basedOn: v || null })} options={[{ value: '', label: '[No paragraph style]' }, ...ed.doc.paraStyles.filter((x) => x.id !== s.id).map((x) => ({ value: x.id, label: x.name }))]} />
          </Field>
        )}
        <div className="text-[11px] uppercase tracking-wider text-fg3">Basic character formats {kind === 'char' && '(blank = unchanged)'}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <FontPicker value={a.font || ''} weight={a.weight || 400} onChange={(f) => set('font', f)} width={180} />
          {a.font && <WeightPicker family={a.font} value={a.weight || 400} onChange={(w) => set('weight', w)} />}
          {!a.font && <Select small value={String(a.weight || '')} onChange={(v) => set('weight', v ? Number(v) : undefined)} options={[{ value: '', label: 'Weight —' }, ...[300, 400, 500, 600, 700, 800].map((w) => ({ value: String(w), label: String(w) }))]} />}
          {a.font && <Button size="xs" variant="ghost" onClick={() => set('font', undefined)}>Clear font</Button>}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {num('size', 'Size', { unit: 'pt', step: 0.5, precision: 1 })}
          <NumberInput label="Leading" value={lead ?? ''} onChange={(v) => set('leading', v)} width={60} unit="pt" step={0.5} precision={1} />
          {num('tracking', 'Tracking', { step: 5 })}
          {num('baseline', 'Baseline', { unit: 'pt' })}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Select small value={a.italic === undefined ? '' : a.italic ? '1' : '0'} onChange={(v) => set('italic', v === '' ? undefined : v === '1')} options={[{ value: '', label: 'Style —' }, { value: '0', label: 'Roman' }, { value: '1', label: 'Italic' }]} />
          <Select small value={a.underline === undefined ? '' : a.underline ? '1' : '0'} onChange={(v) => set('underline', v === '' ? undefined : v === '1')} options={[{ value: '', label: 'Underline —' }, { value: '0', label: 'No underline' }, { value: '1', label: 'Underline' }]} />
          <Select small value={a.caps === undefined ? '' : a.caps ? '1' : '0'} onChange={(v) => set('caps', v === '' ? undefined : v === '1')} options={[{ value: '', label: 'Case —' }, { value: '0', label: 'Normal' }, { value: '1', label: 'All caps' }]} />
          <span className="text-xs text-fg2">Colour</span><SwatchButton ed={ed} value={a.color} none label="Colour" onChange={(v) => set('color', v)} />
        </div>
        {kind === 'para' && (
          <>
            <div className="text-[11px] uppercase tracking-wider text-fg3">Indents, spacing and drop caps</div>
            <Select small value={a.align || ''} onChange={(v) => set('align', v || undefined)} options={[{ value: '', label: 'Alignment —' }, { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify (last line left)' }, { value: 'justify-all', label: 'Justify all lines' }]} />
            <div className="grid grid-cols-3 gap-2">
              {num('indentL', 'Left', { unit: 'pt' })}{num('indentR', 'Right', { unit: 'pt' })}{num('firstIndent', 'First', { unit: 'pt' })}
              {num('spaceBefore', 'Before', { unit: 'pt' })}{num('spaceAfter', 'After', { unit: 'pt' })}<span />
              {num('dropLines', 'Drop lines', { min: 0, max: 10 })}{num('dropChars', 'Drop chars', { min: 1, max: 10 })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Swatches

function SwatchesPanel({ ed }) {
  const { doc } = ed; const dis = !ed.canEdit;
  const { libraries, reloadLibraries } = useApp();
  const [target, setTarget] = useState('fill');
  const [edit, setEdit] = useState(null); // { swatch, anchor }
  const libColors = useMemo(() => (libraries || []).flatMap((l) => l.items.filter((i) => i.kind === 'color' && i.data?.hex).map((i) => ({ id: i.id, name: i.name, hex: i.data.hex, lib: l.name }))), [libraries]);
  const textSel = !!ed.typeInfo && (ed.edit || ed.selItems.some((x) => x.type === 'text'));
  const apply = (v) => {
    if (target === 'text') { if (textSel) ed.applyChar({ color: v }, 'Text colour'); else toast('Select some text first'); return; }
    if (!ed.selItems.length) { toast('Select a frame first'); return; }
    ed.updateSel({ [target]: v }, target === 'fill' ? 'Fill' : 'Stroke');
  };
  const addSwatch = (hex, name) => {
    const ex = doc.swatches.find((s) => s.hex.toLowerCase() === hex.toLowerCase());
    if (ex) return ex.id;
    const id = uid('sw');
    ed.change((d) => ({ ...d, swatches: [...d.swatches, { id, name: name || hex.toUpperCase(), hex }] }), 'New swatch');
    return id;
  };
  const saveToLibrary = async () => {
    const lib = libraries?.[0];
    if (!lib) { toast('Make a library on the Libraries page first'); return; }
    try {
      const have = new Set(libColors.map((c) => c.hex.toLowerCase()));
      let n = 0;
      for (const s of doc.swatches) if (!have.has(s.hex.toLowerCase()) && s.id !== 'paper') { await api.post(`/api/libraries/${lib.id}/items`, { kind: 'color', name: s.name, data: { hex: s.hex } }); n++; }
      reloadLibraries?.();
      toast(n ? `Added ${n} colour${n > 1 ? 's' : ''} to ${lib.name}` : 'Those colours are already in your library', { type: 'success' });
    } catch (e) { toastError(e); }
  };
  return (
    <div className="p-3 flex flex-col gap-3">
      <Segmented value={target} onChange={setTarget} options={[{ value: 'fill', label: 'Fill' }, { value: 'stroke', label: 'Stroke' }, { value: 'text', label: 'Text' }]} />
      <div className="flex flex-col">
        {target !== 'text' && <SwatchRow name="[None]" onClick={() => !dis && apply(null)} />}
        {doc.swatches.map((s) => (
          <SwatchRow key={s.id} hex={s.hex} name={s.name} onClick={() => !dis && apply(s.id)} onDoubleClick={(e) => !dis && setEdit({ swatch: s, anchor: e.currentTarget })}>
            {!dis && !['paper', 'black'].includes(s.id) && <span role="button" tabIndex={-1} className="opacity-40 hover:opacity-100" title="Delete swatch" onClick={(e) => { e.stopPropagation(); ed.change((d) => ops.deleteSwatch(d, s.id), 'Delete swatch'); }}><Icon name="trash" size={13} /></span>}
          </SwatchRow>
        ))}
      </div>
      {!dis && (
        <div className="flex gap-1.5 flex-wrap">
          <Button size="xs" variant="outline" icon="plus" onClick={(e) => setEdit({ swatch: null, anchor: e.currentTarget })}>New swatch</Button>
          <Button size="xs" variant="ghost" icon="library" onClick={saveToLibrary}>Save to library</Button>
        </div>
      )}
      <p className="text-[11px] text-fg3">Click to apply to the {target === 'text' ? 'selected text' : `selection’s ${target}`}. Double-click to edit a swatch — everything using it updates.</p>
      {libColors.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Library colours</div>
          <div className="flex flex-wrap gap-1">
            {libColors.map((c) => (
              <button key={c.id} type="button" title={`${c.name} (${c.lib}) — click to add as a swatch and apply`} disabled={dis}
                onClick={() => { const id = addSwatch(c.hex, c.name); setTimeout(() => apply(id), 0); }}
                className="w-6 h-6 rounded border border-line hover:scale-110 transition" style={{ background: c.hex }} />
            ))}
          </div>
        </div>
      )}
      {edit && (
        <Popover anchor={edit.anchor} onClose={() => setEdit(null)}>
          <SwatchEditor swatch={edit.swatch} onDone={(name, hex) => {
            if (edit.swatch) ed.change((d) => ({ ...d, swatches: d.swatches.map((x) => (x.id === edit.swatch.id ? { ...x, name, hex } : x)) }), 'Edit swatch');
            else addSwatch(hex, name);
            setEdit(null);
          }} />
        </Popover>
      )}
    </div>
  );
}
function SwatchEditor({ swatch, onDone }) {
  const [hex, setHex] = useState(swatch?.hex || '#ff3366');
  const [name, setName] = useState(swatch?.name || '');
  return (
    <div>
      <ColorPicker value={hex} onChange={setHex} alpha={false} />
      <div className="px-3 pb-3 flex gap-2">
        <TextInput value={name} placeholder="Swatch name" onChange={(e) => setName(e.target.value)} className="!h-7" />
        <Button size="sm" variant="primary" onClick={() => onDone(name || hex.toUpperCase(), hex)}>{swatch ? 'OK' : 'Add'}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Preflight

function PreflightPanel({ ed }) {
  const list = ed.preflight;
  const errs = list.filter((x) => x.level === 'error').length;
  return (
    <div className="p-3">
      <div className={cx('flex items-center gap-2 text-sm mb-3', errs ? 'text-danger' : 'text-ok')}>
        <Icon name={errs ? 'warning' : 'check'} size={16} />{errs ? `${errs} error${errs > 1 ? 's' : ''}` : 'No errors'}{list.length - errs > 0 && <span className="text-warn">· {list.length - errs} warning{list.length - errs > 1 ? 's' : ''}</span>}
      </div>
      {list.map((p, k) => {
        const pi = pageIndexOf(ed.doc, p.page);
        return (
          <button key={k} type="button" onClick={() => p.item && ed.showItem(p.item)} className="w-full text-left px-2 py-1.5 rounded hover:bg-hover flex gap-2">
            <Icon name="warning" size={14} className={p.level === 'error' ? 'text-danger mt-0.5' : 'text-warn mt-0.5'} />
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px]">{p.msg}</span>
              <span className="block text-[11px] text-fg3 truncate">{pi >= 0 ? `Page ${pageNumber(ed.doc, pi)}` : `Parent ${p.page}`}{p.detail ? ` · ${p.detail}` : ''}</span>
            </span>
          </button>
        );
      })}
      <p className="text-[11px] text-fg3 mt-3">Checks overset text, missing images and images below 150 ppi at their placed size.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Document Setup

export function docSetupDialog(ed, focus) {
  if (!ed.canEdit) return;
  mount((close) => <DocSetup ed={ed} focus={focus} onClose={close} />);
}
function DocSetup({ ed, onClose }) {
  const d0 = ed.doc;
  const [v, setV] = useState({ width: d0.width, height: d0.height, facing: d0.facing, pages: d0.pages.length, startPage: d0.startPage, margins: { ...d0.margins }, columns: { ...d0.columns }, bleed: d0.bleed });
  const set = (k, x) => setV((s) => ({ ...s, [k]: x }));
  const ok = () => {
    ed.change((d) => {
      let out = { ...d, width: v.width, height: v.height, facing: v.facing, startPage: v.startPage, margins: v.margins, columns: v.columns, bleed: v.bleed };
      if (v.pages > d.pages.length) out = ops.addPages(out, d.pages.length, v.pages - d.pages.length);
      if (v.pages < d.pages.length) out = ops.deletePages(out, range(v.pages, d.pages.length - 1));
      return out;
    }, 'Document setup');
    onClose();
  };
  const m = v.margins;
  return (
    <Modal title="Document Setup" onClose={onClose} width={520} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={ok}>OK</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-4 flex-wrap items-center">
          <NumberInput label="Width" value={v.width} min={36} max={15000} unit="pt" width={80} onChange={(x) => set('width', x)} />
          <NumberInput label="Height" value={v.height} min={36} max={15000} unit="pt" width={80} onChange={(x) => set('height', x)} />
          <Button size="xs" variant="ghost" icon="rotate" onClick={() => setV((s) => ({ ...s, width: s.height, height: s.width }))}>Swap</Button>
        </div>
        <div className="flex gap-4 flex-wrap items-center">
          <NumberInput label="Pages" value={v.pages} min={1} max={999} width={56} onChange={(x) => set('pages', x)} />
          <NumberInput label="Start page #" value={v.startPage} min={1} max={9999} width={56} onChange={(x) => set('startPage', x)} />
          <Toggle checked={v.facing} onChange={(x) => set('facing', x)} label="Facing pages" />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-fg3 mb-2">Margins</div>
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Top" value={m.top} min={0} unit="pt" width={64} onChange={(x) => set('margins', { ...m, top: x })} />
            <NumberInput label="Bottom" value={m.bottom} min={0} unit="pt" width={64} onChange={(x) => set('margins', { ...m, bottom: x })} />
            <NumberInput label={v.facing ? 'Inside' : 'Left'} value={m.inside} min={0} unit="pt" width={64} onChange={(x) => set('margins', { ...m, inside: x })} />
            <NumberInput label={v.facing ? 'Outside' : 'Right'} value={m.outside} min={0} unit="pt" width={64} onChange={(x) => set('margins', { ...m, outside: x })} />
          </div>
        </div>
        <div className="flex gap-4 flex-wrap">
          <NumberInput label="Columns" value={v.columns.count} min={1} max={20} width={48} onChange={(x) => set('columns', { ...v.columns, count: x })} />
          <NumberInput label="Gutter" value={v.columns.gutter} min={0} unit="pt" width={60} onChange={(x) => set('columns', { ...v.columns, gutter: x })} />
          <NumberInput label="Bleed" value={v.bleed} min={0} max={72} unit="pt" width={60} onChange={(x) => set('bleed', x)} />
        </div>
        {v.pages < d0.pages.length && <p className="text-xs text-warn">Pages {v.pages + 1}–{d0.pages.length} and everything on them will be removed.</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Find / Change

export function FindChange({ ed, onClose }) {
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [cs, setCs] = useState(false);
  const [whole, setWhole] = useState(false);
  const [msg, setMsg] = useState('');
  const { doc } = ed;
  const order = useMemo(() => Object.keys(doc.stories).sort((a, b) => {
    const pa = pageIndexOf(doc, findItem(doc, doc.stories[a].frames[0])?.page); const pb = pageIndexOf(doc, findItem(doc, doc.stories[b].frames[0])?.page);
    return pa - pb;
  }), [doc]);
  const rx = () => {
    if (!find) return null;
    const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(whole ? `\\b${esc}\\b` : esc, cs ? 'g' : 'gi');
  };
  const matchesIn = (sid) => { const r = rx(); if (!r) return []; const t = doc.stories[sid].text; const out = []; let m; while ((m = r.exec(t))) { out.push([m.index, m.index + m[0].length]); if (!m[0].length) r.lastIndex++; } return out; };
  const findNext = () => {
    if (!find) return false;
    const startSid = ed.edit?.sid; const startPos = ed.edit ? Math.max(ed.edit.a, ed.edit.f) : -1;
    const k0 = Math.max(0, order.indexOf(startSid));
    for (let n = 0; n <= order.length; n++) {
      const sid = order[(k0 + n) % order.length];
      const ms = matchesIn(sid).filter(([a]) => (n === 0 && sid === startSid ? a >= startPos : true));
      if (ms.length) {
        const [a, b] = ms[0];
        const fr = findItem(doc, doc.stories[sid].frames[0]);
        const pi = pageIndexOf(doc, fr?.page);
        if (pi < 0) ed.editMaster(fr.page); else if (ed.masterEdit) ed.setMasterEdit(null);
        ed.setTool('type'); ed.setEdit({ sid, a, f: b });
        const loc = ed.locate(sid, a);
        if (loc) ed.setSel([loc.it.id]);
        setMsg('');
        return true;
      }
    }
    setMsg('No more matches.');
    return false;
  };
  const isMatchSelected = () => {
    if (!ed.edit || !ed.range || ed.range[0] === ed.range[1]) return false;
    const r = rx(); if (!r) return false;
    const t = doc.stories[ed.edit.sid].text.slice(ed.range[0], ed.range[1]);
    r.lastIndex = 0; const m = r.exec(t);
    return !!m && m.index === 0 && m[0].length === t.length;
  };
  const changeOne = () => {
    if (!isMatchSelected()) return false;
    const [a, b] = ed.range;
    ed.setStory(ed.edit.sid, (s) => deleteRange(insertText(s, b, repl), a, b), 'Change');
    ed.setEdit({ ...ed.edit, a: a + repl.length, f: a + repl.length });
    return true;
  };
  const changeAll = () => {
    let n = 0;
    ed.change((d) => {
      const stories = { ...d.stories };
      for (const sid of Object.keys(stories)) {
        const r = rx(); let s = stories[sid]; const t = s.text;
        const ms = []; let m;
        while ((m = r.exec(t))) { ms.push([m.index, m.index + m[0].length]); if (!m[0].length) r.lastIndex++; }
        for (const [a, b] of ms.reverse()) {
          // the replacement takes the formatting of the matched text
          s = deleteRange(insertText(s, b, repl), a, b);
          n++;
        }
        stories[sid] = s;
      }
      return { ...d, stories };
    }, 'Change all');
    setMsg(`${n} replacement${n === 1 ? '' : 's'} made.`);
  };
  return (
    <div className="absolute top-3 right-3 z-20 w-80 rounded-lg bg-menu border border-line shadow-[0_12px_40px_rgba(0,0,0,.45)] p-3 flex flex-col gap-2 sl-pop" role="dialog" aria-label="Find/Change">
      <div className="flex items-center"><span className="text-sm font-medium flex-1">Find/Change</span><IconButton icon="close" label="Close" size={24} onClick={onClose} /></div>
      <Field label="Find what"><TextInput autoFocus value={find} onChange={(e) => { setFind(e.target.value); setMsg(''); }} onKeyDown={(e) => { if (e.key === 'Enter') findNext(); if (e.key === 'Escape') onClose(); }} /></Field>
      <Field label="Change to"><TextInput value={repl} onChange={(e) => setRepl(e.target.value)} /></Field>
      <div className="flex gap-3"><Checkbox label="Case sensitive" checked={cs} onChange={setCs} /><Checkbox label="Whole word" checked={whole} onChange={setWhole} /></div>
      <div className="grid grid-cols-2 gap-1.5">
        <Button size="sm" variant="primary" onClick={findNext} disabled={!find}>Find Next</Button>
        <Button size="sm" onClick={() => { if (!changeOne()) findNext(); }} disabled={!find || !ed.canEdit}>Change</Button>
        <Button size="sm" onClick={changeAll} disabled={!find || !ed.canEdit}>Change All</Button>
        <Button size="sm" onClick={() => { changeOne(); setTimeout(findNext, 0); }} disabled={!find || !ed.canEdit}>Change/Find</Button>
      </div>
      <div className="text-[11.5px] text-fg2 min-h-4">{msg || (find ? `${order.reduce((n, sid) => n + matchesIn(sid).length, 0)} matches in the document` : 'Searches every story, including parent pages.')}</div>
    </div>
  );
}
