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
