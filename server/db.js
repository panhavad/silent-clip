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
    clip_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    source TEXT NOT NULL DEFAULT 'manual',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    external_id TEXT,
    url TEXT,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    step TEXT,
    shot INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER,
    clip_title TEXT,
    clip_streamer TEXT,
    clip_score REAL,
    clip_thumb TEXT
  );
  CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS posts_user_time ON posts(user_id, scheduled_at);`);

// ---- migrations ----
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!userCols.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
// Existing accounts stay active; new sign-ups are inserted as 'pending' until an admin approves them.
if (!userCols.has('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!userCols.has('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
// Bytes of clip storage an admin allows this user; NULL = unlimited. Over the limit, the oldest clips are replaced.
if (!userCols.has('storage_limit')) db.exec('ALTER TABLE users ADD COLUMN storage_limit INTEGER');
// Admin switch: may this account watch & clip on the server (processing = 'server')? 1 = allowed.
if (!userCols.has('server_watch')) db.exec('ALTER TABLE users ADD COLUMN server_watch INTEGER NOT NULL DEFAULT 1');
// Access end date an admin set (ms); NULL = never. After it passes the user can still sign in and look, but can't use anything.
if (!userCols.has('expires_at')) db.exec('ALTER TABLE users ADD COLUMN expires_at INTEGER');
// When the user finished or skipped the welcome tour; NULL = show it on their next visit. Accounts that existed
// before the tour was added already know the app, so they're marked as seen.
if (!userCols.has('tour_seen_at')) {
  db.exec('ALTER TABLE users ADD COLUMN tour_seen_at INTEGER');
  db.prepare('UPDATE users SET tour_seen_at = ?').run(Date.now());
}
// v1.9: watching never starts on its own unless chosen. Auto-start used to default to on and was saved with
// every settings form, so switch it off once for existing accounts; users can turn it back on in Settings.
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec(`UPDATE users SET settings = json_set(settings, '$.autoStart', json('false')) WHERE json_valid(settings) AND json_extract(settings, '$.autoStart') = 1;
           PRAGMA user_version = 1;`);
}
const postCols = new Set(db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name));
// Set when the user marks a clip as published by hand: it leaves the auto-post queue and is deleted after a day.
if (!new Set(db.prepare('PRAGMA table_info(clips)').all().map((c) => c.name)).has('published_at')) db.exec('ALTER TABLE clips ADD COLUMN published_at INTEGER');
if (!postCols.has('step')) db.exec('ALTER TABLE posts ADD COLUMN step TEXT');
if (!postCols.has('shot')) db.exec('ALTER TABLE posts ADD COLUMN shot INTEGER NOT NULL DEFAULT 0');
if (!postCols.has('finished_at')) db.exec('ALTER TABLE posts ADD COLUMN finished_at INTEGER');
// v1.11: the schedule keeps its history after a clip is deleted. Posts used to be deleted with their clip
// (ON DELETE CASCADE), so the table is rebuilt without that link and with a snapshot of the clip's info.
if (db.prepare('PRAGMA foreign_key_list(posts)').all().some((f) => f.table === 'clips')) {
  const keep = ['id', 'user_id', 'clip_id', 'platform', 'scheduled_at', 'status', 'source', 'attempts', 'error', 'external_id',
    'url', 'published_at', 'created_at', 'step', 'shot', 'finished_at'].join(', ');
  db.exec(`BEGIN;
    CREATE TABLE posts_new (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, clip_id TEXT NOT NULL,
      platform TEXT NOT NULL, scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', source TEXT NOT NULL DEFAULT 'manual',
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, external_id TEXT, url TEXT, published_at INTEGER, created_at INTEGER NOT NULL,
      step TEXT, shot INTEGER NOT NULL DEFAULT 0, finished_at INTEGER, clip_title TEXT, clip_streamer TEXT, clip_score REAL, clip_thumb TEXT);
    INSERT INTO posts_new (${keep}) SELECT ${keep} FROM posts;
    DROP TABLE posts;
    ALTER TABLE posts_new RENAME TO posts;
    CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS posts_user_time ON posts(user_id, scheduled_at);
    COMMIT;`);
}
db.exec('CREATE INDEX IF NOT EXISTS posts_clip ON posts(clip_id)');
// Browsers paired through the SlientClip Chrome extension (they post to YouTube from the user's own Chrome).
db.exec(`CREATE TABLE IF NOT EXISTS ext_links (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  version TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
)`);
// What the extension last saw about YouTube in that Chrome (1 signed in / 0 signed out / NULL unknown).
{
  const cols = new Set(db.prepare('PRAGMA table_info(ext_links)').all().map((c) => c.name));
  if (!cols.has('yt_logged_in')) db.exec('ALTER TABLE ext_links ADD COLUMN yt_logged_in INTEGER');
  if (!cols.has('yt_name')) db.exec('ALTER TABLE ext_links ADD COLUMN yt_name TEXT');
  if (!cols.has('yt_checked_at')) db.exec('ALTER TABLE ext_links ADD COLUMN yt_checked_at INTEGER');
}
// v1.15: the extension no longer takes over the YouTube account row (the server-browser login and the extension
// are two separate ways to connect). Move what older versions stored there to the extension link.
for (const r of db.prepare("SELECT user_id, display_name, meta FROM accounts WHERE platform = 'youtube' AND json_valid(meta) AND json_extract(meta, '$.method') = 'extension'").all()) {
  const meta = JSON.parse(r.meta);
  db.prepare('UPDATE ext_links SET yt_logged_in = ?, yt_name = COALESCE(yt_name, ?), yt_checked_at = ? WHERE user_id = ?')
    .run(meta.loggedIn === false ? 0 : 1, r.display_name, meta.checkedAt || Date.now(), r.user_id);
  db.prepare(`UPDATE users SET settings = json_set(CASE WHEN json_valid(settings) THEN settings ELSE '{}' END, '$.youtubeVia', 'extension') WHERE id = ?`).run(r.user_id);
  if (fs.existsSync(path.join(DATA_DIR, 'browser', String(r.user_id), 'youtube'))) {
    // A server login may still be in the profile: keep the row and let the next check confirm it.
    db.prepare("UPDATE accounts SET meta = ? WHERE user_id = ? AND platform = 'youtube'")
      .run(JSON.stringify({ ...meta, method: 'browser', loggedIn: true, refreshedAt: 0 }), r.user_id);
  } else {
    db.prepare("DELETE FROM accounts WHERE user_id = ? AND platform = 'youtube'").run(r.user_id);
  }
}
// Thumbnails of deleted clips that still appear in the schedule history.
export const HISTORY_THUMBS_DIR = path.join(DATA_DIR, 'history-thumbs');
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
  autoStart: false,            // start background watching automatically when the app is opened (opt-in)
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
  youtubeVia: 'auto',          // how YouTube posts go out: auto (extension when connected) | extension | server
};

const ENUMS = {
  mode: ['background', 'foreground'], windowLayout: ['per-streamer', 'grid'], layout: ['blur', 'crop'],
  resolution: ['720x1280', '1080x1920', '540x960'], processing: ['browser', 'server'],
  publishView: ['background', 'foreground'], youtubeVisibility: ['public', 'unlisted', 'private'], tiktokPrivacy: ['everyone', 'friends', 'only_me'],
  youtubeVia: ['auto', 'extension', 'server'],
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
  if (!serverWatchAllowed(user)) { next.processing = 'browser'; next.serverRunning = false; }
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(next), user.id);
  user.settings = JSON.stringify(next);
  for (const fn of settingsListeners) fn(user.id, next);
  return next;
}

const settingsListeners = new Set();
export const onSettingsChanged = (fn) => settingsListeners.add(fn);

export const serverWatchAllowed = (user) => user?.server_watch !== 0;

/** Has this account's access ended? Administrators never expire. */
export const accessExpired = (user, now = Date.now()) => Boolean(user && user.role !== 'admin' && user.expires_at && user.expires_at <= now);
export const EXPIRED_MESSAGE = 'Your access has expired. Contact your administrator to renew it.';
/** Who expired users should contact: ADMIN_EMAIL, or the longest-standing active admin. */
export const adminContact = () => process.env.ADMIN_EMAIL?.trim()
  || db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL ORDER BY id LIMIT 1").get()?.email || null;

export function userSettings(user) {
  let s = {};
  try { s = JSON.parse(user.settings || '{}'); } catch { /* ignore */ }
  const out = { ...DEFAULT_SETTINGS, ...s };
  if (!serverWatchAllowed(user)) { out.processing = 'browser'; out.serverRunning = false; }
  return out;
}
