// Paint's brush families. Each preset is a set of brush-engine settings (see _raster/brush.js BRUSH_DEFAULTS);
// people tweak size/opacity/flow/curves per family and those tweaks are remembered on this device.
export const FAMILIES = [
  { id: 'pencil', label: 'Pencil', icon: 'pencil', b: { tip: 'grain', size: 6, hardness: 0.9, flow: 0.85, opacity: 1, spacing: 0.08, pressureSize: true, minSize: 0.45, pressureOpacity: true, opacityCurve: 1.2, tilt: true, smoothing: 10 } },
  { id: 'ink', label: 'Ink pen', icon: 'ink', b: { tip: 'round', size: 12, hardness: 0.96, flow: 1, opacity: 1, spacing: 0.04, pressureSize: true, minSize: 0.08, sizeCurve: 1.3, smoothing: 45 } },
  { id: 'marker', label: 'Marker', icon: 'marker', b: { tip: 'chisel', size: 34, hardness: 0.75, flow: 1, opacity: 0.8, spacing: 0.04, pressureSize: false, angle: -35, blend: 'multiply', smoothing: 20 } },
  { id: 'airbrush', label: 'Airbrush', icon: 'airbrush', b: { tip: 'round', size: 140, hardness: 0, flow: 0.06, opacity: 1, spacing: 0.1, pressureSize: false, pressureOpacity: true, buildUp: true, smoothing: 5 } },
  { id: 'soft', label: 'Soft round', icon: 'softRound', b: { tip: 'round', size: 60, hardness: 0.25, flow: 0.45, opacity: 1, spacing: 0.1, pressureSize: true, minSize: 0.3, pressureOpacity: true, smoothing: 15 } },
  { id: 'charcoal', label: 'Charcoal', icon: 'charcoal', b: { tip: 'grain', size: 42, hardness: 0.55, flow: 0.7, opacity: 1, spacing: 0.12, pressureSize: true, minSize: 0.5, pressureOpacity: true, angleJitter: 1, scatter: 0.12, tilt: true, smoothing: 10 } },
  { id: 'watercolor', label: 'Watercolour', icon: 'watercolor', b: { tip: 'wet', size: 90, hardness: 0.15, flow: 0.16, opacity: 0.85, spacing: 0.1, pressureSize: true, minSize: 0.55, pressureOpacity: true, wetEdges: true, pickup: 1, jitterBri: 0.04, smoothing: 20 } },
  { id: 'oil', label: 'Oil (blending)', icon: 'oil', b: { tip: 'bristle', kind: 'blend', size: 54, hardness: 0.7, flow: 0.9, strength: 0.65, opacity: 1, spacing: 0.06, pressureSize: true, minSize: 0.4, pressureOpacity: true, smoothing: 20 } },
  { id: 'smudge', label: 'Smudge', icon: 'smudge', b: { tip: 'round', kind: 'smudge', size: 50, hardness: 0.4, flow: 1, strength: 0.7, opacity: 1, spacing: 0.06, pressureSize: true, minSize: 0.4, pressureOpacity: true, smoothing: 10 } },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', b: { tip: 'round', size: 50, hardness: 0.7, flow: 1, opacity: 1, spacing: 0.08, pressureSize: true, minSize: 0.35, smoothing: 10 } },
];
export const familyById = (id) => FAMILIES.find((f) => f.id === id) || FAMILIES[0];

const KEY = 'sl-paint-brushes';
export function loadBrushes() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* private mode */ }
  return Object.fromEntries(FAMILIES.map((f) => [f.id, { ...f.b, ...(saved[f.id] || {}) }]));
}
export function saveBrushes(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* private mode */ } }
