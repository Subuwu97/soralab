#!/usr/bin/env node
// SoraLab reuses a few pieces of the Mirai suite (notification client, bell, service worker, install helpers).
// They're vendored in suite/ so SoraLab builds on its own; run this to pull the latest from a suite checkout:
//   node scripts/sync-suite.mjs [path to the mirai repo, default ../mirai]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = path.resolve(process.argv[2] || path.join(root, '..', 'mirai'));
const files = { 'shared/notify.js': 'suite/notify.js', 'shared/web/Bell.jsx': 'suite/web/Bell.jsx', 'shared/web/pwa.js': 'suite/web/pwa.js', 'shared/web/sw.js': 'suite/web/sw.js' };
if (!fs.existsSync(path.join(suite, 'shared'))) { console.error(`No Mirai suite at ${suite}`); process.exit(1); }
for (const [from, to] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(suite, from), path.join(root, to));
  console.log(`${from} → ${to}`);
}
