// Paint (Sora Paint) — a Fresco-style painting app on the shared raster engine: pressure/tilt brushes in ten
// families, smoothing, symmetry, a colour wheel, pixel layers, a rotatable/flippable view with touch gestures
// (pinch, rotate, two-finger tap = undo, three-finger tap = redo), and an optional time-lapse recording.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import EditorShell from '../../components/EditorShell.jsx';
import { PanelSection, Spinner, Select, Popover, Button, toast, toastError, openMenu } from '../../components/ui.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, useKeyHeld, keyLabel } from '../../lib/shortcuts.js';
import { download } from '../../lib/api.js';
import { Renderer } from '../_raster/render.js';
import { newBitmap, findLayer, flatten, removeLayers, insertLayers, cloneLayer, uniqueName, updateLayer } from '../_raster/model.js';
import { selAll, invert as invertSel } from '../_raster/selection.js';
import { clearPixels, mergeDown, resizeImage, resizeCanvas, rotateDoc, flipDoc, copyPixels, bitmapFrom } from '../_raster/ops.js';
import { openDocument, toSaved, imageLayer } from '../_raster/io.js';
import { exportImage } from '../_raster/export.js';
import Viewport, { stepZoom } from '../_raster/Viewport.jsx';
import LayersPanel from '../_raster/LayersPanel.jsx';
import { Icon, IBtn } from '../_raster/icons.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { ImageSizeDialog, CanvasSizeDialog } from '../photo/dialogs.jsx';
import { FAMILIES, familyById, loadBrushes, saveBrushes } from './brushes.js';
import { makePaintTools, rotateViewTool } from './tools.js';
import { ColorWheel, BrushSettings, SideSliders } from './widgets.jsx';
import { TimeLapse } from './timelapse.js';

const PAPER = '#f6f1e6';

