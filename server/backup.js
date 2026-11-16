// Per-user settings backup: download a JSON file and restore it later (or on another server/account).
// Includes clipping settings, auto-publish schedule and the streamer list. Linked-account tokens
// and clips are deliberately excluded.
import express from 'express';
import { db, userSettings, applySettings } from './db.js';
import { autopublishSettings, planUser, sanitizeAutopublish } from './publisher.js';
import { syncUser } from './watch/manager.js';

export const router = express.Router();
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;

export function exportSettings(user) {
  const settings = { ...userSettings(user) };
  delete settings.autopublish;
  delete settings.serverRunning;
  return {
    app: 'slientclip', type: 'user-settings', version: 1, exportedAt: new Date().toISOString(),
    settings,
    autopublish: autopublishSettings(user),
    streamers: db.prepare('SELECT login, display_name, avatar, enabled FROM streamers WHERE user_id = ? ORDER BY created_at').all(user.id)
      .map((s) => ({ login: s.login, displayName: s.display_name, avatar: s.avatar, enabled: Boolean(s.enabled) })),
  };
}

export function importSettings(user, backup, { replace = false } = {}) {
  if (!backup || backup.app !== 'slientclip' || backup.type !== 'user-settings') throw new Error('Not a SlientClip settings backup');
  const next = applySettings(user, backup.settings || {});
  if (backup.autopublish) {
    const ap = sanitizeAutopublish(backup.autopublish, autopublishSettings(user));
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify({ ...next, autopublish: ap }), user.id);
  }
  const streamers = (Array.isArray(backup.streamers) ? backup.streamers : []).filter((s) => LOGIN_RE.test(String(s.login || '')));
  if (replace) {
    const keep = new Set(streamers.map((s) => s.login));
    for (const s of db.prepare('SELECT id, login FROM streamers WHERE user_id = ?').all(user.id)) {
      if (!keep.has(s.login)) db.prepare('DELETE FROM streamers WHERE id = ?').run(s.id);
    }
  }
  const up = db.prepare(`INSERT INTO streamers (user_id, login, display_name, avatar, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT(user_id, login) DO UPDATE SET enabled = excluded.enabled,
                           display_name = COALESCE(excluded.display_name, display_name), avatar = COALESCE(excluded.avatar, avatar)`);
  streamers.forEach((s, i) => up.run(user.id, s.login, s.displayName || null, s.avatar || null, s.enabled === false ? 0 : 1, Date.now() + i));
  db.prepare("DELETE FROM posts WHERE user_id = ? AND source = 'auto' AND status = 'scheduled' AND scheduled_at > ?").run(user.id, Date.now());
  planUser(user.id);
  syncUser(user.id);
  return { streamers: streamers.length };
}

router.get('/api/backup', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="slientclip-settings-${stamp}.json"`);
  res.json(exportSettings(req.user));
});

router.post('/api/backup/restore', (req, res) => {
  try {
    const result = importSettings(req.user, req.body?.backup, { replace: req.body?.mode === 'replace' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
