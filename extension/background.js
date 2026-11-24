// SlientClip Publisher — background service worker.
// Every 30 s it asks the paired SlientClip server for YouTube posts that are due. For each one it opens YouTube
// Studio in a background tab of this Chrome (where YouTube is already signed in), hands the video to the upload
// script (youtube-upload.js) and reports the steps and the result back to the server.

const POLL_MINUTES = 0.5;
const HELLO_EVERY_MS = 30 * 60000;
const BUSY_TIMEOUT_MS = 30 * 60000;
const CHUNK = 4 * 1024 * 1024;
const VERSION = chrome.runtime.getManifest().version;
const UPLOAD_URL = 'https://www.youtube.com/upload?hl=en';

const get = (keys) => chrome.storage.local.get(keys);
const set = (o) => chrome.storage.local.set(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body } = {}) {
  const { server, token } = await get(['server', 'token']);
  if (!server || !token) throw Object.assign(new Error('Not connected to SlientClip'), { unpaired: true });
  const res = await fetch(server + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const msg = (await res.json().catch(() => ({}))).error || 'This browser was disconnected from SlientClip';
    throw Object.assign(new Error(msg), { unpaired: true });
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `SlientClip answered HTTP ${res.status}`);
  return res;
}
const apiJson = async (p, o) => (await api(p, o)).json();

async function log(text, ok = null) {
  const { log: list = [] } = await get('log');
  await set({ log: [{ at: Date.now(), text: String(text).slice(0, 300), ok }, ...list].slice(0, 30) });
}

/** Is YouTube signed in in this Chrome? Read from YouTube's own page data (the same flag the site uses). */
async function youtubeStatus() {
  try {
    const t = await (await fetch('https://www.youtube.com/?hl=en', { credentials: 'include' })).text();
    const m = /"LOGGED_IN":(true|false)/.exec(t);
    const raw = /"USER_ACCOUNT_NAME":"((?:[^"\\]|\\.)*)"/.exec(t)?.[1];
    let name = null;
    try { name = raw ? JSON.parse(`"${raw}"`) : null; } catch { name = raw; }
    return { loggedIn: m ? m[1] === 'true' : null, name };
  } catch {
    return { loggedIn: null, name: null };
  }
}

async function hello(force = false) {
  const { lastHello = 0 } = await get('lastHello');
  if (!force && Date.now() - lastHello < HELLO_EVERY_MS) return null;
  const youtube = await youtubeStatus();
  const r = await apiJson('/api/ext/hello', { method: 'POST', body: { youtube, version: VERSION, browser: 'Chrome' } });
  await set({ lastHello: Date.now(), youtube, account: r.youtube });
  return { youtube, account: r.youtube };
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const { token, busy } = await get(['token', 'busy']);
    if (!token) return;
    if (busy && Date.now() - busy.at < BUSY_TIMEOUT_MS) return;
    if (busy) {
      await log('The previous upload stopped responding; giving up on it.', false);
      await set({ busy: null });
    }
    await hello(false);
    const { jobs } = await apiJson('/api/ext/jobs');
    await set({ lastPoll: Date.now(), status: 'ok', lastError: null });
    if (jobs.length) await startJob(jobs[0]);
  } catch (e) {
    await set({ lastPoll: Date.now(), status: e.unpaired ? 'unpaired' : 'error', lastError: e.message });
  } finally {
    polling = false;
  }
}

// ---------- video hand-off (the upload tab asks for it in chunks) ----------
let video = null; // { jobId, buf }

async function videoFor(jobId) {
  if (video?.jobId === jobId) return video.buf;
  const buf = await (await api(`/api/ext/jobs/${jobId}/video`)).arrayBuffer();
  video = { jobId, buf };
  return buf;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- running a job ----------
async function waitForLoad(tabId, timeout = 60000) {
  const end = Date.now() + timeout;
  await sleep(300);
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) return tab;
    if (Date.now() > end) throw new Error('YouTube Studio did not load in time');
    await sleep(500);
  }
}

async function report(jobId, result) {
  try { await api(`/api/ext/jobs/${jobId}/result`, { method: 'POST', body: result }); } catch (e) { await log(`Could not report the result: ${e.message}`, false); }
}

