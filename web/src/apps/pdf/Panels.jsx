// PDF panels: the options bar, left sidebar (thumbnails, bookmarks, search), right panels (properties, comments,
// Fill & Sign, redaction), the Organise Pages grid, and the signature and split dialogs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, IconButton, NumberInput, Select, Segmented, Toggle, Checkbox, PanelSection, Modal, TextInput, Field, Tabs, Slider, openMenu, toast, toastError, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { api, saveBlob, ago } from '../../lib/api.js';
import { ensureFont } from '../../lib/fonts.js';
import { canvasBlob, assetSrc } from '../../lib/doc.js';
import { renderEntry, displaySize, STAMPS } from './engine.js';

const COLORS = ['#ffd400', '#ff8a00', '#e5383b', '#ff4fa3', '#7a4fd6', '#1f6feb', '#00b3c7', '#1f9d55', '#000000', '#ffffff'];
const TYPE_LABEL = { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', note: 'Sticky note', freetext: 'Text box', rect: 'Rectangle', ellipse: 'Oval', line: 'Line', arrow: 'Arrow', ink: 'Drawing', stamp: 'Stamp', text: 'Text', image: 'Signature', redact: 'Redaction' };
const TYPE_ICON = { highlight: 'highlight', underline: 'underline', strike: 'minus', note: 'comment', freetext: 'textBox', rect: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'arrow', ink: 'pencil', stamp: 'stamp', text: 'text', image: 'sign', redact: 'eyeOff' };

function ColorRow({ value, onChange, colors = COLORS }) {
  return (
    <div className="flex items-center gap-1">
      {colors.map((c) => (
        <button key={c} type="button" title={c} onClick={() => onChange(c)} className={cx('w-5 h-5 rounded-full border transition', value === c ? 'border-fg scale-110 ring-2 ring-accent/50' : 'border-line hover:scale-110')} style={{ background: c }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- options bar

export function OptionsBar({ ed }) {
  const t = ed.tool; const o = ed.toolOpts;
  const setO = (k, v) => ed.setToolOpts((x) => ({ ...x, [k]: v }));
  let left = null;
  if (ed.mode === 'organize') left = <span className="text-xs text-fg2">Drag pages to reorder · Shift/Ctrl-click to select several · double-click to open a page</span>;
  else if (['highlight', 'underline', 'strike'].includes(t)) left = <><span className="text-xs text-fg2">Select text to {t === 'strike' ? 'strike through' : t}</span><ColorRow value={o[t]} onChange={(c) => setO(t, c)} /></>;
  else if (['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(t)) left = <><ColorRow value={o[t]} onChange={(c) => setO(t, c)} /><NumberInput label="Width" value={o.width} min={0.5} max={20} step={0.5} precision={1} unit="pt" width={56} onChange={(v) => setO('width', v)} /></>;
  else if (t === 'freetext' || t === 'text') left = <><ColorRow value={o[t]} onChange={(c) => setO(t, c)} colors={['#000000', '#1f6feb', '#e5383b', '#1f9d55', '#7a4fd6']} /><NumberInput label="Size" value={o.size} min={6} max={72} unit="pt" width={52} onChange={(v) => setO('size', v)} /><span className="text-xs text-fg2">Click on the page to add text</span></>;
  else if (t === 'note') left = <><ColorRow value={o.note} onChange={(c) => setO('note', c)} colors={['#ffd400', '#ff8a00', '#ff4fa3', '#00b3c7', '#1f9d55']} /><span className="text-xs text-fg2">Click to add a sticky note</span></>;
  else if (t === 'stamp') left = <><Select small value={o.stamp} onChange={(v) => setO('stamp', v)} options={Object.entries(STAMPS).map(([k, s]) => ({ value: k, label: s.label }))} /><span className="text-xs text-fg2">Click on the page to stamp</span></>;
  else if (t === 'sign' || t === 'initials') {
    const kind = t === 'sign' ? 'signature' : 'initials';
    left = <>{o[kind] ? <img src={assetSrc(o[kind].asset)} alt="" className="h-7 bg-white rounded px-1" /> : <span className="text-xs text-fg2">No {kind} chosen yet</span>}
      <Button size="xs" variant="outline" onClick={() => ed.newSignature(kind)}>{o[kind] ? 'Change…' : `Create ${kind}…`}</Button><span className="text-xs text-fg2">Click on the page to place it</span></>;
  } else if (t === 'date') left = <span className="text-xs text-fg2">Click to add today’s date</span>;
  else if (t === 'redact') left = <><span className="text-xs text-fg2">Drag over what to hide.</span><Button size="xs" variant="danger" onClick={ed.applyRedactions}>Apply redactions…</Button></>;
  else left = <span className="text-xs text-fg2">{ed.canEdit ? 'Select text to copy · click a comment to select it · fill in form fields directly' : 'View only — you can read, search and copy text'}</span>;
  const [pg, setPg] = useState(null);
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="flex items-center gap-2 min-w-0">{left}</div>
      <span className="flex-1" />
      {ed.mode === 'view' && (
        <div className="flex items-center gap-1 shrink-0">
          <IconButton icon="chevronUp" label="Previous page" size={26} onClick={() => ed.goTo(Math.max(0, ed.cur - 1))} disabled={ed.cur === 0} />
          <input aria-label="Page number" value={pg ?? String(ed.cur + 1)} onChange={(e) => setPg(e.target.value)} onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === 'Enter') { const n = parseInt(pg, 10); if (n >= 1 && n <= ed.list.length) ed.goTo(n - 1); setPg(null); e.currentTarget.blur(); } }} onBlur={() => setPg(null)}
            className="w-10 h-7 text-center rounded bg-input border border-line text-[13px]" />
          <span className="text-xs text-fg2">/ {ed.list.length}</span>
          <IconButton icon="chevronDown" label="Next page" size={26} onClick={() => ed.goTo(Math.min(ed.list.length - 1, ed.cur + 1))} disabled={ed.cur >= ed.list.length - 1} />
          <span className="w-px h-5 bg-line mx-1" />
          <IconButton icon="zoomOut" label="Zoom out" size={26} onClick={() => ed.zoomBy(1 / 1.2)} />
          <button type="button" className="text-xs w-12 text-fg2 hover:text-fg" onClick={() => { ed.setFit(null); ed.setZoom(1); }} title="Actual size">{Math.round(ed.zoom * 100)}%</button>
          <IconButton icon="zoomIn" label="Zoom in" size={26} onClick={() => ed.zoomBy(1.2)} />
          <Segmented value={ed.fit || ''} onChange={(v) => ed.setFit(v)} options={[{ value: 'width', label: 'Fit width' }, { value: 'page', label: 'Fit page' }]} />
          <Segmented value={ed.scrollMode} onChange={ed.setScrollMode} options={[{ value: 'continuous', icon: 'list', title: 'Continuous scrolling' }, { value: 'single', icon: 'page', title: 'Single page' }]} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- thumbnails

function Thumb({ ed, e, width = 120, onClick, onDoubleClick, active, children, className, ...rest }) {
  const ref = useRef(null);
  const [src, setSrc] = useState(null);
  const k = ed.list.indexOf(e);
  const inf = ed.infos[k] || { w: 612, h: 792 };
  const [w, h] = displaySize(inf.w, inf.h, e.rot || 0);
  const H = Math.round(width * h / w);
  useEffect(() => {
    let off = false;
    const io = new IntersectionObserver(async ([en]) => {
      if (!en.isIntersecting) return;
      io.disconnect();
      try { const c = await renderEntry(e, ed.docs, (width * 2) / w, { annotations: true }); if (!off) setSrc(c.toDataURL('image/jpeg', 0.75)); } catch { /* cancelled */ }
    }, { rootMargin: '300px' });
    if (ref.current) io.observe(ref.current);
    return () => { off = true; io.disconnect(); };
  }, [e.src, e.i, e.rot, ed.docs, width, w]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button ref={ref} type="button" onClick={onClick} onDoubleClick={onDoubleClick} className={cx('relative bg-white border-2 shrink-0', active ? 'border-accent' : 'border-transparent hover:border-line', className)} style={{ width: width + 4, height: H + 4 }} {...rest}>
      {src && <img src={src} alt="" draggable={false} className="w-full h-full object-contain" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- left sidebar

export function LeftSidebar({ ed }) {
  const [tab, setTab] = useState('pages');
  const [open, setOpen] = useState(true);
  if (!open) return <div className="w-8 shrink-0 bg-panel border-r border-line flex flex-col items-center py-2"><IconButton icon="panelLeft" label="Show sidebar" size={26} onClick={() => setOpen(true)} /></div>;
  return (
    <div className="w-[200px] shrink-0 bg-panel border-r border-line flex flex-col min-h-0">
      <div className="flex items-center border-b border-line">
        <div className="flex-1 flex" role="tablist">
          {[['pages', 'Pages'], ['outline', 'Bookmarks'], ['search', 'Search']].map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)}
              className={cx('px-1.5 h-8 text-[12px] border-b-2 -mb-px', tab === v ? 'border-accent text-fg' : 'border-transparent text-fg2 hover:text-fg')}>{l}</button>
          ))}
        </div>
        <IconButton icon="chevronLeft" label="Hide sidebar" size={24} onClick={() => setOpen(false)} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto scroll-thin">
        {tab === 'pages' && (
          <div className="flex flex-col items-center gap-3 py-3">
            {ed.list.map((e, k) => (
              <div key={e.id} className="flex flex-col items-center">
                <Thumb ed={ed} e={e} width={120} active={k === ed.cur} onClick={() => ed.goTo(k)}>
                  {ed.data.annotations.some((a) => a.page === e.id) && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#ffb000]" title="Has comments" />}
                </Thumb>
                <span className="text-[11px] text-fg2 mt-1">{k + 1}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'outline' && <Outline ed={ed} />}
        {tab === 'search' && <SearchPanel ed={ed} />}
      </div>
    </div>
  );
}

function Outline({ ed }) {
  if (ed.outline === null) return <p className="p-3 text-xs text-fg3">Loading bookmarks…</p>;
  if (!ed.outline.length) return <p className="p-3 text-xs text-fg3">This document has no bookmarks.</p>;
  const go = (srcPage) => { const k = ed.list.findIndex((e) => e.src === 'source' && e.i === srcPage); if (k >= 0) ed.goTo(k); else toast('That page was removed'); };
  const Node = ({ n, depth }) => {
    const [open, setOpen] = useState(depth < 1);
    return (
      <div>
        <div className="flex items-center hover:bg-hover rounded" style={{ paddingLeft: depth * 12 }}>
          {n.items.length ? <button type="button" onClick={() => setOpen(!open)} className="w-5 h-6 grid place-items-center text-fg3"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /></button> : <span className="w-5" />}
          <button type="button" className="flex-1 text-left text-[12.5px] py-1 truncate" title={n.title} onClick={() => n.page !== null && go(n.page)}>{n.title}</button>
        </div>
        {open && n.items.map((c, k) => <Node key={k} n={c} depth={depth + 1} />)}
      </div>
    );
  };
  return <div className="p-1.5">{ed.outline.map((n, k) => <Node key={k} n={n} depth={0} />)}</div>;
}

function SearchPanel({ ed }) {
  const [q, setQ] = useState(ed.search.q);
  const [mc, setMc] = useState(false);
  const s = ed.search;
  return (
    <div className="p-2 flex flex-col gap-2">
      <TextInput id="pdf-search" value={q} placeholder="Find in document" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { if (q === s.q && s.hits.length) ed.stepHit(e.shiftKey ? -1 : 1); else ed.runSearch(q, { matchCase: mc }); } }} />
      <div className="flex items-center gap-1">
        <Checkbox label="Match case" checked={mc} onChange={setMc} />
        <span className="flex-1" />
        <IconButton icon="chevronUp" label="Previous" size={24} onClick={() => ed.stepHit(-1)} disabled={!s.hits.length} />
        <IconButton icon="chevronDown" label="Next" size={24} onClick={() => ed.stepHit(1)} disabled={!s.hits.length} />
      </div>
      <div className="text-[11.5px] text-fg2">{s.busy ? 'Searching…' : s.q ? `${s.hits.length ? s.idx + 1 : 0} of ${s.hits.length} result${s.hits.length === 1 ? '' : 's'}` : 'Press Enter to search'}</div>
      <div className="flex flex-col">
        {s.hits.slice(0, 300).map((hit, k) => (
          <button key={k} type="button" onClick={() => { ed.setSearch((x) => ({ ...x, idx: k })); ed.viewerRef.current?.reveal(hit.page, hit.rects[0]); }}
            className={cx('text-left px-2 py-1.5 rounded text-[11.5px]', k === s.idx ? 'bg-active' : 'hover:bg-hover')}>
            <span className="text-fg3">p.{hit.page + 1}</span> <span className="text-fg2">…{hit.text}…</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- right panels

export function RightPanels({ ed }) {
  const a = ed.selAnn;
  return (
    <div>
      {a && <PanelSection title={`${TYPE_LABEL[a.type] || 'Comment'} properties`} id="pdf-props"><AnnProps ed={ed} a={a} /></PanelSection>}
      <PanelSection title={`Comments (${ed.data.annotations.length})`} id="pdf-comments"><CommentsList ed={ed} /></PanelSection>
      <PanelSection title="Fill & Sign" id="pdf-sign"><FillSign ed={ed} /></PanelSection>
      <PanelSection title="Redact" id="pdf-redact" defaultOpen={false}><RedactPanel ed={ed} /></PanelSection>
    </div>
  );
}

function AnnProps({ ed, a }) {
  const dis = !ed.canEdit;
  const up = (patch, label, merge) => ed.updateAnn(a.id, patch, label, merge);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[11px] text-fg3">{a.author} · {a.created ? ago(a.created) : ''}{a.quote ? ` · “${a.quote.slice(0, 60)}”` : ''}</div>
      {!['image', 'redact', 'stamp'].includes(a.type) && <ColorRow value={a.type === 'freetext' ? a.textColor || a.color : a.color} onChange={(c) => !dis && up(a.type === 'freetext' ? { textColor: c, color: c } : { color: c }, 'Colour')} />}
      {['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(a.type) && <NumberInput label="Width" value={a.width || 2} min={0.5} max={20} step={0.5} precision={1} unit="pt" width={56} onChange={(v) => up({ width: v }, 'Line width', `w-${a.id}`)} disabled={dis} />}
      {['rect', 'ellipse', 'freetext'].includes(a.type) && <div className="flex items-center gap-2"><span className="text-xs text-fg2">Fill</span><ColorRow value={a.fill} onChange={(c) => !dis && up({ fill: a.fill === c ? null : c }, 'Fill')} colors={['#fff7c2', '#ffe1e1', '#e1ecff', '#e3f7e8', '#ffffff']} /></div>}
      {a.type === 'freetext' && <Checkbox label="Border" checked={!!a.border} onChange={(v) => up({ border: v }, 'Border')} />}
      {['freetext', 'text'].includes(a.type) && <NumberInput label="Text size" value={a.size || 12} min={5} max={96} unit="pt" width={56} onChange={(v) => up({ size: v }, 'Text size', `s-${a.id}`)} disabled={dis} />}
      {!['image', 'redact', 'text'].includes(a.type) && <Slider label="Opacity" value={Math.round((a.opacity ?? (a.type === 'highlight' ? 1 : 1)) * 100)} min={10} max={100} unit="%" onChange={(v) => up({ opacity: v / 100 }, 'Opacity', `o-${a.id}`)} />}
      {a.type === 'stamp' && <Select small value={a.stamp} onChange={(v) => up({ stamp: v, color: STAMPS[v].color }, 'Stamp')} options={Object.entries(STAMPS).map(([k, s]) => ({ value: k, label: s.label }))} />}
      {['freetext', 'text', 'note'].includes(a.type) ? (
        <Field label={a.type === 'note' ? 'Note' : 'Text'}>
          <textarea value={a.text || ''} rows={4} disabled={dis} onChange={(e) => up({ text: e.target.value }, 'Edit text', `t-${a.id}`)} autoFocus={ed.editing === a.id && a.type === 'note'}
            className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 resize-y" />
        </Field>
      ) : a.type !== 'redact' && (
        <Field label="Comment">
          <textarea value={a.comment || ''} rows={3} disabled={dis} placeholder="Add a note to this mark-up" onChange={(e) => up({ comment: e.target.value }, 'Edit comment', `c-${a.id}`)}
            className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 resize-y" />
        </Field>
      )}
      {!dis && <div><Button size="xs" variant="outline" icon="trash" onClick={() => ed.deleteAnn(a.id)}>Delete</Button></div>}
    </div>
  );
}

function CommentsList({ ed }) {
  const [filter, setFilter] = useState('all');
  const pageIdx = useMemo(() => Object.fromEntries(ed.list.map((e, k) => [e.id, k])), [ed.list]);
  const anns = ed.data.annotations.filter((a) => pageIdx[a.page] !== undefined && (filter === 'all' || (filter === 'markup' ? !['image', 'text', 'redact'].includes(a.type) : ['image', 'text'].includes(a.type))))
    .sort((x, y) => pageIdx[x.page] - pageIdx[y.page] || annY(x) - annY(y));
  return (
    <div>
      <Select small value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Everything' }, { value: 'markup', label: 'Comments & mark-up' }, { value: 'sign', label: 'Text & signatures' }]} className="w-full mb-2" />
      {!anns.length && <p className="text-[12px] text-fg3">No comments yet. Use the highlight, note and drawing tools on the left.</p>}
      <div className="flex flex-col gap-1">
        {anns.map((a, k) => (
          <div key={a.id}>
            {(k === 0 || pageIdx[anns[k - 1].page] !== pageIdx[a.page]) && <div className="text-[10.5px] uppercase tracking-wider text-fg3 mt-1.5 mb-0.5">Page {pageIdx[a.page] + 1}</div>}
            <button type="button" onClick={() => { ed.setSel(a.id); ed.viewerRef.current?.reveal(pageIdx[a.page], [annX(a), annY(a)]); }}
              className={cx('w-full text-left rounded-md px-2 py-1.5 flex gap-2 items-start', ed.sel === a.id ? 'bg-active' : 'hover:bg-hover')}>
              <span className="w-5 h-5 rounded grid place-items-center shrink-0 mt-0.5" style={{ background: a.type === 'redact' ? '#222' : `${a.color || '#888'}33`, color: a.type === 'redact' ? '#fff' : a.color }}><Icon name={TYPE_ICON[a.type] || 'comment'} size={12} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12px]">{TYPE_LABEL[a.type]}{a.type === 'stamp' ? `: ${STAMPS[a.stamp]?.label}` : ''}{a.type === 'redact' ? (a.applied ? ' (applied)' : ' (marked)') : ''} <span className="text-fg3">· {a.author}</span></span>
                {(a.text || a.comment || a.quote) && <span className="block text-[11.5px] text-fg2 truncate">{a.text || a.comment || `“${a.quote}”`}</span>}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
const annY = (a) => (a.rects ? a.rects[0][1] : a.y ?? a.y1 ?? a.paths?.[0]?.[0]?.[1] ?? 0);
const annX = (a) => (a.rects ? a.rects[0][0] : a.x ?? a.x1 ?? a.paths?.[0]?.[0]?.[0] ?? 0);

function FillSign({ ed }) {
  const o = ed.toolOpts;
  const nFields = ed.fields.reduce((n, l) => n + new Set(l.map((f) => f.name)).size, 0);
  const filled = Object.keys(ed.data.form).length;
  const choose = (kind, it) => { ed.setToolOpts((x) => ({ ...x, [kind]: { asset: it.asset_id, w: it.data.w || 300, h: it.data.h || 100 } })); ed.setTool(kind === 'signature' ? 'sign' : 'initials'); ed.setMode('view'); };
  const sigs = ed.signatures.filter((s) => (s.data.kind || 'signature') === 'signature');
  const inits = ed.signatures.filter((s) => s.data.kind === 'initials');
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-fg2">{nFields ? `${nFields} form field${nFields > 1 ? 's' : ''} — click a field on the page to fill it.${filled ? ` ${filled} filled in.` : ''}` : 'No form fields detected. Use Add text to type anywhere.'}</div>
      {filled > 0 && ed.canEdit && <div><Button size="xs" variant="ghost" onClick={() => ed.change((d) => ({ ...d, form: {} }), 'Clear form')}>Clear form</Button></div>}
      <div className="grid grid-cols-2 gap-1.5">
        <Button size="sm" variant="outline" icon="text" disabled={!ed.canEdit} onClick={() => { ed.setMode('view'); ed.setTool('text'); }}>Add text</Button>
        <Button size="sm" variant="outline" icon="clock" disabled={!ed.canEdit} onClick={() => { ed.setMode('view'); ed.setTool('date'); }}>Date</Button>
      </div>
      {[['signature', 'Signatures', sigs], ['initials', 'Initials', inits]].map(([kind, label, list]) => (
        <div key={kind}>
          <div className="flex items-center mb-1"><span className="text-[11px] uppercase tracking-wider text-fg3 flex-1">{label}</span>
            {ed.canEdit && <Button size="xs" variant="ghost" icon="plus" onClick={async () => { const r = await ed.newSignature(kind); if (r) { ed.setMode('view'); ed.setTool(kind === 'signature' ? 'sign' : 'initials'); } }}>New</Button>}</div>
          <div className="flex flex-wrap gap-1.5">
            {list.map((s) => (
              <button key={s.id} type="button" title={`Use this ${kind}`} disabled={!ed.canEdit} onClick={() => choose(kind, s)}
                className={cx('h-11 px-1.5 rounded bg-white border-2', o[kind]?.asset === s.asset_id ? 'border-accent' : 'border-transparent hover:border-line')}>
                <img src={s.asset_url} alt={s.name} className="h-full max-w-[110px] object-contain" />
              </button>
            ))}
            {!list.length && <span className="text-[11.5px] text-fg3">None saved yet.</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function RedactPanel({ ed }) {
  const marks = ed.data.annotations.filter((a) => a.type === 'redact');
  const pending = marks.filter((a) => !a.applied).length;
  return (
    <div className="flex flex-col gap-2.5 text-[12px]">
      <div className="text-fg2">{marks.length ? `${marks.length} area${marks.length > 1 ? 's' : ''} — ${pending} marked, ${marks.length - pending} applied.` : 'Use the Redact tool to mark areas to black out.'}</div>
      <div className="flex gap-1.5">
        <Button size="xs" variant="outline" icon="eyeOff" disabled={!ed.canEdit} onClick={() => { ed.setMode('view'); ed.setTool('redact'); }}>Mark areas</Button>
        <Button size="xs" variant="danger" disabled={!ed.canEdit || !pending} onClick={ed.applyRedactions}>Apply</Button>
      </div>
      <div className="rounded-md border border-warn/40 bg-warn/10 p-2 text-[11.5px] text-fg2 leading-relaxed">
        <b className="text-warn">Note:</b> applied redactions are drawn as black boxes on export, but the text underneath is <b>not removed</b> — it can still be selected or copied from the PDF. Turn on flattening to export redacted pages as images so the hidden content is gone for good.
      </div>
      <Toggle checked={!!ed.data.redactFlatten} onChange={(v) => ed.change((d) => ({ ...d, redactFlatten: v }), v ? 'Flatten redacted pages' : 'Keep redacted pages as text')} label="Flatten redacted pages to images" disabled={!ed.canEdit} />
    </div>
  );
}

// ---------------------------------------------------------------- organise pages

export function Organizer({ ed }) {
  const sel = ed.orgSel; const setSel = ed.setOrgSel;
  const [drop, setDrop] = useState(null);
  const from = useRef(null);
  const [size, setSize] = useState(150);
  const click = (e, k) => {
    if (e.shiftKey && sel.length) { const a = Math.min(sel[sel.length - 1], k); const b = Math.max(sel[sel.length - 1], k); setSel([...new Set([...sel, ...Array.from({ length: b - a + 1 }, (_, i) => a + i)])]); }
    else if (e.ctrlKey || e.metaKey) setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
    else setSel([k]);
  };
  const target = sel.length ? [...sel].sort((a, b) => a - b) : [];
  const dis = !ed.canEdit;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-1.5 px-3 border-b border-line bg-panel">
        <Button size="sm" variant="ghost" icon="back" onClick={() => ed.setMode('view')}>Back to document</Button>
        <span className="w-px h-5 bg-line mx-1" />
        <Button size="sm" icon="undo" disabled={dis || !target.length} onClick={() => ed.rotatePages(target, -90)}>Rotate left</Button>
        <Button size="sm" icon="redo" disabled={dis || !target.length} onClick={() => ed.rotatePages(target, 90)}>Rotate right</Button>
        <Button size="sm" icon="trash" disabled={dis || !target.length} onClick={() => ed.deletePages(target)}>Delete</Button>
        <Button size="sm" icon="export" disabled={!target.length} onClick={() => ed.exportPicked(target)}>Extract</Button>
        <span className="w-px h-5 bg-line mx-1" />
        <Button size="sm" icon="plus" disabled={dis} onClick={() => ed.insertBlank(target.length ? target[target.length - 1] + 1 : ed.list.length)}>Blank page</Button>
        <Button size="sm" icon="import" disabled={dis} onClick={() => ed.insertFrom(target.length ? target[target.length - 1] + 1 : ed.list.length)}>Insert from PDF…</Button>
        <Button size="sm" icon="merge" disabled={dis} onClick={() => ed.insertFrom(ed.list.length, { title: 'Combine files' })}>Combine files…</Button>
        <Button size="sm" icon="split" onClick={ed.split}>Split…</Button>
        <span className="flex-1" />
        <span className="text-xs text-fg2">{target.length ? `${target.length} selected · ` : ''}{ed.list.length} pages</span>
        <input type="range" className="sl-range w-24" min={90} max={260} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Thumbnail size" />
      </div>
      <div className="flex-1 overflow-auto scroll-thin p-5 bg-work" onClick={(e) => { if (e.target === e.currentTarget) setSel([]); }}>
        <div className="flex flex-wrap gap-5 items-end">
          {ed.list.map((e, k) => (
            <div key={e.id} className="flex flex-col items-center relative group" data-org={k}
              onDragOver={(ev) => { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); setDrop(ev.clientX < r.left + r.width / 2 ? k : k + 1); }}
              onDrop={(ev) => { ev.preventDefault(); const f = from.current; from.current = null; setDrop(null); if (f && drop !== null) { ed.movePages(f, drop); setSel([]); } }}>
              {drop === k && <span className="absolute -left-3 top-0 bottom-6 w-1 rounded bg-accent" />}
              {drop === k + 1 && <span className="absolute -right-3 top-0 bottom-6 w-1 rounded bg-accent" />}
              <Thumb ed={ed} e={e} width={size} active={sel.includes(k)} draggable={!dis}
                onDragStart={() => { from.current = sel.includes(k) ? target : [k]; }} onDragEnd={() => setDrop(null)}
                onClick={(ev) => click(ev, k)} onDoubleClick={() => { ed.setMode('view'); setTimeout(() => ed.goTo(k), 50); }} className="shadow-lg" />
              {!dis && (
                <div className="absolute top-1.5 right-1.5 hidden group-hover:flex gap-1 bg-black/60 rounded-md p-0.5">
                  <IconButton icon="undo" label="Rotate left" size={22} className="!text-white" onClick={() => ed.rotatePages([k], -90)} />
                  <IconButton icon="redo" label="Rotate right" size={22} className="!text-white" onClick={() => ed.rotatePages([k], 90)} />
                  <IconButton icon="trash" label="Delete page" size={22} className="!text-white" onClick={() => ed.deletePages([k])} />
                </div>
              )}
              <span className="text-[12px] text-fg2 mt-1.5">{k + 1}{e.src === 'blank' ? ' · blank' : e.src !== 'source' ? ` · ${(ed.data.inserted.find((x) => x.id === e.src)?.name || 'inserted').replace(/\.pdf$/i, '')}` : ''}{e.rot ? ` · ${e.rot}°` : ''}</span>
            </div>
          ))}
          {!dis && (
            <button type="button" onClick={() => ed.insertBlank(ed.list.length)} className="border-2 border-dashed border-line rounded grid place-items-center text-fg3 hover:text-fg hover:border-accent/50" style={{ width: size + 4, height: size * 1.29 }}>
              <span className="flex flex-col items-center gap-1 text-xs"><Icon name="plus" size={22} />Blank page</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function mount(render) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => setTimeout(() => { root.unmount(); host.remove(); }, 0);
  root.render(render(close));
}

/** Split ranges, e.g. "1-3, 4-6". Resolves to the string or null. */
export const splitDialog = (count) => new Promise((resolve) => mount((close) => <SplitDialog count={count} done={(r) => { resolve(r); close(); }} />));
function SplitDialog({ count, done }) {
  const [v, setV] = useState(count > 1 ? `1-${Math.ceil(count / 2)}, ${Math.ceil(count / 2) + 1}-${count}` : '1');
  const [every, setEvery] = useState(1);
  return (
    <Modal title="Split document" onClose={() => done(null)} width={460} footer={<><Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" onClick={() => done(v)}>Split</Button></>}>
      <Field label="Page ranges — each becomes its own PDF" hint={`This document has ${count} page${count > 1 ? 's' : ''}. Example: 1-3, 4-6, 7-`}><TextInput value={v} onChange={(e) => setV(e.target.value)} /></Field>
      <div className="flex items-center gap-2 mt-3 text-sm text-fg2">
        Or every <NumberInput value={every} min={1} max={count} width={48} onChange={setEvery} /> page{every > 1 ? 's' : ''}
        <Button size="xs" variant="outline" onClick={() => { const parts = []; for (let i = 1; i <= count; i += every) parts.push(every === 1 ? `${i}` : `${i}-${Math.min(count, i + every - 1)}`); setV(parts.join(', ')); }}>Use</Button>
      </div>
    </Modal>
  );
}

/** Draw, type or upload a signature/initials. Resolves to { asset, w, h, saved } or null. */
export const signatureDialog = (opts) => new Promise((resolve) => mount((close) => <SignatureDialog {...opts} done={(r) => { resolve(r); close(); }} />));
function SignatureDialog({ kind = 'signature', docId, libraries, name = '', done }) {
  const [tab, setTab] = useState('type');
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('');
  const [text, setText] = useState(kind === 'initials' ? initials : name);
  const [font, setFont] = useState('Dancing Script');
  const [color, setColor] = useState('#1a2a6c');
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState(null);
  const [knockout, setKnockout] = useState(true);
  const pad = useRef(null);
  const strokes = useRef([]);
  const [drawn, setDrawn] = useState(0);
  useEffect(() => { ensureFont('Dancing Script', 600); ensureFont('Pacifico', 400); }, []);

  // drawing pad (pressure changes the width a little)
  const redraw = () => {
    const c = pad.current; if (!c) return;
    const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes.current) for (let i = 1; i < s.length; i++) { ctx.lineWidth = 2 + 3 * (s[i][2] ?? 0.5); ctx.beginPath(); ctx.moveTo(s[i - 1][0], s[i - 1][1]); ctx.lineTo(s[i][0], s[i][1]); ctx.stroke(); }
  };
  useEffect(redraw, [color, drawn, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const padDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect(); const sx = e.currentTarget.width / r.width;
    strokes.current.push([[(e.clientX - r.left) * sx, (e.clientY - r.top) * sx, e.pressure || 0.5]]);
    setDrawn((n) => n + 1);
  };
  const padMove = (e) => {
    if (!e.buttons) return;
    const r = e.currentTarget.getBoundingClientRect(); const sx = e.currentTarget.width / r.width;
    strokes.current[strokes.current.length - 1]?.push([(e.clientX - r.left) * sx, (e.clientY - r.top) * sx, e.pressure || 0.5]);
    redraw();
  };

  const makeCanvas = async () => {
    const c = document.createElement('canvas');
    if (tab === 'draw') { c.width = pad.current.width; c.height = pad.current.height; c.getContext('2d').drawImage(pad.current, 0, 0); }
    else if (tab === 'type') {
      const weight = font === 'Dancing Script' ? 600 : 400;
      await ensureFont(font, weight);
      c.width = 1400; c.height = 360;
      const ctx = c.getContext('2d'); ctx.font = `${weight} 170px "${font}"`; ctx.fillStyle = color; ctx.textBaseline = 'middle';
      ctx.fillText(text, 40, 180);
    } else {
      if (!upload) return null;
      const img = await createImageBitmap(upload);
      const s = Math.min(1, 1400 / img.width);
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
      if (knockout) { // make the paper transparent
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) { const l = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3; if (l > 215) d.data[i + 3] = 0; else if (l > 170) d.data[i + 3] = Math.round(d.data[i + 3] * (215 - l) / 45); }
        ctx.putImageData(d, 0, 0);
      }
    }
    return trim(c);
  };
  const ok = async () => {
    setBusy(true);
    try {
      const c = await makeCanvas();
      if (!c) { toast(tab === 'upload' ? 'Choose an image first' : 'Nothing to use yet'); setBusy(false); return; }
      const blob = await canvasBlob(c, 'image/png');
      const asset = await saveBlob(blob, `${kind === 'initials' ? 'Initials' : 'Signature'}.png`, { docId, isExport: false });
      let saved = false;
      if (save) {
        try {
          let lib = libraries?.[0];
          if (!lib) lib = await api.post('/api/libraries', { name: 'My Library' });
          await api.post(`/api/libraries/${lib.id}/items`, { kind: 'graphic', name: kind === 'initials' ? `Initials (${text || 'drawn'})` : `Signature${text && tab === 'type' ? ` (${text})` : ''}`, asset_id: asset.id, data: { signature: true, kind, w: c.width, h: c.height } });
          saved = true;
        } catch (e) { toastError(e, 'Couldn’t save to your library'); }
      }
      done({ asset: asset.id, w: c.width, h: c.height, saved });
    } catch (e) { toastError(e); setBusy(false); }
  };
  const canOk = tab === 'type' ? !!text.trim() : tab === 'draw' ? drawn > 0 : !!upload;
  return (
    <Modal title={kind === 'initials' ? 'Create initials' : 'Create signature'} onClose={() => done(null)} width={600}
      footer={<>
        <Checkbox label="Save to my library for next time" checked={save} onChange={setSave} className="mr-auto" />
        <Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!canOk} onClick={ok}>Use</Button>
      </>}>
      <Tabs className="mb-3 -mt-1" value={tab} onChange={setTab} tabs={[{ value: 'type', label: 'Type' }, { value: 'draw', label: 'Draw' }, { value: 'upload', label: 'Image' }]} />
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-fg2">Ink</span>
        <ColorRow value={color} onChange={setColor} colors={['#1a2a6c', '#000000', '#1f6feb', '#b3261e']} />
      </div>
      {tab === 'type' && (
        <div className="flex flex-col gap-3">
          <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'initials' ? 'Your initials' : 'Your name'} autoFocus />
          <div className="grid grid-cols-2 gap-2">
            {['Dancing Script', 'Pacifico'].map((f) => (
              <button key={f} type="button" onClick={() => setFont(f)} className={cx('h-24 rounded-lg bg-white border-2 px-3 truncate text-[34px]', font === f ? 'border-accent' : 'border-line')} style={{ fontFamily: `"${f}"`, color, fontWeight: f === 'Dancing Script' ? 600 : 400 }}>{text || 'Signature'}</button>
            ))}
          </div>
        </div>
      )}
      {tab === 'draw' && (
        <div>
          <canvas ref={pad} width={1100} height={kind === 'initials' ? 400 : 320} onPointerDown={padDown} onPointerMove={padMove} data-testid="sign-pad"
            className="w-full rounded-lg bg-white border border-line touch-none cursor-crosshair" style={{ aspectRatio: kind === 'initials' ? '11/4' : '11/3.2' }} />
          <div className="flex items-center mt-1.5"><span className="text-[11.5px] text-fg3 flex-1">Sign with your mouse, finger or pen.</span><Button size="xs" variant="ghost" onClick={() => { strokes.current = []; setDrawn(0); redraw(); }}>Clear</Button></div>
        </div>
      )}
      {tab === 'upload' && (
        <div className="flex flex-col gap-2">
          <input type="file" accept="image/*" onChange={(e) => setUpload(e.target.files?.[0] || null)} className="text-sm" />
          {upload && <img src={URL.createObjectURL(upload)} alt="" className="max-h-40 object-contain bg-white rounded" />}
          <Checkbox label="Remove the white background" checked={knockout} onChange={setKnockout} />
        </div>
      )}
    </Modal>
  );
}

/** Crops a canvas to its non-transparent pixels (plus a small margin). */
function trim(c) {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 8;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(c.width - 1, x1 + m); y1 = Math.min(c.height - 1, y1 + m);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
