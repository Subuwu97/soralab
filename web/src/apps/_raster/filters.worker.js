// Runs filters.js off the main thread. Message: { id, filter, params, width, height, data } → same shape back.
import { applyFilter } from './filters.js';

self.onmessage = (e) => {
  const { id, filter, params, width, height, data } = e.data;
  const img = { width, height, data };
  applyFilter(filter, img, params);
  self.postMessage({ id, width, height, data: img.data }, [img.data.buffer]);
};
