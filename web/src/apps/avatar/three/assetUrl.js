// Where an asset's bytes are. kind 'web' = the browser-friendly copy (images); 'file' = the original (model files).
// Kept in its own tiny module so the light index can use it without loading three.js.
export const defaultAssetUrl = (id, kind = 'file') => `/api/assets/${id}/${kind === 'web' ? 'web' : 'file'}`;
