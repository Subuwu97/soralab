// The right-hand panels of the 3D editor, one per tab. Each gets the editor context (document, edit(), live avatar,
// view state). Every document change goes through edit(fn, label, mergeKey) so it's undoable; slider drags pass a merge
// key so one drag is one undo step.
import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { Button, IconButton, Slider, Select, Toggle, Checkbox, Segmented, ColorSwatch, TextInput, NumberInput, PanelSection, promptDialog, confirmDialog, toast, cx } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icons.jsx';
import { pickAssets } from '../../../components/Pickers.jsx';
import { assetSrc } from '../../../lib/doc.js';
import {
  PRESETS, PRESET_GROUPS, PRESET_LABELS, BONE_GROUPS, REQUIRED_BONES, boneLabel, LICENSE, LICENSE_FLAGS, LIGHTS, FRAMINGS, SPRING_PRESETS, uid, DEFAULT_DRIVE,
} from './model.js';
import { autoMap } from './humanoid.js';
import { guessExpressions } from './exprmap.js';
import { MARKERS } from './autorig.js';
import { STARTER_DEFAULTS } from './starter.js';

const Row = ({ label, children, className }) => (
  <div className={cx('flex items-center justify-between gap-2 min-h-8', className)}><span className="text-xs text-fg2 truncate">{label}</span><div className="flex items-center gap-1.5">{children}</div></div>
);
const Hint = ({ children, className }) => <p className={cx('text-[11px] leading-snug text-fg3', className)}>{children}</p>;
const Badge = ({ children, tone }) => <span className={cx('text-[10px] px-1.5 py-px rounded-full', tone === 'warn' ? 'bg-warn/15 text-warn' : tone === 'ok' ? 'bg-ok/15 text-ok' : 'bg-chip text-fg2')}>{children}</span>;

// ================================================================ Model

export function ModelPanel({ doc, edit, canEdit, avatar, importFiles, fromFiles, startStarter, busy }) {
  const m = doc.model;
  const st = avatar?.stats();
  const s = { ...STARTER_DEFAULTS, ...(m?.starter || {}) };
  const setStarter = (k, v, merge) => edit((d) => ({ ...d, model: { ...d.model, starter: { ...s, [k]: v } } }), 'Starter avatar', merge);
  return (
    <>
      <PanelSection title="Model" id="n3-model">
        {m ? (
          <div className="flex flex-col gap-1.5 text-[13px]">
            <div className="font-medium truncate" title={m.fileName}>{m.fileName || (m.format === 'starter' ? 'Starter avatar' : 'Model')}</div>
            <div className="text-xs text-fg2">
              {avatar?.loaded.vrmVersion ? `VRM ${avatar.loaded.vrmVersion === '0' ? '0.x (turned to face forward)' : '1.0'}` : m.format === 'starter' ? 'Built in SoraLab' : `${(m.format || '').toUpperCase()} — not a VRM yet`}
              {m.rigged ? ` · ${m.rigged === 'auto' ? 'auto-rigged' : 'weights painted'} in SoraLab` : ''}
            </div>
            {st && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-fg2 mt-1">
                <span>Triangles</span><span className="text-fg tabular-nums">{st.tris.toLocaleString()}</span>
                <span>Meshes</span><span className="text-fg tabular-nums">{st.meshes}</span>
                <span>Bones</span><span className="text-fg tabular-nums">{st.bones}</span>
                <span>Shapes (morphs)</span><span className="text-fg tabular-nums">{st.morphs}</span>
                <span>ARKit shapes</span><span className="text-fg tabular-nums">{st.arkit} of 52</span>
              </div>
            )}
            {m.format !== 'starter' && (
              <Row label="Scale" className="mt-1">
                <NumberInput value={m.scale ?? 1} min={0.0001} max={1000} step={0.01} precision={4} width={80} disabled={!canEdit}
                  onCommit={(v) => edit((d) => ({ ...d, model: { ...d.model, scale: v } }), 'Model scale')} />
              </Row>
            )}
            {m.source && canEdit && (
              <Button size="xs" variant="ghost" icon="undo" className="self-start" onClick={() => edit((d) => ({ ...d, model: d.model.source }), 'Back to the unrigged model')}>Go back to {m.source.fileName || 'the original model'}</Button>
            )}
          </div>
        ) : <Hint>No model yet.</Hint>}
        {canEdit && (
          <div className="flex flex-col gap-1.5 mt-3">
            <Button size="sm" variant={m ? 'secondary' : 'primary'} icon="upload" disabled={busy} onClick={importFiles}>{m ? 'Replace with a file…' : 'Import a model…'}</Button>
            <Button size="sm" icon="folder" disabled={busy} onClick={fromFiles}>Choose from Files…</Button>
            {m?.format !== 'starter' && <Button size="sm" variant="ghost" icon="sparkles" disabled={busy} onClick={startStarter}>Use the starter avatar</Button>}
            <Hint>VRM 0.x / 1.0, glTF / GLB or FBX. For a .gltf or .fbx with separate textures, select the model and its texture files together.</Hint>
          </div>
        )}
      </PanelSection>
      {m?.format === 'starter' && (
        <PanelSection title="Starter avatar" id="n3-starter">
          <div className="grid grid-cols-[1fr_auto] gap-y-1.5 items-center">
            {[['skin', 'Skin'], ['hair', 'Hair'], ['eyes', 'Eyes'], ['outfit', 'Outfit'], ['accent', 'Collar']].map(([k, label]) => (
              <Row key={k} label={label} className="col-span-2"><ColorSwatch value={s[k]} alpha={false} onChange={(v) => setStarter(k, v, `starter-${k}`)} /></Row>
            ))}
          </div>
          <Slider label="Hair length" value={s.hairLength} min={0.4} max={1.8} step={0.05} disabled={!canEdit} onChange={(v) => setStarter('hairLength', v, 'starter-hl')} className="mt-2" />
          <Hint className="mt-2">A simple avatar made in code, with a humanoid skeleton, blink and mouth shapes, emotions and spring-bone hair — enough to try the whole pipeline and export a VRM.</Hint>
        </PanelSection>
      )}
    </>
  );
}

// ================================================================ Rig

