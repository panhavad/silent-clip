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
