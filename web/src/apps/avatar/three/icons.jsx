// Line glyphs the shared icon set doesn't have (24×24, current colour), for the 3D tab rail and view toggles.
const P = {
  figure: ['M12 4.5a2 2 0 1 0 0-.01', 'M12 7.5v6.5', 'M7 9.5l5-1 5 1', 'M12 14l-3 6M12 14l3 6'],
  bone: ['M7.5 16.5l9-9', 'M6.2 14.4a2.2 2.2 0 1 0 3.4 3.4 2.2 2.2 0 1 0-3.4-3.4Z', 'M14.4 6.2a2.2 2.2 0 1 0 3.4 3.4 2.2 2.2 0 1 0-3.4-3.4Z'],
  face: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z', 'M9 10h.01M15 10h.01', 'M8.5 14.2c1.9 2 5.1 2 7 0'],
  spring: ['M12 3c-3 2-3 4 0 5.5s3 3.5 0 5.5-3 4 0 5.5', 'M12 20.5v.5'],
  palette: ['M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.6-.8 1.3-1.7-.4-1.2.4-2.3 1.6-2.3h1.6a4 4 0 0 0 4-4A8.6 8.6 0 0 0 12 3.5Z', 'M7.5 12h.01M9.5 8h.01M14.5 8h.01'],
  tracking: ['M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16', 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z'],
  camera: ['M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z', 'M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  info: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z', 'M12 11v5', 'M12 8h.01'],
  collider: ['M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3'],
};

export function Glyph({ name, size = 18, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {(P[name] || []).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