export function RigPanel(c) {
  const { doc, edit, canEdit, avatar, rig, setRig, startRig, buildRig, paint, setPaint, startPaint, stopPaint, setPick, selBone, setSelBone, busy } = c;
  if (!avatar) return <Hint className="p-3">Loading…</Hint>;
  const st = avatar.stats();
  return (
    <>
      {(!st.skinned || rig) && <AutoRigSection {...c} />}
      {st.skinned && !rig && !paint && <HumanoidSection {...c} />}
      {st.skinned && !rig && (
        <PanelSection title="Weight paint" id="n3-paint">
          {!paint ? (
            <>
              <Hint>Fix how strongly each bone moves the skin. Weights are saved as a new copy of the model in Files (undo brings the old one back).</Hint>
              <Button size="sm" icon="brush" className="mt-2" disabled={!canEdit || busy} onClick={() => startPaint(selBone && avatar.node(selBone) ? selBone : undefined)}>Paint weights</Button>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <Row label="Bone">
                <Select small value={paint.bone || ''} onChange={(v) => { setPaint({ ...paint, bone: v }); setSelBone(v); }}
                  options={avatar.bones.filter((b) => avatar.deform.has(b) || b.name === paint.bone).map((b) => ({ value: b.name, label: b.name }))} className="max-w-[170px]" />
              </Row>
              <Segmented value={paint.mode} onChange={(v) => setPaint({ ...paint, mode: v })} options={[{ value: 'add', label: 'Add' }, { value: 'remove', label: 'Remove' }, { value: 'smooth', label: 'Smooth' }]} />
              <Slider label="Brush size" value={+(paint.radius * 100).toFixed(1)} min={0.5} max={+(avatar.height * 20).toFixed(0)} step={0.5} unit="cm" onChange={(v) => setPaint({ ...paint, radius: v / 100 })} />
              <Slider label="Strength" value={paint.strength} min={0.05} max={1} step={0.05} onChange={(v) => setPaint({ ...paint, strength: v })} />
              <Slider label="Bend test" value={paint.bend} min={-90} max={90} step={1} unit="°" reset={0} onChange={(v) => setPaint({ ...paint, bend: v })} />
              <Hint>Blue = no influence, red = full. The bend test turns the bone so you can see the skin follow.</Hint>
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" icon="check" onClick={() => stopPaint({ save: true })}>{paint.dirty ? 'Save weights' : 'Done'}</Button>
                {paint.dirty && <Button size="sm" variant="ghost" onClick={async () => { if (await confirmDialog({ title: 'Throw away these strokes?', confirm: 'Discard', danger: true })) { stopPaint({ save: false }); edit((d) => ({ ...d, model: { ...d.model } }), 'Reload model'); } }}>Discard</Button>}
              </div>
            </div>
          )}
        </PanelSection>
      )}
      {st.skinned && !rig && doc.model?.rigged === 'auto' && doc.model.source && canEdit && (
        <PanelSection title="Auto-rig" id="n3-rerig" defaultOpen={false}>
          <Hint>Not happy with the joints? Go back to the unrigged model and place the markers again (your marker positions are kept).</Hint>
          <Button size="sm" className="mt-2" icon="undo" onClick={() => edit((d) => ({ ...d, model: d.model.source }), 'Back to the unrigged model')}>Edit the joints again</Button>
        </PanelSection>
      )}
    </>
  );
}

function AutoRigSection({ canEdit, avatar, rig, setRig, startRig, buildRig, busy }) {
  if (!rig) {
    return (
      <PanelSection title="Auto-rig" id="n3-autorig">
        <p className="text-[13px] mb-2">This model has no skeleton, so it can’t move yet.</p>
        <Hint>Auto-rig places a humanoid skeleton from joint markers you adjust, then works out skin weights. Works best on a standing figure facing forward with arms out (T or A pose).</Hint>
        <Button size="sm" variant="primary" icon="wandMagic" className="mt-3" disabled={!canEdit || busy} onClick={startRig}>Auto-rig…</Button>
      </PanelSection>
    );
  }
  return (
    <PanelSection title="Place the joints" id="n3-markers">
      <Hint>Drag the markers in the view. Seen from the front, they stay in the middle of the body’s depth.</Hint>
      <div className="flex flex-col mt-2 rounded-md border border-line overflow-hidden">
        {MARKERS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setRig({ ...rig, selected: k })} className={cx('flex items-center justify-between h-7 px-2 text-[12px] text-left', rig.selected === k ? 'bg-active' : 'hover:bg-hover')}>
            <span>{label}</span><span className="text-fg3 tabular-nums">{rig.markers[k]?.slice(0, 2).map((v) => v.toFixed(2)).join(', ')}</span>
          </button>
        ))}
      </div>
      <Toggle className="mt-2" checked={rig.symmetric} onChange={(v) => setRig({ ...rig, symmetric: v })} label="Mirror left and right" />
      <Slider className="mt-2" label="Smoothness" value={rig.smooth} min={0} max={1} step={0.05} onChange={(v) => setRig({ ...rig, smooth: v })} />
      <Hint>Higher spreads each bone’s influence further, for softer bends. Fingers aren’t rigged — each hand is one bone.</Hint>
      <div className="flex flex-wrap gap-1.5 mt-3">
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={buildRig}>Build skeleton</Button>
        <Button size="sm" variant="ghost" onClick={() => setRig({ ...rig, markers: rig.suggested })}>Suggest again</Button>
        <Button size="sm" variant="ghost" onClick={() => { setRig(null); avatar.restore(); }}>Cancel</Button>
      </div>
    </PanelSection>
  );
}

function HumanoidSection({ doc, edit, canEdit, avatar, setPick, selBone, setSelBone, view, setView }) {
  const map = doc.humanoid.bones || {};
  const opts = useMemo(() => [{ value: '', label: '— none —' }, ...avatar.bones.map((b) => ({ value: b.name, label: b.name }))], [avatar]);
  const missing = REQUIRED_BONES.filter((b) => !map[b] || !avatar.node(map[b]));
  const set = (bone, name) => edit((d) => ({ ...d, humanoid: { ...d.humanoid, bones: { ...d.humanoid.bones, [bone]: name || undefined } } }), `Map ${boneLabel(bone)}`);
  return (
    <PanelSection title="Humanoid bones" id="n3-humanoid"
      actions={canEdit && <Button size="xs" variant="ghost" icon="wandMagic" onClick={() => { edit((d) => ({ ...d, humanoid: { ...d.humanoid, bones: autoMap(avatar.bones, avatar.deform) } }), 'Auto-map bones'); toast('Mapped bones by their names'); }}>Auto-map</Button>}>
      {missing.length ? <div className="text-[12px] text-warn mb-2">Missing for VRM: {missing.map(boneLabel).join(', ')}.</div> : <div className="text-[12px] text-ok mb-2">All required bones are mapped.</div>}
      <Toggle checked={view.skeleton} onChange={(v) => setView({ ...view, skeleton: v })} label="Show the skeleton (click a joint to select it)" />
      {selBone && <div className="text-[12px] text-fg2 mt-1">Selected: <span className="text-fg">{selBone}</span>{Object.entries(map).find(([, n]) => n === selBone) ? ` — ${boneLabel(Object.entries(map).find(([, n]) => n === selBone)[0])}` : ''}</div>}
      {BONE_GROUPS.map(([group, bones]) => (
        <details key={group} open={group === 'Body' || /arm|leg/i.test(group)} className="mt-2">
          <summary className="text-[11px] font-semibold uppercase tracking-wider text-fg2 cursor-pointer select-none">{group} <span className="text-fg3 normal-case font-normal">{bones.filter((b) => map[b] && avatar.node(map[b])).length}/{bones.length}</span></summary>
          <div className="flex flex-col gap-0.5 mt-1">
            {bones.map((b) => (
              <div key={b} className="flex items-center gap-1">
                <span className={cx('text-[12px] w-[92px] shrink-0 truncate', REQUIRED_BONES.includes(b) && !avatar.node(map[b]) ? 'text-warn' : 'text-fg2')} title={boneLabel(b)}>{group === 'Body' ? boneLabel(b) : boneLabel(b).replace(/^(Left|Right) /, '')}</span>
                <Select small value={avatar.node(map[b]) ? map[b] : ''} disabled={!canEdit} onChange={(v) => set(b, v)} options={opts} className="flex-1 min-w-0 !h-6 !text-[12px]" />
                <IconButton size={24} label="Pick in the view" disabled={!canEdit} onClick={() => { setView({ ...view, skeleton: true }); setPick({ label: `Click the joint for ${boneLabel(b)}`, onPick: (name) => set(b, name) }); }}><Icon name="select" size={13} /></IconButton>
                {map[b] && avatar.node(map[b]) && <IconButton size={24} label="Show it" onClick={() => { setSelBone(map[b]); setView({ ...view, skeleton: true }); }}><Icon name="eye" size={13} /></IconButton>}
              </div>
            ))}
          </div>
        </details>
      ))}
    </PanelSection>
  );
}

