// Sora Eshi (vector): an Illustrator-style editor on the shared vector engine — pen, pencil, shapes, type, direct
// selection, Pathfinder, symbols, artboards, clipping masks, smart guides — with Illustrator's shortcuts.
import { useMemo } from 'react';
import EditorShell from '../../components/EditorShell.jsx';
import { PanelSection } from '../../components/ui.jsx';
import { useProject } from '../../lib/doc.js';
import { appById } from '../../lib/apps.js';
import { keyLabel } from '../../lib/shortcuts.js';
import { useVectorEditor } from '../_vector/editor.js';
import Viewport from '../_vector/Viewport.jsx';
import { ToolStrip, PropertiesPanel, LayersPanel, SwatchesPanel, AlignPanel, PathfinderPanel, SymbolsPanel, ArtboardsPanel } from '../_vector/panels.jsx';
import { useGetData, useClipboard, useVectorShortcuts, editItems, objectMenu, typeMenu, viewMenu, placeItems, PanelTabs, OptionsBar, StatusBar, useCanvasDrop, ToolHint } from '../_vector/common.jsx';
import { exportFormats, renderExport } from '../_vector/export.js';
import { solid, strokeOf } from '../_vector/model.js';

const TOOLS = [
  { id: 'select', icon: 'select', label: 'Selection', key: 'v' },
  { id: 'direct', icon: 'directSelect', label: 'Direct Selection', key: 'a' },
  'divider',
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
  { id: 'addAnchor', icon: 'anchorAdd', label: 'Add Anchor Point', key: '=' },
  { id: 'deleteAnchor', icon: 'anchorDelete', label: 'Delete Anchor Point', key: '-' },
  { id: 'convert', icon: 'curvature', label: 'Anchor Point (convert)', key: 'shift+c' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil', key: 'n' },
  'divider',
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'm' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'l' },
  { id: 'polygon', icon: 'polygon', label: 'Polygon' },
  { id: 'star', icon: 'starShape', label: 'Star' },
  { id: 'line', icon: 'line', label: 'Line Segment', key: '\\' },
  { id: 'text', icon: 'text', label: 'Type', key: 't' },
  'divider',
  { id: 'rotate', icon: 'rotate', label: 'Rotate', key: 'r' },
  { id: 'reflect', icon: 'flipH', label: 'Reflect', key: 'o' },
  { id: 'scale', icon: 'scale', label: 'Scale', key: 's' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'i' },
  { id: 'artboard', icon: 'artboard', label: 'Artboard', key: 'shift+o' },
  'divider',
  { id: 'hand', icon: 'hand', label: 'Hand', key: 'h' },
  { id: 'zoom', icon: 'zoom', label: 'Zoom', key: 'z' },
];

