// The 2D rig's right-hand panels: Parts (tree, checklist, inspector), Deformers, Parameters (with keys and keyform
// tools), Physics, Expressions and Tracking (pose → parameter bindings).
import { useState } from 'react';
import { Button, IconButton, NumberInput, Select, Slider, Toggle, Checkbox, TextInput, PanelSection, promptDialog, confirmDialog, toast, cx } from '../../../components/ui.jsx';
import { Icon } from '../../../components/Icons.jsx';
import { checklist, ROLES, paramById, uid, chainOf, wouldLoop, formKey, stdParam, STD_PARAMS, DEFAULT_BINDINGS, defaults } from './model.js';
import { POSE_KEYS, HAND_KEYS } from '../contract.js';
import { KEY_INFO } from '../tracking/pose.js';
import { HAND_KEY_INFO } from '../tracking/hands.js';
import { newChain } from './physics.js';
import { GestureInput, withGesture } from '../gestures.jsx';

const Row = ({ children, className }) => <div className={cx('flex items-center gap-2 min-h-7', className)}>{children}</div>;
const Label = ({ children }) => <span className="text-xs text-fg2 w-20 shrink-0">{children}</span>;
const roleOptions = [{ value: '', label: '— none —' }, ...ROLES.flatMap((r) => (r.side ? ['L', 'R'].map((s) => ({ value: `${r.id}${s}`, label: `${r.label} ${s}` })) : [{ value: r.id, label: r.label }]))];

// ---------------------------------------------------------------- parts

export function PartsPanel({ doc, sel, setSel, canEdit, edit, onAutoCrop, onRemesh, onDelete }) {
  const [open, setOpen] = useState({});
  const selIds = sel?.type === 'part' ? [sel.id, ...(sel.more || [])] : [];
  const editPart = (id, patch, label, merge) => edit((d) => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)) }), label, merge);
  // front-most first, like a layers panel; groups gather their parts
  const rows = []; const seenGroups = new Set();
  for (const p of [...doc.parts].reverse()) {
    if (p.group && doc.groups.some((g) => g.id === p.group)) {
      if (seenGroups.has(p.group)) continue;
      seenGroups.add(p.group);
      const g = doc.groups.find((x) => x.id === p.group);
      rows.push({ group: g, parts: [...doc.parts].reverse().filter((x) => x.group === g.id) });
    } else rows.push({ part: p });
  }
  const move = (dir) => {
    if (!selIds.length) return;
    edit((d) => {
      const parts = d.parts.slice(); const idx = parts.map((p, i) => (selIds.includes(p.id) ? i : -1)).filter((i) => i >= 0);
      // dir +1 = toward the front (later in the array)
      if (dir > 0) for (const i of idx.reverse()) { if (i < parts.length - 1 && !selIds.includes(parts[i + 1].id)) [parts[i], parts[i + 1]] = [parts[i + 1], parts[i]]; }
      else for (const i of idx) if (i > 0 && !selIds.includes(parts[i - 1].id)) [parts[i], parts[i - 1]] = [parts[i - 1], parts[i]];
      return { ...d, parts };
    }, dir > 0 ? 'Bring forward' : 'Send backward');
  };
  const group = async () => {
    if (!selIds.length) return;
    const name = await promptDialog({ title: 'Group parts', label: 'Group name', value: 'Group' });
    if (!name) return;
    const g = { id: uid('g'), name };
    edit((d) => ({ ...d, groups: [...d.groups, g], parts: d.parts.map((p) => (selIds.includes(p.id) ? { ...p, group: g.id } : p)) }), 'Group parts');
  };
  const ungroup = () => edit((d) => ({ ...d, parts: d.parts.map((p) => (selIds.includes(p.id) ? { ...p, group: null } : p)) }), 'Ungroup');
  const partRow = (p, indent) => (
    <div key={p.id} className={cx('flex items-center gap-1 h-7 pr-1 rounded cursor-pointer text-[13px]', selIds.includes(p.id) ? 'bg-active' : 'hover:bg-hover')} style={{ paddingLeft: indent ? 18 : 2 }}
      onClick={(e) => (e.shiftKey && sel?.type === 'part' ? setSel({ ...sel, more: [...new Set([...(sel.more || []), p.id])].filter((x) => x !== sel.id) }) : setSel({ type: 'part', id: p.id }))} data-testid="av-part-row">
      <button type="button" className="p-0.5 text-fg2 hover:text-fg" title={p.visible === false ? 'Show' : 'Hide'} onClick={(e) => { e.stopPropagation(); if (canEdit) editPart(p.id, { visible: p.visible === false }, 'Show / hide part'); }}>
        <Icon name={p.visible === false ? 'eyeOff' : 'eye'} size={14} />
      </button>
      <span className="truncate flex-1" onDoubleClick={async () => { if (!canEdit) return; const n = await promptDialog({ title: 'Rename part', label: 'Name', value: p.name }); if (n) editPart(p.id, { name: n }, 'Rename part'); }}>{p.name}</span>
      {p.role && <span className="text-[10px] text-accent bg-accent/10 rounded px-1 shrink-0">{p.role}</span>}
      {!!(p.clip || []).length && <Icon name="mask" size={12} className="text-fg3 shrink-0" title="Clipped" />}
      {!!(p.kf || []).length && <span className="w-1.5 h-1.5 rounded-full bg-sun shrink-0" title="Has keyforms" />}
    </div>
  );
  return (
    <>
      <PanelSection title={`Parts (${doc.parts.length})`} id="av-parts" actions={canEdit && (
        <div className="flex">
          <IconButton icon="chevronUp" label="Bring forward" size={24} iconSize={14} onClick={() => move(1)} disabled={!selIds.length} />
          <IconButton icon="chevronDown" label="Send backward" size={24} iconSize={14} onClick={() => move(-1)} disabled={!selIds.length} />
          <IconButton icon="group" label="Group selected parts" size={24} iconSize={14} onClick={group} disabled={!selIds.length} />
          <IconButton icon="ungroup" label="Ungroup" size={24} iconSize={14} onClick={ungroup} disabled={!selIds.length} />
          <IconButton icon="trash" label="Delete part" size={24} iconSize={14} onClick={() => onDelete(selIds)} disabled={!selIds.length} />
        </div>
      )}>
        {!doc.parts.length && <p className="text-xs text-fg3">No parts yet. File → Import PSD… brings in a layered PSD (each layer becomes a part).</p>}
        <div className="max-h-[38vh] overflow-y-auto scroll-thin -mx-1">
          {rows.map((r) => (r.part ? partRow(r.part) : (
            <div key={r.group.id}>
              <div className="flex items-center gap-1 h-7 text-[12px] text-fg2 font-medium cursor-pointer hover:bg-hover rounded" onClick={() => setOpen((o) => ({ ...o, [r.group.id]: !o[r.group.id] }))}>
                <Icon name={open[r.group.id] === false ? 'chevronRight' : 'chevronDown'} size={13} /><Icon name="folder" size={13} />
                <span className="truncate flex-1" onDoubleClick={async () => { if (!canEdit) return; const n = await promptDialog({ title: 'Rename group', label: 'Name', value: r.group.name }); if (n) edit((d) => ({ ...d, groups: d.groups.map((g) => (g.id === r.group.id ? { ...g, name: n } : g)) }), 'Rename group'); }}>{r.group.name}</span>
                <span className="text-fg3 text-[11px] pr-1">{r.parts.length}</span>
              </div>
              {open[r.group.id] !== false && r.parts.map((p) => partRow(p, true))}
            </div>
          )))}
        </div>
      </PanelSection>
      <ChecklistSection doc={doc} sel={sel} canEdit={canEdit} editPart={editPart} setSel={setSel} />
      {selIds.length === 1 && <PartInspector doc={doc} part={doc.parts.find((p) => p.id === selIds[0])} canEdit={canEdit} editPart={editPart} edit={edit} onAutoCrop={onAutoCrop} onRemesh={onRemesh} />}
    </>
  );
}

