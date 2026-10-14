// Glue the three vector apps share: saving (getData + throttled thumbnails), keyboard shortcuts, clipboard events,
// menus, the options bar, the status bar and tabbed side panels.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { promptDialog, toast, toastError, cx, NumberInput, ColorSwatch, Select } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { Icon } from '../../components/Icons.jsx';
import { thumbnail } from './export.js';
import { artboardsOf, solid, strokeOf, make, walk, bounds } from './model.js';
import { parsePathData, pathData, localSubpaths, mapSubpaths, I } from './geom.js';
import { nodeLabel } from './panels.jsx';

/** getData for EditorShell: the document plus a thumbnail at most every 20 s. */
export function useGetData(ed) {
  const lastThumb = useRef(0);
  return useCallback(async () => {
    const d = ed.get();
    if (!d) return null;
    const ab = artboardsOf(d)[0];
    let thumb;
    if (Date.now() - lastThumb.current > 20000) {
      try { thumb = await thumbnail(d); lastThumb.current = Date.now(); } catch { /* thumbnails are best effort */ }
    }
    return { data: d, thumb, width: ab ? Math.round(ab.w) : undefined, height: ab ? Math.round(ab.h) : undefined, pages: artboardsOf(d).length };
  }, [ed]);
}

const isTyping = () => { const el = document.activeElement; return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };

/** Copy / cut / paste through the real clipboard events (so SVG text can come in and go out). */
export function useClipboard(ed) {
  const ref = useRef(ed); ref.current = ed;
  useEffect(() => {
    const ok = () => !isTyping() && !document.querySelector('[role=dialog][aria-modal=true]');
    const copy = (e) => { if (ok() && ref.current.sel.length) ref.current.copy(e); };
    const cut = (e) => { if (ok() && ref.current.sel.length && !ref.current.readOnly) ref.current.cut(e); };
    const paste = (e) => { if (ok() && !ref.current.readOnly) { e.preventDefault(); ref.current.paste(e, ref.current.pasteMode || 'center'); ref.current.pasteMode = null; } };
    document.addEventListener('copy', copy); document.addEventListener('cut', cut); document.addEventListener('paste', paste);
    return () => { document.removeEventListener('copy', copy); document.removeEventListener('cut', cut); document.removeEventListener('paste', paste); };
  }, []);
}

