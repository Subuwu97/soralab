// PDF editor (Acrobat-like): view and search, comment and mark up, fill forms and sign, organise pages,
// redact, combine/split/extract, compress and export. The original PDF asset is never modified: the project stores
// { source, blank, annotations, pages, form, inserted } and every change is applied when exporting (engine.js).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { useProject, createProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { useApp } from '../../lib/app.jsx';
import { saveBlob } from '../../lib/api.js';
import { pickAssets } from '../../components/Pickers.jsx';
import { exportDialog } from '../../components/ProjectDialogs.jsx';
import { Spinner, toast, toastError, confirmDialog, promptDialog, Button } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { loadAsset, pageList, entryInfo, buildPdf, formFields, renderEntry, pdfToImages, splitPdf, parseRanges, rasterizePages, pageText, findInPage, displaySize } from './engine.js';
import Viewer from './Viewer.jsx';
import { linkAssets } from './link.js';
import { RightPanels, LeftSidebar, OptionsBar, Organizer, signatureDialog, splitDialog } from './Panels.jsx';

const APP = 'pdf';
export const uid = (p = 'a') => `${p}${Math.random().toString(36).slice(2, 9)}`;

function normalize(d) {
  const data = d && typeof d === 'object' && !(d instanceof Blob) ? { ...d } : {};
  if (data.source === undefined) data.source = null;
  if (!data.source && !data.blank) data.blank = { width: 612, height: 792, count: 1 };
  data.annotations ||= [];
  data.form ||= {};
  data.inserted ||= [];
  if (data.pages === undefined) data.pages = null;
  return data;
}

export default function PdfEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    h.reset(normalize(project.data));
  }, [project.data, project.doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!h.state) return <EditorShell app={APP} project={project}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;
  return <Editor project={project} h={h} />;
}

