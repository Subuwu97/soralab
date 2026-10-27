import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const port = Number(process.env.PORT || 4800);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
const accountsUrl = (process.env.ACCOUNTS_URL || 'http://localhost:4000').replace(/\/$/, '');
const url = (v) => String(v || '').replace(/\/$/, '');

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  publicUrl,
  brand: process.env.BRAND_NAME || 'Mirai',
  // Sign-in: Mirai Account (OpenID Connect). Internal URL for server-to-server calls.
  accountsUrl,
  accountsInternalUrl: url(process.env.ACCOUNTS_INTERNAL_URL || accountsUrl),
  clientId: process.env.CLIENT_ID || 'soralab',
  clientSecret: process.env.CLIENT_SECRET || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  webDist: path.resolve(ROOT, process.env.WEB_DIST || '../web/dist'),
  // The rest of the suite (all optional): open and save files in Minami Cloud, publish videos to Tsunami.
  suiteSecret: process.env.SUITE_SECRET || '',
  cloudUrl: url(process.env.CLOUD_URL),
  cloudInternalUrl: url(process.env.CLOUD_INTERNAL_URL || process.env.CLOUD_URL),
  photosUrl: url(process.env.PHOTOS_URL),
  tsunamiUrl: url(process.env.TSUNAMI_URL),
  tsunamiInternalUrl: url(process.env.TSUNAMI_INTERNAL_URL || process.env.TSUNAMI_URL),
  // Tsunami's RTMP ingest for Sora Ningyō's "Go live" (default: Tsunami's internal host on the port Tsunami reports).
  tsunamiRtmpUrl: url(process.env.TSUNAMI_RTMP_URL),
  // Other suite apps' web addresses that may use Sora Ningyō avatars from their pages (Hikari's avatar camera): its public
  // URL, its https:// network address and dev ports. Written by the suite's setup; see suite-cors.js.
  suiteOrigins: [...new Set([...String(process.env.SUITE_ORIGINS || '').split(','), process.env.HIKARI_URL || ''].map((o) => { try { return new URL(o.trim()).origin; } catch { return ''; } }).filter(Boolean))],
  // Limits. Storage is per person (projects, assets, fonts and exports); 0 = unlimited.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 4096),
  maxDocMb: Number(process.env.MAX_DOC_MB || 512),
  storageGb: Number(process.env.STORAGE_GB_PER_USER || 0),
  // Rendering (video exports, conversions). ffmpeg finds the fastest encoder: NVENC, Quick Sync, AMF/VAAPI, VideoToolbox or CPU.
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  videoEncoder: process.env.VIDEO_ENCODER || 'auto',
  renderJobs: Math.max(1, Number(process.env.RENDER_JOBS || 1)),
  versionsPerDoc: Number(process.env.VERSIONS_PER_DOC || 50),
  // Storage cleanup (api/storage.js): how often it runs (0 = only when asked) and how old an unused autosaved file must be.
  cleanupEveryHours: Number(process.env.CLEANUP_EVERY_HOURS ?? 6),
  cleanupGraceHours: Math.max(1, Number(process.env.CLEANUP_GRACE_HOURS || 24)),
  // HTTPS on the home network (set by the suite's setup; needed for the mic): see lan-https.js.
  httpsPort: Number(process.env.HTTPS_PORT || 0),
  tlsCert: process.env.TLS_CERT ? path.resolve(ROOT, process.env.TLS_CERT) : '',
  tlsKey: process.env.TLS_KEY ? path.resolve(ROOT, process.env.TLS_KEY) : '',
  lanCaCert: process.env.LAN_CA_CERT ? path.resolve(ROOT, process.env.LAN_CA_CERT) : '',
};

for (const d of ['docs', 'assets', 'fonts', 'jobs', 'tmp']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
if (!config.sessionSecret) {
  console.error('[soralab] SESSION_SECRET is not set. Run the Mirai suite\'s setup (npm run setup) or set it in server/.env.');
  process.exit(1);
}
if (!config.clientSecret) console.warn('[soralab] CLIENT_SECRET not set — sign-in will fail until SoraLab is registered with Mirai Account.');
