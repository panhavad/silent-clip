// Clip persistence shared by browser uploads (POST /api/clips) and server-side watchers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, CLIPS_DIR } from './db.js';
import { onClipCreated } from './publisher.js';

const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export const userDir = (userId) => { const d = path.join(CLIPS_DIR, String(userId)); fs.mkdirSync(d, { recursive: true }); return d; };

export function sanitizeMeta(m = {}) {
  const tags = (Array.isArray(m.hashtags) ? m.hashtags : String(m.hashtags || '').split(/[\s,]+/))
    .map((t) => String(t).trim().replace(/^#*/, '#')).filter((t) => t.length > 1).slice(0, 30);
  return {
    title: String(m.title || '').slice(0, 200),
    description: String(m.description || '').slice(0, 5000),
    hashtags: tags,
    caption: String(m.caption || '').slice(0, 500),
    viral: m.viral && typeof m.viral === 'object' ? m.viral : {},
    streamer: String(m.streamer || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25),
    duration: Number(m.duration) || null, width: Number(m.width) || null, height: Number(m.height) || null,
    sourceExt: m.sourceExt === 'mp4' ? 'mp4' : 'ts',
  };
}

/** Move rendered files into the user's clip folder and record the clip. `files` = { video, thumb?, source? } temp paths. */
export function insertClip(userId, meta, files) {
  const id = crypto.randomUUID();
  const dir = userDir(userId);
  const move = (src, name) => {
    if (!src) return null;
    const dest = path.join(dir, name);
    try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
    return name;
  };
  const size = fs.statSync(files.video).size;
  const video = move(files.video, `${id}.mp4`);
  const thumb = move(files.thumb, `${id}.jpg`);
  const source = move(files.source, `${id}.src.${meta.sourceExt}`);
  db.prepare(`INSERT INTO clips (id, user_id, streamer_login, title, description, hashtags, caption, viral, duration, width, height, size, video_file, thumb_file, source_file, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, meta.streamer, meta.title, meta.description, JSON.stringify(meta.hashtags), meta.caption,
      JSON.stringify(meta.viral), meta.duration, meta.width, meta.height, size, video, thumb, source, Date.now());
  onClipCreated(userId);
  return db.prepare('SELECT * FROM clips WHERE id = ?').get(id);
}

export { json };
