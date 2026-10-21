// Sora Ningyō (人形, "puppet") — VTuber avatars, like Live2D Cubism / VRoid. One app, three kinds of project:
//   2D      our own open rig, made from a PSD (./two/)
//   Live2D  an imported Cubism model played with Cubism Core, which the person adds themselves (./live2d/)
//   3D      a VRM avatar (./three/, built separately — "3D is coming" until it's installed)
// Every kind has the same Perform mode (./Perform.jsx): webcam tracking drives the avatar live, with an output page
// for OBS (./Output.jsx) that follows over a small server relay.
//
// The editor of each kind fills the shell's tool strip, options bar, panels and status through `ui.portal(slot, …)`
// and hands its menus / export / thumbnail to `ui.set({…})`, so the shell (autosave, undo, history) stays mounted when
// switching between Edit and Perform.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import EditorShell from '../../components/EditorShell.jsx';
import { Segmented, Spinner, IconButton, toastError } from '../../components/ui.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { emptyDoc2D, normalize2D } from './two/model.js';
import { withTrackingDefaults } from './tracking/pose.js';
import { loadThree, hasThree } from './stage.js';
import Editor2D from './two/Editor2D.jsx';
import Perform, { withPerformDefaults } from './Perform.jsx';
import EditorLive2D from './live2d/EditorLive2D.jsx';

/** The document as saved → what the editor keeps (filling in defaults). New projects get their kind from the preset. */
async function fromSaved(data, meta) {
  const kind = data?.kind || meta?.meta?.kind || '2d';
  const base = { tracking: withTrackingDefaults(data?.tracking), perform: withPerformDefaults(data?.perform) };
  if (kind === '2d') return { ...(data?.kind ? normalize2D(data) : emptyDoc2D({ width: meta?.width, height: meta?.height })), ...base, version: 1, kind: '2d' };
  if (kind === 'live2d') return { version: 1, kind: 'live2d', width: meta?.width || 1920, height: meta?.height || 1080, model: null, ...data, ...base };
  // 3D: the 3D side makes its own empty document when it's installed
  if (!data?.kind) {
    const m = await loadThree().catch(() => null);
    const empty = m?.empty3D ? m.empty3D(meta) : {};
    return { ...empty, version: 1, kind: '3d', ...base };
  }
  return { ...data, ...base };
}

