import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-test-'));
const { default: app, parseTwitchLogin } = await import('../server/index.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let cookie = '';
async function call(p, { method = 'GET', body, form } = {}) {
  const headers = { cookie };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: form || (body && JSON.stringify(body)) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('parseTwitchLogin accepts links and handles', () => {
  assert.equal(parseTwitchLogin('https://www.twitch.tv/Jynxzi'), 'jynxzi');
  assert.equal(parseTwitchLogin('twitch.tv/some_user/videos'), 'some_user');
  assert.equal(parseTwitchLogin('@xQc'), 'xqc');
  assert.equal(parseTwitchLogin('https://www.twitch.tv/directory'), null);
  assert.equal(parseTwitchLogin('not a channel!'), null);
});

test('healthz and public config report the deployed version', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const health = (await call('/healthz')).data;
  assert.equal(health.version, pkg.version);
  assert.match(health.label, new RegExp(`^v${pkg.version.replace(/\./g, '\\.')}`));
  const { build } = (await call('/api/config')).data;
  assert.equal(build.version, pkg.version);
  assert.equal(build.commit, health.commit);
});

test('auth, streamers and clip lifecycle with new/downloaded/posted tracking', async () => {
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', password: 'short' } })).status, 400);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } })).status, 200);
  assert.equal((await call('/api/me')).data.email, 'a@b.co');

  const s = await call('/api/streamers', { method: 'POST', body: { url: 'https://www.twitch.tv/Jynxzi' } });
  assert.equal(s.data.login, 'jynxzi');

  const form = new FormData();
  form.append('meta', JSON.stringify({ streamer: 'jynxzi', title: 'Big moment', hashtags: ['shorts', '#twitch'], viral: { score: 80 } }));
  form.append('video', new Blob([new Uint8Array(1024)], { type: 'video/mp4' }), 'clip.mp4');
  const up = await call('/api/clips', { method: 'POST', form });
  assert.equal(up.status, 200);
  assert.deepEqual(up.data.hashtags, ['#shorts', '#twitch']);
  assert.equal(up.data.isNew, true);
  const id = up.data.id;

  // Editing details keeps everything not sent (e.g. the hashtags when only the title changes).
  const edited = await call(`/api/clips/${id}`, { method: 'PATCH', body: { title: 'Bigger moment', description: 'What a play' } });
  assert.equal(edited.data.title, 'Bigger moment');
  assert.equal(edited.data.description, 'What a play');
  assert.deepEqual(edited.data.hashtags, ['#shorts', '#twitch']);
  await call(`/api/clips/${id}`, { method: 'PATCH', body: { title: 'Big moment' } });
  assert.equal((await call(`/api/clips/${id}`)).data.description, 'What a play');

  let list = await call('/api/clips?filter=new');
  assert.equal(list.data.counts.new, 1);

  const dl = await fetch(`${base}/api/clips/${id}/download`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /Big moment\.mp4/);

  await call(`/api/clips/${id}/mark`, { method: 'POST', body: { action: 'posted', platform: 'tiktok', url: 'https://www.tiktok.com/@x/video/1' } });
  list = await call('/api/clips');
  assert.deepEqual(list.data.counts, { all: 1, new: 0, downloaded: 1, posted: 1 });
  assert.equal(list.data.clips[0].posted.tiktok.url, 'https://www.tiktok.com/@x/video/1');

  // New sign-ups wait for approval; the first account is the admin.
  assert.equal((await call('/api/me')).data.role, 'admin');
  const adminCookie = cookie;
  cookie = '';
  const reg = await call('/api/auth/register', { method: 'POST', body: { email: 'c@d.co', password: 'password123' } });
  assert.equal(reg.status, 202);
  assert.equal(reg.data.pending, true);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'c@d.co', password: 'password123' } })).status, 403);

  cookie = adminCookie;
  const users = (await call('/api/admin/users')).data;
  assert.equal(users.counts.pending, 1);
  const pending = users.users.find((u) => u.email === 'c@d.co');
  assert.equal((await call(`/api/admin/users/${pending.id}`, { method: 'PATCH', body: { status: 'active' } })).data.status, 'active');
  const reset = await call(`/api/admin/users/${pending.id}/reset-password`, { method: 'POST', body: {} });
  assert.ok(reset.data.password.length >= 8);
  const me = (await call('/api/me')).data;
  assert.equal((await call(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { role: 'user' } })).status, 400, 'cannot demote yourself');
  const created = await call('/api/admin/users', { method: 'POST', body: { email: 'e@f.co', name: 'Ed' } });
  assert.ok(created.data.password, 'temporary password returned');
  assert.equal(created.data.user.status, 'active');
  assert.equal((await call(`/api/admin/users/${created.data.user.id}`, { method: 'DELETE' })).status, 200);
  const backup = await fetch(`${base}/api/admin/backup`, { headers: { cookie } });
  assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');

  // The approved user signs in with the reset password, cannot see the admin's clip or admin API.
  cookie = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'c@d.co', password: reset.data.password } })).status, 200);
  assert.equal((await call('/api/admin/users')).status, 403);
  assert.equal((await call(`/api/clips/${id}`)).status, 404);
  assert.equal((await call('/api/clips')).data.counts.all, 0);

  // Settings backup round-trip.
  await call('/api/settings', { method: 'PUT', body: { sensitivity: 8, layout: 'crop' } });
  await call('/api/streamers', { method: 'POST', body: { url: 'twitch.tv/xqc' } });
  const exported = (await call('/api/backup')).data;
  assert.equal(exported.type, 'user-settings');
  assert.deepEqual(exported.streamers.map((s) => s.login), ['xqc']);
  await call('/api/settings', { method: 'PUT', body: { sensitivity: 2 } });
  exported.streamers.push({ login: 'jynxzi', enabled: false });
  assert.equal((await call('/api/backup/restore', { method: 'POST', body: { backup: exported, mode: 'replace' } })).status, 200);
  assert.equal((await call('/api/me')).data.settings.sensitivity, 8);
  assert.deepEqual((await call('/api/streamers')).data.map((s) => [s.login, s.enabled]), [['xqc', true], ['jynxzi', false]]);
});

