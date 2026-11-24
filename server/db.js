import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const CLIPS_DIR = path.join(DATA_DIR, 'clips');
fs.mkdirSync(CLIPS_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const RESTORE_FILE = path.join(DATA_DIR, 'app.db.restore');
// An admin restore is staged as app.db.restore and swapped in before the database is opened.
if (fs.existsSync(RESTORE_FILE)) {
  // Keep the previous database (with its WAL files, so it stays complete) next to the restored one.
  const before = path.join(DATA_DIR, `app.db.before-restore-${Date.now()}`);
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB_FILE + ext)) fs.renameSync(DB_FILE + ext, before + ext);
  }
  fs.renameSync(RESTORE_FILE, DB_FILE);
  console.log(`Database restored from admin backup (previous database kept as ${path.basename(before)})`);
}

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    name TEXT,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    avatar TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login TEXT NOT NULL,
    display_name TEXT,
    avatar TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, login)
  );
  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    streamer_login TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '[]',
    caption TEXT NOT NULL DEFAULT '',
    viral TEXT NOT NULL DEFAULT '{}',
    duration REAL,
    width INTEGER,
    height INTEGER,
    size INTEGER,
    video_file TEXT,
    thumb_file TEXT,
    source_file TEXT,
    created_at INTEGER NOT NULL,
    downloaded_at INTEGER,
    posted TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS clips_user_created ON clips(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_id TEXT,
    username TEXT,
    display_name TEXT,
    avatar TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, platform)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    source TEXT NOT NULL DEFAULT 'manual',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    external_id TEXT,
    url TEXT,
    published_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS posts_user_time ON posts(user_id, scheduled_at);`);

// ---- migrations ----
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!userCols.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
// Existing accounts stay active; new sign-ups are inserted as 'pending' until an admin approves them.
if (!userCols.has('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!userCols.has('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
const postCols = new Set(db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name));
if (!postCols.has('step')) db.exec('ALTER TABLE posts ADD COLUMN step TEXT');
if (!postCols.has('shot')) db.exec('ALTER TABLE posts ADD COLUMN shot INTEGER NOT NULL DEFAULT 0');
if (!postCols.has('finished_at')) db.exec('ALTER TABLE posts ADD COLUMN finished_at INTEGER');
// Accounts used to be OAuth tokens; posting now uses logged-in browser sessions, so old token links are dropped.
db.prepare('DELETE FROM accounts WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL').run();
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = (SELECT MIN(id) FROM users)").run();
}
if (process.env.ADMIN_EMAIL) {
  db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE email = ?").run(process.env.ADMIN_EMAIL.trim().toLowerCase());
}

/** Role/status for a brand-new account: first account or ADMIN_EMAIL = active admin, others wait for approval. */
export function newAccountState(email) {
  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const isAdminEmail = Boolean(email && process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.trim().toLowerCase());
  if (first || isAdminEmail) return { role: 'admin', status: 'active' };
  return { role: 'user', status: process.env.REQUIRE_APPROVAL === 'false' ? 'active' : 'pending' };
}

export const DEFAULT_SETTINGS = {
  mode: 'background',          // background | foreground
  windowLayout: 'per-streamer', // per-streamer | grid
  autoStart: true,             // start watching automatically when the app is opened
  sensitivity: 5,              // 1 (only huge spikes) .. 10 (clip often)
  cooldownSec: 120,
  maxClipsPerHour: 10,
  preRollSec: 20,
  postRollSec: 10,
  reactionDelaySec: 3,
  captions: true,              // burn hook headline + chat bubble into every clip
  subtitles: true,             // burn spoken-word subtitles (in-browser speech-to-text) into every clip
  subtitleLanguage: '',        // '' = auto-detect, or a Whisper language code like 'en'
  layout: 'blur',              // blur | crop
  resolution: '720x1280',
  keepSource: true,
  processing: 'browser',       // browser | server  (where watching + clipping runs)
  serverRunning: false,        // server mode: watchers are on (survives restarts)
  publishView: 'background',   // background (hidden browser, reports result) | foreground (show the posting browser window)
  youtubeVisibility: 'public', // public | unlisted | private
  tiktokPrivacy: 'everyone',   // everyone | friends | only_me
};

const ENUMS = {
  mode: ['background', 'foreground'], windowLayout: ['per-streamer', 'grid'], layout: ['blur', 'crop'],
  resolution: ['720x1280', '1080x1920', '540x960'], processing: ['browser', 'server'],
  publishView: ['background', 'foreground'], youtubeVisibility: ['public', 'unlisted', 'private'], tiktokPrivacy: ['everyone', 'friends', 'only_me'],
};

/** Validate + persist a partial settings object; nested `autopublish` is kept as-is. */
export function applySettings(user, body = {}) {
  const next = { ...userSettings(user) };
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) next[k] = n; }
    else if (typeof def === 'boolean') next[k] = Boolean(v);
    else if (!ENUMS[k] || ENUMS[k].includes(String(v))) next[k] = String(v).slice(0, 40);
  }
  next.sensitivity = Math.min(10, Math.max(1, next.sensitivity));
  next.preRollSec = Math.min(60, Math.max(5, next.preRollSec));
  next.postRollSec = Math.min(30, Math.max(3, next.postRollSec));
  next.reactionDelaySec = Math.min(15, Math.max(0, next.reactionDelaySec));
  next.cooldownSec = Math.min(3600, Math.max(10, next.cooldownSec));
  next.maxClipsPerHour = Math.min(60, Math.max(1, next.maxClipsPerHour));
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(next), user.id);
  user.settings = JSON.stringify(next);
  for (const fn of settingsListeners) fn(user.id, next);
  return next;
}

const settingsListeners = new Set();
export const onSettingsChanged = (fn) => settingsListeners.add(fn);

export function userSettings(user) {
  let s = {};
  try { s = JSON.parse(user.settings || '{}'); } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS, ...s };
}
