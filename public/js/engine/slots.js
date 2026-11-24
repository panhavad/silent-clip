// Posting-slot times for auto-publish. Shared by the server planner and the schedule calendar so both
// always agree. "random" mode spreads N posts a day over a time window at times that look natural and
// differ every day, but are stable for a given day and seed (the planner re-runs every few minutes).

const pad = (n) => String(n).padStart(2, '0');
export const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const toHHMM = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
export const dayKeyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// FNV-1a hash -> mulberry32: small, fast, deterministic.
function seededRandom(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `perDay` times inside [from, to], one per equal share of the window, so posts never bunch up. */
export function randomTimes({ perDay, from, to }, seedText) {
  const start = toMinutes(from);
  const end = toMinutes(to);
  const count = Math.max(1, Math.min(perDay, Math.floor((end - start) / 15) || 1));
  const share = (end - start) / count;
  const rand = seededRandom(seedText);
  const out = [];
  for (let i = 0; i < count; i++) {
    // Keep away from the edges of each share so neighbouring posts stay at least ~30% of a share apart.
    const lo = start + i * share + share * 0.15;
    const hi = start + (i + 1) * share - share * 0.15;
    out.push(Math.floor(lo + rand() * Math.max(1, hi - lo)));
  }
  return [...new Set(out)].sort((a, b) => a - b).map(toHHMM);
}

/** The "HH:MM" posting times of one platform on one local day. */
export function slotsForDay(cfg, { dayKey, platform, seed = '' }) {
  if (cfg.mode !== 'random') return cfg.times || [];
  return randomTimes(cfg, `${seed}|${platform}|${dayKey}`);
}
