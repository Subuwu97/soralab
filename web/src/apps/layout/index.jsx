// Layout editor (InDesign-like): pages and spreads, parent pages, threaded text frames with our own line breaker,
// paragraph/character styles, swatches, image frames with fitting, text wrap, preflight, vector PDF export.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { ensureFont } from '../../lib/fonts.js';
import { appById } from '../../lib/apps.js';
import { pickAssets } from '../../components/Pickers.jsx';
import { toast, toastError, confirmDialog, Spinner } from '../../components/ui.jsx';
import {
  normalizeDoc, uid, findItem, pageIndexOf, pageMargins, charAttrs, paraAttrs, pick, CHAR_KEYS, PARA_KEYS, PAGE_NUM, LINE_BREAK,
  masterLabel, charStyleAttrs, itemsOnPage, pageNumber,
} from './model.js';
import {
  insertText, deleteRange, formatChars, formatParas, sliceStory, insertFragment, attrsAt, wordAt, paraRange, paraAt, emptyStory,
  clearMeasureCache, caretX, posAtX,
} from './text.js';
import * as ops from './ops.js';
import { layoutDoc, onImagesChanged, imageStatus, renderPageCanvas } from './render.js';
import { exportPdf, exportImages, printDoc } from './exporter.js';
import { linkAssets } from './link.js';
import Workspace, { computeSlots } from './Workspace.jsx';
import Panels, { OptionsBar, docSetupDialog, FindChange } from './Panels.jsx';

const APP = 'layout';

export default function LayoutEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const ready = useRef(false);
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    const d = project.data && !(project.data instanceof Blob) && project.data.pages ? project.data : null;
    h.reset(normalizeDoc(d, project.doc));
    ready.current = true;
  }, [project.data, project.doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!h.state) return <EditorShell app={APP} project={project}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;
  return <Editor project={project} h={h} />;
}

