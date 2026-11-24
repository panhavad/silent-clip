// Loads the real Chrome extension into Chromium and runs a whole post through it against a mock of YouTube
// Studio's upload dialog: popup pairing → server routes the post to the extension → background claims it,
// downloads the clip and opens the "Studio" tab → upload script fills everything in and publishes → result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-ext-'));
process.env.PUBLISH_DRY_RUN = 'false';
const { default: app } = await import('../server/index.js');
const { runDuePosts } = await import('../server/publisher.js');
const { EXT_DIR } = await import('../server/extension.js');
const { chromium } = await import('playwright-core');

// Extensions need a Chromium build (branded Chrome ignores --load-extension). Use CHROMIUM_PATH or Playwright's.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')];
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        if (fs.existsSync(path.join(r, d, exe))) return path.join(r, d, exe);
      }
    }
  }
  return null;
}
const exe = findChromium();
const skip = exe ? false : 'no Chromium build for extensions (set CHROMIUM_PATH)';

// ---- mock YouTube Studio upload dialog ----
const got = {};
const STUDIO = `<!doctype html><body>
<ytcp-uploads-dialog style="display:block">
  <div id="picker"><input type="file" name="Filedata"></div>
  <div id="details" hidden>
    <div id="title-textarea"><div id="textbox" contenteditable="true" style="min-height:20px;border:1px solid"></div></div>
    <div id="description-textarea"><div id="textbox" contenteditable="true" style="min-height:20px;border:1px solid"></div></div>
    <tp-yt-paper-radio-button name="VIDEO_MADE_FOR_KIDS_NOT_MFK" aria-checked="false" style="display:block">Not for kids</tp-yt-paper-radio-button>
    <div id="vis" hidden>
      <tp-yt-paper-radio-button name="PUBLIC" aria-checked="false" style="display:block">Public</tp-yt-paper-radio-button>
      <tp-yt-paper-radio-button name="PRIVATE" aria-checked="false" style="display:block">Private</tp-yt-paper-radio-button>
      <ytcp-video-info><a href="https://youtu.be/MockVid123">https://youtu.be/MockVid123</a></ytcp-video-info>
    </div>
    <ytcp-video-upload-progress><span class="progress-label">Uploading 0%</span></ytcp-video-upload-progress>
    <ytcp-button id="next-button" style="display:block">Next</ytcp-button>
    <ytcp-button id="done-button" style="display:block">Publish</ytcp-button>
  </div>
</ytcp-uploads-dialog>
<script>
  const $ = (s) => document.querySelector(s);
  const input = $('input[type=file]');
  let nexts = 0;
  input.addEventListener('change', () => {
    const f = input.files[0];
    window.__file = { name: f.name, size: f.size, type: f.type };
    $('#details').hidden = false;
    setTimeout(() => { $('.progress-label').textContent = 'Upload complete'; }, 2500);
  });
  document.querySelectorAll('tp-yt-paper-radio-button').forEach((r) => r.addEventListener('click', () => {
    r.parentElement.querySelectorAll('tp-yt-paper-radio-button').forEach((o) => o.setAttribute('aria-checked', 'false'));
    r.setAttribute('aria-checked', 'true');
  }));
  $('#next-button').addEventListener('click', () => { if (++nexts === 3) $('#vis').hidden = false; });
  $('#done-button').addEventListener('click', async () => {
    const report = {
      file: window.__file, title: $('#title-textarea #textbox').innerText, description: $('#description-textarea #textbox').innerText,
      notKids: document.querySelector('[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]').getAttribute('aria-checked'),
      visibility: [...document.querySelectorAll('#vis tp-yt-paper-radio-button')].find((r) => r.getAttribute('aria-checked') === 'true')?.getAttribute('name'),
      nexts,
    };
    await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
    const d = document.createElement('ytcp-video-share-dialog'); d.style.display = 'block'; d.textContent = 'Video published'; document.body.append(d);
  });
</script></body>`;

