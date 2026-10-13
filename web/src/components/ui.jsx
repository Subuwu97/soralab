// SoraLab's UI kit: buttons, fields, sliders, menus, popovers, dialogs, toasts and the colour picker.
// Styling uses the theme tokens from index.css (panel, panel-2, input, fg, fg2, fg3, line, hover, active, accent, menu).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons.jsx';
import { parse, toHex, rgbToHsv, hsvToRgb, BASIC_SWATCHES, clamp } from '../lib/color.js';

const cx = (...a) => a.filter(Boolean).join(' ');
export { cx };

// ---------------------------------------------------------------- tiny global store (menus, dialogs, toasts)
function makeStore(initial) {
  let s = initial;
  const subs = new Set();
  return {
    get: () => s,
    set: (p) => { s = typeof p === 'function' ? p(s) : p; subs.forEach((f) => f()); },
    use: () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => s),
  };
}

// ---------------------------------------------------------------- buttons

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, className, children, busy, ...rest }) {
  const v = {
    primary: 'bg-accent text-[#06121f] hover:brightness-110 font-semibold',
    secondary: 'bg-chip hover:bg-chip-hover text-fg',
    ghost: 'hover:bg-hover text-fg2 hover:text-fg',
    danger: 'bg-danger text-white hover:brightness-110 font-semibold',
    outline: 'border border-line hover:bg-hover text-fg',
    sky: 'sora-sky text-white font-semibold hover:brightness-110 shadow-[0_4px_18px_rgba(139,124,255,.35)]',
  }[variant];
  const s = { xs: 'h-6 px-2 text-xs gap-1 rounded', sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-md', md: 'h-9 px-3.5 text-sm gap-2 rounded-lg', lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl' }[size];
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy}
      className={cx('inline-flex items-center justify-center select-none whitespace-nowrap transition disabled:opacity-45 disabled:pointer-events-none', v, s, className)}>
      {busy ? <Spinner size={size === 'lg' ? 18 : 14} /> : icon && <Icon name={icon} size={size === 'xs' ? 13 : size === 'sm' ? 15 : 17} />}
      {children}
      {iconRight && <Icon name={iconRight} size={14} />}
    </button>
  );
}