test('admin storage limit: oldest clips are replaced, scheduled ones are kept', async () => {
  const { db } = await import('../server/db.js');
  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  const user = (await call('/api/admin/users', { method: 'POST', body: { email: 'quota@x.co', password: 'password123' } })).data.user;
  assert.equal(user.storageLimit, null);
  assert.equal((await call(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { storageLimit: 1000 } })).status, 400);
  assert.equal((await call(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { storageLimit: 1.5e6 } })).data.storageLimit, 1.5e6);

  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'quota@x.co', password: 'password123' } });
  const upload = async (title) => {
    const form = new FormData();
    form.append('meta', JSON.stringify({ streamer: 'xqc', title }));
    form.append('video', new Blob([new Uint8Array(600_000)], { type: 'video/mp4' }), 'clip.mp4');
    return (await call('/api/clips', { method: 'POST', form })).data;
  };
  const a = await upload('A');
  assert.equal((await upload('B')).overwritten, 0);
  // A is waiting to be posted, so it must survive even though it is the oldest.
  db.prepare("INSERT INTO posts (id, user_id, clip_id, platform, scheduled_at, status, created_at) VALUES ('p1', ?, ?, 'youtube', ?, 'scheduled', ?)")
    .run(user.id, a.id, Date.now() + 3600000, Date.now());
  assert.equal((await upload('C')).overwritten, 1);
  assert.equal((await upload('D')).overwritten, 1);
  const list = (await call('/api/clips')).data;
  assert.deepEqual(list.clips.map((c) => c.title), ['D', 'A']);
  assert.equal(list.clips[1].scheduled[0].status, 'scheduled', 'cards get the pending post state');
  assert.equal(list.storage.limit, 1.5e6);
  assert.ok(list.storage.used <= 1.5e6);

  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  assert.equal((await call(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { storageLimit: null } })).data.storageLimit, null);
});

