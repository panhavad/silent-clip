import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const CLIPS_DIR = path.join(DATA_DIR, 'clips');
fs.mkdirSync(CLIPS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
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
`);

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
};

export function userSettings(user) {
  let s = {};
  try { s = JSON.parse(user.settings || '{}'); } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS, ...s };
}