function ChecklistSection({ doc, sel, canEdit, editPart, setSel }) {
  const list = checklist(doc);
  const missing = list.filter((c) => !c.optional && !c.parts.length).length;
  return (
    <PanelSection title={`Rig checklist${missing ? ` · ${missing} missing` : ' · ready'}`} id="av-check" defaultOpen={false}>
      <p className="text-[11px] text-fg3 mb-2">Roles are guessed from layer names (Eye L white, 前髪, Arm L, Hand R peace…). Select a part and click “Use selected” to set one. Arms and hands are optional: with them, auto-rig adds arm rotation for hand tracking.</p>
      {list.map((c) => (
        <div key={c.id} className="flex items-center gap-1.5 h-6 text-[12px]">
          <Icon name={c.parts.length ? 'check' : c.optional ? 'dot' : 'warning'} size={13} className={c.parts.length ? 'text-ok' : c.optional ? 'text-fg3' : 'text-warn'} />
          <span className="w-28 shrink-0 truncate">{c.label}</span>
          <button type="button" className="truncate flex-1 text-left text-fg2 hover:text-fg" onClick={() => c.parts[0] && setSel({ type: 'part', id: c.parts[0].id })}>{c.parts.map((p) => p.name).join(', ') || (c.optional ? 'optional' : '—')}</button>
          {canEdit && sel?.type === 'part' && <button type="button" className="text-[11px] text-accent hover:underline shrink-0" onClick={() => editPart(sel.id, { role: c.id }, 'Set role')}>Use selected</button>}
        </div>
      ))}
    </PanelSection>
  );
}