async function startJob(job) {
  const { lastFailedTab, uploadUrl } = await get(['lastFailedTab', 'uploadUrl']);
  if (lastFailedTab) { chrome.tabs.remove(lastFailedTab).catch(() => {}); await set({ lastFailedTab: null }); }
  try {
    await api(`/api/ext/jobs/${job.id}/claim`, { method: 'POST' });
  } catch (e) {
    await log(`Skipped a post: ${e.message}`, false);
    return;
  }
  await set({ busy: { jobId: job.id, at: Date.now() } });
  await log(`Posting "${job.clip.title}" to YouTube${job.dryRun ? ' (test mode)' : ''}…`);
  let tabId = null;
  try {
    await api(`/api/ext/jobs/${job.id}/step`, { method: 'POST', body: { step: 'Downloading the clip to your Chrome' } });
    await videoFor(job.id);
    await api(`/api/ext/jobs/${job.id}/step`, { method: 'POST', body: { step: 'Opening YouTube Studio in your Chrome' } });
    const tab = await chrome.tabs.create({ url: uploadUrl || UPLOAD_URL, active: false });
    tabId = tab.id;
    await set({ busy: { jobId: job.id, tabId, at: Date.now() } });
    let t = await waitForLoad(tabId);
    // /upload redirects to Studio (or to Google's sign-in when signed out); let it settle.
    await sleep(1500);
    t = await chrome.tabs.get(tabId);
    if (t.status !== 'complete') t = await waitForLoad(tabId);
    if (/accounts\.google\.com/.test(t.url || '')) {
      throw Object.assign(new Error('YouTube is signed out in this Chrome'), { loggedOut: true, final: true });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['youtube-upload.js'] });
    const ack = await chrome.tabs.sendMessage(tabId, { type: 'run', job });
    if (!ack?.started) throw new Error('The upload script did not start in YouTube Studio');
  } catch (e) {
    await finish(job.id, { ok: false, error: e.message, final: Boolean(e.final), loggedOut: Boolean(e.loggedOut) }, tabId);
  }
}

async function finish(jobId, result, tabId) {
  await report(jobId, result);
  const { busy } = await get('busy');
  if (busy?.jobId === jobId) await set({ busy: null });
  if (video?.jobId === jobId) video = null;
  if (result.ok) {
    await log(result.dryRun ? 'Test upload finished (not published).' : `Posted: ${result.url || 'YouTube Studio'}`, true);
    if (tabId) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 4000);
  } else {
    await log(`Failed: ${result.error}`, false);
    // Leave a failed upload tab open so you can see what YouTube showed; it's closed when the next post starts.
    if (tabId) await set({ lastFailedTab: tabId });
  }
  if (result.loggedOut) await set({ youtube: { loggedIn: false }, lastHello: 0 });
  setTimeout(poll, 3000);
}

// ---------- messages from the upload tab and the popup ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'chunk': {
        const buf = await videoFor(msg.jobId);
        const start = msg.index * CHUNK;
        reply({ data: toBase64(new Uint8Array(buf, start, Math.min(CHUNK, buf.byteLength - start))), total: Math.ceil(buf.byteLength / CHUNK), size: buf.byteLength });
        return;
      }
      case 'step': {
        const { busy } = await get('busy');
        if (busy?.jobId === msg.jobId) await set({ busy: { ...busy, at: Date.now() } });
        await api(`/api/ext/jobs/${msg.jobId}/step`, { method: 'POST', body: { step: msg.step, final: Boolean(msg.final) } }).catch(() => {});
        reply({ ok: true });
        return;
      }
      case 'result':
        await finish(msg.jobId, msg.result, sender.tab?.id);
        reply({ ok: true });
        return;
      case 'paired':
        await set({ status: 'ok', lastError: null, lastHello: 0 });
        reply(await hello(true).catch((e) => ({ error: e.message })));
        poll();
        return;
      case 'pollNow':
        await poll();
        reply({ ok: true });
        return;
      case 'checkNow':
        await set({ lastHello: 0 });
        await poll();
        reply(await get(['status', 'lastError', 'youtube', 'account']));
        return;
      case 'disconnect':
        await api('/api/ext/link', { method: 'DELETE' }).catch(() => {});
        await chrome.storage.local.clear();
        reply({ ok: true });
        return;
      default:
        reply({ error: 'unknown message' });
    }
  })().catch((e) => reply({ error: e.message }));
  return true;
});

function ensureAlarm() {
  chrome.alarms.get('poll').then((a) => { if (!a) chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 0.1 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') poll(); });
ensureAlarm();