// ================================================================ Expressions

export function ExpressionsPanel({ doc, edit, canEdit, avatar, preview, setPreview, setTab }) {
  const [sel, setSel] = useState('blink');
  const ex = doc.expressions || {};
  const morphs = useMemo(() => avatar?.morphList() || [], [avatar]);
  const customs = Object.keys(ex).filter((k) => !PRESETS.includes(k));
  const cur = ex[sel];
  const setEx = (name, fn, label, merge) => edit((d) => ({ ...d, expressions: { ...d.expressions, [name]: fn(d.expressions[name] || { binds: [], isBinary: false, overrideBlink: 'none', overrideMouth: 'none', overrideLookAt: 'none' }) } }), label, merge);
  const ps = doc.drive.perfectSync;
  const row = (name) => {
    const n = ex[name]?.binds?.length || 0;
    return (
      <div key={name} className={cx('flex items-center gap-2 px-2 h-8 rounded cursor-pointer', sel === name ? 'bg-active' : 'hover:bg-hover')} onClick={() => setSel(name)}>
        <span className="text-[12px] w-[84px] truncate shrink-0" title={name}>{PRESET_LABELS[name] || name}</span>
        <input type="range" className="sl-range flex-1 min-w-0" min={0} max={1} step={0.01} value={preview[name] || 0} aria-label={`Preview ${name}`}
          onClick={(e) => e.stopPropagation()} onChange={(e) => setPreview({ ...preview, [name]: Number(e.target.value) })} />
        <Badge tone={n ? undefined : 'warn'}>{n}</Badge>
      </div>
    );
  };
  if (!avatar) return <Hint className="p-3">Loading…</Hint>;
  return (
    <>
      <PanelSection title="Perfect sync (ARKit)" id="n3-sync">
        <div className="text-[12px] mb-1.5">{avatar.arkitCount ? `This model has ${avatar.arkitCount} of the 52 ARKit face shapes.` : 'This model has no ARKit face shapes.'}</div>
        <Segmented value={ps} onChange={(v) => edit((d) => ({ ...d, drive: { ...d.drive, perfectSync: v } }), 'Perfect sync')}
          options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        <Hint className="mt-1.5">When on, face tracking drives those shapes directly (Auto: when the model has at least 40 of them), and blink, mouth and brows skip the expressions below.</Hint>
      </PanelSection>
      <PanelSection title="Expressions" id="n3-expr" actions={
        <div className="flex gap-0.5">
          <IconButton size={24} icon="refresh" iconSize={14} label="Reset the previews" onClick={() => setPreview({})} />
          {canEdit && <IconButton size={24} icon="wandMagic" iconSize={14} label="Fill empty expressions from shape names" onClick={() => {
            const g = guessExpressions(morphs);
            let n = 0;
            edit((d) => { const e2 = { ...d.expressions }; for (const [k, v] of Object.entries(g)) if (!e2[k]?.binds?.length && v.binds.length) { e2[k] = v; n++; } return { ...d, expressions: e2 }; }, 'Guess expressions');
            setTimeout(() => toast(n ? `Filled ${n} expressions from shape names` : 'Nothing new to fill'), 0);
          }} />}
        </div>}>
        <Hint className="mb-1">Drag to preview. The number is how many shapes each one moves.</Hint>
        {PRESET_GROUPS.map(([g, names]) => (
          <div key={g} className="mb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-fg3 px-2 mt-1">{g}</div>
            {names.map(row)}
          </div>
        ))}
        <div className="text-[10px] uppercase tracking-wider text-fg3 px-2 mt-1">Custom</div>
        {customs.map(row)}
        {canEdit && <Button size="xs" variant="ghost" icon="plus" className="mt-1" onClick={async () => {
          const name = (await promptDialog({ title: 'New custom expression', label: 'Name', value: '', placeholder: 'e.g. wink, tongueOut, browUp' }))?.trim();
          if (!name) return;
          if (ex[name]) { setSel(name); return; }
          setEx(name, (e) => e, 'New expression'); setSel(name);
        }}>New custom expression</Button>}
        <Hint className="mt-1">Custom expressions named “browUp” and “browDown” are driven by eyebrow tracking.</Hint>
      </PanelSection>
      {sel && (
        <PanelSection title={`Edit: ${PRESET_LABELS[sel] || sel}`} id="n3-expr-edit">
          {!morphs.length && <Hint>This model has no shapes (morph targets) to use.</Hint>}
          {(cur?.binds || []).map((b, i) => {
            const meshMorphs = morphs.find((m) => m.mesh === b.mesh)?.morphs || [];
            return (
              <div key={i} className="flex flex-col gap-1 py-1.5 border-b border-line/60">
                <div className="flex items-center gap-1">
                  <Select small value={b.mesh} disabled={!canEdit} className="w-[92px] !h-6 !text-[12px]" options={morphs.map((m) => ({ value: m.mesh, label: m.mesh }))}
                    onChange={(v) => setEx(sel, (e) => ({ ...e, binds: e.binds.map((x, j) => (j === i ? { ...x, mesh: v, morph: morphs.find((m) => m.mesh === v)?.morphs[0] || '' } : x)) }), 'Change shape')} />
                  <Select small value={b.morph} disabled={!canEdit} className="flex-1 min-w-0 !h-6 !text-[12px]" options={(meshMorphs.includes(b.morph) ? meshMorphs : [b.morph, ...meshMorphs]).map((m) => ({ value: m, label: m }))}
                    onChange={(v) => setEx(sel, (e) => ({ ...e, binds: e.binds.map((x, j) => (j === i ? { ...x, morph: v } : x)) }), 'Change shape')} />
                  {canEdit && <IconButton size={24} icon="trash" iconSize={13} label="Remove" onClick={() => setEx(sel, (e) => ({ ...e, binds: e.binds.filter((_, j) => j !== i) }), 'Remove shape')} />}
                </div>
                <Slider label="Weight" value={b.weight} min={0} max={1} step={0.01} disabled={!canEdit}
                  onChange={(v) => setEx(sel, (e) => ({ ...e, binds: e.binds.map((x, j) => (j === i ? { ...x, weight: v } : x)) }), 'Shape weight', `w-${sel}-${i}`)} />
              </div>
            );
          })}
          {canEdit && morphs.length > 0 && <Button size="xs" variant="ghost" icon="plus" className="mt-1.5" onClick={() => {
            setEx(sel, (e) => ({ ...e, binds: [...e.binds, { mesh: morphs[0].mesh, morph: morphs[0].morphs[0], weight: 1 }] }), 'Add shape');
            setPreview({ ...preview, [sel]: 1 });
          }}>Add a shape</Button>}
          <div className="mt-3 flex flex-col gap-1.5">
            <Toggle checked={!!cur?.isBinary} onChange={(v) => setEx(sel, (e) => ({ ...e, isBinary: v }), 'On/off expression')} label="On or off only (no in-between)" disabled={!canEdit} />
            {[['overrideBlink', 'While on, blinking'], ['overrideMouth', 'While on, mouth shapes'], ['overrideLookAt', 'While on, eye look']].map(([k, label]) => (
              <Row key={k} label={label}>
                <Select small value={cur?.[k] || 'none'} disabled={!canEdit} onChange={(v) => setEx(sel, (e) => ({ ...e, [k]: v }), 'Expression override')}
                  options={[{ value: 'none', label: 'keeps working' }, { value: 'blend', label: 'fades out' }, { value: 'block', label: 'is blocked' }]} />
              </Row>
            ))}
            {!PRESETS.includes(sel) && canEdit && <Button size="xs" variant="ghost" icon="trash" className="self-start" onClick={() => { edit((d) => { const e2 = { ...d.expressions }; delete e2[sel]; return { ...d, expressions: e2 }; }, 'Delete expression'); setSel('blink'); }}>Delete this expression</Button>}
          </div>
          <Button size="xs" variant="ghost" className="mt-2" onClick={() => setTab('tracking')}>Tracking sensitivity →</Button>
        </PanelSection>
      )}
    </>
  );
}

