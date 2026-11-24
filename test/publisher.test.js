import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-pub-'));
process.env.PUBLISH_DRY_RUN = 'true';
process.env.BROWSER_DISABLED = 'true';
const { default: app } = await import('../server/index.js');
const { zonedTime, runDuePosts } = await import('../server/publisher.js');

const realFetch = globalThis.fetch;
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let cookie = '';
async function call(p, { method = 'GET', body, form } = {}) {
  const headers = { cookie };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await realFetch(base + p, { method, headers, body: form || (body && JSON.stringify(body)), redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set && set.startsWith('sc_session')) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null), location: res.headers.get('location') };
}

async function uploadClip(title, score) {
  const form = new FormData();
  form.append('meta', JSON.stringify({ streamer: 'jynxzi', title, hashtags: ['#shorts'], viral: { score } }));
  form.append('video', new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), 'clip.mp4');
  return (await call('/api/clips', { method: 'POST', form })).data;
}

test('zonedTime converts wall-clock time in a time zone to UTC', () => {
  assert.equal(zonedTime(2026, 11, 16, 12, 0, 'Asia/Tokyo'), Date.UTC(2026, 10, 16, 3, 0));
  assert.equal(zonedTime(2026, 7, 1, 9, 30, 'America/New_York'), Date.UTC(2026, 6, 1, 13, 30));
  assert.equal(zonedTime(2026, 1, 1, 9, 30, 'America/New_York'), Date.UTC(2026, 0, 1, 14, 30));
});

test('log in (demo), post now, auto-plan and cancel', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'p@b.co', password: 'password123' } });

  const notLinked = await call('/api/posts', { method: 'POST', body: { clipId: 'x', platform: 'tiktok' } });
  assert.equal(notLinked.status, 404);

  const login = await call('/api/accounts/tiktok/login', { method: 'POST' });
  assert.equal(login.data.loggedIn, true);
  const accounts = (await call('/api/accounts')).data.accounts;
  assert.equal(accounts.find((a) => a.platform === 'tiktok').connected, true);
  assert.equal(accounts.find((a) => a.platform === 'youtube').connected, false);

  const clip = await uploadClip('Big play', 80);
  const post = await call('/api/posts', { method: 'POST', body: { clipId: clip.id, platform: 'tiktok' } });
  assert.ok(['scheduled', 'publishing'].includes(post.data.status), 'post now starts immediately');
  const yt = await call('/api/posts', { method: 'POST', body: { clipId: clip.id, platform: 'youtube' } });
  assert.equal(yt.status, 400, 'unlinked platform is rejected');

  let published;
  for (let i = 0; i < 40 && published?.status !== 'published'; i++) {
    await runDuePosts({ wait: true });
    [published] = (await call(`/api/posts?clipId=${clip.id}`)).data;
    if (published.status !== 'published') await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(published.status, 'published');
  assert.match(published.url, /tiktok\.com/);
  assert.match((await call(`/api/clips/${clip.id}`)).data.posted.tiktok.url, /tiktok\.com/);

  // Auto-publish: two TikTok slots per day, best score first, already-posted clips skipped.
  const low = await uploadClip('Low', 30);
  const high = await uploadClip('High', 95);
  const mid = await uploadClip('Mid', 60);
  await call('/api/autopublish', { method: 'PUT', body: { enabled: true, timezone: 'UTC', minScore: 50, platforms: { tiktok: { times: ['09:00', '21:00'] } } } });
  const plan = (await call(`/api/posts?from=${Date.now()}&to=${Date.now() + 8 * 86400000}`)).data.filter((p) => p.source === 'auto');
  assert.deepEqual(plan.map((p) => p.clip.title), ['High', 'Mid'], 'min score excludes Low; already posted clip excluded');
  assert.ok(plan.every((p) => p.platform === 'tiktok' && [9, 21].includes(new Date(p.scheduledAt).getUTCHours())));
  assert.ok(plan[0].scheduledAt < plan[1].scheduledAt);
  assert.ok(!plan.some((p) => p.clipId === low.id));

  // Canceling a planned post frees its slot but never re-plans that clip on that platform.
  await call(`/api/posts/${plan[0].id}`, { method: 'DELETE' });
  const after = (await call(`/api/posts?from=${Date.now()}&to=${Date.now() + 8 * 86400000}`)).data.filter((p) => p.source === 'auto');
  assert.deepEqual(after.map((p) => p.clipId), [mid.id]);
  assert.equal((await call('/api/clips')).data.clips.find((c) => c.id === mid.id).scheduled[0].platform, 'tiktok');
  assert.ok(high);
});

test('random posting times: N a day inside the window, spread out, stable per day, new each day', async () => {
  const { slotsForDay, toMinutes } = await import('../public/js/engine/slots.js');
  const cfg = { mode: 'random', perDay: 4, from: '10:00', to: '22:00' };
  const day = (k, seed = 's1') => slotsForDay(cfg, { dayKey: k, platform: 'tiktok', seed });
  const a = day('2026-11-24');
  assert.equal(a.length, 4);
  assert.deepEqual(day('2026-11-24'), a, 'same day + seed = same times (the planner re-runs often)');
  assert.notDeepEqual(day('2026-11-25'), a, 'a different day gets different times');
  assert.notDeepEqual(day('2026-11-24', 's2'), a, 'shuffling (new seed) changes them');
  const mins = a.map(toMinutes);
  assert.ok(mins.every((m) => m >= 600 && m < 1320), `inside 10:00-22:00: ${a}`);
  for (let i = 1; i < mins.length; i++) assert.ok(mins[i] - mins[i - 1] >= 50, `spread out: ${a}`); // shares are 180 min; >= 30% apart
  assert.notEqual(new Set(a.map((t) => t.slice(3))).size, 1, 'not all on the same minute mark');
  assert.deepEqual(slotsForDay({ mode: 'times', times: ['09:00'] }, { dayKey: '2026-11-24', platform: 'x' }), ['09:00']);
});

