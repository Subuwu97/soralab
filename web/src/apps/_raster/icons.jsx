// Extra icons used by the raster editors (the shared set lives in components/Icons.jsx; same 24×24 line style).
import { Icon as Base } from '../../components/Icons.jsx';

const X = {
  clipArrow: ['M7 4v9a3 3 0 0 0 3 3h9', 'M15 12l4 4-4 4'],
  lockAlpha: ['M4 4h7v7H4z', 'M13 13h7v7h-7z', 'M13 4v7h7', 'M4 13v7h7'],
  swap: ['M7 4 4 7l3 3', 'M4 7h11a4 4 0 0 1 4 4v1', 'M17 20l3-3-3-3', 'M20 17H9a4 4 0 0 1-4-4v-1'],
  defaultColors: ['M4 4h9v9H4z', 'M11 11h9v9h-9z'],
  airbrush: ['M4 20l7-7', 'M11 13l3-3 4 4-3 3z', 'M17 4h.01M20 7h.01M15 3h.01M19 2h.01M21 4h.01'],
  marker: ['M5 19l4-1 10-10-3-3L6 15z', 'M14 7l3 3', 'M4 21h7'], ink: ['M12 3l4 8-4 10-4-10z', 'M12 11v3'],
  charcoal: ['M6 18 16 4l4 3-10 14z', 'M4 21h.01M7 21h.01M3 18h.01'], watercolor: ['M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z', 'M9 15a3 3 0 0 0 3 3'],
  oil: ['M14 3l7 7-4 1-4-4z', 'M13 7 5 15c-2 2-1 5 1 5s3-1 4-3l7-6'], softRound: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  symmetry: ['M12 3v18', 'M8 7 4 12l4 5', 'M16 7l4 5-4 5'], wheel: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 3v9l7 5', 'M12 12 5 17'],
  lassoFill: ['M7 19c-2 0-3-1-3-2.5S6 14 8 15c-3-1.5-5-4-5-6.5C3 5 7 3 12 3s9 2 9 5.5S17 15 12 15', 'M10 8h4M9 11h6'],
  polyLasso: ['M4 18 7 5l8 3 5-3-2 11-7 2z'], rotateView: ['M4 12a8 8 0 0 1 14-5.3L20 9', 'M20 4v5h-5', 'M12 12l4 4'],
  record: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'], sponge: ['M5 8h14v10H5z', 'M8 11h.01M12 13h.01M16 11h.01M10 16h.01M15 15h.01'],
  burn: ['M12 3a9 9 0 0 1 9 9', 'M12 21a9 9 0 0 1-9-9', 'M8 12a4 4 0 0 0 8 0'], sharpen: 'M12 3 20 20H4z', shapeLine: 'M5 19 19 5',
  newLayer: ['M5 5h14v14H5z', 'M12 9v6M9 12h6'], folderPlus: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'M12 10v6M9 13h6'],
  maskAdd: ['M4 4h16v16H4z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'], adjustLayer: ['M12 21a9 9 0 1 0 0-18v18Z', 'M12 3a9 9 0 0 1 0 18'],
};

export function Icon({ name, ...rest }) {
  const d = X[name];
  if (!d) return <Base name={name} {...rest} />;
  const { size = 18, className = '', stroke = 1.75 } = rest;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(Array.isArray(d) ? d : [d]).map((x, i) => <path key={i} d={x} />)}
    </svg>
  );
}

/** Square tool/icon button that understands the extra icons. */
export function IBtn({ icon, label, active, size = 28, iconSize, className = '', shortcut, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label ? (shortcut ? `${label} (${shortcut})` : label) : undefined} aria-pressed={active ?? undefined} {...rest}
      style={{ width: size, height: size, ...(rest.style || {}) }}
      className={`inline-flex items-center justify-center rounded-md transition shrink-0 disabled:opacity-40 disabled:pointer-events-none ${active ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover hover:text-fg'} ${className}`}>
      <Icon name={icon} size={iconSize || Math.round(size * 0.58)} />
    </button>
  );
}
