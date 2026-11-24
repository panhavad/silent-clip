// Clip persistence shared by browser uploads (POST /api/clips) and server-side watchers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, CLIPS_DIR, HISTORY_THUMBS_DIR } from './db.js';
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
  const overwritten = enforceStorageLimit(userId, id);
  onClipCreated(userId);
  return Object.assign(db.prepare('SELECT * FROM clips WHERE id = ?').get(id), { overwritten });
}

export function dirSize(dir) {
  try { return fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0); } catch { return 0; }
}

const fileSize = (dir, f) => { try { return f ? fs.statSync(path.join(dir, f)).size : 0; } catch { return 0; } };

/**
 * Delete a clip's files and row. Its schedule history (published / failed posts) is kept with a snapshot of the
 * clip's title, streamer, score and thumbnail; posts that were still waiting to go out are dropped.
 */
export function removeClip(row) {
  const dir = userDir(row.user_id);
  const history = db.prepare("SELECT COUNT(*) n FROM posts WHERE clip_id = ? AND status IN ('published', 'failed', 'publishing')").get(row.id).n;
  if (history) {
    let thumb = null;
    if (row.thumb_file && fs.existsSync(path.join(dir, row.thumb_file))) {
      const tdir = path.join(HISTORY_THUMBS_DIR, String(row.user_id));
      fs.mkdirSync(tdir, { recursive: true });
      thumb = `${row.id}.jpg`;
      try { fs.copyFileSync(path.join(dir, row.thumb_file), path.join(tdir, thumb)); } catch { thumb = null; }
    }
    db.prepare('UPDATE posts SET clip_title = ?, clip_streamer = ?, clip_score = ?, clip_thumb = ? WHERE clip_id = ?')
      .run(row.title || '', row.streamer_login || '', json(row.viral, {}).score ?? null, thumb, row.id);
  }
  db.prepare("DELETE FROM posts WHERE clip_id = ? AND status NOT IN ('published', 'failed', 'publishing')").run(row.id);
  for (const f of [row.video_file, row.thumb_file, row.source_file]) if (f) fs.rmSync(path.join(dir, f), { force: true });
  db.prepare('DELETE FROM clips WHERE id = ?').run(row.id);
}

/** Drop a deleted clip's saved thumbnail once no history entry uses it any more. */
export function pruneHistoryThumb(userId, clipId) {
  if (db.prepare('SELECT 1 FROM clips WHERE id = ?').get(clipId) || db.prepare('SELECT 1 FROM posts WHERE clip_id = ?').get(clipId)) return;
  fs.rmSync(path.join(HISTORY_THUMBS_DIR, String(userId), `${clipId}.jpg`), { force: true });
}

export function storageUsage(userId) {
  const limit = db.prepare('SELECT storage_limit FROM users WHERE id = ?').get(userId)?.storage_limit || null;
  return { used: dirSize(path.join(CLIPS_DIR, String(userId))), limit };
}

/**
 * Keep a user within the storage limit an admin set: while over it, their oldest clips are deleted
 * so new ones can take their place. The clip just saved (`keepId`) and clips waiting to be posted are kept.
 * Returns the removed clips ({ id, title }).
 */
export function enforceStorageLimit(userId, keepId = '') {
  const { used, limit } = storageUsage(userId);
  if (!limit || used <= limit) return [];
  const dir = userDir(userId);
  const oldest = db.prepare(`SELECT * FROM clips c WHERE c.user_id = ? AND c.id != ?
      AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('scheduled', 'publishing'))
      ORDER BY c.created_at ASC`).all(userId, keepId);
  let left = used;
  const removed = [];
  for (const c of oldest) {
    if (left <= limit) break;
    left -= [c.video_file, c.thumb_file, c.source_file].reduce((a, f) => a + fileSize(dir, f), 0);
    removeClip(c);
    removed.push({ id: c.id, title: c.title });
  }
  return removed;
}

export { json };

// Clips the user marked as published are removed this long afterwards (PUBLISHED_TTL_HOURS, default 24).
export const PUBLISHED_TTL_MS = Number(process.env.PUBLISHED_TTL_HOURS ?? 24) * 3600 * 1000;

/** Delete clips marked published more than PUBLISHED_TTL_MS ago (not while one is being posted). */
export function purgePublished(now = Date.now()) {
  const rows = db.prepare(`SELECT * FROM clips c WHERE c.published_at IS NOT NULL AND c.published_at <= ?
      AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'publishing')`).all(now - PUBLISHED_TTL_MS);
  for (const r of rows) removeClip(r);
  return rows.length;
}

export function startClipJanitor() {
  const run = () => { try { const n = purgePublished(); if (n) console.log(`[clips] removed ${n} published clip(s) older than ${PUBLISHED_TTL_MS / 3600000} h`); } catch (e) { console.error('clip janitor', e.message); } };
  run();
  setInterval(run, 10 * 60000).unref();
}