// ================================================================ Spring bones

const GRAVITY_DIRS = [{ value: '0,-1,0', label: 'Down' }, { value: '0,-1,-1', label: 'Down and back' }, { value: '0,0,-1', label: 'Back' }, { value: '0,1,0', label: 'Up' }];
const SPRING_WORDS = [['hair', /hair|kami|bang|fringe|ponytail|twin|ahoge|髪/i], ['skirt', /skirt|cloth|coat|cape|scarf|ribbon|tie|sleeve|sode|hood|dress|frill/i], ['ears', /ear|mimi|耳/i], ['tail', /tail|shippo|尻尾/i], ['soft', /bust|breast|chest_?soft|oppai/i]];

/** Chains from a root bone: one per branch (a root with several children anchors them; it doesn't swing itself). */
export function chainsFrom(avatar, rootName) {
  const isBone = (o) => avatar.bones.includes(o) || o.isBone;
  const root = avatar.node(rootName);
  if (!root) return [];
  const out = [];
  const walk = (start) => {
    const bones = [start]; let n = start;
    for (;;) {
      const kids = n.children.filter(isBone);
      if (!kids.length) break;
      kids.slice(1).forEach(walk);
      n = kids[0]; bones.push(n);
    }
    out.push(bones.map((b) => b.name));
  };
  const kids = root.children.filter(isBone);
  if (kids.length > 1) kids.forEach(walk); else walk(root);
  return out;
}
const newChain = (bones, preset = 'hair', groups = []) => {
  const p = SPRING_PRESETS[preset];
  return { id: uid('s'), name: bones[0], bones, preset, stiffness: p.stiffness, gravity: p.gravity, gravityDir: [0, -1, 0], drag: p.drag, radius: p.radius, groups };
};

/** Head, chest, hips, arm and leg colliders from the humanoid bones, sized from the avatar's height. */
function bodyColliders(avatar) {
  const h = avatar.humanoid; if (!h) return [];
  avatar.toRest();
  const H = avatar.height; const top = avatar.box.max.y;
  const N = (b) => h.getRawBoneNode(b); const W = (b) => N(b)?.getWorldPosition(new THREE.Vector3());
  const out = [];
  const add = (name, bone, shape, a, b, r, group) => {
    const n = N(bone); if (!n) return;
    const loc = (p) => n.worldToLocal(p.clone()).toArray().map((v) => +v.toFixed(4));
    out.push({ id: uid('c'), name, bone: n.name, shape, offset: loc(a), tail: b ? loc(b) : [0, 0, 0], radius: +r.toFixed(4), group });
  };
  const head = W('head');
  if (head) { const ht = Math.min(top, head.y + H * 0.16); const r = Math.max(H * 0.045, (ht - head.y) * 0.55); add('Head', 'head', 'sphere', new THREE.Vector3(head.x, head.y + (ht - head.y) * 0.45, head.z), null, Math.min(r, H * 0.075), 'Head'); }
  const chest = W('upperChest') || W('chest'); const neck = W('neck');
  if (chest && neck) add('Chest', N('upperChest') ? 'upperChest' : 'chest', 'capsule', chest.clone().add(new THREE.Vector3(0, -H * 0.04, 0)), neck.clone().add(new THREE.Vector3(0, -H * 0.03, 0)), H * 0.065, 'Body');
  const hips = W('hips'); if (hips) add('Hips', 'hips', 'sphere', hips, null, H * 0.07, 'Body');
  for (const s of ['left', 'right']) {
    const ua = W(`${s}UpperArm`); const la = W(`${s}LowerArm`);
    if (ua && la) add(`${s === 'left' ? 'Left' : 'Right'} upper arm`, `${s}UpperArm`, 'capsule', ua, la, H * 0.025, 'Arms');
    const ul = W(`${s}UpperLeg`); const ll = W(`${s}LowerLeg`);
    if (ul && ll) add(`${s === 'left' ? 'Left' : 'Right'} thigh`, `${s}UpperLeg`, 'capsule', ul, ll, H * 0.045, 'Body');
  }
  avatar.restore();
  return out;
}

