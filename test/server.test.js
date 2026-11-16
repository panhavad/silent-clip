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

  let list = await call('/api/clips?filter=new');
  assert.equal(list.data.counts.new, 1);

  const dl = await fetch(`${base}/api/clips/${id}/download`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /Big moment\.mp4/);

  await call(`/api/clips/${id}/mark`, { method: 'POST', body: { action: 'posted', platform: 'tiktok', url: 'https://www.tiktok.com/@x/video/1' } });
  list = await call('/api/clips');
  assert.deepEqual(list.data.counts, { all: 1, new: 0, downloaded: 1, posted: 1 });
  assert.equal(list.data.clips[0].posted.tiktok.url, 'https://www.tiktok.com/@x/video/1');

  // Another user cannot see or fetch the clip.
  cookie = '';
  await call('/api/auth/register', { method: 'POST', body: { email: 'c@d.co', password: 'password123' } });
  assert.equal((await call(`/api/clips/${id}`)).status, 404);
  assert.equal((await call('/api/clips')).data.counts.all, 0);
});
