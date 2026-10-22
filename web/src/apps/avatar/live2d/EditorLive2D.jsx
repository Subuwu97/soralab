// Edit mode for a Live2D project: bring in a Cubism model (zip or files), add Cubism Core if the server doesn't have
// it yet, try the model's parameters, motions and expressions, and set how tracking drives its parameters.
// SoraLab plays Live2D models; it can't make or change .moc3 files (Live2D's format is proprietary).
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Select, Slider, NumberInput, PanelSection, Spinner, ProgressBar, Toggle, toast, toastError, cx } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icons.jsx';
import { POSE_KEYS } from '../contract.js';
import { KEY_INFO } from '../tracking/pose.js';
import { coreStatus, uploadCore, fmtCoreVersion, CORE_DOWNLOAD, CORE_LICENCE } from './core.js';
import { importModel } from './files.js';
import { createStageLive2D, LIVE2D_BINDINGS } from './index.js';

export default function EditorLive2D({ project, h, doc, canEdit, ui }) {
  const docId = project.doc.id;
  const [core, setCore] = useState(null); // { installed, can_upload } | { error }
  const [busy, setBusy] = useState(null);
  const [stageErr, setStageErr] = useState(null);
  const [info, setInfo] = useState(null);
  const [over, setOver] = useState({});
  const [exprOn, setExprOn] = useState({});
  const box = useRef(null); const canvas = useRef(null); const stage = useRef(null);
  const fileRef = useRef(null); const coreRef = useRef(null);
  const edit = (fn, label, merge) => { if (canEdit) h.set((d) => fn(d), label, merge ? { merge } : undefined); };
  const bindings = doc.bindings?.length ? doc.bindings : LIVE2D_BINDINGS;

  useEffect(() => { coreStatus().then(setCore).catch((e) => setCore({ installed: false, error: e.message })); }, []);
  const modelKey = JSON.stringify(doc.model?.files || null);
  useEffect(() => {
    if (!core?.installed || !doc.model) return undefined;
    let off = false; let made = null; setStageErr(null); setInfo(null);
    createStageLive2D(canvas.current, doc, {}).then((s) => {
      if (off) { s.dispose(); return; }
      made = s; stage.current = s; fit(); setInfo(s.info());
    }).catch((e) => { if (!off) setStageErr(e); });
    return () => { off = true; made?.dispose(); stage.current = null; };
  }, [core?.installed, modelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = () => { const r = box.current?.getBoundingClientRect(); if (r && stage.current) stage.current.resize(r.width * devicePixelRatio, r.height * devicePixelRatio); };
  useEffect(() => { const ro = new ResizeObserver(fit); if (box.current) ro.observe(box.current); return () => ro.disconnect(); });
  useEffect(() => { stage.current?.setOverrides(over); }, [over]);

  const pick = (accept, multiple) => new Promise((resolve) => { const i = fileRef.current; i.accept = accept; i.multiple = multiple; i.value = ''; i.onchange = () => resolve([...i.files]); i.click(); });
  const doImport = async (list) => {
    const files = list || await pick('.zip,.json,.moc3,.png,.jpg,.jpeg,.webp', true);
    if (!files.length) return;
    setBusy({ label: 'Reading the model…', p: null });
    try {
      const model = await importModel(files, { docId, onProgress: (p, label) => setBusy({ label, p }) });
      edit((d) => ({ ...d, model, bindings: d.bindings?.length ? d.bindings : LIVE2D_BINDINGS.map((b) => ({ ...b })) }), 'Import Live2D model');
      toast(`Imported ${model.name}${model.missing.length ? ` (missing: ${model.missing.join(', ')})` : ''}.`, { type: model.missing.length ? 'info' : 'success' });
    } catch (e) { toastError(e); } finally { setBusy(null); }
  };
  const addCore = async () => {
    const [f] = await new Promise((resolve) => { const i = coreRef.current; i.value = ''; i.onchange = () => resolve([...i.files]); i.click(); });
    if (!f) return;
    try { await uploadCore(f); toast('Cubism Core added for everyone on this server.', { type: 'success' }); setCore(await coreStatus()); } catch (e) { toastError(e); }
  };

  useEffect(() => {
    ui.set({
      menus: [], thumb: async () => stage.current?.snapshot(),
      fileItems: [{ label: doc.model ? 'Replace Live2D model…' : 'Import Live2D model…', icon: 'import', onClick: () => doImport(), disabled: !canEdit }],
      exportConfig: { formats: [{ id: 'png', label: 'PNG (current pose)', ext: 'png', kind: 'image', note: 'Live2D models stay in their own format; SoraLab can’t write .moc3 files.' }], render: async () => { if (!stage.current) throw new Error('The model isn’t showing yet.'); stage.current.setBackground(null); return stage.current.snapshot(); } },
    });
  });

  const setBinding = (i, patch) => edit((d) => ({ ...d, bindings: (d.bindings?.length ? d.bindings : LIVE2D_BINDINGS).map((b, k) => (k === i ? { ...b, ...patch } : b)) }), 'Tracking binding', `lb-${i}`);
  const params = info?.parameters || [];
  const coreMissing = core && !core.installed;
  const panels = (
    <div>
      <PanelSection title="Model" id="l2d-model">
        {doc.model ? (
          <div className="text-[12px] flex flex-col gap-1">
            <div><b>{doc.model.name}</b></div>
            <div className="text-fg3">{Object.keys(doc.model.files).length} files{info ? ` · ${info.parameters.length} parameters · ${info.drawables} drawables` : ''}</div>
            {canEdit && <Button size="sm" icon="import" onClick={() => doImport()}>Replace model…</Button>}
          </div>
        ) : <p className="text-xs text-fg3">No model yet.</p>}
        <p className="text-[11px] text-fg3 mt-2">Live2D models play with Cubism Core and stay in Live2D’s format. To make your own rig in SoraLab’s open format, start a “2D avatar (from a PSD)” project.</p>
      </PanelSection>
      {core !== null && <PanelSection title="Cubism Core" id={coreMissing ? 'l2d-core-missing' : 'l2d-core'} defaultOpen={!!coreMissing}>
        {core.installed ? (
          <div className="text-[12px] text-fg2 flex flex-col gap-1">
            <span className="flex items-center gap-1"><Icon name="check" size={13} className="text-ok" />Installed on this server{fmtCoreVersion(info?.version) ? ` (version ${fmtCoreVersion(info.version)})` : ''}.</span>
            {core.can_upload && <Button size="sm" variant="ghost" onClick={addCore}>Replace with a newer Core…</Button>}
          </div>
        ) : <CoreHelp core={core} onUpload={addCore} />}
      </PanelSection>}
      {info && (
        <>
          <PanelSection title="Motions & expressions" id="l2d-motion">
            {Object.entries(info.motions).map(([g, n]) => (
              <div key={g} className="flex items-center gap-1 text-[12px] h-7">
                <span className="flex-1 truncate">{g || '(no group)'}</span>
                {Array.from({ length: Math.min(n, 6) }, (_, i) => <IconButton key={i} icon="play" label={`Play ${g} ${i + 1}`} size={22} iconSize={11} onClick={() => stage.current?.playMotion(g, i)} />)}
                <Toggle checked={(doc.idle !== undefined ? doc.idle : (info.motions.Idle ? 'Idle' : null)) === g} onChange={(v) => { edit((d) => ({ ...d, idle: v ? g : null }), 'Idle motion'); stage.current?.setIdle(v ? g : null); }} />
              </div>
            ))}
            {!Object.keys(info.motions).length && <p className="text-xs text-fg3">No motions in this model.</p>}
            <div className="text-[11px] text-fg3 mb-1">The switch picks the idle group: one of its motions plays whenever nothing else does. ▶ plays a motion now, fading over from the one before.{info.pose ? ` The model’s pose switches ${info.pose} part group${info.pose === 1 ? '' : 's'}.` : ''}</div>
            {(stage.current?.expressions() || []).filter((x) => !x.motion).map((x, k) => (
              <div key={x.id} className="flex items-center gap-2 h-7 text-[12px]"><Toggle checked={!!exprOn[k]} onChange={(v) => { setExprOn({ ...exprOn, [k]: v }); stage.current?.setExpression(k, v ? 1 : 0); }} /><span className="truncate">{x.name}</span></div>
            ))}
            <p className="text-[11px] text-fg3">Expressions fade in and out. Give expressions and motions hotkeys in Perform.</p>
          </PanelSection>
          <PanelSection title="Tracking → parameters" id="l2d-bind">
            <datalist id="l2d-params">{params.map((p) => <option key={p.id} value={p.id} />)}</datalist>
            {bindings.map((b, i) => {
              const ok = params.some((p) => p.id === b.param);
              return (
                <div key={i} className="rounded-md bg-panel-2 p-1.5 mb-1.5 flex flex-col gap-1">
                  <Select small value={b.pose} onChange={(v) => setBinding(i, { pose: v })} options={POSE_KEYS.map((k) => ({ value: k, label: KEY_INFO[k].label }))} className="w-full min-w-0" />
                  <div className="flex items-center gap-1">
                    <Icon name="chevronRight" size={13} className="text-fg3 shrink-0" />
                    <input list="l2d-params" value={b.param} disabled={!canEdit} onChange={(e) => setBinding(i, { param: e.target.value })} className={cx('h-7 flex-1 min-w-0 rounded bg-input border px-1.5 text-[12px] font-mono', ok ? 'border-line' : 'border-warn/70 text-warn')} title={ok ? '' : 'This model has no parameter with that ID'} />
                    <NumberInput label="×" title="Scale" value={b.scale} step={0.05} width={40} onChange={(v) => setBinding(i, { scale: v })} />
                  </div>
                </div>
              );
            })}
            {canEdit && <Button size="sm" variant="ghost" icon="plus" onClick={() => edit((d) => ({ ...d, bindings: [...(d.bindings?.length ? d.bindings : LIVE2D_BINDINGS), { pose: 'mouthA', param: params[0]?.id || 'ParamA', scale: 1, offset: 0 }] }), 'Add binding')}>Add</Button>}
          </PanelSection>
          <PanelSection title="Try parameters" id="l2d-params" defaultOpen={false}>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setOver({})}>Reset</Button>
            {params.map((p) => <Slider key={p.id} label={p.id} value={over[p.id] ?? p.def} min={p.min} max={p.max} step={(p.max - p.min) / 100} onChange={(v) => setOver({ ...over, [p.id]: v })} />)}
          </PanelSection>
        </>
      )}
    </div>
  );

  return (
    <>
      {ui.portal('panels', panels)}
      {ui.portal('options', <span className="text-xs text-fg3">{doc.model ? 'Live2D model preview. Switch to Perform to drive it with your webcam.' : 'Import a Live2D model: a zip of its folder, or all its files (.model3.json, .moc3, textures, motions…).'}</span>)}
      {ui.portal('status', <><span>Live2D</span>{doc.model && <span>{doc.model.name}</span>}{!canEdit && <span className="text-warn">View only</span>}</>)}
      <div ref={box} className="absolute inset-0" style={{ background: 'repeating-conic-gradient(#1b1c22 0% 25%, #16171c 0% 50%) 50% / 24px 24px' }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (canEdit && e.dataTransfer.files.length) doImport([...e.dataTransfer.files]); }}>
        <canvas ref={canvas} className="absolute inset-0 w-full h-full" />
        {(!doc.model || coreMissing || stageErr) && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-lg bg-panel/95 border border-line rounded-xl p-6 shadow-lg text-center" data-testid="l2d-message">
              {!doc.model ? (
                <>
                  <div className="font-head font-semibold text-lg mb-1">Open a Live2D model</div>
                  <p className="text-sm text-fg2 mb-4">Pick a zip of the model’s folder, or select all of its files: the .model3.json, the .moc3, the textures, and any motions, expressions and physics.</p>
                  <Button variant="primary" icon="import" disabled={!canEdit} onClick={() => doImport()}>Import model…</Button>
                  {coreMissing && <p className="text-[12px] text-warn mt-4">Note: to play it, this server also needs Live2D’s Cubism Core (see the panel on the right).</p>}
                </>
              ) : coreMissing ? <CoreHelp core={core} onUpload={addCore} big /> : (
                <><div className="font-head font-semibold mb-1">Couldn’t play this model</div><p className="text-sm text-fg2">{stageErr.message}</p></>
              )}
            </div>
          </div>
        )}
        {busy && <div className="absolute inset-0 grid place-items-center bg-black/30"><div className="bg-panel border border-line rounded-xl p-4 w-80"><div className="flex items-center gap-2 text-sm mb-2"><Spinner />{busy.label}</div><ProgressBar value={busy.p ?? 0} indeterminate={busy.p === null} /></div></div>}
      </div>
      <input ref={fileRef} type="file" className="hidden" />
      <input ref={coreRef} type="file" accept=".js" className="hidden" />
    </>
  );
}

