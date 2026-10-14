// Sora UI/UX (proto): an XD-style screen designer on the shared vector engine. Design mode has artboards as device
// screens, components (main + instances with overrides), repeat grids and layout grids; Prototype mode wires objects to
// screens (tap / hover / time → transition, overlay, back, scroll to); Play previews in-page, and
// /proto/<id>?preview=1 is a shareable player.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EditorShell from '../../components/EditorShell.jsx';
import { Button, IconButton, NumberInput, Select, Segmented, Toggle, PanelSection, ColorSwatch, Spinner, toast, openMenu, promptDialog } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { shareDialog } from '../../components/ProjectDialogs.jsx';
import { useProject } from '../../lib/doc.js';
import { appById } from '../../lib/apps.js';
import { keyLabel } from '../../lib/shortcuts.js';
import { useVectorEditor } from '../_vector/editor.js';
import Viewport from '../_vector/Viewport.jsx';
import { ToolStrip, PropertiesPanel, LayersPanel, SwatchesPanel, AlignPanel, SymbolsPanel, ArtboardsPanel, nodeLabel } from '../_vector/panels.jsx';
import { useGetData, useClipboard, useVectorShortcuts, editItems, objectMenu, viewMenu, placeItems, PanelTabs, OptionsBar, StatusBar, useCanvasDrop } from '../_vector/common.jsx';
import { exportFormats, renderExport } from '../_vector/export.js';
import { solid, strokeOf, artboardsOf, find, findNode, bounds, boundsOf, uid, walk, removeIds, insertInto, transformNode, cloneNode, make, normalizeDoc } from '../_vector/model.js';
import { translate, I } from '../_vector/geom.js';
import Preview, { TRIGGERS, ACTIONS, TRANSITIONS, EASINGS } from './Preview.jsx';

const TOOLS = [
  { id: 'select', icon: 'select', label: 'Select', key: 'v' },
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'e' },
  { id: 'polygon', icon: 'polygon', label: 'Polygon', key: 'y' },
  { id: 'line', icon: 'line', label: 'Line', key: 'l' },
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
  { id: 'text', icon: 'text', label: 'Text', key: 't' },
  { id: 'artboard', icon: 'artboard', label: 'Artboard', key: 'a' },
  'divider',
  { id: 'direct', icon: 'directSelect', label: 'Edit anchors' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'i' },
  { id: 'hand', icon: 'hand', label: 'Hand', key: 'h' },
  { id: 'zoom', icon: 'zoom', label: 'Zoom', key: 'z' },
];

export default function ProtoApp({ id }) {
  const preview = new URLSearchParams(location.search).get('preview');
  return preview ? <SharedPreview id={id} /> : <ProtoEditor id={id} />;
}

/** /proto/<id>?preview=1 — the player on its own, for anyone the project is shared with. */
function SharedPreview({ id }) {
  const project = useProject(id);
  const nav = useNavigate();
  const doc = useMemo(() => (project.doc && project.data !== undefined ? normalizeDoc(project.data, { app: 'proto', width: project.doc.width, height: project.doc.height }) : null), [project.doc, project.data]);
  if (project.error) return <div className="h-full grid place-items-center text-fg2">Couldn’t open this prototype{project.error.status === 404 ? ' — it isn’t shared with you.' : '.'}</div>;
  if (!doc) return <div className="h-full grid place-items-center"><Spinner size={28} /></div>;
  return <Preview doc={doc} title={project.doc.name} onClose={() => nav(project.canComment ? `/proto/${id}` : '/')} />;
}

