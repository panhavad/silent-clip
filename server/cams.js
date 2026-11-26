// Per-user, per-streamer webcam position for the "streamer cam + gameplay" clip layout.
import { db } from './db.js';

const MODES = ['auto', 'manual', 'off'];
const num = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 10000) / 10000;
const rect = (b) => (b && typeof b === 'object' ? { x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h) } : null);

// A detection result as stored (only the fields the renderer uses).
function cleanPlan(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'cam') {
    const cam = rect(p.cam);
    if (!cam || cam.w < 0.02 || cam.h < 0.02) return null;
    return { type: 'cam', cam, face: rect(p.face) || undefined, score: Number(p.score) || undefined };
  }
  if (p.type === 'full') return { type: 'full', focusX: num(p.focusX), score: Number(p.score) || undefined };
  return null;
}

export function getCam(userId, login) {
  const row = db.prepare('SELECT data, updated_at FROM streamer_cams WHERE user_id = ? AND login = ?').get(userId, login);
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* ignore */ }
  return { login, mode: MODES.includes(data.mode) ? data.mode : 'auto', box: data.box || null, last: data.last || null, lastAt: data.lastAt || 0, updatedAt: row?.updated_at || 0 };
}

export function updateCam(userId, login, body) {
  const cur = getCam(userId, login);
  const next = { mode: cur.mode, box: cur.box, last: cur.last, lastAt: cur.lastAt };
  if (body.detected !== undefined) {
    const plan = cleanPlan(body.detected);
    if (plan) { next.last = plan; next.lastAt = Date.now(); }
  }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return { error: 'mode must be auto, manual or off' };
    next.mode = body.mode;
    if (body.mode === 'manual') {
      const box = rect(body.box);
      if (!box || box.w < 0.02 || box.h < 0.02 || box.x + box.w > 1.001 || box.y + box.h > 1.001) return { error: 'Draw the rectangle around the streamer\'s cam' };
      next.box = box;
    }
  }
  db.prepare(`INSERT INTO streamer_cams (user_id, login, data, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, login) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(userId, login, JSON.stringify(next), Date.now());
  return getCam(userId, login);
}