/** Shortcuts every vector app has; `tools` maps keys to tool ids, `extra` adds/overrides combos. */
export function useVectorShortcuts(ed, { tools = {}, extra = {} } = {}) {
  const ro = ed.readOnly;
  const map = {
    ...Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, () => ed.setTool(t)])),
    delete: () => (ed.tool === 'artboard' && !ed.sel.length ? ed.deleteArtboard(ed.activeAb) : ed.del()),
    backspace: () => (ed.tool === 'artboard' && !ed.sel.length ? ed.deleteArtboard(ed.activeAb) : ed.del()),
    escape: () => { if (ed.editingText) ed.setEditingText(null); else if (ed.groupScope) ed.setGroupScope(null); else if (ed.scope) ed.exitSymbol(); else ed.setSel([]); },
    arrowleft: () => ed.nudge(-1, 0), arrowright: () => ed.nudge(1, 0), arrowup: () => ed.nudge(0, -1), arrowdown: () => ed.nudge(0, 1),
    'shift+arrowleft': () => ed.nudge(-10, 0), 'shift+arrowright': () => ed.nudge(10, 0), 'shift+arrowup': () => ed.nudge(0, -10), 'shift+arrowdown': () => ed.nudge(0, 10),
    'mod+g': () => ed.group(), 'shift+mod+g': () => ed.ungroup(),
    'mod+]': () => ed.arrange('forward'), 'mod+[': () => ed.arrange('backward'), 'shift+mod+]': () => ed.arrange('front'), 'shift+mod+[': () => ed.arrange('back'), 'mod+}': () => ed.arrange('front'), 'mod+{': () => ed.arrange('back'),
    'mod+a': () => ed.selectAll(), 'shift+mod+a': () => ed.setSel([]),
    'mod+0': () => ed.viewportRef.current?.fit(), 'alt+mod+0': () => ed.viewportRef.current?.fitAll(), 'mod+1': () => ed.viewportRef.current?.actual(),
    'mod+=': () => ed.viewportRef.current?.zoomAt(ed.view.zoom * 1.25), 'mod+plus': () => ed.viewportRef.current?.zoomAt(ed.view.zoom * 1.25), 'mod+-': () => ed.viewportRef.current?.zoomAt(ed.view.zoom / 1.25),
    "mod+'": () => ed.setOpts((o) => ({ ...o, grid: !o.grid })), 'mod+"': () => ed.setOpts((o) => ({ ...o, snapGrid: !o.snapGrid })),
    'mod+u': () => ed.setOpts((o) => ({ ...o, smart: !o.smart })), 'mod+;': () => ed.setOpts((o) => ({ ...o, guides: !o.guides })),
    'shift+mod+v': () => { ed.pasteMode = 'inplace'; return false; }, // let the browser fire the paste event
    'mod+f': () => { ed.pasteMode = 'front'; navigator.clipboard?.readText?.().then(() => {}).catch(() => {}); ed.paste(null, 'front'); },
    ...extra,
  };
  if (ro) for (const k of Object.keys(map)) if (!/^(mod\+[01=+-]|alt\+mod\+0|escape|[vhz]|mod\+a|shift\+mod\+a|mod\+')$/.test(k) && !Object.keys(tools).includes(k)) delete map[k];
  useShortcuts(map, [ed]);
}

/** Edit menu extras (Cut/Copy/Paste go through document.execCommand so the clipboard events run). */
export function editItems(ed, { dupKey } = {}) {
  const ro = ed.readOnly;
  return [
    { label: 'Cut', icon: 'scissors', shortcut: keyLabel('mod+x'), disabled: ro || !ed.sel.length, onClick: () => { if (!document.execCommand('cut')) ed.cut(); } },
    { label: 'Copy', icon: 'copy', shortcut: keyLabel('mod+c'), disabled: !ed.sel.length, onClick: () => { if (!document.execCommand('copy')) ed.copy(); } },
    { label: 'Paste', icon: 'copy', shortcut: keyLabel('mod+v'), disabled: ro, onClick: () => ed.paste(null) },
    { label: 'Paste in Front', shortcut: keyLabel('mod+f'), disabled: ro, onClick: () => ed.paste(null, 'front') },
    { label: 'Paste in Place', shortcut: keyLabel('shift+mod+v'), disabled: ro, onClick: () => ed.paste(null, 'inplace') },
    { label: 'Paste SVG code…', icon: 'import', disabled: ro, onClick: async () => { const t = await promptDialog({ title: 'Paste SVG code', label: 'SVG markup', placeholder: '<svg …>…</svg>' }); if (t && !ed.pasteSvgText(t)) toast('Couldn’t read that SVG.', { type: 'error' }); } },
    { label: 'Duplicate', icon: 'duplicate', shortcut: dupKey ? keyLabel(dupKey) : undefined, disabled: ro || !ed.sel.length, onClick: () => ed.duplicate() },
    { label: 'Delete', icon: 'trash', shortcut: 'Del', disabled: ro || !ed.sel.length, onClick: ed.del },
    { divider: true },
    { label: 'Select All', shortcut: keyLabel('mod+a'), onClick: ed.selectAll },
    { label: 'Deselect', shortcut: keyLabel('shift+mod+a'), onClick: () => ed.setSel([]) },
  ];
}

/** Asks for numbers like "10, -5" (Move) or "120" (Scale). */
async function askNumbers(title, label, value) {
  const v = await promptDialog({ title, label, value });
  if (v === null || v === undefined) return null;
  const nums = String(v).split(/[\s,;x×]+/).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? nums : null;
}

export function objectMenu(ed, { symbolsLabel = 'Symbol', compKey } = {}) {
  const ro = ed.readOnly; const none = !ed.sel.length;
  const single = ed.selNodes.length === 1 ? ed.selNodes[0] : null;
  return {
    label: 'Object',
    items: () => [
      { label: 'Transform', icon: 'transform', disabled: ro || none, items: [
        { label: 'Transform Again', shortcut: ed.app === 'vector' ? keyLabel('mod+d') : undefined, onClick: ed.transformAgain },
        { divider: true },
        { label: 'Move…', onClick: async () => { const n = await askNumbers('Move', 'Horizontal, vertical (px)', '10, 0'); if (n) ed.moveSel(n[0], n[1] ?? 0, false); } },
        { label: 'Move a copy…', onClick: async () => { const n = await askNumbers('Move a copy', 'Horizontal, vertical (px)', '10, 10'); if (n) ed.moveSel(n[0], n[1] ?? 0, true); } },
        { label: 'Rotate…', icon: 'rotate', onClick: async () => { const n = await askNumbers('Rotate', 'Angle (°)', '45'); if (n) ed.rotateSel(n[0]); } },
        { label: 'Scale…', icon: 'scale', onClick: async () => { const n = await askNumbers('Scale', 'Uniform % (or horizontal %, vertical %)', '100'); if (n) ed.scaleSel(n[0] / 100, (n[1] ?? n[0]) / 100); } },
        { label: 'Reflect horizontally', icon: 'flipH', onClick: () => ed.reflectSel('h') },
        { label: 'Reflect vertically', icon: 'flipV', onClick: () => ed.reflectSel('v') },
      ] },
      { label: 'Arrange', icon: 'layers', disabled: ro || none, items: [
        { label: 'Bring to Front', icon: 'bringFront', shortcut: keyLabel('shift+mod+]'), onClick: () => ed.arrange('front') },
        { label: 'Bring Forward', shortcut: keyLabel('mod+]'), onClick: () => ed.arrange('forward') },
        { label: 'Send Backward', shortcut: keyLabel('mod+['), onClick: () => ed.arrange('backward') },
        { label: 'Send to Back', icon: 'sendBack', shortcut: keyLabel('shift+mod+['), onClick: () => ed.arrange('back') },
      ] },
      { label: 'Align', icon: 'alignLeft', disabled: ro || none, items: [
        ['left', 'Left', 'alignLeft'], ['hcenter', 'Horizontal centre', 'alignCenterH'], ['right', 'Right', 'alignRight'], ['top', 'Top', 'alignTop'], ['vcenter', 'Vertical centre', 'alignMiddle'], ['bottom', 'Bottom', 'alignBottom'],
      ].map(([k, l, ic]) => ({ label: l, icon: ic, onClick: () => ed.align(k) })) },
      { divider: true },
      { label: 'Group', icon: 'group', shortcut: keyLabel('mod+g'), disabled: ro || none, onClick: ed.group },
      { label: 'Ungroup', icon: 'ungroup', shortcut: keyLabel('shift+mod+g'), disabled: ro || !ed.selNodes.some((n) => n.type === 'group'), onClick: ed.ungroup },
      { label: 'Lock', icon: 'lock', shortcut: keyLabel('mod+2'), disabled: ro || none, onClick: () => ed.setFlag('locked', true) },
      { label: 'Unlock All', shortcut: keyLabel('alt+mod+2'), disabled: ro, onClick: ed.unlockAll },
      { label: 'Hide', icon: 'eyeOff', shortcut: keyLabel('mod+3'), disabled: ro || none, onClick: () => ed.setFlag('hidden', true) },
      { label: 'Show All', shortcut: keyLabel('alt+mod+3'), disabled: ro, onClick: ed.showAll },
      { divider: true },
      { label: 'Make Clipping Mask', icon: 'mask', shortcut: keyLabel('mod+7'), disabled: ro || ed.sel.length < 2, onClick: ed.makeClip },
      { label: 'Release Clipping Mask', shortcut: keyLabel('alt+mod+7'), disabled: ro || !ed.selNodes.some((n) => n.clip), onClick: ed.releaseClip },
      { label: 'Compound Path', items: [
        { label: 'Make', shortcut: keyLabel('mod+8'), disabled: ro || ed.sel.length < 2, onClick: ed.makeCompound },
        { label: 'Release', shortcut: keyLabel('shift+alt+mod+8'), disabled: ro || !(single?.type === 'path' && single.subpaths.length > 1), onClick: ed.releaseCompound },
      ] },
      { label: 'Path', icon: 'pen', items: [
        { label: 'Convert to Path', disabled: ro || none, onClick: ed.convertToPath },
        { label: 'Simplify', disabled: ro || !ed.selNodes.some((n) => n.type === 'path'), onClick: ed.simplifyPath },
        ...['unite', 'subtract', 'intersect', 'exclude', 'divide'].map((op) => ({ label: { unite: 'Unite', subtract: 'Minus Front', intersect: 'Intersect', exclude: 'Exclude', divide: 'Divide' }[op], disabled: ro || ed.sel.length < 2, onClick: () => ed.doPathfinder(op) })),
      ] },
      { divider: true },
      { label: `New ${symbolsLabel}…`, icon: 'component', shortcut: compKey ? keyLabel(compKey) : undefined, disabled: ro || none || !!ed.scope, onClick: async () => { const v = await promptDialog({ title: `New ${symbolsLabel.toLowerCase()}`, label: 'Name', value: `${symbolsLabel} ${(ed.doc?.symbols.length || 0) + 1}` }); if (v) ed.makeSymbol(v); } },
      { label: `Detach ${symbolsLabel.toLowerCase()} instance`, disabled: ro || !ed.selNodes.some((n) => n.type === 'instance'), onClick: ed.detachInstance },
    ],
  };
}

export function typeMenu(ed) {
  const ro = ed.readOnly;
  const texts = ed.selNodes.filter((n) => n.type === 'text');
  return {
    label: 'Type',
    items: () => [
      { label: 'Create Outlines', shortcut: keyLabel('shift+mod+o'), disabled: ro || !texts.length, onClick: ed.outlineText },
      { label: 'Type on a Path', icon: 'textPath', disabled: ro || !ed.selNodes.some((n) => localSubpaths(n)), onClick: () => typeOnPath(ed) },
      { divider: true },
      { label: 'Larger', shortcut: keyLabel('shift+mod+.'), disabled: ro || !texts.length, onClick: () => ed.setProps((n) => (n.type === 'text' ? { font: { ...n.font, size: Math.round((n.font?.size || 36) * 1.1) } } : {}), 'Font Size') },
      { label: 'Smaller', shortcut: keyLabel('shift+mod+,'), disabled: ro || !texts.length, onClick: () => ed.setProps((n) => (n.type === 'text' ? { font: { ...n.font, size: Math.max(1, Math.round((n.font?.size || 36) / 1.1)) } } : {}), 'Font Size') },
    ],
  };
}

/** Puts text along the selected path (the path itself is used as the baseline and removed). */
export function typeOnPath(ed) {
  const src = ed.selNodes.find((n) => localSubpaths(n) && n.type !== 'image');
  if (!src) return;
  const sps = mapSubpaths(localSubpaths(src), src.t || I);
  const t = make.text({ text: 'Type on a path', mode: 'path', font: { size: 32, ...(ed.style.font || {}) }, fill: solid('#000000'), name: 'Path text' });
  t.t = I; t.pathD = pathData(sps); t.startOffset = 0;
  ed.change((r) => {
    const rep = (list) => list.map((n) => (n.id === src.id ? t : n.children ? { ...n, children: rep(n.children) } : n));
    return rep(r);
  }, 'Type on a Path');
  ed.setSel([t.id]);
  setTimeout(() => ed.setEditingText(t.id), 0);
}

export function viewMenu(ed, extra = []) {
  const o = ed.opts;
  const tog = (k) => ed.setOpts((p) => ({ ...p, [k]: !p[k] }));
  return {
    label: 'View',
    items: () => [
      { label: 'Zoom In', icon: 'zoomIn', shortcut: keyLabel('mod+='), onClick: () => ed.viewportRef.current?.zoomAt(ed.view.zoom * 1.25) },
      { label: 'Zoom Out', icon: 'zoomOut', shortcut: keyLabel('mod+-'), onClick: () => ed.viewportRef.current?.zoomAt(ed.view.zoom / 1.25) },
      { label: 'Fit Artboard in Window', icon: 'fit', shortcut: keyLabel('mod+0'), onClick: () => ed.viewportRef.current?.fit() },
      { label: 'Fit All in Window', shortcut: keyLabel('alt+mod+0'), onClick: () => ed.viewportRef.current?.fitAll() },
      { label: 'Actual Size', shortcut: keyLabel('mod+1'), onClick: () => ed.viewportRef.current?.actual() },
      { divider: true },
      { label: 'Rulers', checked: o.rulers, shortcut: keyLabel('mod+r'), onClick: () => tog('rulers') },
      { label: 'Guides', checked: o.guides, shortcut: keyLabel('mod+;'), onClick: () => tog('guides') },
      { label: 'Clear Guides', disabled: ed.readOnly, onClick: () => ed.changeDoc((d) => ({ ...d, guides: { x: [], y: [] } }), 'Clear Guides') },
      { label: 'Smart Guides', checked: o.smart, shortcut: keyLabel('mod+u'), onClick: () => tog('smart') },
      { label: 'Grid', checked: o.grid, shortcut: keyLabel("mod+'"), onClick: () => tog('grid') },
      { label: 'Snap to Grid', checked: o.snapGrid, onClick: () => tog('snapGrid') },
      { label: 'Grid size…', onClick: async () => { const v = await promptDialog({ title: 'Grid size', label: 'Pixels between grid lines', value: String(o.gridSize) }); const n = Number(v); if (n > 0) ed.setOpts((p) => ({ ...p, gridSize: n })); } },
      ...extra,
    ],
  };
}

/** File menu items for placing images and importing SVG files. */
export function placeItems(ed) {
  const ro = ed.readOnly;
  return [
    { label: 'Place…', icon: 'image', shortcut: keyLabel('shift+mod+p'), disabled: ro, onClick: async () => { const a = await pickAssets({ kinds: ['image'], docId: ed.project.doc?.id, title: 'Place images or SVG' }); if (a?.length) ed.placeAssets(a); } },
    { label: 'Import SVG…', icon: 'import', disabled: ro, onClick: () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.svg,image/svg+xml';
      inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { ed.importSvgText(await f.text()); toast(`Imported ${f.name}`, { type: 'success' }); } catch (e) { toastError(e); } };
      inp.click();
    } },
  ];
}