function PartInspector({ doc, part, canEdit, editPart, edit, onAutoCrop, onRemesh }) {
  const [density, setDensity] = useState(part?.mesh?.density || 48);
  if (!part) return null;
  const others = doc.parts.filter((p) => p.id !== part.id);
  const e = (patch, label, merge) => canEdit && editPart(part.id, patch, label, merge);
  return (
    <PanelSection title="Part" id="av-part">
      <div className="flex flex-col gap-1.5">
        <Row><Label>Name</Label><TextInput value={part.name} disabled={!canEdit} onChange={(ev) => e({ name: ev.target.value }, 'Rename part', `name-${part.id}`)} className="!h-7" /></Row>
        <Row><Label>Role</Label><Select small value={part.role || ''} onChange={(v) => e({ role: v }, 'Set role')} options={roleOptions} className="flex-1 min-w-0" /></Row>
        <Row><Label>Opacity</Label><Slider className="flex-1" value={Math.round((part.opacity ?? 1) * 100)} min={0} max={100} onChange={(v) => e({ opacity: v / 100 }, 'Opacity', `op-${part.id}`)} /></Row>
        <Row><Label>Blend</Label><Select small value={part.blend || 'normal'} onChange={(v) => e({ blend: v }, 'Blend mode')} options={[{ value: 'normal', label: 'Normal' }, { value: 'multiply', label: 'Multiply' }, { value: 'screen', label: 'Screen' }, { value: 'add', label: 'Add' }]} /></Row>
        <Row><Label>Parent</Label><Select small value={part.parent || ''} onChange={(v) => e({ parent: v || null }, 'Set parent deformer')} options={[{ value: '', label: '— none —' }, ...doc.deformers.map((d) => ({ value: d.id, label: `${d.type === 'warp' ? '▦' : '↻'} ${d.name}` }))]} className="flex-1 min-w-0" /></Row>
        <div>
          <div className="text-xs text-fg2 mb-1">Clipping mask — show only where these parts are</div>
          <div className="flex flex-wrap gap-1">
            {(part.clip || []).map((c) => <span key={c} className="text-[11px] bg-chip rounded px-1.5 py-0.5 flex items-center gap-1">{doc.parts.find((p) => p.id === c)?.name || '?'}{canEdit && <button type="button" onClick={() => e((p) => ({ clip: p.clip.filter((x) => x !== c) }), 'Clipping mask')}><Icon name="close" size={10} /></button>}</span>)}
            {canEdit && <Select small value="" onChange={(v) => v && e((p) => ({ clip: [...(p.clip || []), v] }), 'Clipping mask')} options={[{ value: '', label: '+ Add mask…' }, ...others.filter((p) => !(part.clip || []).includes(p.id)).map((p) => ({ value: p.id, label: p.name }))]} />}
          </div>
          {!!(part.clip || []).length && <Checkbox className="mt-1" label="Invert (hide where the mask is)" checked={!!part.invertClip} onChange={(v) => e({ invertClip: v }, 'Invert mask')} />}
        </div>
        <div className="text-[11px] text-fg3">{part.w}×{part.h} px · {part.mesh ? `${part.mesh.v.length / 2} vertices, ${part.mesh.t.length / 3} triangles` : 'no mesh'}{part.mesh?.pins?.length ? ` · ${part.mesh.pins.length} pinned` : ''}</div>
        {canEdit && (
          <>
            <Row><Label>Mesh density</Label><Slider className="flex-1" value={density} min={12} max={160} onChange={setDensity} unit="px" /></Row>
            <div className="flex gap-1.5 flex-wrap">
              <Button size="sm" icon="grid" onClick={() => onRemesh(part.id, density)}>Auto mesh</Button>
              <Button size="sm" icon="crop" onClick={() => onAutoCrop(part.id)}>Auto-crop</Button>
            </div>
          </>
        )}
        <BindingList doc={doc} obj={part} canEdit={canEdit} edit={edit} />
      </div>
    </PanelSection>
  );
}

