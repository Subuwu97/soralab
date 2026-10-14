// Files chosen from "Files" (or uploaded before the project existed) aren't attached to a project, and the server only
// lets people a project is shared with see files attached to it. So the owner's editor attaches them quietly.
import { api } from '../../lib/api.js';

const done = new Set();
export async function linkAssets(ids, docId) {
  for (const id of ids) {
    if (!id || done.has(`${id}|${docId}`)) continue;
    done.add(`${id}|${docId}`);
    try {
      const a = await api.get(`/api/assets/${id}`, { quiet: true });
      if (!a.doc_id) await api.patch(`/api/assets/${id}`, { doc_id: docId }, { quiet: true });
    } catch { /* not ours, or already shared through another project */ }
  }
}
