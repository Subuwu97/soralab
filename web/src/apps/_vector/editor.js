// The editor brain shared by the three apps: the document in undo history, selection, tools, the view, and every
// document action (group, align, arrange, pathfinder, symbols, clipboard…). The apps only add their own chrome.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from '../../lib/history.js';
import { toast, toastError } from '../../components/ui.jsx';
import { uploadFiles } from '../../lib/api.js';
import {
  createDoc, normalizeDoc, rootOf, withRoot, find, findNode, updateIn, updateMany, removeIds, insertInto, cloneNode, walk, bounds, boundsOf,
  transformNode, toPathNode, make, solid, strokeOf, uid, artboardsOf, localBox,
} from './model.js';
import { I, mul, translate, rotate, scale, unionRects, intersects, mapSubpaths } from './geom.js';
import { pathfinder, importSvg, simplifySubpaths } from './paperops.js';
import { svgDocument } from './render.js';
import { textOutline } from './export.js';
import { loadFonts } from './text.js';

// In-app clipboard (also mirrored to the system clipboard as SVG + JSON so copies travel between the three apps).
let clipboard = null;
export const CLIP_MIME = 'web application/x-soralab-vector';

export function useVectorEditor(project, app, { defaultStyle } = {}) {
  const h = useHistory(null);
  const doc = h.state;
  const readOnly = !project.canEdit;
  const [sel, setSelRaw] = useState([]);
  const [anchors, setAnchors] = useState([]); // "nodeId:subpath:point"
  const [tool, setToolRaw] = useState('select');
  const [scope, setScope] = useState(null); // symbol id while editing a symbol
  const [groupScope, setGroupScope] = useState(null); // group entered by double-click
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0, fitted: false });
  const [editingText, setEditingText] = useState(null);
  const [activeAb, setActiveAb] = useState(null);
  const [opts, setOpts] = useState({ smart: true, grid: false, snapGrid: false, gridSize: 10, rulers: app === 'vector', guides: true, outline: false });
  const [style, setStyle] = useState(defaultStyle || { fill: solid('#ffffff'), stroke: strokeOf('#000000', 1) });
  const lastTransform = useRef(null);
  const viewportRef = useRef(null); // the Viewport registers { size, fit, zoomTo } here

  // Load the project.
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    const d = normalizeDoc(project.data && project.data.children ? project.data : null, { app, width: project.doc.width || 1024, height: project.doc.height || 1024 });
    h.reset(d);
    setActiveAb(artboardsOf(d)[0]?.id || null);
    loadFonts([...d.children, ...d.symbols.flatMap((s) => s.children)]);
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const get = h.get;
  // Leaving a text that ended up empty removes it (like Illustrator).
  const prevEditing = useRef(null);
  useEffect(() => {
    const prev = prevEditing.current;
    prevEditing.current = editingText;
    if (!prev || prev === editingText || readOnly) return;
    const n = findNode(rootOf(h.get(), scope), prev);
    if (n && n.type === 'text' && !String(n.text || '').trim()) h.set((d) => withRoot(d, scope, removeIds(rootOf(d, scope), [prev])), 'Delete Text');
  }, [editingText]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = doc ? rootOf(doc, scope) : [];
  const setSel = useCallback((ids) => { setSelRaw(ids); setAnchors([]); }, []);
  const setTool = useCallback((t) => { setToolRaw(t); setEditingText(null); }, []);

  // Drop selected ids that no longer exist (after undo, delete…).
  useEffect(() => {
    if (!doc) return;
    const r = rootOf(doc, scope);
    if (sel.some((id) => !findNode(r, id))) setSelRaw((s) => s.filter((id) => findNode(r, id)));
    if (activeAb && !doc.children.some((n) => n.id === activeAb)) setActiveAb(artboardsOf(doc)[0]?.id || null);
  }, [doc, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Changes the tree being edited: fn(rootList, doc) → new rootList. */
  const change = useCallback((fn, label, o) => {
    if (readOnly) return;
    h.set((d) => { const r = rootOf(d, scope); const nr = fn(r, d); return nr === r ? d : withRoot(d, scope, nr); }, label, o);
  }, [h, scope, readOnly]);
  /** Changes the whole document: fn(doc) → doc. */
  const changeDoc = useCallback((fn, label, o) => { if (!readOnly) h.set(fn, label, o); }, [h, readOnly]);

  const selNodes = useMemo(() => (doc ? sel.map((id) => findNode(root, id)).filter(Boolean) : []), [doc, sel, root]);
  const selBounds = useMemo(() => (doc && selNodes.length ? boundsOf(selNodes, doc) : null), [selNodes, doc]);

  /** The thing a click on `id` selects: the top-level object (or the child of an entered group). */
  const selectable = useCallback((id) => {
    const r = rootOf(get(), scope);
    const f = find(r, id);
    if (!f) return null;
    const chain = [...f.chain, f.node];
    if (groupScope) { const gi = chain.findIndex((n) => n.id === groupScope); if (gi >= 0 && chain[gi + 1]) return chain[gi + 1]; }
    const top = chain[0].type === 'artboard' ? chain[1] : chain[0];
    return top || null;
  }, [get, scope, groupScope]);

  /** The artboard containing a world point (topmost), or null. */
  const artboardAt = useCallback((x, y) => {
    const abs = artboardsOf(get());
    for (let i = abs.length - 1; i >= 0; i--) { const a = abs[i]; if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return a; }
    return null;
  }, [get]);

  /** Adds nodes to the artboard under their centre (or the active one, or the pasteboard). Selects them. */
  const addNodes = useCallback((nodes, label = 'Add', { parent, index, select = true } = {}) => {
    if (readOnly || !nodes.length) return;
    let pid = parent;
    if (pid === undefined) {
      if (scope) pid = null;
      else {
        const b = boundsOf(nodes, get());
        const a = b ? artboardAt(b.x + b.w / 2, b.y + b.h / 2) : null;
        pid = a?.id || (app === 'vector' ? null : activeAb || artboardsOf(get())[0]?.id || null);
      }
    }
    change((r) => insertInto(r, pid, nodes, index), label);
    if (select) setSel(nodes.map((n) => n.id));
    if (pid && !scope) setActiveAb(pid);
  }, [readOnly, scope, get, artboardAt, app, activeAb, change, setSel]);

  /** After a move: objects whose centre left their artboard are moved to the artboard (or pasteboard) they're now over. */
  const reparent = useCallback((ids) => {
    if (scope) return;
    changeDoc((d) => {
      let children = d.children;
      for (const id of ids) {
        const f = find(children, id);
        if (!f || (f.parent && f.parent.type !== 'artboard')) continue;
        const b = bounds(f.node, d);
        const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
        const abs = children.filter((n) => n.type === 'artboard');
        let target = null;
        for (let i = abs.length - 1; i >= 0; i--) { const a = abs[i]; if (cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h) { target = a; break; } }
        const cur = f.parent?.id || null;
        const tid = target?.id || null;
        if (cur === tid) continue;
        children = insertInto(removeIds(children, [id]), tid, [f.node]);
      }
      return children === d.children ? d : { ...d, children };
    }, 'Move', { merge: 'reparent' });
    h.commit();
  }, [scope, changeDoc, h]);

  // ---------------------------------------------------------------- basic actions

  const del = useCallback(() => {
    if (!sel.length) return;
    change((r) => removeIds(r, sel), sel.length > 1 ? 'Delete objects' : 'Delete');
    if (!scope) changeDoc((d) => ({ ...d, interactions: (d.interactions || []).filter((i) => !sel.includes(i.from)) }), 'Delete', { merge: 'delete-int' });
    setSel([]);
  }, [sel, change, changeDoc, scope, setSel]);

  /** Applies a world matrix to the selection (optionally duplicating first). */
  const transformSel = useCallback((M, label = 'Transform', { dup = false, merge, remember } = {}) => {
    if (!sel.length) return;
    if (dup) {
      const r = rootOf(get(), scope);
      const copies = [];
      let nr = r;
      for (const id of sel) {
        const f = find(nr, id); if (!f) continue;
        const c = transformNode(cloneNode(f.node), M);
        copies.push(c);
        nr = insertInto(nr, f.parent?.id || null, [c], f.index + 1);
      }
      change(() => nr, label, { merge });
      setSel(copies.map((c) => c.id));
    } else change((r) => updateMany(r, sel, (n) => transformNode(n, M)), label, { merge });
    if (remember) lastTransform.current = { ...remember, dup };
  }, [sel, get, scope, change, setSel]);

  const nudge = useCallback((dx, dy) => { transformSel(translate(dx, dy), 'Nudge', { merge: 'nudge' }); }, [transformSel]);

  const center = () => (selBounds ? { x: selBounds.x + selBounds.w / 2, y: selBounds.y + selBounds.h / 2 } : { x: 0, y: 0 });
  const rotateSel = (deg) => { const c = center(); transformSel(rotate(deg, c.x, c.y), 'Rotate', { remember: { type: 'rotate', deg } }); };
  const scaleSel = (sx, sy = sx) => { const c = center(); transformSel(scale(sx, sy, c.x, c.y), 'Scale', { remember: { type: 'scale', sx, sy } }); };
  const reflectSel = (axis) => { const c = center(); transformSel(axis === 'h' ? scale(-1, 1, c.x, c.y) : scale(1, -1, c.x, c.y), 'Reflect', { remember: { type: 'reflect', axis } }); };
  const moveSel = (dx, dy, dup) => transformSel(translate(dx, dy), dup ? 'Copy' : 'Move', { dup, remember: { type: 'move', dx, dy } });
  /** Ctrl+D in Illustrator: repeat the last move/rotate/scale/reflect (and duplicate again if it was a copy). */
  const transformAgain = () => {
    const t = lastTransform.current;
    if (!t || !sel.length) return;
    const c = center();
    const M = t.type === 'move' ? translate(t.dx, t.dy) : t.type === 'rotate' ? rotate(t.deg, c.x, c.y) : t.type === 'scale' ? scale(t.sx, t.sy, c.x, c.y) : t.axis === 'h' ? scale(-1, 1, c.x, c.y) : scale(1, -1, c.x, c.y);
    transformSel(M, 'Transform Again', { dup: t.dup });
  };

  const duplicate = useCallback((offset = app === 'vector' ? 10 : 20) => transformSel(translate(offset, offset), 'Duplicate', { dup: true }), [transformSel, app]);

  /** Wraps the selection in a group at the topmost selected object's place (extra: clip etc.). */
  const groupWith = useCallback((extra, label) => {
    if (sel.length < 1) return;
    const r = rootOf(get(), scope);
    const fs = sel.map((id) => find(r, id)).filter(Boolean);
    const order = []; walk(r, (n) => { order.push(n.id); });
    fs.sort((a, b) => order.indexOf(a.node.id) - order.indexOf(b.node.id));
    const top = fs[fs.length - 1];
    let kids = fs.map((f) => f.node);
    if (extra.clip) kids = kids.map((c, i) => (i === kids.length - 1 ? { ...c, fill: c.type === 'text' ? c.fill : null, stroke: null } : c));
    const g = make.group(kids, { name: 'Group', ...extra });
    change((rr) => {
      const parentId = top.parent?.id || null;
      const siblings = parentId ? findNode(rr, parentId).children : rr;
      const anchorIdx = siblings.findIndex((n) => n.id === top.node.id);
      const removedBefore = siblings.slice(0, anchorIdx).filter((n) => sel.includes(n.id)).length;
      return insertInto(removeIds(rr, sel), parentId, [g], anchorIdx - removedBefore);
    }, label);
    setSel([g.id]);
  }, [sel, get, scope, change, setSel]);
  const group = useCallback(() => groupWith({}, 'Group'), [groupWith]);
  /** Ctrl+7: the topmost selected object clips the others. */
  const makeClip = useCallback(() => {
    if (sel.length < 2) { toast('Select the artwork and a shape on top of it to use as the mask.'); return; }
    groupWith({ clip: true, name: 'Clip group' }, 'Make Clipping Mask');
  }, [sel, groupWith]);

  const ungroup = useCallback(() => {
    const r = rootOf(get(), scope);
    const out = [];
    let nr = r;
    for (const id of sel) {
      const f = find(nr, id);
      if (!f || f.node.type !== 'group') { out.push(id); continue; }
      let kids = f.node.children;
      if (f.node.clip) kids = kids.map((k, i) => (i === kids.length - 1 ? k : k)); // releasing keeps the mask as a plain object
      // Group opacity/effects carry over to the children so the look doesn't change.
      if ((f.node.opacity ?? 1) < 1) kids = kids.map((k) => ({ ...k, opacity: (k.opacity ?? 1) * f.node.opacity }));
      nr = updateIn(nr, id, () => kids);
      out.push(...kids.map((k) => k.id));
    }
    change(() => nr, 'Ungroup');
    setSel(out);
    setGroupScope(null);
  }, [sel, get, scope, change, setSel]);

  const releaseClip = useCallback(() => {
    change((r) => updateMany(r, sel, (n) => (n.type === 'group' && n.clip ? { ...n, clip: false, name: 'Group' } : n)), 'Release Clipping Mask');
  }, [sel, change]);

  const setFlag = useCallback((key, value, ids = sel, label) => {
    change((r) => updateMany(r, ids, (n) => ({ ...n, [key]: value })), label || (key === 'locked' ? (value ? 'Lock' : 'Unlock') : value ? 'Hide' : 'Show'));
    if (value) setSel([]);
  }, [sel, change, setSel]);
  const unlockAll = useCallback(() => {
    const ids = []; walk(rootOf(get(), scope), (n) => { if (n.locked) ids.push(n.id); });
    if (ids.length) { change((r) => updateMany(r, ids, (n) => ({ ...n, locked: false })), 'Unlock All'); setSel(ids); }
  }, [get, scope, change, setSel]);
  const showAll = useCallback(() => {
    const ids = []; walk(rootOf(get(), scope), (n) => { if (n.hidden) ids.push(n.id); });
    if (ids.length) { change((r) => updateMany(r, ids, (n) => ({ ...n, hidden: false })), 'Show All'); setSel(ids); }
  }, [get, scope, change, setSel]);

  /** Stacking order within each parent: front, forward, backward, back. */
  const arrange = useCallback((how) => {
    if (!sel.length) return;
    const set = new Set(sel);
    const reorder = (list) => {
      const idx = list.map((n, i) => (set.has(n.id) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return list;
      const l = list.slice();
      if (how === 'front') return [...l.filter((n) => !set.has(n.id)), ...l.filter((n) => set.has(n.id))];
      if (how === 'back') return [...l.filter((n) => set.has(n.id)), ...l.filter((n) => !set.has(n.id))];
      if (how === 'forward') { for (let i = l.length - 2; i >= 0; i--) if (set.has(l[i].id) && !set.has(l[i + 1].id)) [l[i], l[i + 1]] = [l[i + 1], l[i]]; return l; }
      for (let i = 1; i < l.length; i++) if (set.has(l[i].id) && !set.has(l[i - 1].id)) [l[i], l[i - 1]] = [l[i - 1], l[i]];
      return l;
    };
    const rec = (list) => { const l = reorder(list); return l.map((n) => (n.children && n.type !== 'artboard' && !n.children.some((c) => set.has(c.id)) ? n : n.children ? { ...n, children: rec(n.children) } : n)); };
    // Artboards stay in place at the root unless an artboard itself is selected.
    change((r) => rec(r), { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back' }[how]);
  }, [sel, change]);

  /** Align: left | hcenter | right | top | vcenter | bottom, to the selection, the artboard, or a key object. */
  const align = useCallback((how, to = 'auto') => {
    const d = get();
    if (!selNodes.length) return;
    let ref;
    const useAb = to === 'artboard' || (to === 'auto' && selNodes.length === 1);
    if (useAb) {
      const f = find(d.children, selNodes[0].id);
      const ab = f?.chain.find((n) => n.type === 'artboard') || artboardsOf(d).find((a) => a.id === activeAb);
      if (!ab) return;
      ref = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
    } else ref = boundsOf(selNodes, d);
    change((r) => updateMany(r, sel, (n) => {
      const b = bounds(n, d);
      const dx = how === 'left' ? ref.x - b.x : how === 'right' ? ref.x + ref.w - b.x - b.w : how === 'hcenter' ? ref.x + ref.w / 2 - b.x - b.w / 2 : 0;
      const dy = how === 'top' ? ref.y - b.y : how === 'bottom' ? ref.y + ref.h - b.y - b.h : how === 'vcenter' ? ref.y + ref.h / 2 - b.y - b.h / 2 : 0;
      return transformNode(n, translate(dx, dy));
    }), 'Align');
  }, [get, selNodes, sel, change, activeAb]);

  /** Distribute centres (h | v) or equal spacing (hspace | vspace). */
  const distribute = useCallback((how) => {
    const d = get();
    if (selNodes.length < 3) { toast('Select three or more objects to distribute.'); return; }
    const items = selNodes.map((n) => ({ n, b: bounds(n, d) }));
    const horiz = how === 'h' || how === 'hspace';
    items.sort((a, b) => (horiz ? a.b.x - b.b.x : a.b.y - b.b.y));
    const moves = new Map();
    if (how === 'h' || how === 'v') {
      const c = (it) => (horiz ? it.b.x + it.b.w / 2 : it.b.y + it.b.h / 2);
      const a = c(items[0]); const z = c(items[items.length - 1]);
      items.forEach((it, i) => moves.set(it.n.id, a + ((z - a) * i) / (items.length - 1) - c(it)));
    } else {
      const total = horiz ? items[items.length - 1].b.x + items[items.length - 1].b.w - items[0].b.x : items[items.length - 1].b.y + items[items.length - 1].b.h - items[0].b.y;
      const sizes = items.reduce((s, it) => s + (horiz ? it.b.w : it.b.h), 0);
      const gap = (total - sizes) / (items.length - 1);
      let pos = horiz ? items[0].b.x : items[0].b.y;
      for (const it of items) { moves.set(it.n.id, pos - (horiz ? it.b.x : it.b.y)); pos += (horiz ? it.b.w : it.b.h) + gap; }
    }
    change((r) => updateMany(r, sel, (n) => transformNode(n, horiz ? translate(moves.get(n.id) || 0, 0) : translate(0, moves.get(n.id) || 0))), 'Distribute');
  }, [get, selNodes, sel, change]);

  /** Sets properties on the selected objects; style keys go down into groups. */
  const setProps = useCallback((patch, label = 'Change', o) => {
    const styleKeys = ['fill', 'stroke'];
    const deep = (n) => {
      if (n.type === 'group' && Object.keys(patch).some((k) => styleKeys.includes(k))) {
        const own = Object.fromEntries(Object.entries(patch).filter(([k]) => !styleKeys.includes(k)));
        const st = Object.fromEntries(Object.entries(patch).filter(([k]) => styleKeys.includes(k)));
        return { ...n, ...own, children: n.children.map((c, i) => (n.clip && i === n.children.length - 1 ? c : deep2(c, st))) };
      }
      return { ...n, ...(typeof patch === 'function' ? patch(n) : patch) };
    };
    const deep2 = (n, st) => (n.type === 'group' ? { ...n, children: n.children.map((c) => deep2(c, st)) } : n.type === 'image' && st.fill ? n : { ...n, ...st });
    change((r) => updateMany(r, sel, typeof patch === 'function' ? (n) => ({ ...n, ...patch(n) }) : deep), label, o);
  }, [sel, change]);
  /** Updates one node by id. */
  const updateNode = useCallback((id, fn, label = 'Change', o) => change((r) => updateIn(r, id, (n) => (typeof fn === 'function' ? fn(n) : { ...n, ...fn })), label, o), [change]);

  // ---------------------------------------------------------------- paths

  const doPathfinder = useCallback((op) => {
    const d = get();
    const r = rootOf(d, scope);
    const order = []; walk(r, (n) => { order.push(n.id); });
    const ns = selNodes.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // Groups take part as their combined outline.
    const flat = ns.flatMap((n) => { if (n.type !== 'group') return [n]; const leaves = []; walk([n], (x) => { if (x.type !== 'group') leaves.push(x); }); return leaves; });
    try {
      const out = pathfinder(op, flat);
      if (!out.length) { toast('Nothing is left after that operation.'); return; }
      const f = find(r, ns[ns.length - 1].id);
      const parentId = f.parent?.id || null;
      const result = op === 'divide' ? [make.group(out, { name: 'Divided' })] : out;
      change((rr) => { const siblings = parentId ? findNode(rr, parentId).children : rr; const idx = siblings.findIndex((n) => n.id === ns[ns.length - 1].id); const without = removeIds(rr, sel); const before = siblings.slice(0, idx).filter((n) => sel.includes(n.id)).length; return insertInto(without, parentId, result, idx - before); }, { unite: 'Unite', subtract: 'Minus Front', intersect: 'Intersect', exclude: 'Exclude', divide: 'Divide' }[op]);
      setSel(result.map((n) => n.id));
    } catch (e) { toastError(e); }
  }, [get, scope, selNodes, sel, change, setSel]);

  const convertToPath = useCallback(() => change((r) => updateMany(r, sel, (n) => toPathNode(n)), 'Convert to Path'), [sel, change]);
  const makeCompound = useCallback(() => {
    const ns = selNodes.map(toPathNode).filter((n) => n.type === 'path');
    if (ns.length < 2) { toast('Select two or more paths.'); return; }
    const top = ns[ns.length - 1];
    const cp = make.path({ subpaths: ns.flatMap((n) => n.subpaths), fill: top.fill, stroke: top.stroke, fillRule: 'evenodd', name: 'Compound path' });
    const f = find(rootOf(get(), scope), top.id);
    change((r) => insertInto(removeIds(r, sel), f.parent?.id || null, [cp]), 'Make Compound Path');
    setSel([cp.id]);
  }, [selNodes, get, scope, sel, change, setSel]);
  const releaseCompound = useCallback(() => {
    const n = selNodes[0];
    if (!n || n.type !== 'path' || n.subpaths.length < 2) return;
    const parts = n.subpaths.map((sp) => ({ ...n, id: uid(), subpaths: [sp], fillRule: 'nonzero' }));
    change((r) => updateIn(r, n.id, () => parts), 'Release Compound Path');
    setSel(parts.map((p) => p.id));
  }, [selNodes, change, setSel]);
  const simplifyPath = useCallback(() => change((r) => updateMany(r, sel, (n) => (n.type === 'path' ? { ...n, subpaths: simplifySubpaths(n.subpaths, 3) } : n)), 'Simplify'), [sel, change]);
  const outlineText = useCallback(async () => {
    const texts = selNodes.filter((n) => n.type === 'text');
    if (!texts.length) { toast('Select some text first.'); return; }
    await loadFonts(texts);
    const repl = new Map();
    for (const t of texts) {
      const d = await textOutline(t);
      if (d === null) continue;
      const { subpaths } = make.path({ d });
      repl.set(t.id, { ...make.path({ subpaths: mapSubpaths(subpaths, t.t || I), fill: t.fill, stroke: t.stroke, name: (t.text || '').slice(0, 24) }), fillRule: 'nonzero', opacity: t.opacity, blend: t.blend, effects: t.effects });
    }
    change((r) => updateMany(r, [...repl.keys()], (n) => repl.get(n.id)), 'Create Outlines');
    setSel(sel.map((id) => repl.get(id)?.id || id));
  }, [selNodes, change, sel, setSel]);

  // ---------------------------------------------------------------- symbols / components

  const makeSymbol = useCallback(async (name) => {
    if (!selNodes.length || scope) return null;
    const d = get();
    const b = boundsOf(selNodes, d);
    // The master lives in its own space with its top-left at 0,0; the instance's matrix puts it back in place.
    const kids = selNodes.map((n) => transformNode(cloneNode(n), translate(-b.x, -b.y)));
    const sym = { id: uid(), name: name || `Symbol ${d.symbols.length + 1}`, children: kids };
    const inst = make.instance({ symbol: sym.id, x: b.x, y: b.y, name: sym.name });
    const f = find(d.children, selNodes[selNodes.length - 1].id);
    changeDoc((dd) => {
      const siblings = f.parent ? findNode(dd.children, f.parent.id).children : dd.children;
      const idx = siblings.findIndex((n) => n.id === f.node.id);
      const before = siblings.slice(0, idx).filter((n) => sel.includes(n.id)).length;
      return { ...dd, symbols: [...dd.symbols, sym], children: insertInto(removeIds(dd.children, sel), f.parent?.id || null, [inst], idx - before) };
    }, app === 'proto' ? 'Make Component' : 'New Symbol');
    setSel([inst.id]);
    return sym;
  }, [selNodes, scope, get, changeDoc, sel, setSel, app]);
  const placeSymbol = useCallback((symId, at) => {
    const d = get();
    const sym = d.symbols.find((s) => s.id === symId);
    if (!sym) return;
    const b = unionRects(sym.children.map((c) => bounds(c, d))) || { x: 0, y: 0, w: 0, h: 0 };
    const p = at || viewportRef.current?.center() || { x: 0, y: 0 };
    addNodes([make.instance({ symbol: symId, x: p.x - b.w / 2 - b.x, y: p.y - b.h / 2 - b.y, name: sym.name })], 'Place Symbol');
  }, [get, addNodes]);
  const detachInstance = useCallback(() => {
    const d = get();
    const out = [];
    change((r) => updateMany(r, sel, (n) => {
      if (n.type !== 'instance') return n;
      const sym = d.symbols.find((s) => s.id === n.symbol);
      if (!sym) return n;
      const apply = (c) => { const ov = n.overrides?.[c.id]; let x = { ...c, ...(ov?.text !== undefined ? { text: ov.text } : {}), ...(ov?.fill !== undefined ? { fill: ov.fill } : {}), ...(ov?.hidden !== undefined ? { hidden: ov.hidden } : {}) }; if (x.children) x = { ...x, children: x.children.map(apply) }; return x; };
      const g = make.group(sym.children.map((c) => transformNode(cloneNode(apply(c)), n.t)), { name: sym.name, opacity: n.opacity, effects: n.effects });
      out.push(g.id);
      return g;
    }), app === 'proto' ? 'Ungroup Component' : 'Break Link to Symbol');
    if (out.length) setSel(out);
  }, [get, sel, change, setSel, app]);
  const editSymbol = useCallback((symId) => { setSel([]); setGroupScope(null); setScope(symId); viewportRef.current?.fitSoon(); }, [setSel]);
  const exitSymbol = useCallback(() => { setSel([]); setScope(null); viewportRef.current?.fitSoon(); }, [setSel]);
  const deleteSymbol = useCallback((symId) => {
    changeDoc((d) => {
      const sym = d.symbols.find((s) => s.id === symId);
      // Instances become plain groups so artwork isn't lost.
      const conv = (list) => list.map((n) => {
        if (n.type === 'instance' && n.symbol === symId) return make.group(sym.children.map((c) => transformNode(cloneNode(c), n.t)), { name: sym.name });
        return n.children ? { ...n, children: conv(n.children) } : n;
      });
      return { ...d, symbols: d.symbols.filter((s) => s.id !== symId), children: conv(d.children) };
    }, 'Delete Symbol');
  }, [changeDoc]);

  // ---------------------------------------------------------------- clipboard

  const copy = useCallback((e) => {
    if (!selNodes.length) return false;
    const d = get();
    const b = boundsOf(selNodes, d);
    const syms = d.symbols.filter((s) => selNodes.some((n) => JSON.stringify(n).includes(`"symbol":"${s.id}"`)));
    clipboard = { nodes: selNodes, symbols: syms, bounds: b, from: d.id };
    const svg = svgDocument(d, selNodes, b);
    const json = JSON.stringify({ soralabVector: 1, nodes: selNodes, symbols: syms });
    if (e?.clipboardData) { e.clipboardData.setData('text/plain', svg); try { e.clipboardData.setData('application/x-soralab-vector', json); } catch { /* not allowed */ } e.preventDefault(); }
    else navigator.clipboard?.writeText?.(svg).catch(() => {});
    return true;
  }, [selNodes, get]);
  const cut = useCallback((e) => { if (copy(e)) del(); }, [copy, del]);
  /** Pastes nodes: mode 'center' (middle of view), 'inplace', 'front' (in place above the selection). */
  const pasteNodes = useCallback((nodes, symbols = [], mode = 'center') => {
    const d = get();
    // Symbols from another document come along (new ids if they clash with different content).
    const symMap = {};
    const newSyms = [];
    for (const s of symbols) { if (!d.symbols.some((x) => x.id === s.id)) newSyms.push(s); symMap[s.id] = s.id; }
    if (newSyms.length) changeDoc((dd) => ({ ...dd, symbols: [...dd.symbols, ...newSyms] }), 'Paste', { merge: 'paste-syms' });
    let copies = nodes.map(cloneNode);
    const b = boundsOf(copies, { ...d, symbols: [...d.symbols, ...newSyms] });
    if (mode === 'center' && b) {
      const c = viewportRef.current?.center();
      if (c) copies = copies.map((n) => transformNode(n, translate(c.x - b.x - b.w / 2, c.y - b.y - b.h / 2)));
    }
    if (mode === 'front' && sel.length) {
      const f = find(rootOf(d, scope), sel[sel.length - 1]);
      addNodes(copies, 'Paste in Front', { parent: f?.parent?.type === 'artboard' || f?.parent?.type === 'group' ? f.parent.id : scope ? null : undefined, index: f ? f.index + 1 : undefined });
    } else addNodes(copies, 'Paste');
  }, [get, changeDoc, sel, scope, addNodes]);
  const pasteSvgText = useCallback((text) => {
    try {
      const nodes = importSvg(text);
      if (!nodes.length) return false;
      pasteNodes(nodes, [], 'center');
      return true;
    } catch { return false; }
  }, [pasteNodes]);
  const paste = useCallback((e, mode = 'center') => {
    if (readOnly) return;
    const dt = e?.clipboardData;
    if (dt) {
      const json = dt.getData('application/x-soralab-vector');
      if (json) { try { const o = JSON.parse(json); pasteNodes(o.nodes, o.symbols, mode); e.preventDefault(); return; } catch { /* fall through */ } }
      const file = [...(dt.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); placeFiles([file]); return; }
      const text = dt.getData('text/plain');
      if (clipboard && text && text === svgDocument(get(), clipboard.nodes, clipboard.bounds)) { e.preventDefault(); pasteNodes(clipboard.nodes, clipboard.symbols, mode); return; }
      if (text && /<svg[\s>]/i.test(text)) { e.preventDefault(); if (!pasteSvgText(text)) toast('Couldn’t read that SVG.'); return; }
    }
    if (clipboard) pasteNodes(clipboard.nodes, clipboard.symbols, mode);
  }, [readOnly, pasteNodes, pasteSvgText, get]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- placing images and SVG

  /** Places assets (from pickAssets) as images, fitted into the view or a frame. SVG files are imported as vectors. */
  const placeAssets = useCallback(async (assets, { at, fit } = {}) => {
    const out = [];
    const c = at || viewportRef.current?.center() || { x: 0, y: 0 };
    for (const a of assets) {
      if (a.mime === 'image/svg+xml' || /\.svg$/i.test(a.name || '')) {
        try { const text = await (await fetch(`/api/assets/${a.id}/file`, { credentials: 'same-origin' })).text(); const ns = importSvg(text); const b = boundsOf(ns, get()); out.push(...(b ? ns.map((n) => transformNode(n, translate(c.x - b.x - b.w / 2, c.y - b.y - b.h / 2))) : ns)); continue; } catch { /* treat as bitmap */ }
      }
      let w = a.width || 400; let h2 = a.height || 300;
      if (!a.width) { try { const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `/api/assets/${a.id}/web`; }); w = img.naturalWidth; h2 = img.naturalHeight; } catch { /* keep default */ } }
      const max = fit || Math.min(800, (viewportRef.current?.visibleWorld()?.w || 1200) * 0.6);
      const s = Math.min(1, max / Math.max(w, h2));
      out.push(make.image({ x: c.x - (w * s) / 2 + out.length * 20, y: c.y - (h2 * s) / 2 + out.length * 20, w: w * s, h: h2 * s, asset: a.id, name: a.name || 'Image' }));
    }
    if (out.length) addNodes(out, out.length > 1 ? 'Place' : 'Place Image');
    return out;
  }, [get, addNodes]);
  const placeFiles = useCallback(async (files) => {
    try { const assets = await uploadFiles(files, { docId: project.doc?.id }); return placeAssets(assets); }
    catch (e) { toastError(e); return []; }
  }, [project.doc, placeAssets]);
  const importSvgText = useCallback((text) => {
    const nodes = importSvg(text);
    if (!nodes.length) throw new Error('Nothing to import in that SVG.');
    pasteNodes(nodes, [], 'center');
    // Embedded bitmaps become real assets in the background.
    const pend = []; walk(nodes, (n) => { if (n.pendingSrc) pend.push(n); });
    void pend;
  }, [pasteNodes]);

  // ---------------------------------------------------------------- artboards

  const addArtboard = useCallback((o = {}) => {
    const d = get();
    const abs = artboardsOf(d);
    const last = abs[abs.length - 1];
    const w = o.w || last?.w || project.doc?.width || 1024; const hh = o.h || last?.h || project.doc?.height || 1024;
    const pos = o.x !== undefined ? { x: o.x, y: o.y } : app === 'express' ? { x: last ? last.x : 0, y: last ? last.y + last.h + 80 : 0 } : { x: last ? last.x + last.w + 100 : 0, y: last ? last.y : 0 };
    const label = app === 'express' ? 'Page' : app === 'proto' ? 'Screen' : 'Artboard';
    const ab = make.artboard({ ...pos, w, h: hh, name: o.name || `${label} ${abs.length + 1}`, clip: app !== 'vector', bg: o.bg ?? '#ffffff', ...(app === 'proto' ? { viewportH: hh } : {}) });
    changeDoc((dd) => ({ ...dd, children: [...dd.children.filter((n) => n.type === 'artboard'), ab, ...dd.children.filter((n) => n.type !== 'artboard')] }), `New ${label}`);
    setActiveAb(ab.id);
    return ab;
  }, [get, project.doc, app, changeDoc]);
  const updateArtboard = useCallback((id, patch, label = 'Artboard', o) => changeDoc((d) => ({ ...d, children: d.children.map((n) => {
    if (n.id !== id) return n;
    const p = typeof patch === 'function' ? patch(n) : patch;
    // Moving an artboard moves its artwork.
    if ((p.x !== undefined && p.x !== n.x) || (p.y !== undefined && p.y !== n.y)) {
      const moved = transformNode(n, translate((p.x ?? n.x) - n.x, (p.y ?? n.y) - n.y));
      return { ...moved, ...p };
    }
    return { ...n, ...p };
  }) }), label, o), [changeDoc]);
  const deleteArtboard = useCallback((id) => {
    const d = get();
    if (artboardsOf(d).length <= 1) { toast('A document needs at least one artboard.'); return; }
    changeDoc((dd) => ({ ...dd, children: dd.children.filter((n) => n.id !== id), interactions: (dd.interactions || []).filter((i) => i.dest !== id && i.from !== id), home: dd.home === id ? artboardsOf(dd).find((a) => a.id !== id)?.id : dd.home }), 'Delete Artboard');
  }, [get, changeDoc]);
  const duplicateArtboard = useCallback((id) => {
    const d = get();
    const ab = d.children.find((n) => n.id === id);
    if (!ab) return;
    const abs = artboardsOf(d);
    const last = abs[abs.length - 1];
    const dx = app === 'express' ? last.x - ab.x : last.x + last.w + 100 - ab.x;
    const dy = app === 'express' ? last.y + last.h + 80 - ab.y : last.y - ab.y;
    const copy = transformNode(cloneNode(ab), translate(dx, dy));
    copy.name = `${ab.name} copy`;
    changeDoc((dd) => ({ ...dd, children: [...dd.children.filter((n) => n.type === 'artboard'), copy, ...dd.children.filter((n) => n.type !== 'artboard')] }), 'Duplicate Artboard');
    setActiveAb(copy.id);
  }, [get, app, changeDoc]);

  // Keep the active artboard in step with the selection.
  useEffect(() => {
    if (!doc || scope || !sel.length) return;
    const f = find(doc.children, sel[0]);
    const ab = f?.chain.find((n) => n.type === 'artboard');
    if (ab && ab.id !== activeAb) setActiveAb(ab.id);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectAll = useCallback(() => {
    const d = get();
    const ids = [];
    const r = rootOf(d, scope);
    for (const n of r) {
      if (n.type === 'artboard') { if (app === 'vector' || n.id === activeAb) for (const c of n.children) if (!c.locked && !c.hidden) ids.push(c.id); }
      else if (!n.locked && !n.hidden) ids.push(n.id);
    }
    setSel(ids);
  }, [get, scope, app, activeAb, setSel]);

  return {
    app, project, h, doc, root, readOnly, sel, setSel, selNodes, selBounds, anchors, setAnchors, tool, setTool, scope, setScope, groupScope, setGroupScope,
    view, setView, editingText, setEditingText, activeAb, setActiveAb, opts, setOpts, style, setStyle, lastTransform, viewportRef,
    get, change, changeDoc, selectable, artboardAt, addNodes, reparent, del, transformSel, nudge, rotateSel, scaleSel, reflectSel, moveSel, transformAgain,
    duplicate, group, ungroup, makeClip, releaseClip, setFlag, unlockAll, showAll, arrange, align, distribute, setProps, updateNode,
    doPathfinder, convertToPath, makeCompound, releaseCompound, simplifyPath, outlineText, makeSymbol, placeSymbol, detachInstance, editSymbol, exitSymbol, deleteSymbol,
    copy, cut, paste, pasteNodes, pasteSvgText, placeAssets, placeFiles, importSvgText, addArtboard, updateArtboard, deleteArtboard, duplicateArtboard, selectAll,
    localBox: (n) => localBox(n, doc), bounds: (n) => bounds(n, doc), intersects, mul,
  };
}