/** The keyform sets (bindings) an object has, with remove. */
function BindingList({ doc, obj, canEdit, edit }) {
  if (!obj.kf?.length) return <div className="text-[11px] text-fg3">No keyforms yet — pick a parameter, use the Deform tool (D).</div>;
  const kind = doc.parts.some((p) => p.id === obj.id) ? 'parts' : 'deformers';
  return (
    <div className="mt-1">
      <div className="text-xs text-fg2 mb-1">Keyforms</div>
      {obj.kf.map((b, i) => (
        <div key={i} className="flex items-center gap-1 text-[12px] h-6">
          <Icon name="keyframe" size={12} className="text-sun" />
          <span className="flex-1 truncate">{b.params.map((p) => paramById(doc, p)?.name || p).join(' × ')}</span>
          <span className="text-fg3">{Object.keys(b.forms).length} forms</span>
          {canEdit && <IconButton icon="trash" label="Remove these keyforms" size={22} iconSize={12} onClick={() => edit((d) => ({ ...d, [kind]: d[kind].map((o) => (o.id === obj.id ? { ...o, kf: o.kf.filter((_, k) => k !== i) } : o)) }), 'Remove keyforms')} />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- deformers

export function DeformersPanel({ doc, sel, setSel, canEdit, edit, onAdd, onAutoRig, report }) {
  const d = sel?.type === 'deformer' ? doc.deformers.find((x) => x.id === sel.id) : null;
  const editDef = (id, patch, label, merge) => edit((x) => ({ ...x, deformers: x.deformers.map((q) => (q.id === id ? { ...q, ...patch } : q)) }), label, merge);
  const tree = (parent, depth) => doc.deformers.filter((x) => (x.parent || null) === parent).flatMap((x) => [{ x, depth }, ...(depth < 12 ? tree(x.id, depth + 1) : [])]);
  const rows = tree(null, 0);
  return (
    <>
      <PanelSection title="Rig assist" id="av-assist">
        <Button size="sm" variant="primary" icon="sparkles" disabled={!canEdit || !doc.parts.length} onClick={onAutoRig} data-testid="av-autorig">Auto-rig face</Button>
        <p className="text-[11px] text-fg3 mt-1.5">Sets up head angle X/Y/Z, eye blink, eyeballs, brows, mouth open and smile, breathing and hair sway from the named parts. Run it again after renaming parts; it replaces only what it made.</p>
        {report?.length > 0 && <ul className="mt-1.5 text-[11px] text-fg2 list-disc pl-4">{report.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </PanelSection>
      <PanelSection title={`Deformers (${doc.deformers.length})`} id="av-defs" actions={canEdit && (
        <div className="flex">
          <IconButton icon="grid" label="Add warp deformer around the selection" size={24} iconSize={14} onClick={() => onAdd('warp')} />
          <IconButton icon="rotate" label="Add rotation deformer" size={24} iconSize={14} onClick={() => onAdd('rotation')} />
          <IconButton icon="trash" label="Delete deformer" size={24} iconSize={14} disabled={!d} onClick={() => d && edit((x) => ({ ...x, deformers: x.deformers.filter((q) => q.id !== d.id).map((q) => (q.parent === d.id ? { ...q, parent: d.parent } : q)), parts: x.parts.map((p) => (p.parent === d.id ? { ...p, parent: d.parent } : p)) }), 'Delete deformer')} />
        </div>
      )}>
        {!rows.length && <p className="text-xs text-fg3">Warp deformers bend what’s inside them with a grid; rotation deformers turn things around a pivot. Nest them (Body → Head → Face) and put parts inside.</p>}
        {rows.map(({ x, depth }) => (
          <div key={x.id} onClick={() => setSel({ type: 'deformer', id: x.id })} style={{ paddingLeft: 4 + depth * 14 }}
            className={cx('flex items-center gap-1.5 h-7 rounded cursor-pointer text-[13px]', sel?.id === x.id ? 'bg-active' : 'hover:bg-hover')}>
            <Icon name={x.type === 'warp' ? 'grid' : 'rotate'} size={13} className="text-sun" />
            <span className="truncate flex-1">{x.name}</span>
            <span className="text-[11px] text-fg3 pr-1">{doc.parts.filter((p) => p.parent === x.id).length || ''}</span>
          </div>
        ))}
      </PanelSection>
      {d && (
        <PanelSection title={d.type === 'warp' ? 'Warp deformer' : 'Rotation deformer'} id="av-def">
          <div className="flex flex-col gap-1.5">
            <Row><Label>Name</Label><TextInput value={d.name} disabled={!canEdit} onChange={(e) => editDef(d.id, { name: e.target.value }, 'Rename deformer', `dn-${d.id}`)} className="!h-7" /></Row>
            <Row><Label>Parent</Label><Select small value={d.parent || ''} className="flex-1 min-w-0" onChange={(v) => { if (v && wouldLoop(doc, d.id, v)) { toast('That would put the deformer inside itself.', { type: 'error' }); return; } editDef(d.id, { parent: v || null }, 'Set parent'); }}
              options={[{ value: '', label: '— none —' }, ...doc.deformers.filter((q) => q.id !== d.id).map((q) => ({ value: q.id, label: q.name }))]} /></Row>
            <Row><Label>Opacity</Label><Slider className="flex-1" value={Math.round((d.opacity ?? 1) * 100)} min={0} max={100} onChange={(v) => editDef(d.id, { opacity: v / 100 }, 'Opacity', `dop-${d.id}`)} /></Row>
            {d.type === 'warp' ? (
              <Row><Label>Grid</Label>
                <NumberInput value={d.cols} min={1} max={10} width={44} onChange={async (v) => { if (d.kf?.length && !(await confirmDialog({ title: 'Change the grid?', message: 'This clears the deformer’s keyforms (their points no longer match).', confirm: 'Change grid' }))) return; editDef(d.id, { cols: v, kf: [] }, 'Warp grid'); }} />
                <span className="text-fg3">×</span>
                <NumberInput value={d.rows} min={1} max={10} width={44} onChange={async (v) => { if (d.kf?.length && !(await confirmDialog({ title: 'Change the grid?', message: 'This clears the deformer’s keyforms (their points no longer match).', confirm: 'Change grid' }))) return; editDef(d.id, { rows: v, kf: [] }, 'Warp grid'); }} />
              </Row>
            ) : (
              <Row><Label>Pivot</Label><NumberInput value={Math.round(d.pivot[0])} width={56} onChange={(v) => editDef(d.id, { pivot: [v, d.pivot[1]] }, 'Pivot', `pv-${d.id}`)} /><NumberInput value={Math.round(d.pivot[1])} width={56} onChange={(v) => editDef(d.id, { pivot: [d.pivot[0], v] }, 'Pivot', `pv-${d.id}`)} /></Row>
            )}
            <div className="text-[11px] text-fg3">Inside: {[...doc.parts.filter((p) => p.parent === d.id).map((p) => p.name), ...doc.deformers.filter((q) => q.parent === d.id).map((q) => q.name)].join(', ') || 'nothing yet (set a part’s Parent)'}</div>
            <div className="text-[11px] text-fg3">Chain: {[d, ...chainOf(doc, d.parent)].map((q) => q.name).reverse().join(' → ')}</div>
            <BindingList doc={doc} obj={d} canEdit={canEdit} edit={edit} />
          </div>
        </PanelSection>
      )}
    </>
  );
}

// ---------------------------------------------------------------- parameters

export function ParamsPanel({ doc, values, setValues, active, setActive, canEdit, edit, sel, onAddKey, onRemoveKey, onMirror, onMirrorPair, onBind }) {
  const [editing, setEditing] = useState(null);
  const obj = sel ? (doc.parts.find((p) => p.id === sel.id) || doc.deformers.find((d) => d.id === sel.id)) : null;
  const usedBy = (pid) => [...doc.parts, ...doc.deformers].filter((o) => o.kf?.some((b) => b.params.includes(pid))).length;
  const addParam = async () => {
    const free = STD_PARAMS.filter(([id]) => !paramById(doc, id));
    const id = await promptDialog({ title: 'New parameter', label: `ID (e.g. ParamRibbon${free.length ? ` or a standard one like ${free[0][0]}` : ''})`, value: free[0]?.[0] || 'ParamCustom' });
    if (!id) return;
    if (paramById(doc, id)) { toast('That parameter already exists.', { type: 'error' }); return; }
    const p = stdParam(id) || { id, name: id.replace(/^Param/, ''), min: -1, def: 0, max: 1, keys: [-1, 0, 1] };
    edit((d) => ({ ...d, params: [...d.params, p] }), 'New parameter'); setActive(id);
  };
  return (
    <PanelSection title="Parameters" id="av-params" actions={(
      <div className="flex">
        <IconButton icon="refresh" label="Reset all to default" size={24} iconSize={14} onClick={() => setValues(defaults(doc))} />
        {canEdit && <IconButton icon="plus" label="New parameter" size={24} iconSize={14} onClick={addParam} />}
      </div>
    )}>
      {obj && canEdit && (
        <div className="rounded-md bg-panel-2 p-2 mb-2 text-[12px] flex flex-col gap-1.5">
          <div className="text-fg2">Selected: <b className="text-fg">{obj.name}</b>{active ? <> · parameter <b className="text-fg">{paramById(doc, active)?.name}</b></> : ''}</div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" disabled={!active} onClick={() => onBind(obj, [active])}>Add keyforms</Button>
            <Select small value="" onChange={(v) => v && onBind(obj, [active, v])} disabled={!active}
              options={[{ value: '', label: 'Combine with…' }, ...doc.params.filter((p) => p.id !== active).map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" icon="flipH" disabled={!active} onClick={() => onMirror(obj, active)} title="Copy this key’s form to the opposite key, mirrored (e.g. Angle X +30 → −30)">Mirror to opposite key</Button>
            {sel.type === 'part' && <Button size="sm" icon="flipH" onClick={() => onMirrorPair(obj)} title="Copy every keyform to the matching part on the other side (Eye L → Eye R)">Copy to other side</Button>}
          </div>
        </div>
      )}
      <div className="flex flex-col">
        {doc.params.map((p) => {
          const v = values[p.id] ?? p.def; const at = p.keys.find((k) => Math.abs(k - v) < 1e-4);
          return (
            <div key={p.id} className={cx('rounded px-1.5 py-1 cursor-pointer', active === p.id ? 'bg-active' : 'hover:bg-hover')} onClick={() => setActive(p.id)} data-testid={`av-param-${p.id}`}>
              <div className="flex items-center gap-1 text-[12px]">
                <span className="truncate flex-1" title={p.id}>{p.name}</span>
                {usedBy(p.id) > 0 && <span className="text-[10px] text-fg3">{usedBy(p.id)}</span>}
                <NumberInput value={+v.toFixed(2)} min={p.min} max={p.max} step={Math.abs(p.max - p.min) > 5 ? 1 : 0.01} width={50} onChange={(x) => setValues({ ...values, [p.id]: x })} />
                {canEdit && active === p.id && (at !== undefined
                  ? <IconButton icon="minus" label={`Remove key ${at}`} size={22} iconSize={12} onClick={(e) => { e.stopPropagation(); onRemoveKey(p.id, at); }} />
                  : <IconButton icon="keyframe" label={`Add a key at ${+v.toFixed(2)}`} size={22} iconSize={12} onClick={(e) => { e.stopPropagation(); onAddKey(p.id, +v.toFixed(3)); }} />)}
                {canEdit && active === p.id && <IconButton icon="settings" label="Range" size={22} iconSize={12} onClick={(e) => { e.stopPropagation(); setEditing(editing === p.id ? null : p.id); }} />}
              </div>
              <div className="relative h-5">
                <input type="range" className="sl-range absolute inset-x-0 top-1" min={p.min} max={p.max} step={(p.max - p.min) / 200} value={v}
                  onChange={(e) => setValues({ ...values, [p.id]: snap(p, Number(e.target.value)) })} onPointerDown={() => setActive(p.id)} />
                {p.keys.map((k) => <span key={k} className={cx('absolute top-0 w-1.5 h-1.5 rotate-45 -translate-x-1/2 pointer-events-none', Math.abs(k - v) < 1e-4 ? 'bg-sun' : 'bg-fg3')} style={{ left: `${((k - p.min) / (p.max - p.min || 1)) * 100}%` }} />)}
              </div>
              {editing === p.id && canEdit && (
                <div className="flex flex-wrap items-center gap-1.5 pb-1" onClick={(e) => e.stopPropagation()}>
                  <NumberInput label="Min" value={p.min} width={46} step={0.1} onChange={(x) => edit((d) => ({ ...d, params: d.params.map((q) => (q.id === p.id ? { ...q, min: Math.min(x, q.def) } : q)) }), 'Parameter range', `pr-${p.id}`)} />
                  <NumberInput label="Default" value={p.def} width={46} step={0.1} onChange={(x) => edit((d) => ({ ...d, params: d.params.map((q) => (q.id === p.id ? { ...q, def: Math.max(q.min, Math.min(q.max, x)) } : q)) }), 'Parameter default', `pr-${p.id}`)} />
                  <NumberInput label="Max" value={p.max} width={46} step={0.1} onChange={(x) => edit((d) => ({ ...d, params: d.params.map((q) => (q.id === p.id ? { ...q, max: Math.max(x, q.def) } : q)) }), 'Parameter range', `pr-${p.id}`)} />
                  <Button size="sm" variant="ghost" icon="edit" onClick={async () => { const n = await promptDialog({ title: 'Rename parameter', label: 'Name', value: p.name }); if (n) edit((d) => ({ ...d, params: d.params.map((q) => (q.id === p.id ? { ...q, name: n } : q)) }), 'Rename parameter'); }}>Rename</Button>
                  <Button size="sm" variant="ghost" icon="trash" disabled={usedBy(p.id) > 0} title={usedBy(p.id) ? 'Remove its keyforms first' : ''} onClick={() => { edit((d) => ({ ...d, params: d.params.filter((q) => q.id !== p.id) }), 'Delete parameter'); setActive(null); }}>Delete</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}
// sliders snap onto keys when close (so keyform editing is easy to reach)
const snap = (p, v) => { const k = p.keys.find((x) => Math.abs(x - v) < (p.max - p.min) * 0.02); return k ?? v; };

// ---------------------------------------------------------------- physics

export function PhysicsPanel({ doc, canEdit, edit, running, setRunning }) {
  const editChain = (id, patch, label, merge) => edit((d) => ({ ...d, physics: d.physics.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), label, merge);
  const pOpts = doc.params.map((p) => ({ value: p.id, label: p.name }));
  return (
    <PanelSection title="Physics" id="av-physics" actions={(
      <div className="flex items-center gap-1">
        <Toggle label="Preview" checked={running} onChange={setRunning} />
        {canEdit && <IconButton icon="plus" label="New pendulum chain" size={24} iconSize={14} onClick={() => edit((d) => ({ ...d, physics: [...d.physics, newChain(`Chain ${d.physics.length + 1}`)] }), 'New physics chain')} />}
      </div>
    )}>
      {!doc.physics.length && <p className="text-xs text-fg3">Pendulum chains make hair, ribbons and accessories swing: the head’s movement swings the chain, and the swing drives an output parameter (like ParamHairFront) that the hair’s keyforms follow.</p>}
      {doc.physics.map((c) => (
        <div key={c.id} className="rounded-md bg-panel-2 p-2 mb-2 flex flex-col gap-1.5">
          <Row>
            <Toggle checked={c.enabled !== false} onChange={(v) => editChain(c.id, { enabled: v }, 'Physics on/off')} />
            <TextInput value={c.name} disabled={!canEdit} onChange={(e) => editChain(c.id, { name: e.target.value }, 'Rename chain', `cn-${c.id}`)} className="!h-7 flex-1" />
            {canEdit && <IconButton icon="trash" label="Delete chain" size={24} iconSize={13} onClick={() => edit((d) => ({ ...d, physics: d.physics.filter((x) => x.id !== c.id) }), 'Delete chain')} />}
          </Row>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Slider label="Segments" value={c.segments} min={1} max={8} onChange={(v) => editChain(c.id, { segments: v }, 'Physics', `ph-${c.id}`)} />
            <Slider label="Length" unit="px" value={c.length} min={10} max={1000} onChange={(v) => editChain(c.id, { length: v }, 'Physics', `ph-${c.id}`)} />
            <Slider label="Damping" value={Math.round(c.damping * 100)} min={0} max={95} onChange={(v) => editChain(c.id, { damping: v / 100 }, 'Physics', `ph-${c.id}`)} />
            <Slider label="Stiffness" value={Math.round((c.stiffness ?? 0.25) * 100)} min={0} max={100} onChange={(v) => editChain(c.id, { stiffness: v / 100 }, 'Physics', `ph-${c.id}`)} />
            <Slider label="Wind" value={Math.round((c.wind || 0) * 100)} min={0} max={100} onChange={(v) => editChain(c.id, { wind: v / 100 }, 'Physics', `ph-${c.id}`)} />
            <Slider label="Gravity" value={Math.round((c.gravity ?? 1) * 100)} min={0} max={300} onChange={(v) => editChain(c.id, { gravity: v / 100 }, 'Physics', `ph-${c.id}`)} />
          </div>
          <IOList title="Inputs" items={c.inputs} pOpts={pOpts} canEdit={canEdit} types={[['x', 'Sideways'], ['angle', 'Tilt']]}
            onChange={(items) => editChain(c.id, { inputs: items }, 'Physics inputs')} add={() => ({ param: 'ParamAngleX', weight: 0.5, type: 'x' })} />
          <IOList title="Outputs" items={c.outputs} pOpts={pOpts} canEdit={canEdit}
            onChange={(items) => editChain(c.id, { outputs: items }, 'Physics outputs')} add={() => ({ param: 'ParamHairFront', weight: 1, segment: -1 })} />
        </div>
      ))}
    </PanelSection>
  );
}
function IOList({ title, items, pOpts, canEdit, types, onChange, add }) {
  return (
    <div>
      <div className="flex items-center text-[11px] text-fg2"><span className="flex-1">{title}</span>{canEdit && <button type="button" className="text-accent hover:underline" onClick={() => onChange([...items, add()])}>+ Add</button>}</div>
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1 mt-1">
          <Select small value={it.param} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, param: v } : x)))} options={pOpts} className="flex-1 min-w-0" />
          {types && <Select small value={it.type} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, type: v } : x)))} options={types.map(([value, label]) => ({ value, label }))} />}
          <NumberInput value={it.weight} min={-3} max={3} step={0.05} width={44} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, weight: v } : x)))} title="Weight" />
          {canEdit && <IconButton icon="close" label="Remove" size={22} iconSize={11} onClick={() => onChange(items.filter((_, k) => k !== i))} />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- expressions and tracking

export function ExpressionsPanel({ doc, values, canEdit, edit, preview, setPreview }) {
  const editExpr = (id, patch, label, merge) => edit((d) => ({ ...d, expressions: d.expressions.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), label, merge);
  const capture = () => {
    const changed = doc.params.filter((p) => Math.abs((values[p.id] ?? p.def) - p.def) > 1e-3).map((p) => ({ param: p.id, value: +(values[p.id]).toFixed(3), mode: 'set' }));
    if (!changed.length) { toast('Move some parameters away from their defaults first (e.g. Eye Smile, Cheek), then capture.'); return; }
    const x = { id: uid('x'), name: `Expression ${doc.expressions.length + 1}`, params: changed };
    edit((d) => ({ ...d, expressions: [...d.expressions, x] }), 'New expression');
  };
  const hot = doc.perform?.hotkeys || {};
  return (
    <PanelSection title="Expressions" id="av-expr" actions={canEdit && <Button size="sm" variant="ghost" icon="plus" onClick={capture}>Capture</Button>}>
      <p className="text-[11px] text-fg3 mb-2">An expression overrides some parameters (blush, sparkly eyes, angry brows…). Set parameters, click Capture, then give it a hotkey or a hand gesture (peace sign, thumbs up…) to toggle or hold while performing.</p>
      {doc.expressions.map((x) => (
        <div key={x.id} className="rounded-md bg-panel-2 p-2 mb-2 flex flex-col gap-1">
          <Row>
            <Toggle checked={!!preview[x.id]} onChange={(v) => setPreview({ ...preview, [x.id]: v ? 1 : 0 })} />
            <TextInput value={x.name} disabled={!canEdit} onChange={(e) => editExpr(x.id, { name: e.target.value }, 'Rename expression', `xn-${x.id}`)} className="!h-7 flex-1" />
            {canEdit && <IconButton icon="trash" label="Delete" size={24} iconSize={13} onClick={() => edit((d) => ({ ...d, expressions: d.expressions.filter((q) => q.id !== x.id) }), 'Delete expression')} />}
          </Row>
          <Row>
            <span className="text-[11px] text-fg2">Hotkey</span>
            <HotkeyInput value={hot[x.id]?.key || ''} disabled={!canEdit} onChange={(k) => edit((d) => ({ ...d, perform: { ...d.perform, hotkeys: { ...(d.perform?.hotkeys || {}), [x.id]: { mode: 'toggle', ...(d.perform?.hotkeys?.[x.id] || {}), key: k } } } }), 'Expression hotkey')} />
            <Select small value={hot[x.id]?.mode || 'toggle'} onChange={(v) => edit((d) => ({ ...d, perform: { ...d.perform, hotkeys: { ...(d.perform?.hotkeys || {}), [x.id]: { key: '', ...(d.perform?.hotkeys?.[x.id] || {}), mode: v } } } }), 'Expression hotkey')} options={[{ value: 'toggle', label: 'Toggle' }, { value: 'hold', label: 'Hold' }]} />
          </Row>
          <Row>
            <span className="text-[11px] text-fg2">Gesture</span>
            <GestureInput value={doc.perform?.gestures?.[x.id]} disabled={!canEdit} onChange={(g) => edit((d) => ({ ...d, perform: { ...d.perform, gestures: withGesture(d.perform?.gestures || {}, x.id, g) } }), 'Gesture trigger')} />
          </Row>
          {x.params.map((o, i) => (
            <div key={i} className="flex items-center gap-1">
              <Select small value={o.param} className="flex-1 min-w-0" onChange={(v) => editExpr(x.id, { params: x.params.map((q, k) => (k === i ? { ...q, param: v } : q)) }, 'Expression')} options={doc.params.map((p) => ({ value: p.id, label: p.name }))} />
              <Select small value={o.mode} onChange={(v) => editExpr(x.id, { params: x.params.map((q, k) => (k === i ? { ...q, mode: v } : q)) }, 'Expression')} options={[{ value: 'set', label: 'Set' }, { value: 'add', label: 'Add' }, { value: 'mul', label: '×' }]} />
              <NumberInput value={o.value} step={0.05} width={50} onChange={(v) => editExpr(x.id, { params: x.params.map((q, k) => (k === i ? { ...q, value: v } : q)) }, 'Expression', `xv-${x.id}-${i}`)} />
              {canEdit && <IconButton icon="close" label="Remove" size={22} iconSize={11} onClick={() => editExpr(x.id, { params: x.params.filter((_, k) => k !== i) }, 'Expression')} />}
            </div>
          ))}
        </div>
      ))}
    </PanelSection>
  );
}
/** Click, then press a key: records it ("1", "f2", "shift+a"). */
export function HotkeyInput({ value, onChange, disabled }) {
  const [rec, setRec] = useState(false);
  return (
    <button type="button" disabled={disabled} onClick={() => setRec(true)} onBlur={() => setRec(false)}
      onKeyDown={(e) => { if (!rec) return; e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') { setRec(false); return; } if (e.key === 'Backspace' || e.key === 'Delete') { onChange(''); setRec(false); return; } if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; onChange(`${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.key.toLowerCase()}`); setRec(false); }}
      className={cx('h-7 min-w-14 px-2 rounded border text-[12px] font-mono', rec ? 'border-accent text-accent' : 'border-line bg-input text-fg')}>
      {rec ? 'press…' : value || 'none'}
    </button>
  );
}

const POSE_OPTIONS = [{ group: 'Face and body', options: POSE_KEYS.map((k) => ({ value: k, label: KEY_INFO[k].label })) }, { group: 'Hands and arms', options: HAND_KEYS.map((k) => ({ value: k, label: HAND_KEY_INFO[k].label })) }];
export function TrackingMapPanel({ doc, canEdit, edit }) {
  const set = (bindings, label, merge) => edit((d) => ({ ...d, bindings }), label, merge);
  const b = doc.bindings || [];
  return (
    <PanelSection title="Tracking → parameters" id="av-bind" actions={canEdit && (
      <div className="flex">
        <IconButton icon="plus" label="Add a row" size={24} iconSize={14} onClick={() => set([...b, { pose: 'headYaw', param: doc.params[0]?.id, scale: 1, offset: 0 }], 'Add binding')} />
        <IconButton icon="refresh" label="Reset to defaults" size={24} iconSize={14} onClick={() => set(DEFAULT_BINDINGS.filter((x) => paramById(doc, x.param)).map((x) => ({ ...x })), 'Reset bindings')} />
      </div>
    )}>
      <p className="text-[11px] text-fg3 mb-2">What each tracked value drives. Parameter = tracked value × scale + offset (then clipped to the parameter’s range). Hand values need “Track hands too” in Perform; they return to 0 when a hand isn’t seen.</p>
      {b.map((x, i) => (
        <div key={i} className="rounded-md bg-panel-2 p-1.5 mb-1.5 flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <Select small value={x.pose} onChange={(v) => set(b.map((q, k) => (k === i ? { ...q, pose: v } : q)), 'Binding')} options={POSE_OPTIONS} className="flex-1 min-w-0" />
            {canEdit && <IconButton icon="close" label="Remove" size={22} iconSize={11} onClick={() => set(b.filter((_, k) => k !== i), 'Remove binding')} />}
          </div>
          <div className="flex items-center gap-1">
            <Icon name="chevronRight" size={13} className="text-fg3 shrink-0" />
            <Select small value={x.param} onChange={(v) => set(b.map((q, k) => (k === i ? { ...q, param: v } : q)), 'Binding')} options={doc.params.map((p) => ({ value: p.id, label: p.name }))} className="flex-1 min-w-0" />
            <NumberInput label="×" title="Scale" value={x.scale} step={0.05} width={40} onChange={(v) => set(b.map((q, k) => (k === i ? { ...q, scale: v } : q)), 'Binding', `bs-${i}`)} />
            <NumberInput label="+" title="Offset" value={x.offset} step={0.05} width={40} onChange={(v) => set(b.map((q, k) => (k === i ? { ...q, offset: v } : q)), 'Binding', `bo-${i}`)} />
          </div>
        </div>
      ))}
    </PanelSection>
  );
}
export { formKey };