function Editor({ project, h }) {
  const data = h.state;
  const canEdit = project.canEdit;
  const nav = useNavigate();
  const { me, libraries, reloadLibraries } = useApp();
  const [docs, setDocs] = useState({});
  const [loadErr, setLoadErr] = useState(null);
  const [tool, setTool] = useState('select');
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState('width'); // 'width' | 'page' | null
  const [scrollMode, setScrollMode] = useState('continuous');
  const [cur, setCur] = useState(0);
  const [mode, setMode] = useState('view'); // 'view' | 'organize'
  const [toolOpts, setToolOpts] = useState({ highlight: '#ffd400', underline: '#1f6feb', strike: '#e5383b', note: '#ffd400', freetext: '#000000', rect: '#e5383b', ellipse: '#1f6feb', line: '#e5383b', arrow: '#e5383b', ink: '#1f6feb', text: '#000000', width: 2, stamp: 'approved', size: 12, signature: null, initials: null });
  const [search, setSearch] = useState({ q: '', hits: [], idx: 0, busy: false });
  const [fields, setFields] = useState([]);
  const [outlineData, setOutline] = useState(null);
  const [orgSel, setOrgSel] = useState([]);
  const viewerRef = useRef(null);

  // Load the source and inserted PDFs.
  const docKeys = useMemo(() => [data.source, ...data.inserted.map((x) => `${x.id}:${x.asset}`)].join(','), [data.source, data.inserted]);
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const out = {};
        if (data.source) out.source = await loadAsset(data.source);
        for (const x of data.inserted) { try { out[x.id] = await loadAsset(x.asset); } catch { /* missing inserted file */ } }
        if (!off) setDocs(out);
        if (data.source && !off) {
          formFields(out.source).then((f) => !off && setFields(f)).catch(() => {});
          import('./engine.js').then((m) => m.outline(out.source)).then((o) => !off && setOutline(o)).catch(() => setOutline([]));
        }
      } catch (e) { if (!off) setLoadErr(e); }
    })();
    return () => { off = true; };
  }, [docKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  // attach the PDFs and signatures this project uses to it, so people it's shared with can open them
  const assetIds = useMemo(() => [data.source, ...data.inserted.map((x) => x.asset), ...data.annotations.filter((a) => a.asset).map((a) => a.asset)].filter(Boolean).join(','), [data.source, data.inserted, data.annotations]);
  useEffect(() => { if (canEdit && project.doc?.role === 'owner') linkAssets(assetIds.split(',').filter(Boolean), project.doc.id); }, [assetIds, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !data.source || !!docs.source;
  const list = useMemo(() => (ready ? pageList(data, docs) : []), [data, docs, ready]);
  const infos = useMemo(() => list.map((e) => entryInfo(e, docs)), [list, docs]);

  const change = useCallback((fn, label, merge) => { if (!canEdit) return; h.set((d) => (typeof fn === 'function' ? fn(d) : fn), label, merge ? { merge } : undefined); }, [h, canEdit]);
  const author = me?.name || me?.username || 'Me';

  // ---------------------------------------------------------------- annotations
  const addAnn = useCallback((a, label = 'Add comment') => {
    const full = { id: uid(), author, created: Date.now(), ...a };
    change((d) => ({ ...d, annotations: [...d.annotations, full] }), label);
    setSel(full.id);
    return full;
  }, [change, author]);
  const updateAnn = useCallback((id, patch, label = 'Edit', merge) => change((d) => ({ ...d, annotations: d.annotations.map((a) => (a.id === id ? { ...a, ...(typeof patch === 'function' ? patch(a) : patch), modified: Date.now() } : a)) }), label, merge), [change]);
  const deleteAnn = useCallback((id) => { change((d) => ({ ...d, annotations: d.annotations.filter((a) => a.id !== id) }), 'Delete'); setSel(null); setEditing(null); }, [change]);
  const selAnn = data.annotations.find((a) => a.id === sel) || null;

  // ---------------------------------------------------------------- pages (organise)
  /** The page list as stored data (materialised the first time pages change). */
  const setPages = useCallback((fn, label) => change((d) => ({ ...d, pages: fn(pageList(d, docs)) }), label), [change, docs]);
  const rotatePages = (idxs, by) => setPages((ps) => ps.map((p, i) => (idxs.includes(i) ? { ...p, rot: (((p.rot || 0) + by) % 360 + 360) % 360 } : p)), by > 0 ? 'Rotate clockwise' : 'Rotate counter-clockwise');
  const deletePages = async (idxs) => {
    if (idxs.length >= list.length) { toast('A PDF needs at least one page'); return; }
    const ids = new Set(idxs.map((i) => list[i].id));
    const n = data.annotations.filter((a) => ids.has(a.page)).length;
    if (n && !await confirmDialog({ title: `Delete ${idxs.length} page${idxs.length > 1 ? 's' : ''}?`, message: `${n} comment${n > 1 ? 's' : ''} on ${idxs.length > 1 ? 'them' : 'it'} will be deleted too.`, confirm: 'Delete', danger: true })) return;
    change((d) => ({ ...d, pages: pageList(d, docs).filter((p) => !ids.has(p.id)), annotations: d.annotations.filter((a) => !ids.has(a.page)) }), 'Delete pages');
    setOrgSel([]);
  };
  const movePages = (idxs, before) => setPages((ps) => {
    const set = new Set(idxs);
    const moving = ps.filter((_, i) => set.has(i));
    const rest = ps.filter((_, i) => !set.has(i));
    const at = before - idxs.filter((i) => i < before).length;
    rest.splice(Math.max(0, Math.min(rest.length, at)), 0, ...moving);
    return rest;
  }, 'Move pages');
  const insertBlank = (at) => {
    const ref = infos[Math.max(0, Math.min(at - 1, infos.length - 1))] || { w: 612, h: 792 };
    setPages((ps) => { const c = ps.slice(); c.splice(at, 0, { id: uid('b'), src: 'blank', i: 0, rot: 0, w: ref.w, h: ref.h }); return c; }, 'Insert blank page');
  };
  /** Inserts every page of other PDFs (Combine / Insert from file). */
  const insertFrom = async (at, { title = 'Insert pages from PDF' } = {}) => {
    const assets = await pickAssets({ kinds: ['pdf'], multiple: true, docId: project.doc.id, title });
    if (!assets?.length) return;
    try {
      const add = []; const ins = [];
      for (const a of assets) {
        const d = await loadAsset(a.id);
        const iid = uid('i');
        ins.push({ id: iid, asset: a.id, name: a.name });
        d.pages.forEach((_, i) => add.push({ id: uid('p'), src: iid, i, rot: 0 }));
      }
      setDocs((x) => ({ ...x }));
      change((d) => {
        const ps = pageList(d, docs).slice();
        ps.splice(at ?? ps.length, 0, ...add);
        return { ...d, pages: ps, inserted: [...d.inserted, ...ins] };
      }, assets.length > 1 ? 'Combine files' : 'Insert pages');
      toast(`Added ${add.length} page${add.length > 1 ? 's' : ''} from ${assets.length} file${assets.length > 1 ? 's' : ''}`, { type: 'success' });
    } catch (e) { toastError(e); }
  };

  // ---------------------------------------------------------------- search
  const runSearch = useCallback(async (q, opts = {}) => {
    if (!q) { setSearch({ q: '', hits: [], idx: 0 }); return; }
    setSearch((s) => ({ ...s, q, busy: true }));
    const hits = [];
    for (let k = 0; k < list.length; k++) {
      const e = list[k]; const d = docs[e.src];
      if (!d) continue;
      const pt = await pageText(d, e.i);
      for (const m of findInPage(pt, q, opts)) hits.push({ page: k, ...m });
    }
    setSearch({ q, hits, idx: 0, busy: false });
    if (hits.length) viewerRef.current?.reveal(hits[0].page, hits[0].rects[0]);
  }, [list, docs]);
  const stepHit = (dir) => setSearch((s) => {
    if (!s.hits.length) return s;
    const idx = (s.idx + dir + s.hits.length) % s.hits.length;
    viewerRef.current?.reveal(s.hits[idx].page, s.hits[idx].rects[0]);
    return { ...s, idx };
  });

  // ---------------------------------------------------------------- export
  const docName = project.doc?.name || 'Document';
  const build = useCallback((opts = {}) => {
    const rasterize = data.redactFlatten ? [...new Set(data.annotations.filter((a) => a.type === 'redact' && a.applied).map((a) => a.page))] : [];
    return buildPdf(data, docs, { rasterize, ...opts });
  }, [data, docs]);
  const exportConfig = useMemo(() => ({
    formats: [
      { id: 'pdf', label: 'PDF', ext: 'pdf', kind: 'document', options: [
        { key: 'comments', label: 'Include comments', type: 'toggle', default: true },
        { key: 'flattenAnnots', label: 'Flatten comments', type: 'toggle', default: false, hint: 'Draw comments into the page instead of keeping them editable' },
        { key: 'flattenForm', label: 'Flatten form fields', type: 'toggle', default: false },
      ], note: 'Pages, rotations, form values, signatures and applied redactions are written into a new PDF. Your original file is kept as it is.' },
      { id: 'compressed', label: 'PDF — reduced size', ext: 'pdf', kind: 'document', options: [
        { key: 'dpi', label: 'Resolution', type: 'select', default: 110, choices: [[72, '72 ppi (smallest)'], [110, '110 ppi'], [150, '150 ppi'], [200, '200 ppi']] },
        { key: 'quality', label: 'JPEG quality', type: 'range', default: 70, min: 30, max: 95, unit: '%' },
      ], note: 'Every page is re-rendered as an image. Text is no longer selectable or searchable.' },
      { id: 'png', label: 'PNG images', ext: 'png', kind: 'image', options: [{ key: 'dpi', label: 'Resolution', type: 'select', default: 150, choices: [[72, '72 ppi'], [150, '150 ppi'], [300, '300 ppi']] }], note: 'One image per page; several pages download as a ZIP.' },
      { id: 'jpeg', label: 'JPEG images', ext: 'jpg', kind: 'image', options: [{ key: 'dpi', label: 'Resolution', type: 'select', default: 150, choices: [[72, '72 ppi'], [150, '150 ppi'], [300, '300 ppi']] }], note: 'One image per page; several pages download as a ZIP.' },
    ],
    render: async (fmt, o, { onProgress }) => {
      if (fmt === 'pdf') return new Blob([await build({ ...o, onProgress })], { type: 'application/pdf' });
      const bytes = await build({ onProgress: (p) => onProgress?.(p * 0.4, 'Building…') });
      if (fmt === 'compressed') {
        const n = list.length;
        const out = await rasterizePages(bytes, Array.from({ length: n }, (_, i) => i), { dpi: o.dpi, quality: o.quality / 100, onProgress: (p) => onProgress?.(0.4 + p * 0.6, 'Compressing…') });
        return new Blob([out], { type: 'application/pdf' });
      }
      return pdfToImages(bytes, { format: fmt, dpi: o.dpi, name: docName, onProgress: (p, l) => onProgress?.(0.4 + p * 0.6, l) });
    },
  }), [build, list.length, docName]);

  const exportPicked = async (idxs, title = 'Extract pages') => {
    await exportDialog({ name: `${docName} (pages ${idxs.map((i) => i + 1).join(', ')})`.slice(0, 120), docId: project.doc.id, title,
      formats: [{ id: 'pdf', label: 'PDF', ext: 'pdf', kind: 'document' }],
      render: async () => new Blob([await build({ pick: idxs })], { type: 'application/pdf' }) });
  };
  const split = async () => {
    const ranges = await splitDialog(list.length);
    if (!ranges) return;
    const groups = parseRanges(ranges, list.length);
    if (!groups.length) { toast('Those page ranges don’t match any pages'); return; }
    await exportDialog({ name: `${docName} split`, docId: project.doc.id, title: `Split into ${groups.length} file${groups.length > 1 ? 's' : ''}`,
      formats: [{ id: 'zip', label: 'ZIP of PDFs', ext: 'zip', kind: 'file', note: groups.map((g, k) => `File ${k + 1}: pages ${g[0] + 1}–${g[g.length - 1] + 1}`).join(' · ') }],
      render: async () => splitPdf(await build(), groups, docName) });
  };
  const saveAsCopy = async () => {
    const name = await promptDialog({ title: 'Save as copy', label: 'Name of the new PDF project', value: `${docName} copy` });
    if (!name) return;
    try {
      toast('Building the PDF…');
      const bytes = await build();
      const asset = await saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${name}.pdf`, { docId: project.doc.id, isExport: true });
      const d = await createProject('pdf', { name, data: { source: asset.id, annotations: [], pages: null, form: {}, inserted: [] }, meta: { source: asset.id } });
      toast('Saved as a new PDF project', { type: 'success', action: { label: 'Open', onClick: () => nav(`/pdf/${d.id}`) } });
    } catch (e) { toastError(e, 'Couldn’t save a copy'); }
  };

  const getData = useCallback(async () => {
    let thumb;
    try { if (list[0]) thumb = await renderEntry(list[0], docs, 0.8); } catch { /* still loading */ }
    return { data, thumb, pages: list.length, width: Math.round(infos[0]?.w || 612), height: Math.round(infos[0]?.h || 792), meta: { source: data.source } };
  }, [data, list, docs, infos]);

  // ---------------------------------------------------------------- signatures (library items of kind 'graphic')
  const signatures = useMemo(() => (libraries || []).flatMap((l) => l.items.filter((i) => i.kind === 'graphic' && i.data?.signature && i.asset_id)), [libraries]);
  const newSignature = async (kind = 'signature') => {
    const r = await signatureDialog({ kind, docId: project.doc.id, libraries, name: author });
    if (!r) return null;
    if (r.saved) reloadLibraries?.();
    setToolOpts((o) => ({ ...o, [kind]: r }));
    return r;
  };

  const zoomBy = (f) => { setFit(null); setZoom((z) => Math.max(0.1, Math.min(8, z * f))); };
  const goTo = (i) => { setCur(i); viewerRef.current?.scrollToPage(i); };

  // ---------------------------------------------------------------- the editor API
  const ed = {
    data, h, change, canEdit, docs, list, infos, ready, tool, setTool, sel, setSel, selAnn, editing, setEditing, zoom, setZoom, fit, setFit, scrollMode, setScrollMode,
    cur, setCur, goTo, mode, setMode, toolOpts, setToolOpts, search, runSearch, stepHit, setSearch, fields, outline: outlineData, author,
    addAnn, updateAnn, deleteAnn, setPages, rotatePages, deletePages, movePages, insertBlank, insertFrom, orgSel, setOrgSel, exportPicked, split, saveAsCopy,
    signatures, newSignature, viewerRef, project, zoomBy, docName,
    applyRedactions: async () => {
      const marks = data.annotations.filter((a) => a.type === 'redact' && !a.applied);
      if (!marks.length) { toast('Mark areas with the Redact tool first'); return; }
      const ok = await confirmDialog({ title: `Apply ${marks.length} redaction${marks.length > 1 ? 's' : ''}?`, message: 'The marked areas become solid black boxes in the exported PDF.\n\nThe text underneath is NOT removed unless you also turn on “Flatten redacted pages to images” — then those pages are exported as pictures and nothing under the boxes can be recovered.', confirm: 'Apply' });
      if (ok) change((d) => ({ ...d, annotations: d.annotations.map((a) => (a.type === 'redact' ? { ...a, applied: true } : a)) }), 'Apply redactions');
    },
  };
  if (import.meta.env.DEV) window.__pdf = ed; // handy for automated browser tests

  // ---------------------------------------------------------------- shortcuts (Acrobat's)
  useShortcuts({
    v: () => setTool('select'), h: () => setTool('hand'), escape: () => { setSel(null); setEditing(null); setTool('select'); },
    delete: () => sel && canEdit && deleteAnn(sel), backspace: () => sel && canEdit && deleteAnn(sel),
    'mod+=': () => zoomBy(1.2), 'mod+plus': () => zoomBy(1.2), 'mod+-': () => zoomBy(1 / 1.2), 'mod+0': () => setFit('page'), 'mod+2': () => setFit('width'), 'mod+1': () => { setFit(null); setZoom(1); },
    'mod+f': () => document.getElementById('pdf-search')?.focus(),
    'shift+mod+=': () => rotatePages([cur], 90), 'shift+mod+-': () => rotatePages([cur], -90),
    pagedown: () => goTo(Math.min(list.length - 1, cur + 1)), pageup: () => goTo(Math.max(0, cur - 1)),
    home: () => goTo(0), end: () => goTo(list.length - 1),
    'mod+p': () => printPdf(),
  }, [sel, cur, list.length, canEdit]);
  async function printPdf() {
    try {
      const url = URL.createObjectURL(new Blob([await build()], { type: 'application/pdf' }));
      const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'; f.src = url;
      document.body.appendChild(f);
      f.onload = () => { try { f.contentWindow.print(); } catch { window.open(url, '_blank'); } };
      setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 120000);
    } catch (e) { toastError(e); }
  }

  // ---------------------------------------------------------------- menus
  const menus = [
    { label: 'View', items: () => [
      { label: 'Zoom In', shortcut: keyLabel('mod+='), onClick: () => zoomBy(1.2) }, { label: 'Zoom Out', shortcut: keyLabel('mod+-'), onClick: () => zoomBy(1 / 1.2) },
      { label: 'Actual Size', shortcut: keyLabel('mod+1'), onClick: () => { setFit(null); setZoom(1); } },
      { label: 'Fit Page', shortcut: keyLabel('mod+0'), checked: fit === 'page', onClick: () => setFit('page') },
      { label: 'Fit Width', shortcut: keyLabel('mod+2'), checked: fit === 'width', onClick: () => setFit('width') },
      { divider: true },
      { label: 'Single Page', checked: scrollMode === 'single', onClick: () => setScrollMode('single') },
      { label: 'Continuous Scrolling', checked: scrollMode === 'continuous', onClick: () => setScrollMode('continuous') },
      { divider: true },
      { label: 'Rotate View Clockwise', shortcut: keyLabel('shift+mod+='), onClick: () => rotatePages([cur], 90), disabled: !canEdit },
      { label: 'Organise Pages', icon: 'organize', checked: mode === 'organize', onClick: () => setMode(mode === 'organize' ? 'view' : 'organize') },
    ] },
    { label: 'Tools', items: () => [
      { heading: 'Comment' },
      ...[['highlight', 'Highlight Text'], ['underline', 'Underline Text'], ['strike', 'Strikethrough Text'], ['note', 'Sticky Note'], ['freetext', 'Text Box'], ['rect', 'Rectangle'], ['ellipse', 'Oval'], ['arrow', 'Arrow'], ['line', 'Line'], ['ink', 'Draw (Pencil)'], ['stamp', 'Stamp']].map(([t, l]) => ({ label: l, checked: tool === t, disabled: !canEdit, onClick: () => { setMode('view'); setTool(t); } })),
      { heading: 'Fill & Sign' },
      { label: 'Add Text', disabled: !canEdit, onClick: () => { setMode('view'); setTool('text'); } },
      { label: 'Sign Yourself…', disabled: !canEdit, onClick: () => { setMode('view'); setTool('sign'); } },
      { label: 'Add Initials', disabled: !canEdit, onClick: () => { setMode('view'); setTool('initials'); } },
      { label: 'Add Date', disabled: !canEdit, onClick: () => { setMode('view'); setTool('date'); } },
      { heading: 'Protect' },
      { label: 'Mark for Redaction', disabled: !canEdit, onClick: () => { setMode('view'); setTool('redact'); } },
      { label: 'Apply Redactions…', disabled: !canEdit, onClick: ed.applyRedactions },
    ] },
    { label: 'Pages', items: () => [
      { label: 'Organise Pages', icon: 'organize', onClick: () => setMode('organize') },
      { label: 'Insert Blank Page After Current', disabled: !canEdit, onClick: () => insertBlank(cur + 1) },
      { label: 'Insert Pages from PDF…', disabled: !canEdit, onClick: () => insertFrom(cur + 1) },
      { label: 'Combine Files (append PDFs)…', icon: 'merge', disabled: !canEdit, onClick: () => insertFrom(list.length, { title: 'Combine files' }) },
      { divider: true },
      { label: 'Rotate Page Clockwise', disabled: !canEdit, onClick: () => rotatePages([cur], 90) },
      { label: 'Rotate Page Counter-clockwise', disabled: !canEdit, onClick: () => rotatePages([cur], -90) },
      { label: 'Delete Page', icon: 'trash', disabled: !canEdit || list.length < 2, onClick: () => deletePages([cur]) },
      { divider: true },
      { label: 'Extract Current Page…', onClick: () => exportPicked([cur]) },
      { label: 'Split Document…', icon: 'split', onClick: split },
    ] },
  ];
  const fileItems = [
    { label: 'Save as Copy…', icon: 'duplicate', onClick: saveAsCopy },
    { label: 'Combine Files…', icon: 'merge', disabled: !canEdit, onClick: () => insertFrom(list.length, { title: 'Combine files' }) },
    { label: 'Split Document…', icon: 'split', onClick: split },
    { label: 'Print…', icon: 'file', shortcut: keyLabel('mod+p'), onClick: printPdf },
  ];

  const T = (t, icon, label, shortcut) => <Tool icon={icon} label={label} shortcut={shortcut} active={tool === t && mode === 'view'} onClick={() => { setMode('view'); setTool(t); setSel(null); }} />;
  const tools = (
    <>
      {T('select', 'select', 'Select text and comments', 'v')}
      {T('hand', 'hand', 'Hand', 'h')}
      {canEdit && <>
        <ToolDivider />
        {T('highlight', 'highlight', 'Highlight text')}
        {T('underline', 'underline', 'Underline text')}
        <Tool label="Strikethrough text" active={tool === 'strike' && mode === 'view'} onClick={() => { setMode('view'); setTool('strike'); }}><span className="text-[15px] line-through font-semibold">S</span></Tool>
        {T('note', 'comment', 'Sticky note')}
        {T('freetext', 'textBox', 'Text box')}
        {T('rect', 'rect', 'Rectangle')}
        {T('ellipse', 'ellipse', 'Oval')}
        {T('arrow', 'arrow', 'Arrow')}
        {T('line', 'line', 'Line')}
        {T('ink', 'pencil', 'Draw')}
        {T('stamp', 'stamp', 'Stamp')}
        <ToolDivider />
        {T('text', 'text', 'Add text (Fill & Sign)')}
        {T('sign', 'sign', 'Sign')}
        <Tool label="Initials" active={tool === 'initials' && mode === 'view'} onClick={() => { setMode('view'); setTool('initials'); }}><span className="text-[12px] font-semibold italic">AB</span></Tool>
        {T('date', 'clock', 'Date')}
        <ToolDivider />
        {T('redact', 'eyeOff', 'Mark for redaction')}
      </>}
      <ToolDivider />
      <Tool icon="organize" label="Organise pages" active={mode === 'organize'} onClick={() => setMode(mode === 'organize' ? 'view' : 'organize')} />
    </>
  );

  const status = (
    <>
      <span>Page {list.length ? cur + 1 : 0} of {list.length}</span>
      <span>{Math.round(zoom * 100)}%</span>
      {infos[cur] && <span>{(() => { const [w, hh] = displaySize(infos[cur].w, infos[cur].h, list[cur]?.rot || 0); return `${(w / 72).toFixed(2)} × ${(hh / 72).toFixed(2)} in`; })()}</span>}
      <span>{data.annotations.length} comment{data.annotations.length === 1 ? '' : 's'}</span>
      {data.annotations.some((a) => a.type === 'redact' && !a.applied) && <span className="text-warn">Redactions marked — not applied yet</span>}
      {!data.source && <span>Blank PDF</span>}
    </>
  );

  if (loadErr) {
    return (
      <EditorShell app={APP} project={project}>
        <div className="h-full grid place-items-center text-center p-6"><div><Icon name="warning" size={32} className="mx-auto text-warn mb-2" /><div className="font-medium">Couldn’t open this PDF</div><p className="text-sm text-fg2 mt-1">{loadErr.message}</p></div></div>
      </EditorShell>
    );
  }

  return (
    <EditorShell app={APP} project={project} history={h} getData={getData} menus={menus} fileItems={fileItems} exportConfig={exportConfig}
      tools={tools} options={<OptionsBar ed={ed} />} panels={<RightPanels ed={ed} />} panelWidth={300} status={status}
      commentAnchor={() => ({ page: cur })} anchorLabel={(a) => `page ${(a.page ?? 0) + 1}`} onJumpToComment={(a) => goTo(Math.min(a.page ?? 0, list.length - 1))}
      toolbarExtra={canEdit && <Button size="sm" variant="ghost" icon="duplicate" onClick={saveAsCopy} className="mr-1">Save as copy</Button>}>
      {!ready ? <div className="h-full grid place-items-center"><Spinner size={28} /></div> : (
        <div className="absolute inset-0 flex">
          {mode === 'view' && <LeftSidebar ed={ed} />}
          <div className="flex-1 min-w-0 relative">
            {mode === 'organize' ? <Organizer ed={ed} /> : <Viewer ed={ed} ref={viewerRef} />}
          </div>
        </div>
      )}
    </EditorShell>
  );
}
