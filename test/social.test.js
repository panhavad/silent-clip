// Drives a real Chrome/Edge/Chromium against a tiny fake "platform" site to exercise the whole
// browser-posting pipeline: live-viewer login, saved session, human-like upload, results and failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-social-'));
process.env.PUBLISH_DRY_RUN = 'false';
process.env.SOCIAL_KEEPALIVE_DWELL_SEC = '0';
const { default: app } = await import('../server/index.js');
const { runDuePosts } = await import('../server/publisher.js');
const { DRIVERS, refreshDueSessions } = await import('../server/social/index.js');
const { browserAvailable, openSession } = await import('../server/social/browser.js');
const { humanClick, clearAndType, waitForAny, LoggedOutError } = await import('../server/social/human.js');

const skip = browserAvailable() ? false : 'no Chrome, Edge or Chromium installed';

// ---- fake platform ----
const PAGES = {
  '/login': `<button id="in" style="position:absolute;left:100px;top:100px;width:200px;height:80px"
      onclick="document.cookie='sid=abc; max-age=3600; path=/'; document.body.dataset.ok=1">Log in</button>
      <script>if (location.search.includes('next=')) setTimeout(() => { location.href = '/upload'; }, 1500);</script>`,
  // A signed-in visit that briefly passes through the login page (like Google's sign-in redirects).
  '/bounce': `<script>location.href = '/login?next=/upload';</script>`,
  '/upload': `<input type="file" id="f" onchange="document.getElementById('post').disabled=false">
      <div id="cap" contenteditable="true" style="min-height:40px;border:1px solid"></div>
      <button id="post" disabled onclick="localStorage.cap=document.getElementById('cap').innerText; location.href='/done?v=777'">Post</button>`,
  '/done': '<h1>Your video has been posted</h1>',
};
const site = http.createServer((req, res) => {
  const page = PAGES[new URL(req.url, 'http://x').pathname];
  res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html' }).end(`<!doctype html><body>${page || ''}</body>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

let mode = 'ok';
DRIVERS.mock = {
  id: 'mock', label: 'Mock', loginUrl: `${SITE}/login`, homeUrl: `${SITE}/upload`, loggedOutUrl: /\/login/, hosts: ['127.0.0.1'],
  sessionCookies: { urls: [SITE], names: ['sid'] },
  async identify() { return { username: 'mockuser', displayName: 'Mock User' }; },
  async publish({ page, file, clip, step, final }) {
    step('Opening uploader');
    await page.goto(`${SITE}/upload`);
    step('Uploading video');
    await page.locator('#f').setInputFiles(file);
    step('Writing caption');
    await clearAndType(page, page.locator('#cap'), `${clip.title} ${clip.hashtags.join(' ')}`, { fast: true });
    if (mode === 'fail-before') throw new Error('Upload box never appeared');
    step('Posting');
    final();
    await humanClick(page.locator('#post'));
    if (mode === 'fail-after') throw new Error('No confirmation shown');
    await waitForAny({ done: () => page.getByText('Your video has been posted').isVisible() }, { timeout: 15000 });
    return { externalId: '777', url: `${SITE}/done?v=777`, caption: await page.evaluate(() => localStorage.cap) };
  },
};

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); site.close(); delete DRIVERS.mock; });