export function SpringsPanel({ doc, edit, canEdit, avatar, setPick, view, setView, wiggle, selBone }) {
  const [open, setOpen] = useState(null);
  const sp = doc.springs;
  const human = new Set(Object.values(doc.humanoid.bones || {}));
  const groups = [...new Set(sp.colliders.map((c) => c.group || 'Body'))];
  const boneOpts = useMemo(() => (avatar ? avatar.bones.filter((b) => !human.has(b.name)).map((b) => ({ value: b.name, label: b.name })) : []), [avatar, doc.humanoid]); // eslint-disable-line react-hooks/exhaustive-deps
  const allBoneOpts = useMemo(() => (avatar ? avatar.bones.map((b) => ({ value: b.name, label: b.name })) : []), [avatar]);
  const setSp = (fn, label, merge) => edit((d) => ({ ...d, springs: fn(d.springs) }), label, merge);
  const setChain = (id, patch, label, merge) => setSp((s) => ({ ...s, chains: s.chains.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), label, merge);
  const setCol = (id, patch, label, merge) => setSp((s) => ({ ...s, colliders: s.colliders.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), label, merge);
  const addFrom = (name, preset = 'hair') => {
    if (!name) return;
    const used = new Set(sp.chains.flatMap((c) => c.bones));
    const chains = chainsFrom(avatar, name).filter((b) => b.length > 1 && !b.some((x) => used.has(x))).map((b) => newChain(b, preset, groups));
    if (!chains.length) { toast('No free bone chain under that bone (it needs at least one child bone).', { type: 'error' }); return; }
    setSp((s) => ({ ...s, chains: [...s.chains, ...chains] }), 'Add spring chain');
    setOpen(chains[0].id);
  };
  const findAll = () => {
    const used = new Set(sp.chains.flatMap((c) => c.bones));
    const found = [];
    for (const b of avatar.bones) {
      if (human.has(b.name) || used.has(b.name)) continue;
      const kind = SPRING_WORDS.find(([, re]) => re.test(b.name));
      if (!kind || SPRING_WORDS.some(([, re]) => re.test(b.parent?.name || '')) && !human.has(b.parent?.name)) continue; // start at the top of a run
      for (const chain of chainsFrom(avatar, b.name)) if (chain.length > 1 && !chain.some((x) => used.has(x))) { found.push(newChain(chain, kind[0], groups)); chain.forEach((x) => used.add(x)); }
    }
    if (!found.length) { toast('Didn’t find bones named like hair, skirt, ears or tail. Add chains from a bone instead.'); return; }
    setSp((s) => ({ ...s, chains: [...s.chains, ...found] }), 'Find spring bones');
    toast(`Added ${found.length} chains`, { type: 'success' });
  };
  if (!avatar) return <Hint className="p-3">Loading…</Hint>;
  return (
    <>
      <PanelSection title="Chains" id="n3-chains" actions={<Button size="xs" variant="ghost" icon="wave" onClick={wiggle}>Wiggle</Button>}>
        <Hint className="mb-2">Bones that swing on their own: hair, skirts, ears, tails. Each chain hangs from its first bone.</Hint>
        {sp.chains.map((ch) => (
          <div key={ch.id} className="border border-line rounded-md mb-1.5">
            <button type="button" className="w-full flex items-center gap-2 px-2 h-8 text-left" onClick={() => setOpen(open === ch.id ? null : ch.id)}>
              <Icon name={open === ch.id ? 'chevronDown' : 'chevronRight'} size={13} />
              <span className="text-[12px] flex-1 truncate">{ch.name}</span>
              <Badge>{ch.bones.length} bones</Badge>
            </button>
            {open === ch.id && (
              <div className="px-2 pb-2 flex flex-col gap-1.5">
                <Row label="Name"><TextInput value={ch.name} disabled={!canEdit} onChange={(e) => setChain(ch.id, { name: e.target.value }, 'Rename chain', `n-${ch.id}`)} className="!h-7 !w-36" /></Row>
                <Row label="Preset">
                  <Select small value={ch.preset || ''} disabled={!canEdit} onChange={(v) => { const p = SPRING_PRESETS[v]; setChain(ch.id, { preset: v, stiffness: p.stiffness, gravity: p.gravity, drag: p.drag, radius: p.radius }, 'Spring preset'); }}
                    options={[{ value: '', label: 'Custom' }, ...Object.entries(SPRING_PRESETS).map(([k, p]) => ({ value: k, label: p.label }))]} />
                </Row>
                <Slider label="Stiffness" value={ch.stiffness} min={0} max={4} step={0.05} disabled={!canEdit} onChange={(v) => setChain(ch.id, { stiffness: v, preset: '' }, 'Stiffness', `st-${ch.id}`)} />
                <Slider label="Gravity" value={ch.gravity} min={0} max={2} step={0.01} disabled={!canEdit} onChange={(v) => setChain(ch.id, { gravity: v, preset: '' }, 'Gravity', `gr-${ch.id}`)} />
                <Row label="Gravity direction">
                  <Select small value={(ch.gravityDir || [0, -1, 0]).join(',')} disabled={!canEdit} onChange={(v) => { const d = v.split(',').map(Number); const l = Math.hypot(...d) || 1; setChain(ch.id, { gravityDir: d.map((x) => +(x / l).toFixed(3)) }, 'Gravity direction'); }}
                    options={GRAVITY_DIRS.some((g) => g.value === (ch.gravityDir || []).join(',')) ? GRAVITY_DIRS : [...GRAVITY_DIRS, { value: (ch.gravityDir || []).join(','), label: 'From the file' }]} />
                </Row>
                <Slider label="Drag (damping)" value={ch.drag} min={0} max={1} step={0.01} disabled={!canEdit} onChange={(v) => setChain(ch.id, { drag: v, preset: '' }, 'Drag', `dr-${ch.id}`)} />
                <Slider label="Hit radius" value={ch.radius} min={0} max={0.15} step={0.001} unit="m" disabled={!canEdit} onChange={(v) => setChain(ch.id, { radius: v }, 'Hit radius', `hr-${ch.id}`)} />
                <div className="text-xs text-fg2 mt-1">Collides with</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {groups.length ? groups.map((g) => (
                    <Checkbox key={g} label={g} checked={(ch.groups || []).includes(g)} onChange={(v) => canEdit && setChain(ch.id, { groups: v ? [...new Set([...(ch.groups || []), g])] : (ch.groups || []).filter((x) => x !== g) }, 'Chain colliders')} />
                  )) : <Hint>No colliders yet.</Hint>}
                </div>
                <div className="text-[11px] text-fg3 break-words">{ch.bones.join(' → ')}</div>
                {canEdit && <Button size="xs" variant="ghost" icon="trash" className="self-start" onClick={() => setSp((s) => ({ ...s, chains: s.chains.filter((c) => c.id !== ch.id) }), 'Delete chain')}>Delete chain</Button>}
              </div>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex flex-col gap-1.5 mt-2">
            <div className="flex items-center gap-1">
              <Select small value="" onChange={(v) => addFrom(v)} options={[{ value: '', label: 'Add chains from a bone…' }, ...boneOpts]} className="flex-1 min-w-0" />
              <IconButton size={28} label="Pick the bone in the view" onClick={() => { setView({ ...view, skeleton: true }); setPick({ label: 'Click the first bone of the hair, skirt, ear or tail', onPick: (n) => addFrom(n) }); }}><Icon name="select" size={14} /></IconButton>
            </div>
            <Button size="sm" variant="ghost" icon="search" onClick={findAll}>Find hair, skirt, ears and tail</Button>
          </div>
        )}
      </PanelSection>
      <PanelSection title="Colliders" id="n3-colliders" actions={canEdit && <Button size="xs" variant="ghost" icon="plus" onClick={() => {
        const list = bodyColliders(avatar);
        if (!list.length) { toast('Map the humanoid bones first (Rig & bones).', { type: 'error' }); return; }
        setSp((s) => ({ ...s, colliders: [...s.colliders, ...list], chains: s.chains.map((c) => ({ ...c, groups: [...new Set([...(c.groups || []), ...list.map((x) => x.group)])] })) }), 'Add body colliders');
      }}>Body set</Button>}>
        <Hint className="mb-2">Spheres and capsules on the body that spring bones can’t pass through. They show as wire shapes in the view.</Hint>
        {sp.colliders.map((c) => (
          <div key={c.id} className="border border-line rounded-md mb-1.5">
            <button type="button" className="w-full flex items-center gap-2 px-2 h-8 text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <Icon name={open === c.id ? 'chevronDown' : 'chevronRight'} size={13} />
              <span className="text-[12px] flex-1 truncate">{c.name || c.bone}</span>
              <Badge>{c.shape === 'capsule' ? 'capsule' : 'sphere'} · {c.group}</Badge>
            </button>
            {open === c.id && (
              <div className="px-2 pb-2 flex flex-col gap-1.5">
                <Row label="On bone"><Select small value={c.bone} disabled={!canEdit} onChange={(v) => setCol(c.id, { bone: v }, 'Collider bone')} options={allBoneOpts} className="max-w-[160px]" /></Row>
                <Row label="Shape"><Segmented value={c.shape} onChange={(v) => canEdit && setCol(c.id, { shape: v, tail: v === 'capsule' && !c.tail?.some(Boolean) ? [0, 0.1, 0] : c.tail }, 'Collider shape')} options={[{ value: 'sphere', label: 'Sphere' }, { value: 'capsule', label: 'Capsule' }]} /></Row>
                <Slider label="Radius" value={c.radius} min={0.005} max={0.4} step={0.001} unit="m" disabled={!canEdit} onChange={(v) => setCol(c.id, { radius: v }, 'Collider radius', `cr-${c.id}`)} />
                {[['offset', 'Centre'], ...(c.shape === 'capsule' ? [['tail', 'Other end']] : [])].map(([k, label]) => (
                  <Row key={k} label={label}>
                    {[0, 1, 2].map((i) => <NumberInput key={i} label={'xyz'[i]} value={(c[k] || [0, 0, 0])[i]} step={0.005} precision={3} width={46} disabled={!canEdit}
                      onChange={(v) => setCol(c.id, { [k]: (c[k] || [0, 0, 0]).map((x, j) => (j === i ? v : x)) }, 'Move collider', `co-${c.id}-${k}${i}`)} />)}
                  </Row>
                ))}
                <Row label="Group"><TextInput value={c.group || ''} disabled={!canEdit} onChange={(e) => setCol(c.id, { group: e.target.value }, 'Collider group', `cg-${c.id}`)} className="!h-7 !w-28" /></Row>
                {canEdit && <Button size="xs" variant="ghost" icon="trash" className="self-start" onClick={() => setSp((s) => ({ ...s, colliders: s.colliders.filter((x) => x.id !== c.id) }), 'Delete collider')}>Delete collider</Button>}
              </div>
            )}
          </div>
        ))}
        {canEdit && <Button size="xs" variant="ghost" icon="plus" onClick={() => {
          const add = (bone) => { const id = uid('c'); setSp((s) => ({ ...s, colliders: [...s.colliders, { id, name: bone, bone, shape: 'sphere', offset: [0, 0, 0], tail: [0, 0, 0], radius: +(avatar.height * 0.04).toFixed(3), group: groups[0] || 'Body' }] }), 'Add collider'); setOpen(id); };
          if (selBone) add(selBone); else { setView({ ...view, skeleton: true }); setPick({ label: 'Click the bone to put a collider on', onPick: add }); }
        }}>{selBone ? `Add a collider on ${selBone}` : 'Add a collider…'}</Button>}
        <div className="flex gap-3 mt-2">
          <Toggle checked={view.colliders} onChange={(v) => setView({ ...view, colliders: v })} label="Show colliders" />
          <Toggle checked={view.joints} onChange={(v) => setView({ ...view, joints: v })} label="Joints" />
        </div>
      </PanelSection>
    </>
  );
}

// ================================================================ Look & materials

export function LookPanel({ doc, edit, canEdit, avatar, docId, rev }) {
  const look = doc.look;
  const setLook = (patch, label, merge) => edit((d) => ({ ...d, look: { ...d.look, ...patch } }), label, merge);
  const mats = useMemo(() => avatar?.materialList() || [], [avatar, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState(null);
  const setMat = (name, patch, label, merge) => edit((d) => ({ ...d, materials: { ...d.materials, [name]: { ...(d.materials[name] || {}), ...patch } } }), label, merge);
  return (
    <>
      <PanelSection title="Lighting" id="n3-light">
        <Row label="Preset"><Select small value={look.light} disabled={!canEdit} onChange={(v) => setLook({ light: v }, 'Lighting')} options={LIGHTS} /></Row>
        <Slider label="Brightness" value={look.exposure} min={0.2} max={2} step={0.05} reset={1} disabled={!canEdit} onChange={(v) => setLook({ exposure: v }, 'Brightness', 'exposure')} />
        <Toggle className="mt-2" checked={look.env} disabled={!canEdit} onChange={(v) => setLook({ env: v }, 'Environment')} label="Room reflections (for standard materials)" />
        <Row label="Editor background" className="mt-1"><ColorSwatch value={look.background} alpha={false} onChange={(v) => setLook({ background: v }, 'Background', 'bg')} /></Row>
        <Hint>The stage (Perform / OBS) has its own background and can be transparent.</Hint>
      </PanelSection>
      <PanelSection title="Materials" id="n3-mats" actions={canEdit && mats.length > 0 && <Button size="xs" variant="ghost" onClick={() => edit((d) => ({ ...d, materials: Object.fromEntries(mats.map((m) => [m.name, { ...(d.materials[m.name] || {}), type: 'mtoon' }])) }), 'Toon look')}>All MToon</Button>}>
        {!mats.length && <Hint>No materials.</Hint>}
        {mats.map((m) => {
          const cfg = doc.materials[m.name] || {};
          const type = cfg.type || 'keep';
          const toon = type === 'mtoon' || (type === 'keep' && m.type === 'MToon');
          const v = (k, d) => cfg[k] ?? m[k] ?? d;
          return (
            <div key={m.name} className="border border-line rounded-md mb-1.5">
              <button type="button" className="w-full flex items-center gap-2 px-2 h-8 text-left" onClick={() => setOpen(open === m.name ? null : m.name)}>
                <Icon name={open === m.name ? 'chevronDown' : 'chevronRight'} size={13} />
                <span className="w-3.5 h-3.5 rounded-sm border border-line shrink-0" style={{ background: v('color', '#fff') }} />
                <span className="text-[12px] flex-1 truncate">{m.name}</span>
                <Badge>{type === 'keep' ? m.type : { mtoon: 'MToon', unlit: 'Unlit', standard: 'Standard' }[type]}</Badge>
              </button>
              {open === m.name && (
                <div className="px-2 pb-2 flex flex-col gap-1.5">
                  <Row label="Shader">
                    <Select small value={type} disabled={!canEdit} onChange={(t) => setMat(m.name, { type: t }, 'Material shader')}
                      options={[{ value: 'keep', label: `Original (${m.type})` }, { value: 'mtoon', label: 'MToon (toon)' }, { value: 'unlit', label: 'Unlit' }, { value: 'standard', label: 'Standard (PBR)' }]} />
                  </Row>
                  <Row label="Colour"><ColorSwatch value={v('color', '#ffffff')} alpha={false} onChange={(x) => setMat(m.name, { color: x }, 'Material colour', `mc-${m.name}`)} /></Row>
                  {toon && (
                    <>
                      <Row label="Shade colour"><ColorSwatch value={v('shade', '#999999')} alpha={false} onChange={(x) => setMat(m.name, { shade: x }, 'Shade colour', `ms-${m.name}`)} /></Row>
                      <Slider label="Toon sharpness" value={v('toony', 0.9)} min={0} max={1} step={0.01} disabled={!canEdit} onChange={(x) => setMat(m.name, { toony: x }, 'Toon sharpness', `mt-${m.name}`)} />
                      <Slider label="Shade amount" value={-v('shadeShift', 0)} min={-1} max={1} step={0.01} disabled={!canEdit} onChange={(x) => setMat(m.name, { shadeShift: -x }, 'Shade amount', `mh-${m.name}`)} />
                      <Slider label="Outline width" value={+(v('outline', 0) * 1000).toFixed(2)} min={0} max={10} step={0.1} unit="mm" disabled={!canEdit} onChange={(x) => setMat(m.name, { outline: x / 1000 }, 'Outline width', `mo-${m.name}`)} />
                      <Row label="Outline colour"><ColorSwatch value={v('outlineColor', '#000000')} alpha={false} onChange={(x) => setMat(m.name, { outlineColor: x }, 'Outline colour', `moc-${m.name}`)} /></Row>
                      <Row label="Rim light"><ColorSwatch value={v('rim', '#000000')} alpha={false} onChange={(x) => setMat(m.name, { rim: x }, 'Rim colour', `mr-${m.name}`)} /></Row>
                      <Slider label="Rim tightness" value={v('rimPower', 3)} min={0.5} max={10} step={0.1} disabled={!canEdit} onChange={(x) => setMat(m.name, { rimPower: x }, 'Rim tightness', `mrp-${m.name}`)} />
                    </>
                  )}
                  {type !== 'unlit' && (
                    <>
                      <Row label="Glow (emission)"><ColorSwatch value={v('emission', '#000000')} alpha={false} onChange={(x) => setMat(m.name, { emission: x }, 'Emission', `me-${m.name}`)} /></Row>
                      <Slider label="Glow strength" value={v('emissionStrength', 1)} min={0} max={5} step={0.05} disabled={!canEdit} onChange={(x) => setMat(m.name, { emissionStrength: x }, 'Emission strength', `mes-${m.name}`)} />
                    </>
                  )}
                  <Row label="Texture">
                    {cfg.map && <img src={assetSrc(cfg.map)} alt="" className="w-7 h-7 rounded object-cover border border-line" />}
                    {canEdit && <Button size="xs" variant="ghost" icon="image" onClick={async () => { const [a] = (await pickAssets({ kinds: ['image'], multiple: false, docId, title: 'Swap texture' })) || []; if (a) setMat(m.name, { map: a.id }, 'Swap texture'); }}>{cfg.map ? 'Change' : 'Swap…'}</Button>}
                    {cfg.map && canEdit && <IconButton size={24} icon="close" iconSize={13} label="Back to the original texture" onClick={() => setMat(m.name, { map: null }, 'Original texture')} />}
                  </Row>
                  {canEdit && Object.keys(cfg).length > 0 && <Button size="xs" variant="ghost" icon="undo" className="self-start" onClick={() => edit((d) => { const x = { ...d.materials }; delete x[m.name]; return { ...d, materials: x }; }, 'Reset material')}>Reset to the file’s material</Button>}
                </div>
              )}
            </div>
          );
        })}
      </PanelSection>
    </>
  );
}

// ================================================================ Tracking

const TEST_DEFAULT = { headYaw: 0, headPitch: 0, headRoll: 0, eyeX: 0, eyeY: 0, eyeLOpen: 1, eyeROpen: 1, mouthOpen: 0, mouthForm: 0, browL: 0, browR: 0 };

export function TrackingPanel({ doc, edit, canEdit, avatar, testPose, setTestPose }) {
  const t = { ...DEFAULT_DRIVE, ...doc.drive };
  const set = (patch, label, merge) => edit((d) => ({ ...d, drive: { ...d.drive, ...patch } }), label, merge);
  const S = (k, label, min, max, step, unit) => <Slider key={k} label={label} value={t[k]} min={min} max={max} step={step} unit={unit} reset={DEFAULT_DRIVE[k]} disabled={!canEdit} onChange={(v) => set({ [k]: v }, label, `trk-${k}`)} />;
  const tp = testPose || TEST_DEFAULT;
  const T = (k, label, min, max, step = 1) => <Slider key={k} label={label} value={tp[k]} min={min} max={max} step={step} reset={TEST_DEFAULT[k]} onChange={(v) => setTestPose({ ...tp, [k]: v })} />;
  return (
    <>
      <PanelSection title="Try a pose" id="n3-test">
        <Toggle checked={!!testPose} onChange={(v) => setTestPose(v ? { ...TEST_DEFAULT } : null)} label="Use these instead of tracking" />
        {testPose && (
          <div className="flex flex-col gap-1.5 mt-2">
            {T('headYaw', 'Head turn', -40, 40)}{T('headPitch', 'Head up / down', -30, 30)}{T('headRoll', 'Head tilt', -30, 30)}
            {T('eyeX', 'Eyes left / right', -1, 1, 0.01)}{T('eyeY', 'Eyes up / down', -1, 1, 0.01)}
            {T('eyeLOpen', 'Left eye open', 0, 1, 0.01)}{T('eyeROpen', 'Right eye open', 0, 1, 0.01)}
            {T('mouthOpen', 'Mouth open', 0, 1, 0.01)}{T('mouthForm', 'Frown / smile', -1, 1, 0.01)}
            <Slider label="Eyebrows" value={tp.browL} min={-1} max={1} step={0.01} reset={0} onChange={(v) => setTestPose({ ...tp, browL: v, browR: v })} />
          </div>
        )}
        {!testPose && <Hint className="mt-1.5">With tracking off, the avatar breathes, sways and blinks on its own{t.idle ? '' : ' (idle is turned off below)'}.</Hint>}
      </PanelSection>
      <PanelSection title="Head and body" id="n3-trk-head">
        <Toggle checked={t.mirror} disabled={!canEdit} onChange={(v) => set({ mirror: v }, 'Swap sides')} label="Swap left and right" />
        <Hint className="mt-1">Mirroring is set in Perform → Tracking; use this only if this model turns the wrong way.</Hint>
        <div className="flex flex-col gap-1.5 mt-2">
          {S('head', 'Head sensitivity', 0, 2, 0.05)}
          <div className="text-xs text-fg2 mt-1">A head turn is shared out between</div>
          {['head', 'neck', 'spine'].map((k) => (
            <Slider key={k} label={{ head: 'Head', neck: 'Neck', spine: 'Upper body' }[k]} value={t.split[k]} min={0} max={1} step={0.05} reset={DEFAULT_DRIVE.split[k]} disabled={!canEdit}
              onChange={(v) => set({ split: { ...t.split, [k]: v } }, 'Head/neck split', `trk-split-${k}`)} />
          ))}
          {S('body', 'Body lean', 0, 2, 0.05)}
          {S('move', 'Lean with head position', 0, 2, 0.05)}
          <Toggle checked={t.armAngle === null || t.armAngle === undefined} disabled={!canEdit} onChange={(v) => set({ armAngle: v ? null : Math.round(avatar?.autoArm ?? 60) }, 'Arm pose')} label="Lower T-posed arms automatically" />
          {t.armAngle !== null && t.armAngle !== undefined && <Slider label="Lower arms by" value={t.armAngle} min={0} max={85} step={1} unit="°" disabled={!canEdit} onChange={(v) => set({ armAngle: v }, 'Arm pose', 'trk-arm')} />}
          <Toggle checked={t.idle} disabled={!canEdit} onChange={(v) => set({ idle: v }, 'Idle motion')} label="Breathe and sway when tracking is lost" />
        </div>
      </PanelSection>
      <PanelSection title="Eyes" id="n3-trk-eyes">
        <div className="flex flex-col gap-1.5">
          {S('eyes', 'Gaze sensitivity', 0, 2, 0.05)}
          {doc.lookAt.type !== 'expression' && avatar?.lookAt?.applier?.humanoid && <Slider label="Eye turn (eye bones)" value={doc.lookAt.range} min={2} max={30} step={0.5} unit="°" disabled={!canEdit} onChange={(v) => edit((d) => ({ ...d, lookAt: { ...d.lookAt, range: v } }), 'Eye range', 'trk-range')} />}
          <Row label="Eyes move by">
            <Select small value={doc.lookAt.type || 'auto'} disabled={!canEdit} onChange={(v) => edit((d) => ({ ...d, lookAt: { ...d.lookAt, type: v } }), 'Look-at type')}
              options={[{ value: 'auto', label: 'Automatic' }, { value: 'bone', label: 'Eye bones' }, { value: 'expression', label: 'Look expressions' }]} />
          </Row>
          {S('blink', 'Blink sensitivity', 0, 2, 0.05)}
          {S('blinkClosed', 'Counts as closed below', 0, 0.6, 0.01)}
          {S('blinkOpen', 'Counts as open above', 0.3, 1, 0.01)}
          <Toggle checked={t.linkEyes} disabled={!canEdit} onChange={(v) => set({ linkEyes: v }, 'Link eyes')} label="Blink both eyes together" />
        </div>
      </PanelSection>
      <PanelSection title="Mouth and brows" id="n3-trk-mouth">
        <div className="flex flex-col gap-1.5">
          {S('mouth', 'Mouth sensitivity', 0, 2, 0.05)}
          {S('smile', 'Smile → Happy', 0, 1.5, 0.05)}
          {S('brows', 'Eyebrows', 0, 1.5, 0.05)}
          <Hint>Mouth shapes come from aa/ih/ou/ee/oh visemes (mic or face) when tracking sends them, otherwise “mouth open” drives “aa”. Hands aren’t driven yet.</Hint>
        </div>
      </PanelSection>
    </>
  );
}

// ================================================================ Stage camera

export function CameraPanel({ doc, edit, canEdit, stageCam, setStageCam, saveView }) {
  const cam = doc.camera;
  const set = (patch, label, merge) => edit((d) => ({ ...d, camera: { ...d.camera, ...patch } }), label, merge);
  return (
    <PanelSection title="Stage camera" id="n3-cam">
      <Toggle checked={stageCam} onChange={setStageCam} label="Look through the stage camera" />
      <div className="grid grid-cols-3 gap-1 mt-2">
        {FRAMINGS.map((f) => (
          <Button key={f.value} size="xs" variant={cam.framing === f.value ? 'primary' : 'secondary'} disabled={!canEdit || (f.value === 'custom' && !cam.custom)}
            onClick={() => { set({ framing: f.value }, 'Stage framing'); setStageCam(true); }}>{f.label}</Button>
        ))}
      </div>
      {cam.framing !== 'custom' && (
        <div className="flex flex-col gap-1.5 mt-2">
          <Slider label="Zoom" value={cam.zoom} min={0.5} max={2.5} step={0.01} reset={1} disabled={!canEdit} onChange={(v) => set({ zoom: v }, 'Stage zoom', 'cam-zoom')} />
          <Slider label="Left / right" value={cam.x} min={-0.5} max={0.5} step={0.01} reset={0} disabled={!canEdit} onChange={(v) => set({ x: v }, 'Stage offset', 'cam-x')} />
          <Slider label="Up / down" value={cam.y} min={-0.5} max={0.5} step={0.01} reset={0} disabled={!canEdit} onChange={(v) => set({ y: v }, 'Stage offset', 'cam-y')} />
          <Slider label="Turn" value={cam.turn} min={-60} max={60} step={1} unit="°" reset={0} disabled={!canEdit} onChange={(v) => set({ turn: v }, 'Stage turn', 'cam-turn')} />
        </div>
      )}
      <Slider className="mt-1.5" label="Lens (field of view)" value={cam.fov} min={10} max={60} step={1} unit="°" reset={30} disabled={!canEdit} onChange={(v) => set({ fov: v }, 'Stage lens', 'cam-fov')} />
      {canEdit && <Button size="sm" className="mt-2" icon="camera" onClick={() => { set({ framing: 'custom', custom: saveView() }, 'Stage camera from view'); setStageCam(true); }}>Use the current view</Button>}
      <Hint className="mt-2">Perform and the OBS output use this framing. Their background can be transparent; the PNG snapshot export can be too.</Hint>
    </PanelSection>
  );
}

// ================================================================ Info & licence

export function InfoPanel({ doc, edit, canEdit, docId }) {
  const m = doc.meta;
  const set = (patch, label, merge) => edit((d) => ({ ...d, meta: { ...d.meta, ...patch } }), label, merge);
  const T = (k, label, ph) => <div key={k} className="flex flex-col gap-0.5"><span className="text-xs text-fg2">{label}</span><TextInput value={m[k] || ''} placeholder={ph} disabled={!canEdit} onChange={(e) => set({ [k]: e.target.value }, label, `meta-${k}`)} className="!h-7" /></div>;
  return (
    <>
      <PanelSection title="About this avatar" id="n3-meta">
        <div className="flex flex-col gap-2">
          {T('name', 'Avatar name')}{T('authors', 'Authors', 'Comma-separated')}{T('version', 'Version')}
          {T('copyright', 'Copyright')}{T('contact', 'Contact', 'Email or URL')}{T('references', 'Based on / references', 'Comma-separated')}
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg2 flex-1">Thumbnail</span>
            {m.thumbnail ? <img src={assetSrc(m.thumbnail)} alt="" className="w-12 h-12 rounded object-cover border border-line" /> : <span className="text-[11px] text-fg3">A bust-up snapshot</span>}
            {canEdit && <Button size="xs" variant="ghost" icon="image" onClick={async () => { const [a] = (await pickAssets({ kinds: ['image'], multiple: false, docId, title: 'VRM thumbnail' })) || []; if (a) set({ thumbnail: a.id }, 'Thumbnail'); }}>Choose…</Button>}
            {m.thumbnail && canEdit && <IconButton size={24} icon="close" iconSize={13} label="Use a snapshot" onClick={() => set({ thumbnail: null }, 'Thumbnail')} />}
          </div>
        </div>
      </PanelSection>
      <PanelSection title="Licence (VRM 1.0)" id="n3-license">
        <div className="flex flex-col gap-2">
          {[['avatarPermission', 'Who may use it as an avatar'], ['commercialUsage', 'Commercial use'], ['creditNotation', 'Credit'], ['modification', 'Modifying']].map(([k, label]) => (
            <div key={k} className="flex flex-col gap-0.5"><span className="text-xs text-fg2">{label}</span>
              <Select small value={m[k]} disabled={!canEdit} onChange={(v) => set({ [k]: v }, label)} options={LICENSE[k].map(([value, l]) => ({ value, label: l }))} /></div>
          ))}
          {LICENSE_FLAGS.map(([k, label]) => <Toggle key={k} checked={!!m[k]} disabled={!canEdit} onChange={(v) => set({ [k]: v }, label)} label={label} />)}
          {T('otherLicenseUrl', 'Other licence URL', 'https://…')}
          <Hint>Saved into exported VRM files with the VRM Public License 1.0 (vrm.dev/licenses/1.0). Apps like VRoid Hub show these terms to people who use your avatar.</Hint>
        </div>
      </PanelSection>
    </>
  );
}
