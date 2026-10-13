// Undo / redo for editors. Keep your document in one immutable value; every change goes through set().
//
//   const h = useHistory(initialDoc);
//   h.state                         current document
//   h.set(next, 'Move layer')       new step (label shows in the History panel and the Edit menu)
//   h.set(next, 'Move layer', { merge: 'drag-123' })   consecutive sets with the same merge key become one step
//   h.replace(next)                 change without a new step (e.g. selection, or live preview while dragging)
//   h.undo(), h.redo(), h.canUndo, h.canRedo, h.undoLabel, h.redoLabel
//   h.entries, h.index, h.jump(i)   for a History panel
//   h.reset(doc)                    start over (after loading)
//   h.version                       increments on every change (handy for autosave / re-render keys)
import { useCallback, useMemo, useRef, useState } from 'react';

export function useHistory(initial, { limit = 200 } = {}) {
  const [s, setS] = useState(() => ({ entries: [{ state: initial, label: 'Open' }], index: 0, version: 0 }));
  const mergeKey = useRef(null);
  const ref = useRef(s);
  ref.current = s;

  const set = useCallback((next, label = 'Edit', { merge } = {}) => {
    setS((p) => {
      const value = typeof next === 'function' ? next(p.entries[p.index].state) : next;
      if (merge && mergeKey.current === merge && p.index > 0) {
        const entries = p.entries.slice(0, p.index + 1);
        entries[p.index] = { state: value, label };
        return { entries, index: p.index, version: p.version + 1 };
      }
      mergeKey.current = merge || null;
      const entries = [...p.entries.slice(0, p.index + 1), { state: value, label }];
      const drop = Math.max(0, entries.length - limit);
      return { entries: entries.slice(drop), index: entries.length - 1 - drop, version: p.version + 1 };
    });
  }, [limit]);
  const replace = useCallback((next) => {
    setS((p) => {
      const entries = p.entries.slice();
      entries[p.index] = { ...entries[p.index], state: typeof next === 'function' ? next(p.entries[p.index].state) : next };
      return { ...p, entries, version: p.version + 1 };
    });
  }, []);
  const undo = useCallback(() => { mergeKey.current = null; setS((p) => (p.index > 0 ? { ...p, index: p.index - 1, version: p.version + 1 } : p)); }, []);
  const redo = useCallback(() => { mergeKey.current = null; setS((p) => (p.index < p.entries.length - 1 ? { ...p, index: p.index + 1, version: p.version + 1 } : p)); }, []);
  const jump = useCallback((i) => { mergeKey.current = null; setS((p) => ({ ...p, index: Math.max(0, Math.min(p.entries.length - 1, i)), version: p.version + 1 })); }, []);
  const reset = useCallback((state) => { mergeKey.current = null; setS((p) => ({ entries: [{ state, label: 'Open' }], index: 0, version: p.version + 1 })); }, []);
  /** Ends the current merge group so the next set() starts a new step. */
  const commit = useCallback(() => { mergeKey.current = null; }, []);

  return useMemo(() => ({
    state: s.entries[s.index].state, set, replace, undo, redo, jump, reset, commit, get: () => ref.current.entries[ref.current.index].state,
    canUndo: s.index > 0, canRedo: s.index < s.entries.length - 1,
    undoLabel: s.index > 0 ? s.entries[s.index].label : null, redoLabel: s.index < s.entries.length - 1 ? s.entries[s.index + 1].label : null,
    entries: s.entries.map((e) => e.label), index: s.index, version: s.version,
  }), [s, set, replace, undo, redo, jump, reset, commit]);
}
