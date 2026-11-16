import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-pub-'));
process.env.PUBLISH_DRY_RUN = 'true';
const { default: app } = await import('../server/index.js');
const { zonedTime, runDuePosts } = await import('../server/publisher.js');
const { tiktok } = await import('../server/platforms/tiktok.js');

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

test('link account, post now, auto-plan and cancel (demo mode)', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'p@b.co', password: 'password123' } });

  const notLinked = await call('/api/posts', { method: 'POST', body: { clipId: 'x', platform: 'tiktok' } });
  assert.equal(notLinked.status, 404);

  const connect = await call('/connect/tiktok');
  assert.equal(connect.status, 302);
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

test('TikTok publish follows the Content Posting API upload protocol', async () => {
  const file = path.join(os.tmpdir(), `tt-${Date.now()}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (url.endsWith('/creator_info/query/')) return ok({ data: { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] } });
    if (url.endsWith('/post/publish/video/init/')) return ok({ data: { publish_id: 'pub1', upload_url: 'https://upload.example/u1' } });
    if (url === 'https://upload.example/u1') return new Response('', { status: 201 });
    if (url.endsWith('/status/fetch/')) return ok({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [777] } });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const out = await tiktok.publish({ acc: { accessToken: 'tok', username: 'me' }, clip: { title: 'Wow', hashtags: ['#fyp'] }, file, pollMs: 1 });
    assert.deepEqual(out, { externalId: '777', url: 'https://www.tiktok.com/@me/video/777' });
    const init = JSON.parse(calls[1].opts.body);
    assert.equal(init.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
    assert.equal(init.post_info.title, 'Wow\n\n#fyp');
    assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    assert.equal(calls[2].opts.headers['Content-Range'], 'bytes 0-999/1000');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(file, { force: true });
  }
});