/** Tabs across the top of the right-hand panel area. */
export function PanelTabs({ tabs, initial, id }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(`sl-vtab-${id}`) || initial || tabs[0].id; } catch { return initial || tabs[0].id; } });
  useEffect(() => { try { localStorage.setItem(`sl-vtab-${id}`, tab); } catch { /* private mode */ } }, [tab, id]);
  const cur = tabs.find((t) => t.id === tab) || tabs[0];
  return (
    <div className="flex flex-col min-h-full">
      <div className="flex border-b border-line sticky top-0 bg-panel z-10">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={cx('flex-1 h-9 text-[12px] border-b-2 -mb-px', cur.id === t.id ? 'border-accent text-fg' : 'border-transparent text-fg2 hover:text-fg')}>{t.label}</button>
        ))}
      </div>
      <div className="flex-1">{cur.render()}</div>
    </div>
  );
}

/** The contextual options bar (like Illustrator's Control panel). */
export function OptionsBar({ ed, children }) {
  const n = ed.selNodes;
  const leaf = n.find((x) => x.type !== 'group' && x.type !== 'image');
  const ro = ed.readOnly;
  const key = ed.sel.join();
  const fill = leaf?.fill; const st = leaf?.stroke;
  const label = !n.length ? (ed.scope ? 'Editing symbol' : 'No selection') : n.length === 1 ? nodeLabel(n[0]) : `${n.length} objects`;
  return (
    <>
      <span className="text-[12px] text-fg2 min-w-24 truncate">{label}</span>
      {leaf && !ro && (
        <>
          <span className="text-[11px] text-fg3">Fill</span>
          <ColorSwatch size={22} none value={fill?.type === 'solid' ? fill.color : fill?.stops?.[0]?.color || null} onChange={(c) => ed.setProps({ fill: c ? solid(c) : null }, 'Fill', { merge: `fill-${key}` })} onCommit={() => ed.h.commit()} />
          <span className="text-[11px] text-fg3 ml-1">Stroke</span>
          <ColorSwatch size={22} none value={st?.color || null} onChange={(c) => ed.setProps((x) => ({ stroke: c ? { ...(x.stroke || strokeOf(c, 1)), color: c } : null }), 'Stroke', { merge: `stroke-${key}` })} onCommit={() => ed.h.commit()} />
          <NumberInput value={st?.width ?? 0} min={0} step={0.5} unit="pt" width={56} onChange={(v) => ed.setProps((x) => ({ stroke: { ...(x.stroke || strokeOf('#000000', 1)), width: v } }), 'Stroke Weight', { merge: `sw-${key}` })} onCommit={() => ed.h.commit()} />
          <NumberInput label="Opacity" value={Math.round((n[0].opacity ?? 1) * 100)} min={0} max={100} unit="%" width={52} onChange={(v) => ed.setProps({ opacity: v / 100 }, 'Opacity', { merge: `op-${key}` })} onCommit={() => ed.h.commit()} />
        </>
      )}
      {children}
      <span className="flex-1" />
      <Select small value={String(Math.round(ed.view.zoom * 100))} onChange={(v) => (v === 'fit' ? ed.viewportRef.current?.fit() : ed.viewportRef.current?.zoomAt(Number(v) / 100))}
        options={[...new Set([Math.round(ed.view.zoom * 100), 25, 50, 66, 100, 150, 200, 400, 800])].sort((a, b) => a - b).map((z) => ({ value: String(z), label: `${z}%` })).concat([{ value: 'fit', label: 'Fit' }])} />
    </>
  );
}

