// Administrator API: manage every account (approve, disable, create, reset password, role, delete)
// and back up / restore the whole database (clip video files are not included).
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, CLIPS_DIR, HISTORY_THUMBS_DIR, RESTORE_FILE, applySettings, userSettings, serverWatchAllowed } from './db.js';
import { hashPassword, requireAdmin } from './auth.js';
import { stopUser, syncUser, queueCommand, watchingOverview } from './watch/manager.js';
import { removeUserBrowserData } from './social/index.js';
import { dirSize } from './store.js';

export const router = express.Router();
router.use(requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['user', 'admin'];
const STATUSES = ['pending', 'active', 'disabled'];
const MIN_STORAGE_LIMIT = 1e6;

function userRow(u) {
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM clips WHERE user_id = ?) AS clips,
      (SELECT COUNT(*) FROM streamers WHERE user_id = ?) AS streamers,
      (SELECT COUNT(*) FROM accounts WHERE user_id = ?) AS accounts,
      (SELECT COUNT(*) FROM posts WHERE user_id = ? AND status = 'published') AS published`).get(u.id, u.id, u.id, u.id);
  let processing = 'browser';
  try { processing = JSON.parse(u.settings || '{}').processing || 'browser'; } catch { /* default */ }
  if (!serverWatchAllowed(u)) processing = 'browser';
  return {
    id: u.id, email: u.email, name: u.name, avatar: u.avatar, role: u.role, status: u.status,
    google: Boolean(u.google_id), password: Boolean(u.password_hash), createdAt: u.created_at, lastLoginAt: u.last_login_at,
    processing, serverWatch: serverWatchAllowed(u), storage: dirSize(path.join(CLIPS_DIR, String(u.id))), storageLimit: u.storage_limit || null, ...stats,
  };
}

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
const tempPassword = () => crypto.randomBytes(9).toString('base64url');

router.get('/users', (_req, res) => {
  const users = db.prepare(`SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all().map(userRow);
  res.json({ users, counts: Object.fromEntries(STATUSES.map((s) => [s, users.filter((u) => u.status === s).length])) });
});

router.post('/users', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  const role = ROLES.includes(req.body.role) ? req.body.role : 'user';
  const password = String(req.body.password || '') || tempPassword();
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const name = String(req.body.name || '').trim() || email.split('@')[0];
  const r = db.prepare("INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .run(email, name, hashPassword(password), role, Date.now());
  res.json({ user: userRow(getUser(Number(r.lastInsertRowid))), password: req.body.password ? undefined : password });
});

router.patch('/users/:id', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const self = u.id === req.user.id;
  const role = req.body.role !== undefined ? req.body.role : u.role;
  const status = req.body.status !== undefined ? req.body.status : u.status;
  if (!ROLES.includes(role) || !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid role or status' });
  if (self && (role !== 'admin' || status !== 'active')) return res.status(400).json({ error: 'You cannot demote or disable your own account' });
  if (u.role === 'admin' && u.status === 'active' && (role !== 'admin' || status !== 'active') && activeAdmins() <= 1) {
    return res.status(400).json({ error: 'At least one active administrator is required' });
  }
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 80) || u.name : u.name;
  // Storage limit in bytes; null/0 removes it. Enforced (oldest clips replaced) the next time a clip is saved.
  let storageLimit = u.storage_limit;
  if (req.body.storageLimit !== undefined) {
    const n = Number(req.body.storageLimit || 0);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid storage limit' });
    if (n && n < MIN_STORAGE_LIMIT) return res.status(400).json({ error: 'Storage limit must be at least 1 MB' });
    storageLimit = n ? Math.round(n) : null;
  }
  const serverWatch = req.body.serverWatch !== undefined ? (req.body.serverWatch ? 1 : 0) : u.server_watch;
  db.prepare('UPDATE users SET role = ?, status = ?, name = ?, storage_limit = ?, server_watch = ? WHERE id = ?').run(role, status, name, storageLimit, serverWatch, u.id);
  if (!serverWatch && u.server_watch) {
    // Turning it off stops their server watchers and moves them back to watching in the browser.
    stopUser(u.id);
    applySettings(getUser(u.id), { processing: 'browser', serverRunning: false });
  }
  if (status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    stopUser(u.id);
  }
  res.json(userRow(getUser(u.id)));
});

router.post('/users/:id/reset-password', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const password = String(req.body.password || '') || tempPassword();
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
  if (u.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true, password: req.body.password ? undefined : password });
});

router.delete('/users/:id', async (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (u.role === 'admin' && u.status === 'active' && activeAdmins() <= 1) return res.status(400).json({ error: 'At least one active administrator is required' });
  stopUser(u.id);
  await removeUserBrowserData(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  fs.rmSync(path.join(CLIPS_DIR, String(u.id)), { recursive: true, force: true });
  fs.rmSync(path.join(HISTORY_THUMBS_DIR, String(u.id)), { recursive: true, force: true });
  res.json({ ok: true });
});

// ---------- live watching: see and stop what any user is watching ----------
router.get('/watching', (_req, res) => {
  res.json(watchingOverview().map((w) => {
    const u = getUser(w.userId);
    return u && { ...w, email: u.email, name: u.name, avatar: u.avatar };
  }).filter(Boolean));
});

// Stop everything the user is watching: server watchers are switched off; an open browser dashboard stops on its next heartbeat.
router.post('/watching/:id/stop', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (userSettings(u).serverRunning) applySettings(u, { serverRunning: false });
  stopUser(u.id);
  const browser = queueCommand(u.id, { type: 'stop' });
  res.json({ ok: true, browser });
});

// Stop one stream: turns off auto-clip for that streamer (so it is not picked up again) wherever it is watched.
router.post('/watching/:id/streamers/:login/stop', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const login = String(req.params.login).toLowerCase();
  if (!db.prepare('UPDATE streamers SET enabled = 0 WHERE user_id = ? AND login = ?').run(u.id, login).changes) {
    return res.status(404).json({ error: 'Streamer not found' });
  }
  syncUser(u.id);
  const browser = queueCommand(u.id, { type: 'disable', login });
  res.json({ ok: true, browser });
});

// ---------- whole-database backup / restore ----------
router.get('/backup', (_req, res) => {
  const file = path.join(os.tmpdir(), `slientclip-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.download(file, `slientclip-db-${stamp}.db`, () => fs.rm(file, { force: true }, () => {}));
});

router.post('/restore', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    return res.status(400).json({ error: 'Not a SlientClip database backup (.db)' });
  }
  const tmp = `${RESTORE_FILE}.tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    const check = new DatabaseSync(tmp, { readOnly: true });
    const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const admins = tables.has('users') ? check.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n : 0;
    check.close();
    if (!['users', 'clips', 'streamers'].every((t) => tables.has(t))) throw new Error('Backup is missing SlientClip tables');
    if (!admins) throw new Error('Backup has no administrator account');
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return res.status(400).json({ error: e.message });
  }
  fs.renameSync(tmp, RESTORE_FILE);
  res.json({ ok: true, restarting: true });
  // Docker restarts the container (restart: unless-stopped); db.js swaps the file in on boot.
  setTimeout(() => process.exit(0), 500);
});