/** Why Cubism Core is needed, where to get it, and (for admins) the upload button. */
export function CoreHelp({ core, onUpload, big }) {
  return (
    <div className={cx('text-left', big ? 'text-sm' : 'text-[12px]')} data-testid="l2d-core-help">
      {big && <div className="font-head font-semibold text-lg mb-1 text-center">Cubism Core is needed</div>}
      <p className="text-fg2 mb-2">Live2D models are played by Live2D’s <b>Cubism Core</b> library. Its licence doesn’t let SoraLab include it, so {core?.can_upload ? 'you (as a server admin) add it once' : 'a server admin needs to add it once'}:</p>
      <ol className="list-decimal pl-5 text-fg2 mb-2 flex flex-col gap-0.5">
        <li>Download the <a className="text-accent underline" href={CORE_DOWNLOAD} target="_blank" rel="noreferrer">Cubism SDK for Web</a> from Live2D and accept its licence.</li>
        <li>In the download, find <code className="text-fg">Core/live2dcubismcore.min.js</code>.</li>
        <li>{core?.can_upload ? 'Upload it here:' : 'Ask your admin to upload it in any Live2D project.'}</li>
      </ol>
      {core?.can_upload && <Button size="sm" variant="primary" icon="upload" onClick={onUpload} data-testid="l2d-upload-core">Upload live2dcubismcore.min.js…</Button>}
      <p className="text-[11px] text-fg3 mt-2">Live2D’s terms apply to Core and to your use of it (free for individuals and small businesses under their revenue limit; see the <a className="underline" href={CORE_LICENCE} target="_blank" rel="noreferrer">SDK licence</a>). SoraLab keeps it on your server and only signed-in people (and your OBS output links) can load it.</p>
    </div>
  );
}