export function StatusBar({ ed, hint }) {
  const b = ed.selBounds;
  return (
    <>
      <span>{Math.round(ed.view.zoom * 100)}%</span>
      {b && <span>X {Math.round(b.x)} · Y {Math.round(b.y)} · W {Math.round(b.w)} · H {Math.round(b.h)}</span>}
      <span className="truncate">{hint}</span>
      <span className="flex-1" />
      {ed.opts.snapGrid && <span>Snap to grid</span>}
      {ed.opts.smart && <span>Smart guides</span>}
    </>
  );
}

/** Lets the canvas accept dropped image files and symbols dragged from the Symbols panel. */
export function useCanvasDrop(ed) {
  return {
    onDragOver: (e) => { if (!ed.readOnly) e.preventDefault(); },
    onDrop: (e) => {
      if (ed.readOnly) return;
      e.preventDefault();
      const at = ed.viewportRef.current?.clientToWorld(e.clientX, e.clientY);
      const sym = e.dataTransfer.getData('application/x-sora-symbol');
      if (sym) { ed.placeSymbol(sym, at); return; }
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.svg$/i.test(f.name));
      if (files.length) {
        const svg = files.find((f) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml');
        if (svg) svg.text().then((t) => ed.importSvgText(t)).catch(toastError);
        else ed.placeFiles(files);
      }
    },
  };
}

export const ToolHint = { select: 'Click to select · Shift adds · Alt-drag duplicates · drag handles to scale, outside corners to rotate', direct: 'Drag anchors and handles · Shift adds anchors', pen: 'Click for corners, drag for curves · click the first anchor to close · Enter/Esc to finish', pencil: 'Draw freehand; it’s smoothed when you let go', text: 'Click for point text, drag for a text box', artboard: 'Drag to make an artboard · drag an artboard to move it · handles resize', eyedropper: 'Click an object to copy its look onto the selection', hand: 'Drag to pan', zoom: 'Click to zoom in, Alt-click to zoom out, drag a rectangle', rotate: 'Drag to rotate around the centre · Shift for 45°', scale: 'Drag to scale around the centre · Shift keeps proportions', reflect: 'Click to flip horizontally · Alt-click vertically' };
export { Icon, walk, bounds, parsePathData };