test('the Chrome extension pairs from the popup and posts a clip through YouTube Studio', { skip, timeout: 180000 }, async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const studio = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.report = JSON.parse(b); res.end('ok'); });
      return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end(STUDIO);
  }).listen(0);
  const studioUrl = `http://127.0.0.1:${studio.address().port}/upload`;

  // A copy of the extension that may also script the mock Studio on 127.0.0.1.
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-extcopy-'));
  fs.cpSync(EXT_DIR, extDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slientclip-extprof-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: exe, headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ||= await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = sw.url().split('/')[2];

    // Sign in to SlientClip in a normal tab.
    const page = await ctx.newPage();
    await page.goto(base + '/healthz');
    const signedUp = await page.evaluate(async () => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ext@b.co', password: 'password123' }) })).status);
    assert.equal(signedUp, 200);
    const pageTab = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /127\.0\.0\.1/.test(t.url))?.id);

    // Pair through the real popup ("Connect this SlientClip tab"), pointed at the SlientClip tab. YouTube's own
    // sign-in check is skipped here (this test Chrome isn't signed in to YouTube); the server is told directly.
    await sw.evaluate((url) => chrome.storage.local.set({ uploadUrl: url, lastHello: Date.now() + 3600000 }), studioUrl);
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.evaluate((tabId) => {
      chrome.tabs.query = async () => [{ id: tabId, url: location.href.replace(/^chrome-extension:\/\/[^/]+/, 'http://127.0.0.1') }];
      chrome.runtime.sendMessage = async () => ({ youtube: { loggedIn: true, name: 'Test Channel' } });
    }, pageTab);
    await popup.click('#connect');
    await popup.waitForSelector('#paired:not([hidden])', { timeout: 15000 });
    const { token, server: paired } = await sw.evaluate(() => chrome.storage.local.get(['token', 'server']));
    assert.equal(paired, base);
    const hello = await fetch(`${base}/api/ext/hello`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ youtube: { loggedIn: true, name: 'Test Channel' } }) });
    assert.equal(hello.status, 200);

    // Make a clip and press "post now" for YouTube, as from a clip card.
    const post = await page.evaluate(async () => {
      const fd = new FormData();
      fd.append('meta', JSON.stringify({ streamer: 'xqc', title: 'Ext E2E clip', description: 'Huge play', hashtags: ['#gaming'], viral: { score: 90 } }));
      fd.append('video', new Blob([new Uint8Array(300000).fill(7)], { type: 'video/mp4' }), 'clip.mp4');
      const clip = await (await fetch('/api/clips', { method: 'POST', body: fd })).json();
      return (await fetch('/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clipId: clip.id, platform: 'youtube' }) })).json();
    });
    await runDuePosts({ wait: true });

    // The extension's background picks it up (a check is triggered instead of waiting for the 30 s alarm).
    await popup.reload();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'pollNow' }));
    let p;
    for (let i = 0; i < 90; i++) {
      p = await page.evaluate(async (id) => (await (await fetch('/api/posts?from=0&to=9e15')).json()).find((x) => x.id === id), post.id);
      if (p.status === 'published' || p.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const log = await sw.evaluate(async () => ({ ...(await chrome.storage.local.get(['log', 'lastError', 'uploadUrl'])), tabs: (await chrome.tabs.query({})).map((t) => `${t.status} ${t.url}`) }));
    assert.equal(p.status, 'published', `post ended as ${p.status}: ${p.error || ''} ${JSON.stringify(log)}`);
    assert.equal(p.url, 'https://www.youtube.com/shorts/MockVid123');
    assert.deepEqual(got.report.file, { name: 'Ext E2E clip.mp4', size: 300000, type: 'video/mp4' }, 'the whole clip reached the file picker');
    assert.equal(got.report.title, 'Ext E2E clip');
    assert.match(got.report.description, /Huge play[\s\S]*#gaming[\s\S]*#Shorts/);
    assert.deepEqual([got.report.notKids, got.report.visibility, got.report.nexts], ['true', 'PUBLIC', 3]);
    assert.ok(log.log.some((l) => l.ok === true && /Posted/.test(l.text)), 'the popup shows the post in Recent activity');
  } finally {
    await ctx.close();
    server.close();
    studio.close();
  }
});