function ProtoEditor({ id }) {
  const project = useProject(id);
  const ed = useVectorEditor(project, 'proto', { defaultStyle: { fill: solid('#e6e6e6'), stroke: strokeOf('#707070', 1), font: { family: 'Inter', size: 20 } } });
  const [mode, setMode] = useState('design');
  const [playing, setPlaying] = useState(null);
  const getData = useGetData(ed);
  useClipboard(ed);
  const play = (start) => setPlaying({ start: start || ed.get()?.home });
  useVectorShortcuts(ed, {
    tools: mode === 'design' ? Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key, t.id])) : { h: 'hand', z: 'zoom' },
    extra: {
      'mod+d': () => ed.duplicate(), 'mod+k': () => makeComponent(), 'mod+r': () => makeRepeatGrid(),
      'mod+l': () => ed.setFlag('locked', true), 'mod+;': () => ed.setFlag('hidden', true),
      'mod+enter': () => play(ed.activeAb), 'mod+tab': () => setMode((m) => (m === 'design' ? 'prototype' : 'design')),
    },
  });
  const drop = useCanvasDrop(ed);

  const makeComponent = async () => {
    if (!ed.sel.length || ed.readOnly) return;
    const n = (ed.doc.symbols.length || 0) + 1;
    await ed.makeSymbol(`Component ${n}`);
  };
  /** Turns the selection into a repeat grid (3 copies across to start; change rows/columns in Properties). */
  const makeRepeatGrid = () => {
    if (!ed.selNodes.length || ed.readOnly) return;
    const d = ed.get();
    const b = boundsOf(ed.selNodes, d);
    const cell = { w: b.w, h: b.h, children: ed.selNodes.map((x) => transformNode(cloneNode(x), translate(-b.x, -b.y))) };
    const rg = { id: uid(), type: 'repeat', name: 'Repeat grid', t: translate(b.x, b.y), cell, cols: 3, rows: 1, gx: 20, gy: 20, opacity: 1, blend: 'normal', effects: [], texts: {} };
    const f = find(ed.root, ed.sel[ed.sel.length - 1]);
    ed.change((r) => insertInto(removeIds(r, ed.sel), f.parent?.id || null, [rg]), 'Repeat Grid');
    ed.setSel([rg.id]);
  };
  const ungroupGrid = (rg) => {
    const groups = [];
    for (let r = 0; r < rg.rows; r++) for (let c = 0; c < rg.cols; c++) {
      const k = r * rg.cols + c;
      const kids = rg.cell.children.map((x) => {
        let y = transformNode(cloneNode(x), translate(c * (rg.cell.w + rg.gx), r * (rg.cell.h + rg.gy)));
        y = transformNode(y, rg.t);
        return y;
      });
      groups.push(make.group(kids, { name: `Cell ${k + 1}` }));
    }
    ed.updateNode(rg.id, () => make.group(groups, { name: 'Grid' }), 'Ungroup Grid');
  };

  /** A wire dropped on a screen: one interaction per object and trigger. */
  const onWire = (from, dest) => {
    if (from === dest) return;
    const isAb = artboardsOf(ed.get()).some((a) => a.id === from);
    const trigger = isAb ? 'time' : 'tap';
    ed.changeDoc((d) => {
      const others = (d.interactions || []).filter((i) => !(i.from === from && i.trigger === trigger));
      const old = (d.interactions || []).find((i) => i.from === from && i.trigger === trigger);
      return { ...d, interactions: [...others, { id: old?.id || uid(), from, trigger, delay: 1, action: 'navigate', dest, transition: old?.transition || 'dissolve', duration: old?.duration ?? 0.3, easing: old?.easing || 'ease-out' }] };
    }, 'Add Interaction');
  };

  // Wires (prototype mode): from each source's right edge to the destination screen.
  const wireOverlay = ({ S, z }) => {
    const d = ed.doc;
    if (!d || ed.scope) return null;
    const abs = artboardsOf(d);
    const srcBox = (fid) => { const ab = abs.find((a) => a.id === fid); if (ab) return ab; const f = find(d.children, fid); return f ? bounds(f.node, d) : null; };
    const home = abs.find((a) => a.id === d.home);
    const out = [];
    if (home) { const p = S({ x: home.x, y: home.y }); out.push(<g key="home" transform={`translate(${p.x - 18} ${p.y - 22})`} pointerEvents="none"><rect width={16} height={16} rx={3} fill="#3b8cff" /><path d="M3 9l5-5 5 5M5 8v5h6V8" stroke="#fff" strokeWidth={1.4} fill="none" /></g>); }
    if (mode !== 'prototype') return out;
    for (const i of d.interactions || []) {
      const b = srcBox(i.from); const dest = abs.find((a) => a.id === i.dest);
      if (!b || !dest || !['navigate', 'overlay'].includes(i.action)) continue;
      const a = S({ x: b.x + b.w, y: b.y + b.h / 2 }); const t = S({ x: dest.x, y: dest.y + Math.min(dest.h, 200 / z) / 2 });
      const selected = ed.sel.includes(i.from) || (!ed.sel.length && ed.activeAb === i.from);
      const dx = Math.max(40, Math.abs(t.x - a.x) / 2);
      out.push(<g key={i.id} pointerEvents="none" opacity={selected ? 1 : 0.45}>
        <path d={`M${a.x} ${a.y}C${a.x + dx} ${a.y} ${t.x - dx} ${t.y} ${t.x - 8} ${t.y}`} fill="none" stroke="#3b8cff" strokeWidth={selected ? 2.5 : 1.5} />
        <path d={`M${t.x - 9} ${t.y - 5}L${t.x} ${t.y}L${t.x - 9} ${t.y + 5}Z`} fill="#3b8cff" />
        <circle cx={a.x} cy={a.y} r={3.5} fill="#3b8cff" />
      </g>);
    }
    // The handle to drag a new wire from the selection (or the selected screen, for time triggers).
    const srcId = ed.sel[0] || ed.activeAb;
    const b = srcId && srcBox(srcId);
    if (b && !ed.readOnly) {
      const p = S({ x: b.x + b.w, y: b.y + b.h / 2 });
      const o = S({ x: b.x, y: b.y });
      out.push(<rect key="srcbox" x={o.x} y={o.y} width={b.w * z} height={b.h * z} fill="none" stroke="#3b8cff" strokeWidth={1.5} pointerEvents="none" />);
      out.push(<g key="wh"><circle data-wire={srcId} cx={p.x + 12} cy={p.y} r={10} fill="#3b8cff" stroke="#fff" strokeWidth={2} style={{ cursor: 'crosshair' }} /><path d={`M${p.x + 8} ${p.y - 4}l5 4-5 4`} stroke="#fff" strokeWidth={2} fill="none" pointerEvents="none" /></g>);
    }
    return out;
  };

  const exportConfig = useMemo(() => (ed.doc ? { formats: exportFormats(ed.doc, { pdf: false, label: 'Artboard', current: ed.activeAb }), render: (fid, o, { onProgress }) => renderExport(ed.get(), fid, o, onProgress) } : undefined), [ed.doc, ed.activeAb]); // eslint-disable-line react-hooks/exhaustive-deps
  const shareLink = () => {
    const url = `${location.origin}/proto/${id}?preview=1`;
    navigator.clipboard?.writeText(url).catch(() => {});
    toast('Preview link copied — share the project so others can open it', { action: { label: 'Share…', onClick: () => shareDialog(project.doc) } });
  };

  const toolbarExtra = (
    <div className="flex items-center gap-1 mr-1">
      <Segmented value={mode} onChange={(m) => { setMode(m); if (m === 'prototype') ed.setTool('select'); }} options={[{ value: 'design', label: 'Design' }, { value: 'prototype', label: 'Prototype' }]} />
      <IconButton icon="play" label={`Preview (${keyLabel('mod+enter')})`} size={30} onClick={() => play(ed.activeAb)} />
      <IconButton icon="link" label="Copy preview link" size={30} onClick={shareLink} />
    </div>
  );

  const artboardExtra = (ab) => (
    <>
      <PanelSection title="Screen" id="p-screen">
        <div className="flex flex-col gap-2">
          <Select small value="" onChange={(v) => { const p = appById('proto').presets[Number(v)]; if (p) ed.updateArtboard(ab.id, { w: p.width, h: Math.max(ab.h, p.height), viewportH: p.height }, 'Device'); }}
            options={[{ value: '', label: 'Device preset…' }, ...appById('proto').presets.map((p, i) => ({ value: String(i), label: `${p.label} ${p.width}×${p.height}` }))]} disabled={ed.readOnly} />
          <NumberInput label="Viewport height" value={ab.viewportH || ab.h} min={1} width={64} onChange={(v) => ed.updateArtboard(ab.id, { viewportH: v }, 'Viewport', { merge: `vh-${ab.id}` })} onCommit={() => ed.h.commit()} disabled={ed.readOnly} />
          <p className="text-[11px] text-fg3">Make the artboard taller than the viewport to scroll in the preview.</p>
          <Button size="xs" variant={ed.doc.home === ab.id ? 'primary' : 'outline'} icon="home" disabled={ed.readOnly || ed.doc.home === ab.id} onClick={() => ed.changeDoc((d) => ({ ...d, home: ab.id }), 'Set Home')}>{ed.doc.home === ab.id ? 'Home screen' : 'Set as home screen'}</Button>
        </div>
      </PanelSection>
      <PanelSection title="Layout grid" id="p-layout">
        <div className="flex flex-col gap-2">
          <Toggle checked={!!ab.layout?.on} label="Columns" onChange={(on) => ed.updateArtboard(ab.id, { layout: { cols: 4, gutter: 16, margin: 16, ...(ab.layout || {}), on } }, 'Layout Grid')} />
          {ab.layout?.on && <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="Columns" value={ab.layout.cols} min={1} max={24} width={44} onChange={(v) => ed.updateArtboard(ab.id, { layout: { ...ab.layout, cols: v } }, 'Layout Grid', { merge: `lg-${ab.id}` })} onCommit={() => ed.h.commit()} />
            <NumberInput label="Gutter" value={ab.layout.gutter} min={0} width={44} onChange={(v) => ed.updateArtboard(ab.id, { layout: { ...ab.layout, gutter: v } }, 'Layout Grid', { merge: `lg-${ab.id}` })} onCommit={() => ed.h.commit()} />
            <NumberInput label="Margin" value={ab.layout.margin} min={0} width={44} onChange={(v) => ed.updateArtboard(ab.id, { layout: { ...ab.layout, margin: v } }, 'Layout Grid', { merge: `lg-${ab.id}` })} onCommit={() => ed.h.commit()} />
            <ColorSwatch value={ab.layout.color || '#ff3c5a1f'} size={22} onChange={(c) => ed.updateArtboard(ab.id, { layout: { ...ab.layout, color: c } }, 'Layout Grid', { merge: `lg-${ab.id}` })} onCommit={() => ed.h.commit()} />
          </div>}
        </div>
      </PanelSection>
    </>
  );
  const nodeExtra = (single) => (single?.type === 'repeat' ? <div className="px-3 pb-2 -mt-1 border-b border-line"><Button size="xs" variant="ghost" onClick={() => ungroupGrid(single)}>Ungroup grid</Button></div> : null);

  const panels = mode === 'prototype'
    ? <InteractionPanel ed={ed} onPlay={play} />
    : (
      <PanelTabs id="proto" tabs={[
        { id: 'props', label: 'Properties', render: () => <><PropertiesPanel ed={ed} artboardExtra={artboardExtra} nodeExtra={nodeExtra} labels={{ symbol: 'Component', artboard: 'Artboard' }} /><PanelSection title="Align" id="p-align"><AlignPanel ed={ed} /></PanelSection></> },
        { id: 'layers', label: 'Layers', render: () => <LayersPanel ed={ed} /> },
        { id: 'assets', label: 'Assets', render: () => <><PanelSection title="Components" id="p-comps"><SymbolsPanel ed={ed} label="Component" /></PanelSection><PanelSection title="Colours" id="p-colors"><SwatchesPanel ed={ed} /></PanelSection><PanelSection title="Screens" id="p-screens"><ArtboardsPanel ed={ed} label="Artboard" /></PanelSection></> },
      ]} />
    );

  return (
    <>
      <EditorShell app="proto" project={project} history={ed.h} getData={getData}
        menus={[objectMenu(ed, { symbolsLabel: 'Component', compKey: 'mod+k' }), { label: 'Prototype', items: () => [
          { label: 'Design mode', checked: mode === 'design', onClick: () => setMode('design') },
          { label: 'Prototype mode', checked: mode === 'prototype', shortcut: keyLabel('mod+tab'), onClick: () => setMode('prototype') },
          { divider: true },
          { label: 'Preview from this screen', icon: 'play', shortcut: keyLabel('mod+enter'), onClick: () => play(ed.activeAb) },
          { label: 'Preview from home', onClick: () => play() },
          { label: 'Open shareable preview', icon: 'external', onClick: () => window.open(`/proto/${id}?preview=1`, '_blank') },
          { label: 'Copy preview link', icon: 'link', onClick: shareLink },
          { divider: true },
          { label: 'Make component', icon: 'component', shortcut: keyLabel('mod+k'), disabled: !ed.sel.length || ed.readOnly, onClick: makeComponent },
          { label: 'Repeat grid', icon: 'grid', shortcut: keyLabel('mod+r'), disabled: !ed.sel.length || ed.readOnly, onClick: makeRepeatGrid },
          { label: 'Add screen', icon: 'plus', disabled: ed.readOnly, onClick: () => ed.addArtboard() },
        ] }, viewMenu(ed)]}
        fileItems={placeItems(ed)} editItems={editItems(ed, { dupKey: 'mod+d' })}
        exportConfig={exportConfig} toolbarExtra={toolbarExtra}
        tools={mode === 'design' ? <ToolStrip ed={ed} tools={TOOLS} /> : <div className="text-[10px] text-fg3 text-center px-1 pt-2 leading-tight"><Icon name="prototype" size={20} className="mx-auto mb-1 text-accent" />Drag the blue handle to a screen</div>}
        options={<OptionsBar ed={ed}>{mode === 'prototype' && <span className="text-[12px] text-accent">Prototype mode — select an object or screen, then drag its handle onto a screen</span>}</OptionsBar>}
        panels={panels} panelWidth={290}
        status={<StatusBar ed={ed} hint={mode === 'prototype' ? `${(ed.doc?.interactions || []).length} interactions` : ''} />}
        commentAnchor={() => ed.viewportRef.current?.center()} anchorLabel={() => 'this spot'}
        onJumpToComment={(a) => ed.viewportRef.current?.fitRect({ x: a.x - 300, y: a.y - 300, w: 600, h: 600 })}>
        <div className="absolute inset-0" {...drop}>
          {ed.doc && <Viewport ed={ed} mode={mode} overlay={wireOverlay} onWire={onWire} />}
          {ed.scope && <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 h-8 rounded-full bg-panel border border-line text-[12px] flex items-center gap-2 shadow-lg">Editing main component <b>{ed.doc.symbols.find((s) => s.id === ed.scope)?.name}</b><button type="button" className="text-accent hover:underline" onClick={ed.exitSymbol}>Done</button></div>}
        </div>
      </EditorShell>
      {playing && ed.doc && <Preview doc={ed.doc} start={playing.start} title={project.doc?.name} onClose={() => setPlaying(null)} />}
    </>
  );
}