function Editor({ project, h }) {
  const doc = h.state;
  const canEdit = project.canEdit;
  const [tool, setToolState] = useState('select');
  const [sel, setSel] = useState([]);
  const [edit, setEdit] = useState(null); // { sid, a, f } text editing
  const [masterEdit, setMasterEdit] = useState(null);
  const [view, setView] = useState(null); // { zoom, x, y }
  const [opts, setOpts] = useState({ guides: true, snap: true, preview: false, rulers: true, edges: true, threads: true });
  const [loaded, setLoaded] = useState(null); // { from: frame id } loaded text cursor
  const [placing, setPlacing] = useState(null); // assets waiting to be placed
  const [fontsTick, setFontsTick] = useState(0);
  const [imgTick, setImgTick] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [curPage, setCurPage] = useState(0);
  const pending = useRef(null); // formatting for the next typed characters
  const clip = useRef(null);
  const wsRef = useRef(null);
  const app = appById(APP);

  useEffect(() => onImagesChanged(() => setImgTick((t) => t + 1)), []);
  // attach placed images to this project so people it's shared with can see them
  const imageIds = useMemo(() => [...new Set(doc.items.filter((it) => it.asset).map((it) => it.asset))].join(','), [doc.items]);
  useEffect(() => { if (canEdit && project.doc?.role === 'owner') linkAssets(imageIds.split(',').filter(Boolean), project.doc.id); }, [imageIds, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load every font the document uses, then re-measure.
  const fontKey = useMemo(() => {
    const set = new Set();
    const add = (a) => { if (a?.font) set.add(`${a.font}|${a.weight || 400}|${a.italic ? 'italic' : 'normal'}`); };
    for (const s of Object.values(doc.stories)) for (const p of s.paras) { add(charAttrs(doc, p, null)); }
    for (const s of Object.values(doc.stories)) { let at = 0; let pi = 0; for (const r of s.runs) { while (pi < s.paras.length - 1 && at >= paraRange(s, pi)[1] + 1) pi++; add(charAttrs(doc, s.paras[Math.min(pi, s.paras.length - 1)], r)); at += r.n; } }
    for (const st of doc.paraStyles) add({ font: 'Lora', weight: 400, ...st.a });
    return [...set].sort().join(',');
  }, [doc.stories, doc.paraStyles, doc.charStyles]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let off = false;
    Promise.all(fontKey.split(',').filter(Boolean).map((k) => { const [f, w, s] = k.split('|'); return ensureFont(f, Number(w), s); }))
      .then(() => document.fonts.ready).then(() => { if (!off) { clearMeasureCache(); setFontsTick((t) => t + 1); } });
    return () => { off = true; };
  }, [fontKey]);

  const layout = useMemo(() => layoutDoc(doc, { masterView: !!masterEdit }), [doc, fontsTick, masterEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTool = useCallback((t) => { setToolState(t); setLoaded(null); if (t !== 'type') setEdit(null); }, []);
  const change = useCallback((fn, label, merge) => { if (!canEdit) return; h.set((d) => (typeof fn === 'function' ? fn(d) : fn), label, merge ? { merge } : undefined); }, [h, canEdit]);

  // ---------------------------------------------------------------- text editing

  const story = edit ? doc.stories[edit.sid] : null;
  useEffect(() => { if (edit && !doc.stories[edit.sid]) setEdit(null); }, [doc, edit]);
  const clampEdit = (e, s) => (e && s ? { ...e, a: Math.min(e.a, s.text.length), f: Math.min(e.f, s.text.length) } : e);
  const range = edit && story ? [Math.min(edit.a, edit.f, story.text.length), Math.min(Math.max(edit.a, edit.f), story.text.length)] : null;

  /** Frames of a story with where they show ('m' on a parent page being edited, else the page index). */
  const storyFrames = useCallback((sid) => {
    const s = doc.stories[sid];
    if (!s) return [];
    return s.frames.map((fid) => findItem(doc, fid)).filter(Boolean).map((it) => {
      const pi = pageIndexOf(doc, it.page);
      return { it, where: pi >= 0 ? pi : 'm' };
    });
  }, [doc]);

  /** Where the caret for pos is drawn: { it, where, line }. */
  const locate = useCallback((sid, pos) => {
    let best = null;
    for (const fr of storyFrames(sid)) {
      for (const line of layout.lines(fr.it.id, fr.where)) {
        if (pos >= line.start && (pos < line.end || (pos === line.end && (line.last || !best)))) return { ...fr, line };
        if (pos === line.end) best = { ...fr, line };
        if (line.start <= pos) best = { ...fr, line };
      }
    }
    return best;
  }, [layout, storyFrames]);

  const allLines = useCallback((sid) => storyFrames(sid).flatMap((fr) => layout.lines(fr.it.id, fr.where).map((line) => ({ ...fr, line }))), [layout, storyFrames]);

  const setStory = useCallback((sid, fn, label = 'Typing', merge) => {
    change((d) => ({ ...d, stories: { ...d.stories, [sid]: fn(d.stories[sid]) } }), label, merge);
  }, [change]);

  const insert = useCallback((str) => {
    if (!edit || !canEdit) return;
    const s = doc.stories[edit.sid];
    const [a, b] = [Math.min(edit.a, edit.f), Math.max(edit.a, edit.f)];
    let ns = b > a ? deleteRange(s, a, b) : s;
    const p = pending.current;
    ns = insertText(ns, a, str, p ? { cs: p.cs !== undefined ? p.cs : (attrsAt(doc, s, a).run?.cs || null), a: { ...(attrsAt(doc, s, a).run?.a || {}), ...(p.a || {}) } } : undefined);
    setStory(edit.sid, () => ns, 'Typing', `type-${edit.sid}`);
    setEdit({ ...edit, a: a + str.length, f: a + str.length });
  }, [edit, doc, canEdit, setStory]);

  const removeText = useCallback((dir, word) => {
    if (!edit || !canEdit) return;
    const s = doc.stories[edit.sid];
    let [a, b] = [Math.min(edit.a, edit.f), Math.max(edit.a, edit.f)];
    if (a === b) {
      if (dir < 0) { if (!a) return; a = word ? wordAt(s.text, a - 1)[0] : a - 1; }
      else { if (b >= s.text.length) return; b = word ? wordAt(s.text, b + 1)[1] : b + 1; }
    }
    setStory(edit.sid, (x) => deleteRange(x, a, b), 'Delete text', `type-${edit.sid}`);
    pending.current = null;
    setEdit({ ...edit, a, f: a });
  }, [edit, doc, canEdit, setStory]);

  const moveCaret = useCallback((pos, extend) => {
    if (!edit) return;
    h.commit(); pending.current = null;
    const s = doc.stories[edit.sid];
    const p = Math.max(0, Math.min(s.text.length, pos));
    setEdit({ ...edit, a: extend ? edit.a : p, f: p });
  }, [edit, doc, h]);

  const lineMove = useCallback((dir, extend) => {
    const lines = allLines(edit.sid);
    const cur = locate(edit.sid, edit.f);
    if (!cur) return;
    const k = lines.findIndex((l) => l.line === cur.line);
    const t = lines[k + dir];
    if (!t) { moveCaret(dir < 0 ? 0 : doc.stories[edit.sid].text.length, extend); return; }
    const gx = cur.it.x + caretX(cur.line, edit.f) - t.it.x;
    moveCaret(posAtX(t.line, gx), extend);
  }, [edit, allLines, locate, moveCaret, doc]);

  /** Character / paragraph formatting for the selection: edited text, or whole stories of selected frames. */
  const targets = useCallback(() => {
    if (edit && range) return [{ sid: edit.sid, a: range[0], b: range[1] }];
    return sel.map((i) => findItem(doc, i)).filter((it) => it?.type === 'text').map((it) => ({ sid: it.story, a: 0, b: doc.stories[it.story]?.text.length || 0 }))
      .filter((t, i, arr) => arr.findIndex((x) => x.sid === t.sid) === i);
  }, [edit, range, sel, doc]);

  const applyChar = useCallback((patch, label = 'Character format') => {
    const ts = targets();
    if (!ts.length) return;
    if (edit && range && range[0] === range[1]) {
      // nothing selected: the change applies to what's typed next (and an empty paragraph shows it straight away)
      pending.current = { ...(pending.current || {}), a: { ...(pending.current?.a || {}), ...patch } };
      const s = doc.stories[edit.sid];
      const [ps, pe] = paraRange(s, paraAt(s, range[0]));
      if (ps === pe) setStory(edit.sid, (x) => formatParas(x, ps, ps, { patch }), label);
      setPendingTick((t) => t + 1);
      return;
    }
    change((d) => {
      const stories = { ...d.stories };
      for (const t of ts) stories[t.sid] = formatChars(stories[t.sid], t.a, t.b, { patch });
      return { ...d, stories };
    }, label);
  }, [targets, edit, range, doc, change, setStory]);
  const [, setPendingTick] = useState(0);

  const applyCharStyle = useCallback((csId, clear) => {
    const ts = targets();
    change((d) => {
      const stories = { ...d.stories };
      for (const t of ts) stories[t.sid] = formatChars(stories[t.sid], t.a, t.b, { cs: csId, clear });
      return { ...d, stories };
    }, 'Apply character style');
    if (edit && range && range[0] === range[1]) pending.current = { cs: csId };
  }, [targets, change, edit, range]);

  const applyPara = useCallback((patch, label = 'Paragraph format') => {
    const ts = targets();
    change((d) => {
      const stories = { ...d.stories };
      for (const t of ts) stories[t.sid] = formatParas(stories[t.sid], t.a, t.b, { patch });
      return { ...d, stories };
    }, label);
  }, [targets, change]);

  const applyParaStyle = useCallback((psId, clear = false) => {
    const ts = targets();
    change((d) => {
      const stories = { ...d.stories };
      for (const t of ts) stories[t.sid] = formatParas(stories[t.sid], t.a, t.b, { ps: psId, clear: true, ...(clear ? {} : {}) });
      return { ...d, stories };
    }, 'Apply paragraph style');
  }, [targets, change]);

  /** Attributes shown in the type controls. */
  const typeInfo = useMemo(() => {
    const t = targets()[0];
    if (!t) return null;
    const s = doc.stories[t.sid];
    if (!s) return null;
    const info = attrsAt(doc, s, edit ? t.a : 0);
    const char = { ...info.char, ...(edit && pending.current?.a ? pending.current.a : {}) };
    if (edit && pending.current?.cs !== undefined) Object.assign(char, charStyleAttrs(doc, pending.current.cs));
    return { char, para: paraAttrs(doc, info.para), ps: info.para.ps, cs: pending.current?.cs !== undefined ? pending.current.cs : info.run?.cs || null, run: info.run, rawPara: info.para };
  }, [targets, doc, edit]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- items

  const selItems = useMemo(() => sel.map((i) => findItem(doc, i)).filter(Boolean), [sel, doc]);
  useEffect(() => { if (sel.some((i) => !findItem(doc, i))) setSel((s) => s.filter((i) => findItem(doc, i))); }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateSel = useCallback((patch, label = 'Change', merge) => change((d) => ops.updateItems(d, sel, patch), label, merge), [change, sel]);
  const deleteSel = useCallback(() => { if (!sel.length) return; change((d) => ops.deleteItems(d, sel), 'Delete'); setSel([]); }, [change, sel]);

  /** The page (or parent) new items go on. */
  const targetPage = useCallback(() => (masterEdit ? { page: masterEdit, side: doc.facing ? 'R' : undefined, idx: null } : { page: doc.pages[Math.min(curPage, doc.pages.length - 1)].id, idx: Math.min(curPage, doc.pages.length - 1) }), [masterEdit, doc, curPage]);

  const copySel = useCallback(() => { if (!selItems.length) return; clip.current = { items: structuredClone(selItems), doc }; }, [selItems, doc]);
  const pasteItems = useCallback((inPlace) => {
    if (!clip.current) return;
    const tp = targetPage();
    const ids = clip.current.items.map((x) => x.id);
    const sameSpot = inPlace || clip.current.items.every((x) => x.page !== tp.page);
    let out;
    change((d) => { const r = ops.cloneItems(d, ids, { dx: sameSpot ? 0 : 12, dy: sameSpot ? 0 : 12, page: tp.page, side: tp.side, fromDoc: clip.current.doc }); out = r.ids; return r.doc; }, 'Paste');
    setTimeout(() => out && setSel(out), 0);
  }, [targetPage, change]);
  const duplicateSel = useCallback(() => {
    if (!sel.length) return;
    let out;
    change((d) => { const r = ops.cloneItems(d, sel, { dx: 12, dy: 12 }); out = r.ids; return r.doc; }, 'Duplicate');
    setTimeout(() => out && setSel(out), 0);
  }, [sel, change]);

  // Image fitting (Object → Fitting)
  const fitImage = useCallback((it, how, img) => {
    const iw = it.iw || img?.naturalWidth || 1; const ih = it.ih || img?.naturalHeight || 1;
    let cs = it.cs || 1; let csy;
    if (how === 'fill') cs = Math.max(it.w / iw, it.h / ih);
    else if (how === 'fit') cs = Math.min(it.w / iw, it.h / ih);
    else if (how === 'stretch') { cs = it.w / iw; csy = it.h / ih; }
    else if (how === 'frame') { return { w: iw * cs, h: ih * (it.csy || cs), cx: 0, cy: 0 }; }
    const w = iw * cs; const hh = ih * (csy || cs);
    return { cs, csy, cx: (it.w - w) / 2, cy: (it.h - hh) / 2, iw, ih, fit: how };
  }, []);
  const fitSel = useCallback((how) => {
    const imgs = selItems.filter((x) => x.type === 'image' && x.asset);
    if (!imgs.length) return;
    change((d) => ops.updateItems(d, imgs.map((x) => x.id), (it) => fitImage(it, how)), { fill: 'Fill frame proportionally', fit: 'Fit content proportionally', stretch: 'Fit content to frame', center: 'Centre content', frame: 'Fit frame to content' }[how]);
  }, [selItems, change, fitImage]);

  /** Places images: into the selected empty frame(s), or as new frames on the current page. */
  const place = useCallback(async () => {
    const assets = await pickAssets({ kinds: ['image'], multiple: true, docId: project.doc.id, title: 'Place images' });
    if (!assets?.length) return;
    const targetsF = selItems.filter((x) => x.type === 'image' || x.type === 'rect' || x.type === 'ellipse');
    if (targetsF.length) {
      change((d) => {
        let out = d;
        targetsF.forEach((t, k) => {
          const a = assets[k % assets.length];
          const it = { ...t, type: 'image', shape: t.type === 'ellipse' ? 'ellipse' : t.shape, asset: a.id, iw: a.width || 1000, ih: a.height || 1000 };
          out = ops.updateItems(out, [t.id], { ...it, ...fitImage(it, 'fill') });
        });
        return out;
      }, 'Place');
      return;
    }
    setPlacing(assets);
    setTool('select');
    toast('Click on a page to place, or drag to draw the frame', { duration: 4000 });
  }, [project.doc?.id, selItems, change, fitImage, setTool]);

  const insertSpecial = useCallback((ch) => { if (edit) insert(ch); else toast('Click into text with the Type tool first'); }, [edit, insert]);

  // ---------------------------------------------------------------- navigation

  const slots = useMemo(() => computeSlots(doc, masterEdit), [doc.pages, doc.width, doc.height, doc.facing, doc.startPage, masterEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const goPage = useCallback((i) => { setMasterEdit(null); setCurPage(i); setTimeout(() => wsRef.current?.showPage(i), 0); }, []);
  const editMaster = useCallback((mid) => { setMasterEdit(mid); setSel([]); setEdit(null); setTimeout(() => wsRef.current?.fit('spread'), 0); }, []);

  // ---------------------------------------------------------------- export

  const docName = project.doc?.name || 'Layout';
  const renderExport = useCallback(async (fmt, o, { onProgress }) => {
    const L = layoutDoc(doc);
    if (fmt === 'pdf') return exportPdf(doc, L, { range: o.range, bleed: o.bleed, marks: o.marks, onProgress, title: docName });
    return exportImages(doc, L, { format: fmt, dpi: o.dpi, range: o.range, quality: (o.quality || 90) / 100, onProgress, name: docName });
  }, [doc, docName]);
  const exportConfig = useMemo(() => ({
    formats: [
      { id: 'pdf', label: 'Adobe PDF (Print)', ext: 'pdf', kind: 'document', options: [
        { key: 'range', label: 'Pages', type: 'text', default: 'all', hint: 'e.g. 1-4, 7 — or "all"' },
        { key: 'bleed', label: 'Include bleed', type: 'toggle', default: false },
        { key: 'marks', label: 'Crop marks', type: 'toggle', default: false },
      ], note: 'Real, selectable text with embedded font subsets. Images are embedded at full resolution.' },
      { id: 'png', label: 'PNG (each page)', ext: 'png', kind: 'image', options: [
        { key: 'range', label: 'Pages', type: 'text', default: 'all', hint: 'Several pages download as a ZIP' },
        { key: 'dpi', label: 'Resolution', type: 'select', default: 150, choices: [[72, '72 ppi'], [150, '150 ppi'], [300, '300 ppi']] },
      ] },
      { id: 'jpeg', label: 'JPEG (each page)', ext: 'jpg', kind: 'image', options: [
        { key: 'range', label: 'Pages', type: 'text', default: 'all', hint: 'Several pages download as a ZIP' },
        { key: 'dpi', label: 'Resolution', type: 'select', default: 150, choices: [[72, '72 ppi'], [150, '150 ppi'], [300, '300 ppi']] },
        { key: 'quality', label: 'Quality', type: 'range', default: 90, min: 30, max: 100, unit: '%' },
      ] },
    ],
    render: async (fmt, o, x) => {
      const blob = await renderExport(fmt, o, x);
      // several pages as images come back zipped
      if (fmt !== 'pdf' && blob.type === 'application/zip') Object.defineProperty(blob, 'name', { value: `${docName}.zip` });
      return blob;
    },
  }), [renderExport, docName]);

  const getData = useCallback(async () => {
    const L = layoutDoc(doc);
    let thumb;
    try { thumb = renderPageCanvas(doc, 0, L, { scale: Math.min(1, 640 / Math.max(doc.width, doc.height)) }); } catch { /* fonts still loading */ }
    return { data: doc, thumb, width: Math.round(doc.width), height: Math.round(doc.height), pages: doc.pages.length, meta: { pages: doc.pages.length, facing: doc.facing } };
  }, [doc]);

  // ---------------------------------------------------------------- preflight

  const preflight = useMemo(() => {
    const out = [];
    for (const [sid, ov] of Object.entries(layout.overset)) if (ov) {
      const s = doc.stories[sid]; const last = findItem(doc, s.frames[s.frames.length - 1]);
      out.push({ kind: 'overset', level: 'error', msg: 'Overset text', item: last?.id, page: last?.page, detail: `“${s.text.slice(0, 40).replace(/\n/g, ' ')}…”` });
    }
    for (const it of doc.items) {
      if (it.type !== 'image' || !it.asset) continue;
      const st = imageStatus(it.asset);
      if (st === 'error') out.push({ kind: 'missing', level: 'error', msg: 'Missing image', item: it.id, page: it.page });
      const ppi = 72 / Math.max(it.cs || 1, it.csy || 0);
      if (st !== 'error' && ppi < 150) out.push({ kind: 'res', level: 'warn', msg: `Low resolution (${Math.round(ppi)} ppi)`, item: it.id, page: it.page, detail: 'Below 150 ppi effective resolution' });
    }
    return out;
  }, [layout, doc, imgTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const showItem = useCallback((iid) => {
    const it = findItem(doc, iid);
    if (!it) return;
    const pi = pageIndexOf(doc, it.page);
    if (pi < 0) editMaster(it.page); else { setMasterEdit(null); setCurPage(pi); }
    setEdit(null); setTool('select'); setSel([iid]);
    setTimeout(() => wsRef.current?.showItem(iid), 30);
  }, [doc, editMaster, setTool]);

  // ---------------------------------------------------------------- the editor API passed to the workspace and panels

  const ed = {
    doc, h, change, canEdit, layout, slots, tool, setTool, sel, setSel, selItems, edit, setEdit, range, story, masterEdit, setMasterEdit, editMaster, goPage,
    view, setView, opts, setOpts, loaded, setLoaded, placing, setPlacing, fontsTick, imgTick, curPage, setCurPage, wsRef, project,
    locate, allLines, storyFrames, insert, removeText, moveCaret, lineMove, setStory, applyChar, applyPara, applyCharStyle, applyParaStyle, typeInfo, pending,
    updateSel, deleteSel, copySel, pasteItems, duplicateSel, fitSel, fitImage, place, targetPage, preflight, showItem, insertSpecial, clampEdit,
    openFind: () => setFindOpen(true), docName,
    print: () => printDoc(doc, layoutDoc(doc)).catch(toastError),
    autoflow: () => {
      const it = selItems.find((x) => x.type === 'text') || (edit && findItem(doc, doc.stories[edit.sid]?.frames[0]));
      if (!it) { toast('Select a text frame first'); return; }
      change((d) => ops.autoflow(d, it.story, (dd) => layoutDoc(dd).overset[it.story]), 'Add pages for overset text');
    },
    textCopy: (cut) => {
      if (!edit || !range || range[0] === range[1]) return null;
      const s = doc.stories[edit.sid];
      clip.current = { frag: sliceStory(s, range[0], range[1]), text: s.text.slice(range[0], range[1]) };
      if (cut) removeText(0);
      return clip.current.text.replace(new RegExp(PAGE_NUM, 'g'), '#').replace(new RegExp(LINE_BREAK, 'g'), '\n');
    },
    textPaste: (txt) => {
      if (!edit || !canEdit) return;
      const s = doc.stories[edit.sid];
      const [a, b] = range;
      let ns = b > a ? deleteRange(s, a, b) : s;
      let n;
      if (clip.current?.frag && clip.current.text.replace(new RegExp(PAGE_NUM, 'g'), '#').replace(new RegExp(LINE_BREAK, 'g'), '\n') === txt.replace(/\r/g, '')) { ns = insertFragment(ns, a, clip.current.frag); n = clip.current.frag.text.length; }
      else { const t = txt.replace(/\r\n?/g, '\n'); ns = insertText(ns, a, t); n = t.length; }
      setStory(edit.sid, () => ns, 'Paste');
      h.commit();
      setEdit({ ...edit, a: a + n, f: a + n });
    },
  };

  if (import.meta.env.DEV) window.__layout = ed; // handy for automated browser tests

  // ---------------------------------------------------------------- shortcuts (InDesign's)

  const notTyping = !edit;
  useShortcuts({
    v: () => notTyping && setTool('select'), a: () => notTyping && setTool('direct'), t: () => notTyping && setTool('type'),
    f: () => notTyping && setTool('frame'), m: () => notTyping && setTool('rect'), l: () => notTyping && setTool('ellipse'), '\\': () => notTyping && setTool('line'),
    h: () => notTyping && setTool('hand'), z: () => notTyping && setTool('zoom'),
    w: () => notTyping && setOpts((o) => ({ ...o, preview: !o.preview })),
    escape: () => { if (loaded) setLoaded(null); else if (placing) setPlacing(null); else if (edit) { const it = locate(edit.sid, edit.f)?.it; setEdit(null); setTool('select'); if (it) setSel([it.id]); } else setSel([]); },
    delete: () => notTyping && deleteSel(), backspace: () => notTyping && deleteSel(),
    'mod+c': () => { if (notTyping) copySel(); else return false; }, 'mod+x': () => { if (notTyping) { copySel(); deleteSel(); } else return false; },
    'mod+v': () => { if (notTyping) pasteItems(false); else return false; }, 'alt+shift+mod+v': () => pasteItems(true),
    'alt+shift+mod+d': () => duplicateSel(), 'mod+d': () => place(),
    'mod+a': () => { if (notTyping) setSel(wsRef.current?.editableIds() || []); else return false; },
    'mod+f': () => setFindOpen(true),
    'shift+mod+]': () => change((d) => ops.arrange(d, sel, 'front'), 'Bring to front'), 'mod+]': () => change((d) => ops.arrange(d, sel, 'forward'), 'Bring forward'),
    'shift+mod+[': () => change((d) => ops.arrange(d, sel, 'back'), 'Send to back'), 'mod+[': () => change((d) => ops.arrange(d, sel, 'backward'), 'Send backward'),
    'mod+=': () => wsRef.current?.zoomBy(1.25), 'mod+plus': () => wsRef.current?.zoomBy(1.25), 'mod+-': () => wsRef.current?.zoomBy(0.8),
    'mod+0': () => wsRef.current?.fit('page'), 'alt+mod+0': () => wsRef.current?.fit('spread'), 'mod+1': () => wsRef.current?.zoomTo(1),
    'mod+;': () => setOpts((o) => ({ ...o, guides: !o.guides })), 'shift+mod+;': () => setOpts((o) => ({ ...o, snap: !o.snap })),
    'mod+r': () => setOpts((o) => ({ ...o, rulers: !o.rulers })),
    'shift+mod+p': () => change((d) => ops.addPages(d, d.pages.length, 1), 'Add page'),
    'alt+shift+mod+c': () => fitSel('fill'), 'alt+shift+mod+e': () => fitSel('fit'),
    'alt+shift+mod+n': () => insertSpecial(PAGE_NUM),
    'alt+mod+p': () => docSetupDialog(ed),
    'mod+p': () => ed.print(),
    arrowleft: (e) => notTyping && nudge(-1, 0, e), arrowright: (e) => notTyping && nudge(1, 0, e), arrowup: (e) => notTyping && nudge(0, -1, e), arrowdown: (e) => notTyping && nudge(0, 1, e),
    'shift+arrowleft': (e) => notTyping && nudge(-1, 0, e), 'shift+arrowright': (e) => notTyping && nudge(1, 0, e), 'shift+arrowup': (e) => notTyping && nudge(0, -1, e), 'shift+arrowdown': (e) => notTyping && nudge(0, 1, e),
  }, [notTyping, sel, edit, loaded, placing, selItems, doc]);
  function nudge(dx, dy, e) {
    if (!sel.length) return;
    const k = e.shiftKey ? 10 : 1;
    if (tool === 'direct' && selItems.length === 1 && selItems[0].type === 'image') updateSel((it) => ({ cx: (it.cx || 0) + dx * k, cy: (it.cy || 0) + dy * k }), 'Move content', 'nudge');
    else updateSel((it) => ({ x: it.x + dx * k, y: it.y + dy * k }), 'Nudge', 'nudge');
  }

  // ---------------------------------------------------------------- menus

  const objMenu = () => [
    { label: 'Arrange', items: [
      { label: 'Bring to Front', shortcut: keyLabel('shift+mod+]'), onClick: () => change((d) => ops.arrange(d, sel, 'front'), 'Bring to front') },
      { label: 'Bring Forward', shortcut: keyLabel('mod+]'), onClick: () => change((d) => ops.arrange(d, sel, 'forward'), 'Bring forward') },
      { label: 'Send Backward', shortcut: keyLabel('mod+['), onClick: () => change((d) => ops.arrange(d, sel, 'backward'), 'Send backward') },
      { label: 'Send to Back', shortcut: keyLabel('shift+mod+['), onClick: () => change((d) => ops.arrange(d, sel, 'back'), 'Send to back') },
    ] },
    { label: 'Fitting', items: [
      { label: 'Fill Frame Proportionally', shortcut: keyLabel('alt+shift+mod+c'), onClick: () => fitSel('fill') },
      { label: 'Fit Content Proportionally', shortcut: keyLabel('alt+shift+mod+e'), onClick: () => fitSel('fit') },
      { label: 'Fit Content to Frame', onClick: () => fitSel('stretch') },
      { label: 'Fit Frame to Content', onClick: () => change((d) => ops.updateItems(d, selItems.filter((x) => x.type === 'image' && x.asset).map((x) => x.id), (it) => fitImage(it, 'frame')), 'Fit frame to content') },
      { label: 'Centre Content', onClick: () => change((d) => ops.updateItems(d, selItems.filter((x) => x.type === 'image').map((x) => x.id), (it) => { const w = (it.iw || 1) * (it.cs || 1); const hh = (it.ih || 1) * (it.csy || it.cs || 1); return { cx: (it.w - w) / 2, cy: (it.h - hh) / 2 }; }), 'Centre content') },
    ] },
    { divider: true },
    { label: 'Text Wrap: None', onClick: () => updateSel({ wrap: { mode: 'none', off: 0 } }, 'Text wrap') },
    { label: 'Text Wrap: Bounding Box', onClick: () => updateSel((it) => ({ wrap: { mode: 'bbox', off: it.wrap?.off || 9 } }), 'Text wrap') },
    { label: 'Text Wrap: Jump Object', onClick: () => updateSel((it) => ({ wrap: { mode: 'jump', off: it.wrap?.off || 9 } }), 'Text wrap') },
    { divider: true },
    { label: 'Break Thread After Frame', disabled: !selItems.some((x) => x.type === 'text'), onClick: () => change((d) => ops.unthreadAfter(d, selItems.find((x) => x.type === 'text').id), 'Break thread') },
    { label: 'Add Pages for Overset Text', onClick: () => ed.autoflow() },
    { divider: true },
    { label: 'Override Parent Items on Page', disabled: !!masterEdit, onClick: () => {
      const i = curPage; const { master } = itemsOnPage(doc, i);
      if (!master.length) { toast('No parent items on this page'); return; }
      change((d) => master.reduce((acc, m) => ops.overrideMasterItem(acc, i, m.id).doc, d), 'Override parent items');
    } },
    { label: 'Remove Overrides', disabled: !selItems.some((x) => x.masterRef), onClick: () => { change((d) => ops.deleteItems(d, selItems.filter((x) => x.masterRef).map((x) => x.id)), 'Remove override'); setSel([]); } },
  ];

  const menus = [
    { label: 'Layout', items: () => [
      { label: 'Add Page', shortcut: keyLabel('shift+mod+p'), icon: 'plus', onClick: () => change((d) => ops.addPages(d, d.pages.length, 1), 'Add page') },
      { label: 'Insert Page After Current', onClick: () => change((d) => ops.addPages(d, curPage + 1, 1), 'Insert page') },
      { label: 'Duplicate Page', icon: 'duplicate', onClick: () => change((d) => ops.duplicatePage(d, curPage), 'Duplicate page') },
      { label: 'Delete Page', icon: 'trash', disabled: doc.pages.length < 2, onClick: () => change((d) => ops.deletePages(d, [curPage]), 'Delete page') },
      { divider: true },
      { label: 'Margins and Columns…', onClick: () => docSetupDialog(ed, 'margins') },
      { label: 'Document Setup…', shortcut: keyLabel('alt+mod+p'), onClick: () => docSetupDialog(ed) },
      { divider: true },
      { label: 'First Page', onClick: () => goPage(0) }, { label: 'Last Page', onClick: () => goPage(doc.pages.length - 1) },
      { label: 'Next Page', onClick: () => goPage(Math.min(doc.pages.length - 1, curPage + 1)) }, { label: 'Previous Page', onClick: () => goPage(Math.max(0, curPage - 1)) },
    ] },
    { label: 'Type', items: () => [
      { label: 'Find/Change…', icon: 'search', shortcut: keyLabel('mod+f'), onClick: () => setFindOpen(true) },
      { divider: true },
      { label: 'Insert Current Page Number', shortcut: keyLabel('alt+shift+mod+n'), onClick: () => insertSpecial(PAGE_NUM) },
      { label: 'Insert Forced Line Break', onClick: () => insertSpecial(LINE_BREAK) },
      { label: 'Insert Em Dash', onClick: () => insertSpecial('—') }, { label: 'Insert Bullet', onClick: () => insertSpecial('•') },
      { label: 'Insert Copyright Symbol', onClick: () => insertSpecial('©') },
      { divider: true },
      { label: 'Paragraph Styles', items: doc.paraStyles.map((s) => ({ label: s.name, checked: typeInfo?.ps === s.id, onClick: () => applyParaStyle(s.id) })) },
      { label: 'Character Styles', items: [{ label: '[None]', onClick: () => applyCharStyle(null) }, ...doc.charStyles.map((s) => ({ label: s.name, checked: typeInfo?.cs === s.id, onClick: () => applyCharStyle(s.id) }))] },
    ] },
    { label: 'Object', items: objMenu },
    { label: 'View', items: () => [
      { label: 'Zoom In', shortcut: keyLabel('mod+='), onClick: () => wsRef.current?.zoomBy(1.25) }, { label: 'Zoom Out', shortcut: keyLabel('mod+-'), onClick: () => wsRef.current?.zoomBy(0.8) },
      { label: 'Fit Page in Window', shortcut: keyLabel('mod+0'), onClick: () => wsRef.current?.fit('page') }, { label: 'Fit Spread in Window', shortcut: keyLabel('alt+mod+0'), onClick: () => wsRef.current?.fit('spread') },
      { label: 'Actual Size', shortcut: keyLabel('mod+1'), onClick: () => wsRef.current?.zoomTo(1) },
      { divider: true },
      { label: 'Preview Mode', shortcut: 'W', checked: opts.preview, onClick: () => setOpts((o) => ({ ...o, preview: !o.preview })) },
      { label: 'Rulers', shortcut: keyLabel('mod+r'), checked: opts.rulers, onClick: () => setOpts((o) => ({ ...o, rulers: !o.rulers })) },
      { label: 'Guides', shortcut: keyLabel('mod+;'), checked: opts.guides, onClick: () => setOpts((o) => ({ ...o, guides: !o.guides })) },
      { label: 'Snap to Guides', shortcut: keyLabel('shift+mod+;'), checked: opts.snap, onClick: () => setOpts((o) => ({ ...o, snap: !o.snap })) },
      { label: 'Frame Edges', checked: opts.edges, onClick: () => setOpts((o) => ({ ...o, edges: !o.edges })) },
      { label: 'Text Threads', checked: opts.threads, onClick: () => setOpts((o) => ({ ...o, threads: !o.threads })) },
    ] },
  ];
  const fileItems = [
    { label: 'Place…', icon: 'image', shortcut: keyLabel('mod+d'), onClick: place, disabled: !canEdit },
    { label: 'Document Setup…', icon: 'settings', shortcut: keyLabel('alt+mod+p'), onClick: () => docSetupDialog(ed), disabled: !canEdit },
    { label: 'Print…', icon: 'file', shortcut: keyLabel('mod+p'), onClick: () => ed.print() },
  ];
  const editItems = [
    { label: 'Cut', shortcut: keyLabel('mod+x'), onClick: () => { copySel(); deleteSel(); }, disabled: !sel.length },
    { label: 'Copy', shortcut: keyLabel('mod+c'), onClick: copySel, disabled: !sel.length },
    { label: 'Paste', shortcut: keyLabel('mod+v'), onClick: () => pasteItems(false) },
    { label: 'Paste in Place', shortcut: keyLabel('alt+shift+mod+v'), onClick: () => pasteItems(true) },
    { label: 'Duplicate', shortcut: keyLabel('alt+shift+mod+d'), onClick: duplicateSel, disabled: !sel.length },
    { label: 'Delete', onClick: deleteSel, disabled: !sel.length },
    { divider: true },
    { label: 'Select All', shortcut: keyLabel('mod+a'), onClick: () => setSel(wsRef.current?.editableIds() || []) },
    { label: 'Find/Change…', shortcut: keyLabel('mod+f'), onClick: () => setFindOpen(true) },
  ];

  const tools = (
    <>
      <Tool icon="select" label="Selection" shortcut="v" active={tool === 'select' && !loaded} onClick={() => setTool('select')} />
      <Tool icon="directSelect" label="Direct Selection (move image inside frame)" shortcut="a" active={tool === 'direct'} onClick={() => setTool('direct')} />
      <ToolDivider />
      <Tool icon="text" label="Type" shortcut="t" active={tool === 'type'} onClick={() => setTool('type')} />
      <Tool icon="frame" label="Rectangle Frame (for images)" shortcut="f" active={tool === 'frame'} onClick={() => setTool('frame')} />
      <Tool icon="rect" label="Rectangle" shortcut="m" active={tool === 'rect'} onClick={() => setTool('rect')} />
      <Tool icon="ellipse" label="Ellipse" shortcut="l" active={tool === 'ellipse'} onClick={() => setTool('ellipse')} />
      <Tool icon="line" label="Line" shortcut="\\" active={tool === 'line'} onClick={() => setTool('line')} />
      <ToolDivider />
      <Tool icon="image" label="Place image" shortcut="mod+d" onClick={place} />
      <ToolDivider />
      <Tool icon="hand" label="Hand" shortcut="h" active={tool === 'hand'} onClick={() => setTool('hand')} />
      <Tool icon="zoom" label="Zoom" shortcut="z" active={tool === 'zoom'} onClick={() => setTool('zoom')} />
      <ToolDivider />
      <Tool icon="eye" label="Preview mode" shortcut="w" active={opts.preview} onClick={() => setOpts((o) => ({ ...o, preview: !o.preview }))} />
    </>
  );

  const pageLabel = masterEdit ? `Parent ${masterLabel(doc.masters.find((m) => m.id === masterEdit) || { id: masterEdit, name: '' })}` : `Page ${pageNumber(doc, Math.min(curPage, doc.pages.length - 1))} of ${doc.pages.length}`;
  const status = (
    <>
      <span>{pageLabel}</span>
      <span>{Math.round((view?.zoom || 1) * 100)}%</span>
      <span>{doc.width} × {doc.height} pt{doc.facing ? ' · facing pages' : ''}</span>
      {selItems.length > 0 && <span>{selItems.length} selected</span>}
      {edit && story && <span>{story.text.length} characters</span>}
      {preflight.some((p) => p.level === 'error') ? <span className="text-danger">● {preflight.length} preflight issue{preflight.length > 1 ? 's' : ''}</span> : <span className="text-ok">● No errors</span>}
      {loaded && <span className="text-accent">Loaded text cursor — click a frame to thread, or click/drag on a page (Esc cancels)</span>}
      {placing && <span className="text-accent">Placing {placing.length} image{placing.length > 1 ? 's' : ''} — click or drag on a page (Esc cancels)</span>}
    </>
  );

  return (
    <EditorShell app={APP} project={project} history={h} getData={getData} menus={menus} fileItems={fileItems} editItems={editItems}
      exportConfig={exportConfig} tools={canEdit ? tools : null} options={<OptionsBar ed={ed} />} panels={<Panels ed={ed} />} panelWidth={300} status={status}
      commentAnchor={() => ({ page: curPage })} anchorLabel={(a) => `page ${pageNumber(doc, a.page ?? 0)}`} onJumpToComment={(a) => goPage(Math.min(a.page ?? 0, doc.pages.length - 1))}>
      <Workspace ed={ed} ref={wsRef} />
      {findOpen && <FindChange ed={ed} onClose={() => setFindOpen(false)} />}
    </EditorShell>
  );
}