/** Square icon button with a tooltip. active = toggled on (tools, panels). */
export function IconButton({ icon, label, active, size = 32, iconSize, className, shortcut, children, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label ? (shortcut ? `${label} (${shortcut})` : label) : undefined} aria-pressed={active ?? undefined} {...rest}
      style={{ width: size, height: size, ...(rest.style || {}) }}
      className={cx('inline-flex items-center justify-center rounded-md transition shrink-0 disabled:opacity-40 disabled:pointer-events-none',
        active ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover hover:text-fg', className)}>
      {icon ? <Icon name={icon} size={iconSize || Math.round(size * 0.56)} /> : children}
    </button>
  );
}

export const Spinner = ({ size = 16, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={cx('animate-spin shrink-0', className)} aria-label="Loading">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export function ProgressBar({ value, className, indeterminate }) {
  return (
    <div className={cx('h-1.5 rounded-full bg-chip overflow-hidden', className)} role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round((value || 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full sora-sky rounded-full transition-[width] duration-300', indeterminate && 'animate-pulse')} style={{ width: `${indeterminate ? 100 : Math.round(clamp(value || 0) * 100)}%` }} />
    </div>
  );
}

export const Kbd = ({ children }) => <kbd className="px-1.5 py-0.5 rounded bg-chip text-[11px] font-mono text-fg2 border border-line">{children}</kbd>;

// ---------------------------------------------------------------- fields

export function Field({ label, hint, children, className, inline }) {
  return (
    <label className={cx(inline ? 'flex items-center gap-2' : 'block', className)}>
      {label && <span className={cx('text-xs text-fg2', inline ? 'shrink-0 min-w-16' : 'block mb-1')}>{label}</span>}
      {children}
      {hint && <span className="block mt-1 text-[11px] text-fg3">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full h-8 px-2.5 rounded-md bg-input border border-line text-sm text-fg placeholder:text-fg3 outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/20';

export function TextInput({ className, ...rest }) {
  return <input type="text" {...rest} className={cx(inputCls, className)} />;
}

/**
 * Number field. Drag on the label (or the field with Alt) to scrub; arrow keys step (Shift ×10).
 * onChange fires while typing/scrubbing; onCommit when you finish (blur, Enter, mouse up) — use it for undo history.
 */
export function NumberInput({ value, onChange, onCommit, min = -Infinity, max = Infinity, step = 1, unit, label, precision, className, width = 64, disabled, title }) {
  const [text, setText] = useState(null);
  const p = precision ?? (step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0);
  const fmt = (v) => (Number.isFinite(v) ? String(+Number(v).toFixed(p)) : '');
  const set = (v, commit) => {
    const n = clamp(Math.round(Number(v) / step) * step, min, max);
    if (!Number.isFinite(n)) return;
    onChange?.(+n.toFixed(p + 2));
    if (commit) onCommit?.(+n.toFixed(p + 2));
  };
  const scrub = (e) => {
    if (disabled) return;
    e.preventDefault();
    const x0 = e.clientX; const v0 = Number(value) || 0;
    const move = (ev) => set(v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1));
    const up = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); set(v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1), true); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)} title={title}>
      {label && <span onPointerDown={scrub} className="text-xs text-fg2 cursor-ew-resize select-none shrink-0">{label}</span>}
      <span className="relative inline-flex items-center">
        <input type="text" inputMode="decimal" disabled={disabled} value={text ?? fmt(value)} style={{ width }}
          onChange={(e) => { setText(e.target.value); const n = parseFloat(e.target.value); if (Number.isFinite(n)) set(n); }}
          onBlur={() => { if (text !== null) { const n = parseFloat(text); if (Number.isFinite(n)) set(n, true); } setText(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setText(null); set((Number(value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true); }
          }}
          className={cx('h-7 rounded bg-input border border-line text-[13px] tabular-nums text-fg outline-none focus:border-accent/70 px-1.5', unit && 'pr-6', disabled && 'opacity-50')} />
        {unit && <span className="absolute right-1.5 text-[11px] text-fg3 pointer-events-none">{unit}</span>}
      </span>
    </span>
  );
}

/** Labelled slider with a number box. format(v) changes how the value reads. Double-click resets to `reset`. */
export function Slider({ label, value, onChange, onCommit, min = 0, max = 100, step = 1, unit, reset, className, gradient, disabled, showNumber = true }) {
  const v = Number(value) || 0;
  return (
    <div className={cx('flex flex-col gap-0.5', disabled && 'opacity-50 pointer-events-none', className)}>
      <div className="flex items-center justify-between gap-2">
        {label && <span className="text-xs text-fg2 truncate" onDoubleClick={() => reset !== undefined && (onChange?.(reset), onCommit?.(reset))} title={reset !== undefined ? 'Double-click to reset' : undefined}>{label}</span>}
        {showNumber && <NumberInput value={v} onChange={onChange} onCommit={onCommit} min={min} max={max} step={step} unit={unit} width={52} />}
      </div>
      <input type="range" className="sl-range" min={min} max={max} step={step} value={v} aria-label={label}
        style={gradient ? { background: gradient, borderRadius: 4, height: 8 } : undefined}
        onChange={(e) => onChange?.(Number(e.target.value))} onPointerUp={(e) => onCommit?.(Number(e.target.value))} onKeyUp={(e) => onCommit?.(Number(e.target.value))}
        onDoubleClick={() => reset !== undefined && (onChange?.(reset), onCommit?.(reset))} />
    </div>
  );
}

export function Select({ value, onChange, options, className, small, ...rest }) {
  return (
    <select value={value} onChange={(e) => onChange?.(e.target.value)} {...rest}
      className={cx('rounded-md bg-input border border-line text-fg outline-none focus:border-accent/70 pr-6', small ? 'h-7 text-[13px] px-1.5' : 'h-8 text-sm px-2', className)}>
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option>
        : o.group ? <optgroup key={o.group} label={o.group}>{o.options.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</optgroup>
          : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, className, disabled }) {
  return (
    <label className={cx('inline-flex items-center gap-2 cursor-pointer select-none', disabled && 'opacity-50 pointer-events-none', className)}>
      <button type="button" role="switch" aria-checked={!!checked} onClick={() => onChange?.(!checked)}
        className={cx('w-8 h-[18px] rounded-full relative transition shrink-0', checked ? 'bg-accent' : 'bg-chip-hover')}>
        <span className={cx('absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all', checked ? 'left-[16px]' : 'left-[2px]')} />
      </button>
      {label && <span className="text-[13px] text-fg">{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, className }) {
  return (
    <label className={cx('inline-flex items-center gap-2 cursor-pointer select-none text-[13px]', className)}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} className="accent-[#5AB4FF] w-3.5 h-3.5" />
      {label}
    </label>
  );
}

/** A row of mutually exclusive buttons. options: [{ value, label?, icon?, title? }] */
export function Segmented({ value, onChange, options, className, size = 'sm' }) {
  return (
    <div className={cx('inline-flex p-0.5 rounded-md bg-input border border-line', className)} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title || o.label} onClick={() => onChange?.(o.value)}
          className={cx('inline-flex items-center justify-center gap-1 rounded transition', size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-sm',
            value === o.value ? 'bg-panel-2 text-fg shadow-sm' : 'text-fg2 hover:text-fg')}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cx('flex items-end gap-1 border-b border-line', className)} role="tablist">
      {tabs.map((t) => {
        const id = typeof t === 'string' ? t : t.value;
        return (
          <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
            className={cx('px-3 h-8 text-[13px] border-b-2 -mb-px transition', value === id ? 'border-accent text-fg' : 'border-transparent text-fg2 hover:text-fg')}>
            {typeof t === 'string' ? t : t.label}{t.count !== undefined && <span className="ml-1.5 text-fg3">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Collapsible panel section (Properties, Layers…). */
export function PanelSection({ title, children, defaultOpen = true, actions, className, id }) {
  const key = id ? `sl-panel-${id}` : null;
  const [open, setOpen] = useState(() => { try { const v = key && localStorage.getItem(key); return v === null || v === undefined ? defaultOpen : v === '1'; } catch { return defaultOpen; } });
  useEffect(() => { try { if (key) localStorage.setItem(key, open ? '1' : '0'); } catch { /* private mode */ } }, [key, open]);
  return (
    <section className={cx('border-b border-line', className)}>
      <div className="flex items-center h-8 px-2 gap-1">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 flex-1 min-w-0 text-[11px] font-semibold uppercase tracking-wider text-fg2 hover:text-fg">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

export function EmptyState({ icon = 'sparkles', title, children, action, className }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center gap-2 py-12 px-6', className)}>
      <div className="w-14 h-14 rounded-2xl bg-chip grid place-items-center text-fg2 mb-1"><Icon name={icon} size={26} /></div>
      {title && <div className="font-head font-semibold text-fg">{title}</div>}
      {children && <div className="text-sm text-fg2 max-w-sm">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- popovers

function useOutside(ref, onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-sl-popover]')) onClose?.(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [ref, onClose, active]);
}

/** Places a floating box next to an anchor rect, kept on screen. */
function place(anchor, box, side = 'bottom', align = 'start') {
  const vw = window.innerWidth; const vh = window.innerHeight; const m = 6;
  let x; let y;
  if (side === 'right') { x = anchor.right + 2; y = anchor.top; }
  else if (side === 'left') { x = anchor.left - box.width - 2; y = anchor.top; }
  else if (side === 'top') { x = align === 'end' ? anchor.right - box.width : anchor.left; y = anchor.top - box.height - 4; }
  else { x = align === 'end' ? anchor.right - box.width : align === 'center' ? anchor.left + anchor.width / 2 - box.width / 2 : anchor.left; y = anchor.bottom + 4; }
  if (side === 'right' && x + box.width > vw - m) x = anchor.left - box.width - 2;
  if (side === 'bottom' && y + box.height > vh - m && anchor.top - box.height - 4 > m) y = anchor.top - box.height - 4;
  return { left: Math.max(m, Math.min(x, vw - box.width - m)), top: Math.max(m, Math.min(y, vh - box.height - m)) };
}

/**
 * A floating box anchored to an element (or a {x,y} point). Closes on outside click / Escape.
 * <Popover anchor={buttonEl} onClose={…}>…</Popover>
 */
export function Popover({ anchor, onClose, children, side = 'bottom', align = 'start', className, style }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useOutside(ref, onClose);
  useLayoutEffect(() => {
    if (!ref.current || !anchor) return;
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    setPos(place(r, ref.current.getBoundingClientRect(), side, align));
  }, [anchor, side, align]);
  return createPortal(
    <div ref={ref} data-sl-popover="" style={{ position: 'fixed', zIndex: 1000, ...pos, ...style }}
      className={cx('rounded-lg bg-menu border border-line shadow-[0_12px_40px_rgba(0,0,0,.45)] sl-pop', className)}>
      {children}
    </div>, document.body,
  );
}

// ---------------------------------------------------------------- menus

/**
 * Menu items: { label, icon, shortcut, onClick, disabled, checked, danger, items (submenu) } or { divider: true } or { heading: 'Text' }.
 */
const menuStore = makeStore(null);
export const openMenu = (anchorOrEvent, items, opts = {}) => {
  let anchor = anchorOrEvent;
  if (anchorOrEvent?.clientX !== undefined) { anchorOrEvent.preventDefault?.(); anchor = { x: anchorOrEvent.clientX, y: anchorOrEvent.clientY }; }
  else if (anchorOrEvent?.currentTarget) anchor = anchorOrEvent.currentTarget;
  menuStore.set({ anchor, items, ...opts });
};
export const closeMenu = () => menuStore.set(null);

export function MenuList({ items, onDone, className, autoFocus = true }) {
  const ref = useRef(null);
  const [sub, setSub] = useState(null); // { index, anchor }
  const [hi, setHi] = useState(-1);
  const enabled = items.map((it, i) => (!it.divider && !it.heading && !it.disabled ? i : -1)).filter((i) => i >= 0);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const run = (it, el) => {
    if (it.items) { setSub({ index: items.indexOf(it), anchor: el }); return; }
    onDone?.();
    it.onClick?.();
  };
  return (
    <div ref={ref} tabIndex={-1} role="menu" className={cx('py-1 min-w-48 outline-none', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const k = enabled.indexOf(hi);
          setHi(enabled[(k + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1);
        } else if (e.key === 'Enter' && hi >= 0) { e.preventDefault(); run(items[hi], ref.current.querySelectorAll('[role=menuitem]')[enabled.indexOf(hi)]); }
        else if (e.key === 'ArrowRight' && items[hi]?.items) setSub({ index: hi, anchor: ref.current.querySelectorAll('[role=menuitem]')[enabled.indexOf(hi)] });
      }}>
      {items.map((it, i) => {
        if (it.divider) return <div key={i} className="my-1 h-px bg-line" />;
        if (it.heading) return <div key={i} className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg3">{it.heading}</div>;
        return (
          <button key={i} type="button" role="menuitem" disabled={it.disabled}
            onMouseEnter={(e) => { setHi(i); setSub(it.items ? { index: i, anchor: e.currentTarget } : null); }}
            onClick={(e) => run(it, e.currentTarget)}
            className={cx('w-full flex items-center gap-2.5 px-3 h-7 text-[13px] text-left disabled:opacity-40',
              hi === i ? (it.danger ? 'bg-danger text-white' : 'bg-accent/20 text-fg') : it.danger ? 'text-danger' : 'text-fg')}>
            <span className="w-4 grid place-items-center shrink-0">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="text-[11px] text-fg3 ml-4">{it.shortcut}</span>}
            {it.items && <Icon name="chevronRight" size={13} className="text-fg3" />}
          </button>
        );
      })}
      {sub && items[sub.index]?.items && (
        <Popover anchor={sub.anchor} side="right" onClose={() => setSub(null)}>
          <MenuList items={items[sub.index].items} onDone={onDone} autoFocus={false} />
        </Popover>
      )}
    </div>
  );
}

export function MenuHost() {
  const m = menuStore.use();
  if (!m) return null;
  return (
    <Popover anchor={m.anchor} onClose={closeMenu} side={m.side || 'bottom'} align={m.align || 'start'}>
      <MenuList items={m.items} onDone={closeMenu} />
    </Popover>
  );
}

/** Application menu bar (File, Edit, Image…). menus: [{ label, items }]. Hovering moves between open menus like a desktop app. */
export function MenuBar({ menus, className }) {
  const [open, setOpen] = useState(null);
  const refs = useRef([]);
  return (
    <nav className={cx('flex items-center', className)} aria-label="Menu">
      {menus.map((m, i) => (
        <button key={m.label} type="button" ref={(el) => { refs.current[i] = el; }}
          onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}
          className={cx('h-7 px-2.5 rounded text-[13px] transition', open === i ? 'bg-active text-fg' : 'text-fg2 hover:text-fg hover:bg-hover')}>
          {m.label}
        </button>
      ))}
      {open !== null && menus[open] && (
        <Popover anchor={refs.current[open]} onClose={() => setOpen(null)}>
          <MenuList items={typeof menus[open].items === 'function' ? menus[open].items() : menus[open].items} onDone={() => setOpen(null)} />
        </Popover>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- modals and dialogs

export function Modal({ title, onClose, children, footer, width = 480, className, bodyClassName, closeOnBackdrop = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', key);
    const prev = document.activeElement;
    ref.current?.querySelector('input,textarea,select,button[data-autofocus]')?.focus();
    return () => { window.removeEventListener('keydown', key); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[900] grid place-items-center p-4 bg-black/55 backdrop-blur-[2px] sl-fade" onPointerDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ width, maxWidth: '100%' }}
        className={cx('bg-panel border border-line rounded-xl shadow-[0_24px_80px_rgba(0,0,0,.55)] max-h-[92vh] flex flex-col sl-pop', className)}>
        {title && (
          <div className="flex items-center gap-3 px-5 h-13 py-3 border-b border-line shrink-0">
            <h2 className="font-head font-semibold text-[15px] flex-1 truncate">{title}</h2>
            {onClose && <IconButton icon="close" label="Close" onClick={onClose} size={28} />}
          </div>
        )}
        <div className={cx('p-5 overflow-auto scroll-thin', bodyClassName)}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line shrink-0">{footer}</div>}
      </div>
    </div>, document.body,
  );
}

const dialogStore = makeStore(null);
/** await confirmDialog({ title, message, confirm: 'Delete', danger: true }) → true/false */
export const confirmDialog = (o) => new Promise((resolve) => dialogStore.set({ kind: 'confirm', ...o, resolve }));
/** await promptDialog({ title, label, value, placeholder, confirm }) → string or null */
export const promptDialog = (o) => new Promise((resolve) => dialogStore.set({ kind: 'prompt', ...o, resolve }));
/** await alertDialog({ title, message }) */
export const alertDialog = (o) => new Promise((resolve) => dialogStore.set({ kind: 'alert', ...o, resolve }));

function DialogBox({ d }) {
  const [v, setV] = useState(d.value ?? '');
  const done = (r) => { dialogStore.set(null); d.resolve(r); };
  return (
    <Modal title={d.title} onClose={() => done(d.kind === 'prompt' ? null : false)} width={420}
      footer={<>
        {d.kind !== 'alert' && <Button variant="ghost" onClick={() => done(d.kind === 'prompt' ? null : false)}>{d.cancel || 'Cancel'}</Button>}
        <Button data-autofocus="" variant={d.danger ? 'danger' : 'primary'} onClick={() => done(d.kind === 'prompt' ? v : true)} disabled={d.kind === 'prompt' && !String(v).trim() && !d.allowEmpty}>
          {d.confirm || (d.kind === 'alert' ? 'OK' : d.kind === 'prompt' ? 'Save' : 'Continue')}
        </Button>
      </>}>
      {d.message && <p className="text-sm text-fg2 whitespace-pre-line">{d.message}</p>}
      {d.kind === 'prompt' && (
        <Field label={d.label} className={d.message ? 'mt-3' : ''}>
          <TextInput value={v} placeholder={d.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (String(v).trim() || d.allowEmpty)) done(v); }}
            onFocus={(e) => e.target.select()} />
        </Field>
      )}
    </Modal>
  );
}
export function DialogHost() {
  const d = dialogStore.use();
  return d ? <DialogBox key={d.title + (d.value || '')} d={d} /> : null;
}

// ---------------------------------------------------------------- toasts

const toastStore = makeStore([]);
let toastId = 0;
/** toast('Saved'), toast('Couldn’t save', { type: 'error' }), toast('Exported', { action: { label: 'Open', onClick } }) */
export function toast(message, { type = 'info', action, duration } = {}) {
  const id = ++toastId;
  toastStore.set((l) => [...l.slice(-3), { id, message, type, action }]);
  setTimeout(() => toastStore.set((l) => l.filter((t) => t.id !== id)), duration ?? (type === 'error' ? 7000 : 3500));
  return id;
}
export const toastError = (e, prefix) => toast(`${prefix ? `${prefix}: ` : ''}${e?.message || e}`, { type: 'error' });
export function Toaster() {
  const list = toastStore.use();
  return createPortal(
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[1100] flex flex-col items-center gap-2 pointer-events-none" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={cx('pointer-events-auto flex items-center gap-3 pl-4 pr-2 h-10 rounded-lg shadow-lg text-sm sl-pop border',
          t.type === 'error' ? 'bg-[#3a1018] border-danger/40 text-[#ffd4d9]' : t.type === 'success' ? 'bg-[#0f2a20] border-ok/40 text-[#c9f5e1]' : 'bg-menu border-line text-fg')}>
          {t.type === 'error' && <Icon name="warning" size={16} />}{t.type === 'success' && <Icon name="check" size={16} />}
          <span className="max-w-[60vw] truncate">{t.message}</span>
          {t.action ? <Button size="xs" variant="ghost" onClick={() => { t.action.onClick(); toastStore.set((l) => l.filter((x) => x.id !== t.id)); }}>{t.action.label}</Button> : <span className="w-2" />}
        </div>
      ))}
    </div>, document.body,
  );
}

// ---------------------------------------------------------------- colour

const recentStore = makeStore((() => { try { return JSON.parse(localStorage.getItem('sl-recent-colors') || '[]'); } catch { return []; } })());
export function rememberColor(hex) {
  const list = [hex, ...recentStore.get().filter((c) => c !== hex)].slice(0, 16);
  recentStore.set(list);
  try { localStorage.setItem('sl-recent-colors', JSON.stringify(list)); } catch { /* private mode */ }
}
export const useRecentColors = () => recentStore.use();

// Colours from the person's libraries (loaded once by the app shell; see lib/app.jsx).
export const libraryColorStore = makeStore([]);

/**
 * Full colour picker: saturation/brightness square, hue and alpha sliders, hex/RGB/HSB entry, eyedropper,
 * basic, recent and library swatches. value/onChange use "#rrggbb" or "#rrggbbaa".
 */
export function ColorPicker({ value, onChange, onCommit, alpha = true, className }) {
  const c = parse(value || '#000000');
  const [hsv, setHsv] = useState(() => rgbToHsv(c));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { const h = rgbToHsv(parse(value)); setHsv((p) => (h.s === 0 || h.v === 0 ? { ...h, h: p.h } : h)); last.current = value; }
  }, [value]);
  const a = c.a ?? 1;
  const emit = (h, al = a, commit = false) => {
    const hex = toHex({ ...hsvToRgb(h), a: al }, al < 1);
    last.current = hex;
    setHsv(h);
    onChange?.(hex);
    if (commit) { onCommit?.(hex); rememberColor(hex); }
  };
  const recent = useRecentColors();
  const lib = libraryColorStore.use();
  const sv = useRef(null);
  const drag = (el, fn) => (e) => {
    e.preventDefault();
    const go = (ev, commit) => { const r = el.current.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height), commit); };
    go(e);
    const move = (ev) => go(ev);
    const up = (ev) => { go(ev, true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const hueRef = useRef(null); const alphaRef = useRef(null);
  const rgb = hsvToRgb(hsv);
  const [hexText, setHexText] = useState(null);
  const pick = async () => {
    try { const r = await new window.EyeDropper().open(); const h = rgbToHsv(parse(r.sRGBHex)); emit(h, a, true); } catch { /* cancelled */ }
  };
  return (
    <div className={cx('w-60 p-3 select-none', className)}>
      <div ref={sv} onPointerDown={drag(sv, (x, y, commit) => emit({ ...hsv, s: x, v: 1 - y }, a, commit))}
        className="relative h-40 rounded-md cursor-crosshair" style={{ background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))` }}>
        <span className="absolute w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)] pointer-events-none"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: toHex(rgb) }} />
      </div>
      <div className="flex items-center gap-2 mt-3">
        <div className="flex-1 flex flex-col gap-2">
          <div ref={hueRef} onPointerDown={drag(hueRef, (x, _y, commit) => emit({ ...hsv, h: x * 360 }, a, commit))} className="relative h-3 rounded-full cursor-pointer"
            style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}>
            <span className="absolute top-1/2 w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full border-2 border-white shadow pointer-events-none" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h},100%,50%)` }} />
          </div>
          {alpha && (
            <div ref={alphaRef} onPointerDown={drag(alphaRef, (x, _y, commit) => emit(hsv, Math.round(x * 100) / 100, commit))} className="relative h-3 rounded-full cursor-pointer checker">
              <div className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(to right,transparent,${toHex(rgb)})` }} />
              <span className="absolute top-1/2 w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full border-2 border-white shadow pointer-events-none" style={{ left: `${a * 100}%` }} />
            </div>
          )}
        </div>
        {'EyeDropper' in window && <IconButton icon="eyedropper" label="Pick a colour from the screen" onClick={pick} size={30} />}
      </div>
      <div className="flex items-center gap-1.5 mt-3">
        <span className="w-7 h-7 rounded checker shrink-0 overflow-hidden border border-line"><span className="block w-full h-full" style={{ background: toHex({ ...rgb, a }, a < 1) }} /></span>
        <input aria-label="Hex colour" value={hexText ?? toHex(rgb).slice(1).toUpperCase()} onChange={(e) => setHexText(e.target.value)}
          onBlur={() => { if (hexText !== null && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hexText.trim())) emit(rgbToHsv(parse(`#${hexText.trim().replace('#', '')}`)), a, true); setHexText(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-[72px] h-7 rounded bg-input border border-line text-[12px] font-mono px-1.5 outline-none focus:border-accent/70 uppercase" />
        <NumberInput label="R" value={Math.round(rgb.r)} min={0} max={255} width={36} onChange={(v) => emit(rgbToHsv({ ...rgb, r: v }))} onCommit={(v) => emit(rgbToHsv({ ...rgb, r: v }), a, true)} />
        {alpha && <NumberInput value={Math.round(a * 100)} unit="%" min={0} max={100} width={46} onChange={(v) => emit(hsv, v / 100)} onCommit={(v) => emit(hsv, v / 100, true)} title="Opacity" />}
      </div>
      <div className="flex items-center gap-1.5 mt-1.5">
        <NumberInput label="G" value={Math.round(rgb.g)} min={0} max={255} width={36} onChange={(v) => emit(rgbToHsv({ ...rgb, g: v }))} onCommit={(v) => emit(rgbToHsv({ ...rgb, g: v }), a, true)} />
        <NumberInput label="B" value={Math.round(rgb.b)} min={0} max={255} width={36} onChange={(v) => emit(rgbToHsv({ ...rgb, b: v }))} onCommit={(v) => emit(rgbToHsv({ ...rgb, b: v }), a, true)} />
        <NumberInput label="H" value={Math.round(hsv.h)} min={0} max={360} width={36} onChange={(v) => emit({ ...hsv, h: v })} onCommit={(v) => emit({ ...hsv, h: v }, a, true)} />
      </div>
      <Swatches label="Recent" colors={recent} onPick={(x) => emit(rgbToHsv(parse(x)), parse(x).a, true)} />
      {lib.length > 0 && <Swatches label="Libraries" colors={lib} onPick={(x) => emit(rgbToHsv(parse(x)), parse(x).a, true)} />}
      <Swatches label="Basic" colors={BASIC_SWATCHES} onPick={(x) => emit(rgbToHsv(parse(x)), 1, true)} />
    </div>
  );
}

function Swatches({ label, colors, onPick }) {
  if (!colors?.length) return null;
  return (
    <div className="mt-2.5">
      <div className="text-[10.5px] uppercase tracking-wider text-fg3 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {colors.slice(0, 18).map((c, i) => (
          <button key={`${c}${i}`} type="button" title={c} onClick={() => onPick(c)} className="w-[22px] h-[22px] rounded checker overflow-hidden border border-line hover:scale-110 transition">
            <span className="block w-full h-full" style={{ background: c }} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A colour square that opens the picker. */
export function ColorSwatch({ value, onChange, onCommit, label, alpha = true, size = 26, className, none, title }) {
  const [anchor, setAnchor] = useState(null);
  const isNone = value === null || value === 'none' || value === 'transparent';
  return (
    <>
      <button type="button" aria-label={label || title || 'Colour'} title={title || label} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={cx('rounded-md checker overflow-hidden border border-line shrink-0 relative', className)} style={{ width: size, height: size }}>
        {isNone ? <span className="absolute inset-0 bg-panel"><span className="absolute left-0 top-1/2 w-[140%] h-0.5 bg-danger -rotate-45 origin-left translate-y-[9px]" /></span>
          : <span className="block w-full h-full" style={{ background: value }} />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          {none && <div className="px-3 pt-3"><Button size="xs" variant="outline" icon="close" onClick={() => { onChange?.(null); onCommit?.(null); setAnchor(null); }}>No colour</Button></div>}
          <ColorPicker value={isNone ? '#000000' : value} onChange={onChange} onCommit={onCommit} alpha={alpha} />
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------- misc hooks

/** Calls fn after `ms` without changes to deps. */
export function useDebounced(fn, ms, deps) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => { const t = setTimeout(() => f.current(), ms); return () => clearTimeout(t); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Element size (ResizeObserver). */
export function useSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Stable callback identity with the latest closure. */
export function useEvent(fn) {
  const r = useRef(fn);
  r.current = fn;
  return useCallback((...a) => r.current(...a), []);
}

export const useMemoOnce = (fn) => useMemo(fn, []); // eslint-disable-line react-hooks/exhaustive-deps