test('admin can turn server-side watching off and on per user', async () => {
  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  const user = (await call('/api/admin/users', { method: 'POST', body: { email: 'watcher@x.co', password: 'password123' } })).data.user;
  assert.equal(user.serverWatch, true, 'allowed by default');

  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'watcher@x.co', password: 'password123' } });
  assert.equal((await call('/api/server-watch', { method: 'PUT', body: { processing: 'server' } })).data.processing, 'server');
  const userCookie = cookie;

  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  const off = (await call(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { serverWatch: false } })).data;
  assert.equal(off.serverWatch, false);
  assert.equal(off.processing, 'browser', 'moved back to browser processing');
  const adminCookie = cookie;

  cookie = userCookie;
  const me = (await call('/api/me')).data;
  assert.equal(me.serverWatch, false);
  assert.equal(me.settings.processing, 'browser');
  assert.equal((await call('/api/server-watch', { method: 'PUT', body: { running: true } })).status, 403);
  assert.equal((await call('/api/server-watch', { method: 'PUT', body: { processing: 'server' } })).status, 403);
  assert.equal((await call('/api/settings', { method: 'PUT', body: { processing: 'server' } })).data.processing, 'browser');
  assert.equal((await call('/api/server-watch')).data.allowed, false);

  cookie = adminCookie;
  assert.equal((await call(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { serverWatch: true } })).data.serverWatch, true);
  cookie = userCookie;
  assert.equal((await call('/api/server-watch', { method: 'PUT', body: { processing: 'server' } })).data.processing, 'server');
});

test('admin sees who is watching and can stop a user or a single stream', async () => {
  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  const adminCookie = cookie;
  const user = (await call('/api/admin/users', { method: 'POST', body: { email: 'viewer@x.co', password: 'password123' } })).data.user;

  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'viewer@x.co', password: 'password123' } });
  const userCookie = cookie;
  await call('/api/streamers', { method: 'POST', body: { url: 'twitch.tv/xqc' } });
  const beat = (running = true) => call('/api/watch/heartbeat', { method: 'POST', body: { running, processing: 'browser', mode: 'background', streamers: [{ login: 'xqc', status: 'watching', live: true, viewers: 50000 }] } });
  assert.deepEqual((await beat()).data.commands, []);
  assert.equal((await call('/api/admin/watching')).status, 403, 'admins only');

  cookie = adminCookie;
  let watching = (await call('/api/admin/watching')).data;
  const row = watching.find((w) => w.email === 'viewer@x.co');
  assert.deepEqual(row.browser.streamers.map((s) => [s.login, s.live]), [['xqc', true]]);
  // One stream: auto-clip goes off and the open dashboard is told to drop it.
  assert.equal((await call(`/api/admin/watching/${user.id}/streamers/xqc/stop`, { method: 'POST' })).data.browser, true);
  assert.equal((await call(`/api/admin/watching/${user.id}/streamers/nobody/stop`, { method: 'POST' })).status, 404);
  // Everything: the dashboard gets a stop command on its next heartbeat.
  assert.equal((await call(`/api/admin/watching/${user.id}/stop`, { method: 'POST' })).data.browser, true);

  cookie = userCookie;
  assert.equal((await call('/api/streamers')).data[0].enabled, false);
  assert.deepEqual((await beat()).data.commands, [{ type: 'disable', login: 'xqc' }, { type: 'stop' }]);
  cookie = adminCookie;
  // The dashboard is stopping as soon as it has the command, even though this heartbeat still said "running".
  assert.equal((await call('/api/admin/watching')).data.some((w) => w.email === 'viewer@x.co'), false);
  cookie = userCookie;
  assert.deepEqual((await beat(false)).data.commands, [], 'commands are delivered once');

  cookie = adminCookie;
  watching = (await call('/api/admin/watching')).data;
  assert.equal(watching.some((w) => w.email === 'viewer@x.co'), false);
});

test('sign-in sessions slide forward instead of expiring', async () => {
  const { db } = await import('../server/db.js');
  cookie = '';
  await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'password123' } });
  const id = cookie.split('=')[1];
  // Pretend the session is about to run out; the next visit extends it to the full lifetime again.
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + 60000, id);
  const res = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') || '', /Max-Age=34560000/);
  const left = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id).expires_at - Date.now();
  assert.ok(left > 399 * 86400000, 'renewed to ~400 days');
  // Renewed at most once a day: an immediate second visit doesn't rewrite the cookie.
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).headers.get('set-cookie'), null);
});