export default function VectorEditor({ id }) {
  const project = useProject(id);
  const ed = useVectorEditor(project, 'vector', { defaultStyle: { fill: solid('#ffffff'), stroke: strokeOf('#000000', 1), font: { family: 'Inter', size: 36 } } });
  const getData = useGetData(ed);
  useClipboard(ed);
  useVectorShortcuts(ed, {
    tools: Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key, t.id])),
    extra: {
      'mod+d': () => ed.transformAgain(),
      'mod+7': () => ed.makeClip(), 'alt+mod+7': () => ed.releaseClip(),
      'mod+8': () => ed.makeCompound(), 'shift+alt+mod+8': () => ed.releaseCompound(),
      'mod+2': () => ed.setFlag('locked', true), 'alt+mod+2': () => ed.unlockAll(),
      'mod+3': () => ed.setFlag('hidden', true), 'alt+mod+3': () => ed.showAll(),
      'shift+mod+o': () => ed.outlineText(),
      'mod+r': () => ed.setOpts((o) => ({ ...o, rulers: !o.rulers })),
      'shift+mod+p': () => placeItems(ed)[0].onClick(),
      'shift+mod+>': () => ed.setProps((n) => (n.type === 'text' ? { font: { ...n.font, size: Math.round((n.font?.size || 36) + 2) } } : {}), 'Font Size'),
      'shift+mod+<': () => ed.setProps((n) => (n.type === 'text' ? { font: { ...n.font, size: Math.max(1, Math.round((n.font?.size || 36) - 2)) } } : {}), 'Font Size'),
    },
  });
  const drop = useCanvasDrop(ed);
  const exportConfig = useMemo(() => (ed.doc ? { formats: exportFormats(ed.doc, { current: ed.activeAb }), render: (fid, o, { onProgress }) => renderExport(ed.get(), fid, o, onProgress) } : undefined), [ed.doc, ed.get, ed.activeAb]); // eslint-disable-line react-hooks/exhaustive-deps

  const panels = (
    <PanelTabs id="vector" tabs={[
      { id: 'props', label: 'Properties', render: () => (
        <>
          <PropertiesPanel ed={ed} />
          <PanelSection title="Align" id="v-align"><AlignPanel ed={ed} /></PanelSection>
          <PanelSection title="Pathfinder" id="v-pathfinder"><PathfinderPanel ed={ed} /></PanelSection>
        </>
      ) },
      { id: 'layers', label: 'Layers', render: () => <LayersPanel ed={ed} /> },
      { id: 'assets', label: 'Swatches', render: () => (
        <>
          <PanelSection title="Swatches" id="v-swatches"><SwatchesPanel ed={ed} /></PanelSection>
          <PanelSection title="Symbols" id="v-symbols"><SymbolsPanel ed={ed} /></PanelSection>
        </>
      ) },
      { id: 'artboards', label: 'Artboards', render: () => <div className="p-2"><ArtboardsPanel ed={ed} /></div> },
    ]} />
  );

  return (
    <EditorShell app="vector" project={project} history={ed.h} getData={getData}
      menus={[objectMenu(ed), typeMenu(ed), { label: 'Select', items: () => [
        { label: 'All', shortcut: keyLabel('mod+a'), onClick: ed.selectAll },
        { label: 'Deselect', shortcut: keyLabel('shift+mod+a'), onClick: () => ed.setSel([]) },
        { label: 'Same fill colour', disabled: !ed.selNodes[0]?.fill, onClick: () => selectSame(ed, 'fill') },
        { label: 'Same stroke colour', disabled: !ed.selNodes[0]?.stroke, onClick: () => selectSame(ed, 'stroke') },
      ] }, viewMenu(ed)]}
      fileItems={placeItems(ed)} editItems={editItems(ed)}
      exportConfig={exportConfig}
      tools={<ToolStrip ed={ed} tools={TOOLS} />}
      options={<OptionsBar ed={ed} />}
      panels={panels} panelWidth={290}
      status={<StatusBar ed={ed} hint={ToolHint[ed.tool]} />}
      commentAnchor={() => ed.viewportRef.current?.center()}
      anchorLabel={(a) => `${Math.round(a.x)}, ${Math.round(a.y)}`}
      onJumpToComment={(a) => ed.viewportRef.current?.fitRect({ x: a.x - 200, y: a.y - 200, w: 400, h: 400 })}>
      <div className="absolute inset-0" {...drop}>
        {ed.doc && <Viewport ed={ed} />}
        {ed.scope && <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 h-8 rounded-full bg-panel border border-line text-[12px] flex items-center gap-2 shadow-lg">Editing symbol <b>{ed.doc.symbols.find((s) => s.id === ed.scope)?.name}</b><button type="button" className="text-accent hover:underline" onClick={ed.exitSymbol}>Done</button></div>}
      </div>
    </EditorShell>
  );
}
void appById;

function selectSame(ed, key) {
  const ref = JSON.stringify(key === 'fill' ? ed.selNodes[0].fill : ed.selNodes[0].stroke?.color);
  const ids = [];
  const visit = (list) => { for (const n of list) { if (n.type === 'artboard') visit(n.children); else if (!n.locked && !n.hidden && JSON.stringify(key === 'fill' ? n.fill : n.stroke?.color) === ref) ids.push(n.id); } };
  visit(ed.root);
  ed.setSel(ids);
}