export default function AvatarEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    fromSaved(project.data instanceof Blob ? null : project.data, project.doc).then((d) => { if (!off) h.reset(d); }).catch(toastError);
    return () => { off = true; };
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = h.state;
  const canEdit = project.canEdit;
  const [mode, setMode] = useState(() => (new URLSearchParams(location.search).get('mode') === 'perform' ? 'perform' : 'edit'));

  // ---------------------------------------------------------------- slots the kind editors fill
  const [els, setEls] = useState({});
  const slotRef = (name) => (el) => { if (el && els[name] !== el) setEls((s) => ({ ...s, [name]: el })); };
  const reg = useRef({});
  const [, setSig] = useState('');
  const ui = useMemo(() => ({
    portal: (name, node) => (els[name] ? createPortal(node, els[name]) : null),
    set: (cfg) => {
      reg.current = { ...reg.current, ...cfg };
      // re-render the shell only when what it shows changes (menu titles, whether there's an export)
      const sig = `${(reg.current.menus || []).map((m) => m.label).join()}|${!!reg.current.exportConfig}|${(reg.current.fileItems || []).length}`;
      setSig((s) => (s === sig ? s : sig));
    },
  }), [els]);
  // (each kind editor and Perform set every key — menus, fileItems, exportConfig, thumb — so nothing stale is left)

  const menus = (reg.current.menus || []).map((m) => ({ label: m.label, items: () => (reg.current.menus || []).find((x) => x.label === m.label)?.items() || [] }));
  const fileItems = (reg.current.fileItems || []).map((it, i) => (it.divider ? it : { ...it, onClick: () => reg.current.fileItems?.[i]?.onClick?.() }));
  const exportConfig = reg.current.exportConfig ? {
    get formats() { return reg.current.exportConfig?.formats || []; },
    render: (...a) => reg.current.exportConfig.render(...a),
  } : undefined;

  const getData = useCallback(async () => {
    const d = h.get();
    if (!d) return null;
    let thumb = null;
    try { thumb = await reg.current.thumb?.(); } catch { /* the thumbnail is optional */ }
    return { data: d, thumb: thumb || undefined, width: d.width, height: d.height, meta: { kind: d.kind } };
  }, [h]);

  const modeSwitch = doc && (
    <div className="flex items-center gap-1 mr-1">
      <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'edit', label: 'Edit', icon: 'edit' }, { value: 'perform', label: 'Perform', icon: 'camera' }]} />
      <IconButton icon="info" label={doc.kind === '2d' ? 'Our open 2D rig (saved in SoraLab’s open format, not Live2D .moc3)' : doc.kind === 'live2d' ? 'A Live2D Cubism model, played with Cubism Core' : '3D (VRM) avatar'} size={26} iconSize={14} />
    </div>
  );
  const wants3D = doc?.kind === '3d' && mode === 'edit';
  return (
    <EditorShell app="avatar" project={project} history={h} getData={getData} menus={menus} fileItems={fileItems} exportConfig={exportConfig} toolbarExtra={modeSwitch}
      tools={doc && !wants3D && mode === 'edit' && doc.kind === '2d' ? <div ref={slotRef('tools')} className="contents" /> : undefined}
      options={doc && !wants3D ? <div ref={slotRef('options')} className="flex items-center gap-2 w-full min-w-0" /> : undefined}
      panels={doc && !wants3D ? <div ref={slotRef('panels')} /> : undefined} panelWidth={mode === 'perform' ? 300 : 320}
      status={doc ? <div ref={slotRef('status')} className="flex items-center gap-4" /> : undefined}>
      {!doc ? <div className="h-full grid place-items-center"><Spinner size={28} /></div>
        : mode === 'perform' ? <Perform key="perform" project={project} h={h} doc={doc} canEdit={canEdit} ui={ui} />
          : doc.kind === '2d' ? <Editor2D project={project} h={h} doc={doc} canEdit={canEdit} ui={ui} />
            : doc.kind === 'live2d' ? <EditorLive2D project={project} h={h} doc={doc} canEdit={canEdit} ui={ui} />
              : <Edit3D project={project} h={h} canEdit={canEdit} ui={ui} />}
    </EditorShell>
  );
}

/** The 3D side's editor, when it's installed. */
function Edit3D({ project, h, canEdit, ui }) {
  const [mod, setMod] = useState(undefined);
  useEffect(() => { loadThree().then(setMod).catch(() => setMod(null)); }, []);
  useEffect(() => {
    if (!mod?.exportConfig3D) { ui.set({ menus: [], fileItems: [], exportConfig: null, thumb: null }); return; }
    ui.set({ menus: [], fileItems: [], thumb: null, exportConfig: mod.exportConfig3D({ getDoc: () => h.get(), project, history: h }) });
  }, [mod]); // eslint-disable-line react-hooks/exhaustive-deps
  if (mod === undefined) return <div className="h-full grid place-items-center"><Spinner size={28} /></div>;
  if (!mod?.Editor3D) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div className="max-w-md">
          <div className="font-head font-semibold text-lg mb-1">3D is coming</div>
          <p className="text-sm text-fg2">{hasThree() ? 'The 3D avatar editor didn’t load.' : 'The 3D (VRM) side of Sora Ningyō isn’t installed on this server yet.'} Your project is kept; open it again once 3D is here. Meanwhile you can make a 2D avatar from a PSD or play a Live2D model.</p>
        </div>
      </div>
    );
  }
  const E = mod.Editor3D;
  return <E project={project} history={h} canEdit={canEdit} />;
}
