// Keyboard shortcuts. Keys: 'mod+z' (Ctrl, or ⌘ on Mac), 'shift+mod+z', 'alt+x', 'v', 'space', 'delete', '[', 'arrowleft'…
//
//   useShortcuts({ 'mod+z': undo, 'shift+mod+z': redo, v: () => setTool('move') }, [deps])
//
// Single keys are ignored while typing in a field. Return false from a handler to let the browser handle the key too.
import { useEffect, useRef } from 'react';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modLabel = isMac ? '⌘' : 'Ctrl+';
/** Turns 'shift+mod+z' into a label for menus: ⇧⌘Z or Ctrl+Shift+Z. */
export function keyLabel(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const k = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', delete: 'Del', backspace: '⌫', space: 'Space', escape: 'Esc', enter: '↵' }[key] || key.toUpperCase();
  if (isMac) return parts.map((p) => ({ mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }[p])).join('') + k;
  return [...parts.map((p) => ({ mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' }[p])), k].join('+');
}

export function comboOf(e) {
  const k = e.key === ' ' ? 'space' : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const mods = [];
  if (e.shiftKey && e.key.length > 1) mods.push('shift');
  else if (e.shiftKey && !/[^a-z0-9]/i.test(e.key)) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (isMac && e.ctrlKey) mods.push('ctrl');
  return [...mods, k === '+' ? 'plus' : k].join('+');
}

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !(el.type === 'range' || el.type === 'checkbox' || el.type === 'button');

export function useShortcuts(map, deps = [], { enabled = true } = {}) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return undefined;
    const down = (e) => {
      if (e.defaultPrevented) return;
      const combo = comboOf(e);
      const fn = ref.current[combo];
      if (!fn) return;
      const hasMod = /(^|\+)(mod|alt|ctrl)\+/.test(combo);
      if (typing(document.activeElement) && (!hasMod || /mod\+(a|c|v|x|z)$|shift\+mod\+z/.test(combo))) return;
      if (document.querySelector('[role=dialog][aria-modal=true]') && !combo.startsWith('mod+s')) return;
      if (fn(e) !== false) e.preventDefault();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Tracks whether a key is held (space for the hand tool, alt for eyedropper…). */
export function useKeyHeld(key) {
  const held = useRef(false);
  useEffect(() => {
    const d = (e) => { if ((e.key === ' ' ? 'space' : e.key.toLowerCase()) === key && !typing(document.activeElement)) held.current = true; };
    const u = (e) => { if ((e.key === ' ' ? 'space' : e.key.toLowerCase()) === key) held.current = false; };
    const b = () => { held.current = false; };
    window.addEventListener('keydown', d); window.addEventListener('keyup', u); window.addEventListener('blur', b);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); window.removeEventListener('blur', b); };
  }, [key]);
  return held;
}