export default function PaintEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null, { limit: 80 });
  const renderer = useMemo(() => new Renderer(), []);
  const [ready, setReady] = useState(false);
  const readOnly = !project.canEdit;
  const doc = h.state;

  const [activeId, setActive] = useState(null);
  const [tool, setTool] = useState('brush');
  const [family, setFamily] = useState('ink');
  const [brushes, setBrushes] = useState(loadBrushes);
  const [fg, setFg] = useState('#23324a');
  const [view, setView] = useState({ zoom: 0, cx: 0, cy: 0, rot: 0, flip: false });
  const [symmetry, setSymmetry] = useState({ mode: 'off', n: 6 });
  const [fillOpts, setFillOpts] = useState({ tolerance: 24, merged: true });
  const [recording, setRecording] = useState(false);
  const [frames, setFrames] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [colorPop, setColorPop] = useState(null);
  const [rHeld, setRHeld] = useState(false);
  const vp = useRef(null);
  const spaceHeld = useKeyHeld('space');
  const lapse = useRef(new TimeLapse()).current;

  // ---------------------------------------------------------------- open
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    openDocument(project, { background: PAPER, backgroundName: 'Paper', defaultSize: [2048, 2048], onMissing: (l) => toast(`Couldn’t load the pixels of “${l.name}”`, { type: 'error' }) })
      .then(({ doc: d, fresh }) => {
        if (off) return;
        // new paintings get an empty layer above the paper, ready to paint on
        if (fresh && d.layers.length === 1) d = { ...d, layers: [...d.layers, newBitmap('Layer 1')] };
        h.reset(d);
        setActive(d.layers[d.layers.length - 1]?.id || null);
        setReady(true);
      }).catch((e) => toastError(e, 'Couldn’t open this painting'));
    return () => { off = true; };
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { if (doc) renderer.setDoc(doc); }, [doc, renderer]);
  useEffect(() => saveBrushes(brushes), [brushes]);
  useEffect(() => {
    if (!doc) return;
    if (!activeId || !findLayer(doc.layers, activeId)) { const all = flatten(doc.layers); setActive(all[all.length - 1]?.id || null); }
  }, [doc, activeId]);

  const commit = useCallback((d, label, o) => {
    if (readOnly) return;
    h.set(d, label, o);
    if (recording) setTimeout(() => { renderer.flush(); lapse.capture(renderer.canvas); setFrames((n) => n + 1); }, 60);
  }, [h, readOnly, recording, renderer, lapse]);
  const brush = brushes[family];
  const setBrush = (patch) => setBrushes((b) => ({ ...b, [family]: { ...b[family], ...patch } }));

  // ---------------------------------------------------------------- tool context
  const ed = useRef({}).current;
  Object.assign(ed, {
    get doc() { return h.get(); },
    commit, renderer, readOnly, fg, setFg,
    get vp() { return vp.current; },
    layer: () => (ed.activeId ? findLayer(h.get().layers, ed.activeId) : null),
    activeId,
    brush: () => brushes[family], family: () => family,
    symmetry: () => ({ ...symmetry, cx: h.get().width / 2, cy: h.get().height / 2 }),
    fillOpts: () => fillOpts,
    toast: (m, o) => toast(m, o),
    view: () => view, setView,
  });
  const tools = useMemo(() => makePaintTools(ed), [ed]);
  const rotTool = useMemo(() => rotateViewTool(ed), [ed]);
  const curTool = rHeld ? rotTool : tools[tool];

  // hold R to rotate the view; a quick tap straightens it
  useEffect(() => {
    const down = (e) => { if (e.key.toLowerCase() === 'r' && !e.repeat && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { ed.rotated = false; setRHeld(true); } };
    const up = (e) => { if (e.key.toLowerCase() === 'r') { setRHeld(false); if (!ed.rotated) setView((v) => ({ ...v, rot: 0 })); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [ed]);

  const pickBrush = (fid) => { setFamily(fid); setTool('brush'); };

  // ---------------------------------------------------------------- layer actions
  const active = doc && activeId ? findLayer(doc.layers, activeId) : null;
  const placeAbove = (d, l, label) => { commit({ ...d, layers: insertLayers(d.layers, l, active ? { above: active.id } : null) }, label); setActive(l.id); };
  const newLayer = () => placeAbove(doc, newBitmap(uniqueName(doc.layers, 'Layer')), 'New Layer');
  const deleteLayer = () => {
    if (!active) return;
    if (flatten(doc.layers).length <= 1) { toast('A painting needs at least one layer'); return; }
    const all = flatten(doc.layers); const i = all.findIndex((l) => l.id === active.id);
    commit({ ...doc, layers: removeLayers(doc.layers, [active.id]) }, 'Delete Layer');
    setActive(all[i - 1]?.id || all[i + 1]?.id || null);
  };
  const clearLayer = () => { if (active?.type === 'bitmap' && !active.locked) commit(clearPixels(doc, active, 'pix', doc.sel), doc.sel ? 'Clear Selection' : 'Clear Layer'); };
  const duplicate = () => active && placeAbove(doc, cloneLayer(active), 'Duplicate Layer');
  const importImage = async () => {
    const assets = await pickAssets({ kinds: ['image'], docId: id, title: 'Import images' });
    if (!assets?.length) return;
    let d = h.get(); let last = active;
    for (const a of assets) {
      try { const { layer } = await imageLayer(a, d.width, d.height); d = { ...d, layers: insertLayers(d.layers, layer, last ? { above: last.id } : null) }; last = layer; }
      catch (e) { toastError(e); }
    }
    commit(d, 'Import Image'); if (last) setActive(last.id);
  };

  // ---------------------------------------------------------------- save, export
  const getData = useCallback(async () => {
    const d = h.get(); if (!d) return null;
    const data = await toSaved(d, id);
    renderer.flush();
    return { data, thumb: renderer.canvas, width: d.width, height: d.height };
  }, [h, id, renderer]);
  const exportConfig = useMemo(() => ({
    formats: [
      { id: 'png', label: 'PNG', ext: 'png', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[0.5, '50%'], [1, '100%'], [2, '200%']] }] },
      { id: 'jpeg', label: 'JPEG', ext: 'jpg', kind: 'image', options: [{ key: 'quality', label: 'Quality', type: 'range', default: 92, min: 10, max: 100, unit: '%' }, { key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[0.5, '50%'], [1, '100%'], [2, '200%']] }] },
      { id: 'timelapse', label: 'Time-lapse video (WebM)', ext: 'webm', kind: 'video', options: [{ key: 'fps', label: 'Speed', type: 'select', default: 12, choices: [[6, 'Slow (6 strokes/s)'], [12, 'Normal (12/s)'], [24, 'Fast (24/s)']] }],
        note: 'Made from the strokes recorded while “Record time-lapse” was on in this session.' },
    ],
    render: async (fmt, o, { onProgress }) => {
      if (fmt === 'timelapse') return lapse.toWebm({ fps: o.fps || 12, onProgress });
      return exportImage(renderer, h.get(), fmt, { scale: o.scale || 1, quality: (o.quality || 92) / 100 });
    },
  }), [h, renderer, lapse]);

  // ---------------------------------------------------------------- shortcuts
  const sizeStep = (dir) => setBrush({ size: Math.max(1, Math.min(800, Math.round(dir > 0 ? brush.size * 1.15 + 1 : brush.size / 1.15 - 0.5))) });
  const can = !readOnly && !!doc;
  useShortcuts({
    b: () => { if (family === 'eraser' || family === 'smudge') setFamily('ink'); setTool('brush'); }, e: () => pickBrush('eraser'), s: () => pickBrush('smudge'),
    g: () => setTool('fill'), l: () => setTool('lassoFill'), m: () => setTool('select'), i: () => setTool('eyedropper'), h: () => setTool('hand'),
    '[': () => sizeStep(-1), ']': () => sizeStep(1),
    'shift+mod+n': () => can && newLayer(), 'mod+j': () => can && duplicate(), 'mod+e': () => can && active && commit(mergeDown(renderer, doc, active.id), 'Merge Down'),
    'mod+d': () => can && doc.sel && commit({ ...doc, sel: null }, 'Deselect'), 'mod+a': () => can && commit({ ...doc, sel: selAll(doc) }, 'Select All'),
    'shift+mod+i': () => can && commit({ ...doc, sel: invertSel(doc.sel, doc) }, 'Inverse'),
    delete: () => can && clearLayer(), backspace: () => can && clearLayer(),
    'mod+0': () => vp.current?.fit(), 'mod+1': () => vp.current?.actual(), 'mod+=': () => vp.current?.zoomAt((z) => stepZoom(z, 1)), 'mod+plus': () => vp.current?.zoomAt((z) => stepZoom(z, 1)), 'mod+-': () => vp.current?.zoomAt((z) => stepZoom(z, -1)),
    'shift+h': () => setView((v) => ({ ...v, flip: !v.flip })),
  }, [family, brush, doc, active, can], { enabled: ready && !dialog });
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') curTool?.cancel?.(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [curTool]);

  if (!ready || !doc) {
    return <EditorShell app="paint" project={project} history={h}><div className="h-full grid place-items-center text-fg2 text-sm"><div className="flex items-center gap-2"><Spinner />Opening…</div></div></EditorShell>;
  }

  const menus = [
    { label: 'Layer', items: () => [
      { label: 'New Layer', shortcut: keyLabel('shift+mod+n'), disabled: !can, onClick: newLayer },
      { label: 'Duplicate Layer', shortcut: keyLabel('mod+j'), disabled: !can || !active, onClick: duplicate },
      { label: 'Delete Layer', disabled: !can || !active, onClick: deleteLayer },
      { label: 'Merge Down', shortcut: keyLabel('mod+e'), disabled: !can || !active, onClick: () => commit(mergeDown(renderer, doc, active.id), 'Merge Down') },
      { divider: true },
      { label: doc.sel ? 'Clear Selection' : 'Clear Layer', shortcut: keyLabel('delete'), disabled: !can || active?.type !== 'bitmap', onClick: clearLayer },
      { label: 'Lock Transparency', checked: !!active?.lockAlpha, disabled: !can || !active, onClick: () => commit(updateLayer(doc, active.id, { lockAlpha: !active.lockAlpha }), 'Lock Transparency') },
      { label: 'Clip to Layer Below', checked: !!active?.clip, disabled: !can || !active, onClick: () => commit(updateLayer(doc, active.id, { clip: !active.clip }), 'Clipping') },
      { divider: true },
      { label: 'Import Image…', icon: 'image', disabled: !can, onClick: importImage },
    ] },
    { label: 'Select', items: () => [
      { label: 'All', shortcut: keyLabel('mod+a'), disabled: !can, onClick: () => commit({ ...doc, sel: selAll(doc) }, 'Select All') },
      { label: 'Deselect', shortcut: keyLabel('mod+d'), disabled: !can || !doc.sel, onClick: () => commit({ ...doc, sel: null }, 'Deselect') },
      { label: 'Inverse', shortcut: keyLabel('shift+mod+i'), disabled: !can, onClick: () => commit({ ...doc, sel: invertSel(doc.sel, doc) }, 'Inverse') },
      { label: 'Selection to New Layer', disabled: !can || !doc.sel || active?.type !== 'bitmap', onClick: () => { const cp = copyPixels(renderer, doc, active, doc.sel); if (cp) placeAbove(doc, bitmapFrom(cp.canvas, cp.x, cp.y, uniqueName(doc.layers, 'Layer')), 'Copy to Layer'); } },
    ] },
    { label: 'Canvas', items: () => [
      { label: 'Image Size…', disabled: !can, onClick: () => setDialog('imageSize') },
      { label: 'Canvas Size…', disabled: !can, onClick: () => setDialog('canvasSize') },
      { divider: true },
      { label: 'Rotate Canvas 90° Clockwise', disabled: !can, onClick: () => { commit(rotateDoc(renderer, doc, 90), 'Rotate Canvas'); setTimeout(() => vp.current?.fit(), 0); } },
      { label: 'Rotate Canvas 90° Counter Clockwise', disabled: !can, onClick: () => { commit(rotateDoc(renderer, doc, -90), 'Rotate Canvas'); setTimeout(() => vp.current?.fit(), 0); } },
      { label: 'Flip Canvas Horizontal', disabled: !can, onClick: () => commit(flipDoc(renderer, doc, 'h'), 'Flip Canvas') },
      { label: 'Flip Canvas Vertical', disabled: !can, onClick: () => commit(flipDoc(renderer, doc, 'v'), 'Flip Canvas') },
    ] },
    { label: 'View', items: () => [
      { label: 'Fit to Screen', shortcut: keyLabel('mod+0'), onClick: () => vp.current?.fit() },
      { label: '100%', shortcut: keyLabel('mod+1'), onClick: () => vp.current?.actual() },
      { label: 'Rotate View Left', onClick: () => setView((v) => ({ ...v, rot: (v.rot || 0) - 15 })) },
      { label: 'Rotate View Right', onClick: () => setView((v) => ({ ...v, rot: (v.rot || 0) + 15 })) },
      { label: 'Reset Rotation (tap R)', onClick: () => setView((v) => ({ ...v, rot: 0 })) },
      { label: 'Flip View', shortcut: keyLabel('shift+h'), checked: view.flip, onClick: () => setView((v) => ({ ...v, flip: !v.flip })) },
    ] },
  ];

  const fam = familyById(family);
  const toolBtn = (tid, icon, label, key) => <IBtn key={tid} icon={icon} label={label} shortcut={key ? keyLabel(key) : undefined} active={tool === tid} size={34} iconSize={19} onClick={() => setTool(tid)} />;
  const options = readOnly ? <span className="text-xs text-fg2 px-2">View only — you can look, zoom and comment.</span> : (
    <>
      <span className="flex items-center gap-1.5 text-[13px] font-medium shrink-0"><Icon name={tool === 'brush' ? fam.icon : { fill: 'fill', lassoFill: 'lassoFill', select: 'lasso', eyedropper: 'eyedropper', hand: 'hand' }[tool]} size={16} />{tool === 'brush' ? fam.label : { fill: 'Fill', lassoFill: 'Lasso fill', select: 'Lasso select', eyedropper: 'Eyedropper', hand: 'Hand' }[tool]}</span>
      <span className="w-px h-5 bg-line mx-1" />
      {tool === 'brush' && <span className="text-[11.5px] text-fg3 shrink-0">Long-press or Alt to pick a colour · [ ] size</span>}
      {tool === 'fill' && (<><span className="text-[11.5px] text-fg2">Tolerance</span><input type="range" className="sl-range w-24" min={0} max={128} value={fillOpts.tolerance} onChange={(e) => setFillOpts({ ...fillOpts, tolerance: Number(e.target.value) })} /><span className="text-[11px] tabular-nums w-7">{fillOpts.tolerance}</span>
        <Select small value={fillOpts.merged ? 'all' : 'layer'} onChange={(v) => setFillOpts({ ...fillOpts, merged: v === 'all' })} options={[{ value: 'all', label: 'Sample all layers' }, { value: 'layer', label: 'Current layer' }]} /></>)}
      {tool === 'select' && <span className="text-[11.5px] text-fg3">Draw around an area; Shift adds, Alt subtracts. Painting stays inside it. {keyLabel('mod+d')} clears.</span>}
      {tool === 'lassoFill' && <span className="text-[11.5px] text-fg3">Draw a shape to fill it with the current colour.</span>}
      <span className="flex-1" />
      <span className="text-[11.5px] text-fg2 shrink-0">Symmetry</span>
      <Select small value={symmetry.mode} onChange={(v) => setSymmetry({ ...symmetry, mode: v })} options={[{ value: 'off', label: 'Off' }, { value: 'v', label: 'Vertical' }, { value: 'h', label: 'Horizontal' }, { value: 'quad', label: 'Quadrant' }, { value: 'radial', label: 'Radial' }]} />
      {symmetry.mode === 'radial' && <Select small value={String(symmetry.n)} onChange={(v) => setSymmetry({ ...symmetry, n: Number(v) })} options={[3, 4, 5, 6, 8, 10, 12].map((n) => ({ value: String(n), label: `${n} segments` }))} />}
      <span className="w-px h-5 bg-line mx-1" />
      <IBtn icon="rotate" size={28} label="Rotate view left" onClick={() => setView((v) => ({ ...v, rot: (v.rot || 0) - 15 }))} className="-scale-x-100" />
      <button type="button" title="Reset rotation (tap R)" onClick={() => setView((v) => ({ ...v, rot: 0 }))} className="h-7 px-1.5 rounded text-[11.5px] tabular-nums text-fg2 hover:bg-hover min-w-10">{Math.round(((view.rot % 360) + 540) % 360 - 180)}°</button>
      <IBtn icon="rotate" size={28} label="Rotate view right (hold R and drag)" onClick={() => setView((v) => ({ ...v, rot: (v.rot || 0) + 15 }))} />
      <IBtn icon="flipH" size={28} label={`Flip view (${keyLabel('shift+h')})`} active={view.flip} onClick={() => setView((v) => ({ ...v, flip: !v.flip }))} />
      <IBtn icon="fit" size={28} label={`Fit (${keyLabel('mod+0')})`} onClick={() => vp.current?.fit()} />
      <span className="w-px h-5 bg-line mx-1" />
      <button type="button" onClick={() => { if (!recording) { lapse.clear(); renderer.flush(); lapse.capture(renderer.canvas); setFrames(1); } setRecording(!recording); }}
        className={`h-7 px-2 rounded-md text-[12px] flex items-center gap-1.5 shrink-0 ${recording ? 'bg-danger/20 text-[#ffb3bb]' : 'text-fg2 hover:bg-hover'}`} title="Record a time-lapse of your strokes (export it as a video)">
        <span className={`w-2.5 h-2.5 rounded-full ${recording ? 'bg-danger animate-pulse' : 'bg-fg3'}`} />{recording ? `Recording · ${frames}` : 'Record time-lapse'}
      </button>
    </>
  );

  const toolStrip = readOnly ? <>{toolBtn('hand', 'hand', 'Hand')}</> : (
    <>
      {FAMILIES.filter((f) => f.id !== 'eraser' && f.id !== 'smudge').map((f) => (
        <IBtn key={f.id} icon={f.icon} label={f.label} active={tool === 'brush' && family === f.id} size={34} iconSize={19} onClick={() => pickBrush(f.id)} shortcut={f.id === 'ink' ? 'B' : undefined} />
      ))}
      <div className="w-6 h-px bg-line my-1 shrink-0" />
      <IBtn icon="eraser" label="Eraser" shortcut="E" active={tool === 'brush' && family === 'eraser'} size={34} iconSize={19} onClick={() => pickBrush('eraser')} />
      <IBtn icon="smudge" label="Smudge" shortcut="S" active={tool === 'brush' && family === 'smudge'} size={34} iconSize={19} onClick={() => pickBrush('smudge')} />
      {toolBtn('fill', 'fill', 'Fill', 'g')}
      {toolBtn('lassoFill', 'lassoFill', 'Lasso fill', 'l')}
      {toolBtn('select', 'lasso', 'Lasso select', 'm')}
      {toolBtn('eyedropper', 'eyedropper', 'Eyedropper', 'i')}
      {toolBtn('hand', 'hand', 'Hand (Space)', 'h')}
      <div className="flex-1" />
      <button type="button" aria-label="Colour" title="Colour" onClick={(e) => setColorPop(e.currentTarget)} className="w-8 h-8 my-2 rounded-full border-2 border-white/80 shadow shrink-0" style={{ background: fg }} />
    </>
  );

  return (
    <EditorShell app="paint" project={project} history={h} getData={readOnly ? undefined : getData} exportConfig={exportConfig} menus={menus} panelWidth={268}
      fileItems={[{ label: 'Import Image…', icon: 'image', disabled: !can, onClick: importImage }, { label: 'Quick Export as PNG', icon: 'download', onClick: async () => download(await exportImage(renderer, h.get(), 'png'), `${project.doc?.name || 'Painting'}.png`) }]}
      commentAnchor={() => { const c = vp.current?.hover(); const p = c ? vp.current.toDoc(c.sx, c.sy) : { x: doc.width / 2, y: doc.height / 2 }; return { x: Math.round(p.x), y: Math.round(p.y) }; }}
      anchorLabel={(a) => (a?.x !== undefined ? `${a.x}, ${a.y}` : '')}
      onJumpToComment={(a) => a?.x !== undefined && setView((v) => ({ ...v, cx: a.x, cy: a.y }))}
      tools={toolStrip} options={options}
      status={<><span>{Math.round(view.zoom * 100)}%</span>{view.rot % 360 ? <span>Rotated {Math.round(view.rot)}°</span> : null}{view.flip && <span>Flipped view</span>}<span>{doc.width} × {doc.height} px</span>{doc.sel && <span>Selection active</span>}<span>{active?.name}</span></>}
      panels={(
        <>
          <PanelSection id="pt-color" title="Colour">
            <ColorWheel value={fg} onChange={setFg} size={228} />
          </PanelSection>
          <PanelSection id="pt-layers" title="Layers">
            <div className="-mx-3 -mb-3">
              <LayersPanel doc={doc} activeId={activeId} onSelect={setActive} commit={commit} renderer={renderer} readOnly={readOnly} compact height={290}
                onNewLayer={newLayer} onDelete={deleteLayer} onDuplicate={duplicate}
                contextItems={(l) => [
                  { label: 'Duplicate', onClick: duplicate, disabled: readOnly }, { label: 'Merge Down', onClick: () => commit(mergeDown(renderer, doc, l.id), 'Merge Down'), disabled: readOnly },
                  { label: 'Clear', onClick: clearLayer, disabled: readOnly }, { label: 'Delete', onClick: deleteLayer, disabled: readOnly },
                ]} />
            </div>
          </PanelSection>
          {!readOnly && (
            <PanelSection id="pt-brush" title={`Brush — ${fam.label}`}>
              <BrushSettings fam={family} b={brush} set={setBrush} />
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setBrushes((b) => ({ ...b, [family]: { ...familyById(family).b } }))}>Reset this brush</Button>
            </PanelSection>
          )}
        </>
      )}>
      <Viewport ref={vp} renderer={renderer} doc={doc} view={view} onView={setView} tool={readOnly ? { id: 'hand', cursor: 'grab' } : curTool} readOnly={readOnly}
        spaceHeld={spaceHeld} gestureRotate onUndo={h.undo} onRedo={h.redo} background="#16171c"
        onFrame={() => { const r = ed.live?.flush?.(); if (r) renderer.invalidate(r); }}
        onDropFiles={readOnly ? null : async (files) => {
          for (const f of files.filter((x) => x.type.startsWith('image/'))) {
            try { const bmp = await createImageBitmap(f); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); const d = h.get(); placeAbove(d, bitmapFrom(c, (d.width - c.width) / 2, (d.height - c.height) / 2, f.name.replace(/\.[^.]+$/, '')), 'Import Image'); } catch (e) { toastError(e); }
          }
        }}
        onContextMenu={(e) => !readOnly && openMenu(e, [{ label: 'Undo', onClick: h.undo, disabled: !h.canUndo }, { label: 'Redo', onClick: h.redo, disabled: !h.canRedo }, { divider: true }, { label: 'New Layer', onClick: newLayer }, { label: 'Fit to Screen', onClick: () => vp.current?.fit() }])} />
      {!readOnly && tool === 'brush' && (
        <SideSliders size={brush.size} onSize={(v) => setBrush({ size: v })} opacity={['smudge', 'oil'].includes(family) ? brush.strength ?? 0.5 : brush.opacity}
          onOpacity={(v) => setBrush(['smudge', 'oil'].includes(family) ? { strength: v } : { opacity: v })} color={family === 'eraser' ? '#fff' : fg} />
      )}
      {colorPop && <Popover anchor={colorPop} side="right" onClose={() => setColorPop(null)}><div className="p-3 w-64"><ColorWheel value={fg} onChange={setFg} size={232} /></div></Popover>}
      {dialog === 'imageSize' && <ImageSizeDialog doc={doc} onClose={() => setDialog(null)} onApply={(w, hh) => { setDialog(null); commit(resizeImage(doc, w, hh), 'Image Size'); setTimeout(() => vp.current?.fit(), 0); }} />}
      {dialog === 'canvasSize' && <CanvasSizeDialog doc={doc} onClose={() => setDialog(null)} onApply={(w, hh, a) => { setDialog(null); commit(resizeCanvas(doc, w, hh, a), 'Canvas Size'); setTimeout(() => vp.current?.fit(), 0); }} />}
    </EditorShell>
  );
}
