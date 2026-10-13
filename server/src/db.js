// SQLite schema: people, projects (documents) and their versions, uploaded assets, libraries, fonts and render jobs.
// Document contents and files live on disk under data/; the database only holds what's needed to list and find them.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

export const db = new Database(path.join(config.dataDir, 'soralab.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,             -- Mirai Account sub
  username      TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  picture       TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  settings      TEXT NOT NULL DEFAULT '{}',   -- JSON: theme, recent colours, workspace layouts, shortcuts…
  refresh_token TEXT,
  session_ver   INTEGER NOT NULL DEFAULT 1,
  last_sync     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_name ON users(username);

-- A project in one of the apps (a Photo document, a Cut sequence, a Layout publication…).
-- Its contents are opaque to the server: data/docs/<id>/data (usually JSON), written by the app.
CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app         TEXT NOT NULL,                  -- photo | paint | develop | vector | express | proto | layout | pdf | cut | motion | animate | audio
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/json',
  size        INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0,     -- bumped on every save; saves can require the rev they started from
  width       INTEGER, height INTEGER, duration REAL, pages INTEGER,   -- for display in lists
  has_thumb   INTEGER NOT NULL DEFAULT 0,
  starred     INTEGER NOT NULL DEFAULT 0,
  meta        TEXT NOT NULL DEFAULT '{}',     -- app-defined summary (colour mode, frame rate…)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  opened_at   INTEGER,
  trashed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS docs_owner ON docs(owner, updated_at);

CREATE TABLE IF NOT EXISTS doc_versions (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  label       TEXT,                           -- named versions are never pruned
  size        INTEGER NOT NULL,
  author      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_versions_doc ON doc_versions(doc_id, created_at);

-- Other people who can open a project.
CREATE TABLE IF NOT EXISTS doc_shares (
  doc_id      TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer', -- viewer | commenter | editor
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (doc_id, user_id)
);

-- Review comments, pinned to a spot: { x, y } (0..1 of the canvas), t (seconds) for timelines, page for documents.
CREATE TABLE IF NOT EXISTS doc_comments (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  parent_id   TEXT,
  author      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  anchor      TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_comments_doc ON doc_comments(doc_id, created_at);

-- Files used by projects or kept in Files: images, video, audio, fonts in use, exports. data/assets/<id>/file
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id      TEXT REFERENCES docs(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- image | video | audio | pdf | font | other
  size        INTEGER NOT NULL,
  width       INTEGER, height INTEGER, duration REAL, fps REAL, has_audio INTEGER,
  is_export   INTEGER NOT NULL DEFAULT 0,     -- made by SoraLab (render, export), shown under Exports
  source      TEXT,                           -- upload | cloud:<file id> | render:<job id> | export
  web         INTEGER NOT NULL DEFAULT 0,     -- browser-friendly copy (images browsers can't show, video codecs they can't play): 0 not needed, 1 making, 2 ready, -1 failed
  meta        TEXT NOT NULL DEFAULT '{}',     -- codecs etc.
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_owner ON assets(owner, created_at);
CREATE INDEX IF NOT EXISTS assets_doc ON assets(doc_id);

-- Libraries: colours, gradients, character / paragraph styles, graphics, brushes, presets, LUTs… usable in every app.
CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS library_items (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                  -- color | gradient | swatchgroup | charstyle | parastyle | graphic | brush | preset | lut | template | text
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',     -- JSON, defined by the kind
  asset_id    TEXT REFERENCES assets(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_items_lib ON library_items(library_id, position);

-- Fonts people add (TTF, OTF, WOFF, WOFF2). They can be used in every app.
CREATE TABLE IF NOT EXISTS fonts (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family      TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT 'normal',
  weight      INTEGER NOT NULL DEFAULT 400,
  file        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Render queue (Media Encoder): timeline exports and conversions run by ffmpeg.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id      TEXT REFERENCES docs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                  -- timeline | transcode
  name        TEXT NOT NULL,
  spec        TEXT NOT NULL,                  -- JSON
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
  progress    REAL NOT NULL DEFAULT 0,
  error       TEXT,
  output_id   TEXT REFERENCES assets(id) ON DELETE SET NULL,
  after       TEXT,                           -- JSON: what to do when done { cloud: { folder_id }, tsunami: { title, visibility } }
  after_result TEXT,                          -- JSON
  encoder     TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at);
`);

export const now = () => Date.now();
export const newId = () => crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, (c) => (c === '-' ? 'x' : 'y'));
export const json = (s, fallback = {}) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