let cookie = '';
async function call(p, { method = 'GET', body, form, raw } = {}) {
  const headers = { cookie };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: form || (body && JSON.stringify(body)) });
  const set = res.headers.get('set-cookie');
  if (set && set.startsWith('sc_session')) cookie = set.split(';')[0];
  if (raw) return res;
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function postAndWait(clipId) {
  const created = await call('/api/posts', { method: 'POST', body: { clipId, platform: 'mock' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  // "Post now" starts right away; wait until that attempt has finished.
  for (let i = 0; i < 240; i++) {
    await runDuePosts({ wait: true });
    const p = (await call(`/api/posts?clipId=${clipId}`)).data.find((x) => x.id === created.data.id);
    if (p.status === 'published' || p.status === 'failed' || (p.status === 'scheduled' && p.error)) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('post did not finish');
}

test('browser login through the live viewer, then human-like posting with results', { skip, timeout: 180000 }, async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 's@b.co', password: 'password123' } });

  // Log in by "clicking" on the streamed screen, exactly as the web viewer does.
  const { data: login } = await call('/api/accounts/mock/login', { method: 'POST' });
  assert.ok(login.sessionId);
  let frame;
  for (let i = 0; i < 30; i++) {
    frame = await call(`/api/browser/${login.sessionId}/frame?seq=-1`, { raw: true });
    if (frame.status === 200) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.ok((await frame.arrayBuffer()).byteLength > 1000, 'a real screenshot is streamed');
  assert.equal((await call(`/api/accounts/mock/login/finish`, { method: 'POST', body: { sessionId: login.sessionId } })).data.loggedIn, false);
  const clicked = await call(`/api/browser/${login.sessionId}/input`, { method: 'POST', body: { type: 'click', x: 200 / 1280, y: 140 / 800 } });
  assert.equal(clicked.status, 200);
  const blocked = await call(`/api/browser/${login.sessionId}/input`, { method: 'POST', body: { type: 'goto', url: 'http://10.0.0.1/' } });
  assert.equal(blocked.status, 400, 'typed addresses outside the platform are refused');
  const done = await call(`/api/accounts/mock/login/finish`, { method: 'POST', body: { sessionId: login.sessionId } });
  assert.equal(done.data.loggedIn, true);
  assert.equal(done.data.username, 'mockuser');
  const acc = (await call('/api/accounts')).data.accounts.find((a) => a.platform === 'mock');
  assert.equal(acc.loggedIn, true);
  assert.equal(acc.session, null, 'login window closed after confirming');

  // The saved profile keeps the session for later checks and posts.
  assert.equal((await call('/api/accounts/mock/check', { method: 'POST' })).data.loggedIn, true);

  // Hidden sessions present the same device as a visible browser: no "Headless", real client hints.
  const me = (await call('/api/me')).data;
  const s = await openSession({ userId: me.id, platform: 'mock', kind: 'check' });
  await s.page.goto(`${SITE}/upload`);
  const id = await s.page.evaluate(async () => ({
    ua: navigator.userAgent, touch: navigator.maxTouchPoints,
    hints: await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']),
  }));
  await s.close();
  assert.doesNotMatch(id.ua, /Headless/);
  assert.ok(id.hints.fullVersionList.length > 0 && id.hints.fullVersionList.every((b) => !/Headless/.test(b.brand)), 'real full version list');
  assert.ok(id.hints.fullVersionList.some((b) => !/^\d+\.0\.0\.0$/.test(b.version) && /^\d+\.\d+\.\d+\.\d+$/.test(b.version)), 'exact browser version, not a made-up one');
  assert.equal(id.touch, 0);

  // Background keep-alive revisits the platform and records the refresh.
  const refreshed = await refreshDueSessions({ force: true });
  assert.deepEqual(refreshed.find((r) => r.platform === 'mock'), { userId: me.id, platform: 'mock', loggedIn: true });
  assert.ok((await call('/api/accounts')).data.keepAliveHours > 0);

  // Passing through the login page on the way back (sign-in redirects) is not a logout.
  DRIVERS.mock.homeUrl = `${SITE}/bounce`;
  assert.equal((await call('/api/accounts/mock/check', { method: 'POST' })).data.loggedIn, true);
  // Staying on the login page is: it's reported, with the reason.
  DRIVERS.mock.homeUrl = `${SITE}/login`;
  assert.equal((await call('/api/accounts/mock/check', { method: 'POST' })).data.loggedIn, false);
  const expired = (await call('/api/accounts')).data.accounts.find((a) => a.platform === 'mock');
  assert.match(expired.loggedOutReason, /login page/);
  DRIVERS.mock.homeUrl = `${SITE}/upload`;
  assert.equal((await call('/api/accounts/mock/check', { method: 'POST' })).data.loggedIn, true);

  const form = new FormData();
  form.append('meta', JSON.stringify({ streamer: 'jynxzi', title: 'Huge play', hashtags: ['#shorts', '#twitch'], viral: { score: 80 } }));
  form.append('video', new Blob([new Uint8Array(4096)], { type: 'video/mp4' }), 'clip.mp4');
  const clip = (await call('/api/clips', { method: 'POST', form })).data;

  const ok = await postAndWait(clip.id);
  assert.equal(ok.status, 'published', ok.error);
  assert.equal(ok.url, `${SITE}/done?v=777`);
  assert.equal(ok.step, 'Posted');
  const results = (await call(`/api/posts/results?since=${Date.now() - 120000}`)).data;
  assert.ok(results.some((r) => r.id === ok.id && r.status === 'published'), 'background result is reported');

  // Fails before pressing Post: kept for an automatic retry, with a screenshot.
  mode = 'fail-before';
  const retrying = await postAndWait(clip.id);
  assert.equal(retrying.status, 'scheduled');
  assert.match(retrying.error, /Upload box never appeared.*retrying/);
  assert.ok(retrying.screenshotUrl);
  assert.equal((await call(retrying.screenshotUrl, { raw: true })).headers.get('content-type'), 'image/jpeg');

  // Fails after pressing Post: never retried automatically (it may already be live).
  mode = 'fail-after';
  const stopped = await postAndWait(clip.id);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.error, /not retried/);

  // Session gone (logged out on the platform): reported and the account is flagged.
  mode = 'ok';
  DRIVERS.mock.sessionCookies = { urls: [SITE], names: ['nope'] };
  const loggedOut = await postAndWait(clip.id);
  assert.equal(loggedOut.status, 'failed');
  assert.match(loggedOut.error, /Not logged in to Mock/);
  assert.equal((await call('/api/accounts')).data.accounts.find((a) => a.platform === 'mock').loggedIn, false);
  assert.ok(LoggedOutError);
});

test('healSignIn re-signs a lapsed login through the silent sign-in, and reports a real sign-out', async () => {
  const { healSignIn } = await import('../server/social/session-check.js');
  const fakePage = (googleStillSignedIn) => {
    let signedIn = false;
    return {
      url: () => 'https://www.youtube.com/',
      waitForTimeout: async () => {},
      goto: async (u) => { if (u.includes('passive=true') && googleStillSignedIn) signedIn = true; },
      get signedIn() { return signedIn; },
    };
  };
  const driver = { passiveLoginUrl: 'https://accounts.google.com/ServiceLogin?passive=true', signedIn: async (p) => p.signedIn };

  const healed = fakePage(true);
  assert.equal(await healSignIn(driver, healed), true);
  assert.equal(healed.__healed, true);

  const gone = fakePage(false);
  assert.equal(await healSignIn(driver, gone), false);
  assert.equal(gone.__healed, undefined);

  // Without a silent sign-in the platform's own answer stands.
  assert.equal(await healSignIn({ signedIn: async () => false }, fakePage(true)), false);
  assert.equal(await healSignIn({ signedIn: async () => null }, fakePage(true)), null);
});