function InteractionPanel({ ed, onPlay }) {
  const d = ed.doc;
  if (!d) return null;
  const abs = artboardsOf(d);
  const srcId = ed.sel[0] || ed.activeAb;
  const src = abs.find((a) => a.id === srcId) || findNode(d.children, srcId);
  const list = (d.interactions || []).filter((i) => i.from === srcId);
  const ro = ed.readOnly;
  const set = (iid, patch, merge) => ed.changeDoc((dd) => ({ ...dd, interactions: dd.interactions.map((i) => (i.id === iid ? { ...i, ...patch } : i)) }), 'Interaction', merge ? { merge: `int-${iid}` } : undefined);
  const scrollTargets = [];
  const ab = abs.find((a) => a.id === srcId) || find(d.children, srcId)?.chain.find((n) => n.type === 'artboard');
  if (ab) walk(ab.children, (n) => { scrollTargets.push(n); return n.type !== 'group'; });
  return (
    <div>
      <PanelSection title="Interaction" id="p-int">
        {!src ? <p className="text-xs text-fg3">Select an object or a screen.</p> : (
          <div className="flex flex-col gap-3">
            <div className="text-sm flex items-center gap-2"><Icon name={src.type === 'artboard' ? 'artboard' : 'select'} size={14} className="text-accent" />{src.type === 'artboard' ? src.name : nodeLabel(src)}</div>
            {!list.length && <p className="text-xs text-fg3">No interactions yet. Drag the blue handle onto a screen, or add one here.</p>}
            {list.map((i) => (
              <div key={i.id} className="rounded-lg border border-line p-2.5 flex flex-col gap-2 bg-panel-2/50" data-interaction={i.id}>
                <Row label="Trigger"><Select small value={i.trigger} onChange={(v) => set(i.id, { trigger: v })} options={TRIGGERS} disabled={ro} /></Row>
                {i.trigger === 'time' && <Row label="Delay"><NumberInput value={i.delay ?? 1} min={0} max={60} step={0.1} unit="s" width={60} onChange={(v) => set(i.id, { delay: v }, true)} onCommit={() => ed.h.commit()} disabled={ro} /></Row>}
                <Row label="Action"><Select small value={i.action} onChange={(v) => set(i.id, { action: v })} options={ACTIONS} disabled={ro} /></Row>
                {(i.action === 'navigate' || i.action === 'overlay') && <Row label="Destination"><Select small value={i.dest || ''} onChange={(v) => set(i.id, { dest: v })} options={[{ value: '', label: 'Choose…' }, ...abs.filter((a) => a.id !== srcId).map((a) => ({ value: a.id, label: a.name }))]} disabled={ro} /></Row>}
                {i.action === 'scroll' && <Row label="Scroll to"><Select small value={i.target || ''} onChange={(v) => set(i.id, { target: v })} options={[{ value: '', label: 'Choose…' }, ...scrollTargets.map((n) => ({ value: n.id, label: nodeLabel(n) }))]} disabled={ro} /></Row>}
                {i.action !== 'back' && <Row label="Animation"><Select small value={i.transition || 'dissolve'} onChange={(v) => set(i.id, { transition: v })} options={TRANSITIONS} disabled={ro} /></Row>}
                {i.action !== 'back' && i.transition !== 'none' && (
                  <>
                    <Row label="Easing"><Select small value={i.easing || 'ease-out'} onChange={(v) => set(i.id, { easing: v })} options={EASINGS} disabled={ro} /></Row>
                    <Row label="Duration"><NumberInput value={i.duration ?? 0.3} min={0} max={10} step={0.1} unit="s" width={60} onChange={(v) => set(i.id, { duration: v }, true)} onCommit={() => ed.h.commit()} disabled={ro} /></Row>
                  </>
                )}
                {!ro && <Button size="xs" variant="ghost" icon="trash" className="self-start" onClick={() => ed.changeDoc((dd) => ({ ...dd, interactions: dd.interactions.filter((x) => x.id !== i.id) }), 'Delete Interaction')}>Remove</Button>}
              </div>
            ))}
            {!ro && <Button size="xs" icon="plus" className="self-start" onClick={() => ed.changeDoc((dd) => ({ ...dd, interactions: [...(dd.interactions || []), { id: uid(), from: srcId, trigger: src.type === 'artboard' ? 'time' : 'tap', delay: 1, action: 'navigate', dest: abs.find((a) => a.id !== srcId)?.id || '', transition: 'dissolve', duration: 0.3, easing: 'ease-out' }] }), 'Add Interaction')}>Add interaction</Button>}
          </div>
        )}
      </PanelSection>
      <PanelSection title="Home screen" id="p-home">
        <Select small value={d.home || ''} onChange={(v) => ed.changeDoc((dd) => ({ ...dd, home: v }), 'Set Home')} options={abs.map((a) => ({ value: a.id, label: a.name }))} disabled={ro} />
        <Button size="sm" variant="primary" icon="play" className="mt-2" onClick={() => onPlay()}>Preview from home</Button>
      </PanelSection>
    </div>
  );
}
const Row = ({ label, children }) => <div className="flex items-center gap-2"><span className="text-xs text-fg2 w-20 shrink-0">{label}</span><div className="flex-1 min-w-0 [&_select]:w-full">{children}</div></div>;
void openMenu; void promptDialog; void I; void SwatchesPanel;
