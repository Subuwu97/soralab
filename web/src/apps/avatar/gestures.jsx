// Hand gesture → expression triggers, shared by Perform and the 2D / 3D expression panels. Saved per expression in
// doc.perform.gestures[exprId] = { gesture, hand: 'any' | 'L' | 'R', mode: 'hold' | 'toggle' }; the tracker applies them
// (./tracking/index.js) so the OBS output gets the expressions too.
import { Select } from '../../components/ui.jsx';
import { GESTURES, GESTURE_LABELS } from './tracking/hands.js';

export const GESTURE_OPTIONS = [{ value: '', label: 'No gesture' }, ...GESTURES.map((g) => ({ value: g, label: GESTURE_LABELS[g] }))];
export const GESTURE_HANDS = [{ value: 'any', label: 'Any hand' }, { value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }];

/** The gesture trigger of one expression: which gesture, which hand, hold or toggle. */
export function GestureInput({ value, onChange, disabled }) {
  const g = value || {};
  const set = (patch) => onChange({ hand: 'any', mode: 'hold', ...g, ...patch });
  return (
    <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1" data-testid="av-gesture">
      <Select small value={g.gesture || ''} disabled={disabled} onChange={(v) => (v ? set({ gesture: v }) : onChange(null))} options={GESTURE_OPTIONS} className="basis-full min-w-0" />
      {g.gesture && <Select small value={g.hand || 'any'} disabled={disabled} onChange={(v) => set({ hand: v })} options={GESTURE_HANDS} className="flex-1 min-w-0" title="The avatar’s hand (with mirroring on, your right hand is the avatar’s left)" />}
      {g.gesture && <Select small value={g.mode || 'hold'} disabled={disabled} onChange={(v) => set({ mode: v })} options={[{ value: 'hold', label: 'Hold' }, { value: 'toggle', label: 'Toggle' }]} className="flex-1 min-w-0" title="Hold: on while you show the gesture. Toggle: each time you show it, the expression turns on or off." />}
    </div>
  );
}
/** perform.gestures with one expression's trigger set (or removed when null). */
export const withGesture = (gestures, xid, g) => { const n = { ...gestures }; if (g?.gesture) n[xid] = g; else delete n[xid]; return n; };