test('auto-publish in random mode plans N posts a day at system-picked times', async () => {
  for (let i = 0; i < 6; i++) await uploadClip(`R${i}`, 70 + i);
  const bad = await call('/api/autopublish', { method: 'PUT', body: { platforms: { tiktok: { mode: 'random', from: '20:00', to: '08:00' } } } });
  assert.equal(bad.status, 400, 'window must end after it starts');
  const saved = (await call('/api/autopublish', { method: 'PUT', body: {
    enabled: true, timezone: 'UTC', minScore: 50, platforms: { tiktok: { mode: 'random', perDay: 3, from: '10:00', to: '22:00' } },
  } })).data;
  assert.equal(saved.platforms.tiktok.mode, 'random');
  assert.ok(saved.seed, 'a seed is created');
  const autoPlan = async () => (await call(`/api/posts?from=${Date.now()}&to=${Date.now() + 8 * 86400000}`)).data.filter((p) => p.source === 'auto' && p.status === 'scheduled');
  const plan = await autoPlan();
  assert.ok(plan.length >= 3, `planned ${plan.length}`);
  const perDay = {};
  for (const p of plan) {
    const d = new Date(p.scheduledAt);
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    assert.ok(min >= 600 && min < 1320, `inside the window: ${d.toISOString()}`);
    perDay[d.toISOString().slice(0, 10)] = (perDay[d.toISOString().slice(0, 10)] || 0) + 1;
  }
  assert.ok(Object.values(perDay).every((n) => n <= 3), 'never more than 3 a day');
  // Re-planning (runs every few minutes) keeps the same times and doesn't add duplicates.
  const { planUser } = await import('../server/publisher.js');
  const me = (await call('/api/me')).data;
  planUser(me.id);
  assert.deepEqual((await autoPlan()).map((p) => p.scheduledAt).sort(), plan.map((p) => p.scheduledAt).sort());
  // Shuffle: a new seed gives new times.
  await call('/api/autopublish', { method: 'PUT', body: { seed: 'shuffled1' } });
  assert.notDeepEqual((await autoPlan()).map((p) => p.scheduledAt).sort(), plan.map((p) => p.scheduledAt).sort());
});

test('bulk select: mark published (off the schedule, deleted after 24 h), unmark, and delete', async () => {
  const { purgePublished } = await import('../server/store.js');
  const { db } = await import('../server/db.js');
  const range = () => `/api/posts?from=${Date.now()}&to=${Date.now() + 8 * 86400000}`;
  const autoClipIds = async () => new Set((await call(range())).data.filter((p) => p.source === 'auto' && p.status === 'scheduled').map((p) => p.clipId));
  const a = await uploadClip('Bulk A', 99);
  const b = await uploadClip('Bulk B', 98);
  const c = await uploadClip('Bulk C', 97);
  await call('/api/autopublish', { method: 'PUT', body: { enabled: true, timezone: 'UTC', minScore: 50, platforms: { tiktok: { mode: 'random', perDay: 3, from: '10:00', to: '22:00' } } } });
  assert.ok((await autoClipIds()).has(a.id), 'best clip is planned before marking');

  const marked = await call('/api/clips/bulk', { method: 'POST', body: { action: 'published', ids: [a.id, b.id, 'not-mine'] } });
  assert.deepEqual([marked.status, marked.data.done], [200, 2]);
  const planned = await autoClipIds();
  assert.ok(!planned.has(a.id) && !planned.has(b.id), 'published clips leave the schedule and are not re-planned');
  const lib = (await call('/api/clips?filter=posted')).data;
  const ca = lib.clips.find((x) => x.id === a.id);
  assert.ok(ca.publishedAt && !ca.isNew && ca.deletesAt - ca.publishedAt === 24 * 3600000, 'shown under Posted with a 24 h deadline');
  const later = await call('/api/posts', { method: 'POST', body: { clipId: a.id, platform: 'tiktok', scheduledAt: Date.now() + 3600000 } });
  assert.equal(later.status, 409, 'a published clip cannot be scheduled by hand either');

  await call('/api/clips/bulk', { method: 'POST', body: { action: 'unpublished', ids: [b.id] } });
  assert.equal((await call(`/api/clips/${b.id}`)).data.publishedAt, null);

  assert.equal(purgePublished(Date.now() + 23 * 3600000), 0, 'kept for 24 h');
  assert.equal(purgePublished(Date.now() + 24 * 3600000 + 1000), 1, 'then deleted (only the still-published one)');
  assert.equal((await call(`/api/clips/${a.id}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts WHERE clip_id = ?').get(a.id).n, 0);

  const del = await call('/api/clips/bulk', { method: 'POST', body: { action: 'delete', ids: [b.id, c.id] } });
  assert.equal(del.data.done, 2);
  assert.equal((await call(`/api/clips/${c.id}`)).status, 404);
  assert.equal((await call('/api/clips/bulk', { method: 'POST', body: { action: 'nope', ids: [b.id] } })).status, 400);
});
