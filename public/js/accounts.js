import { api, esc, toast, timeAgo } from './api.js';
import { icon } from './icons.js';
import { openBrowserViewer } from './browser-view.js';
import { skeleton, showLoading } from './loader.js';

export const PLATFORM_META = {
  youtube: { label: 'YouTube Shorts', short: 'YouTube', icon: icon('youtube'), cls: 'yt' },
  tiktok: { label: 'TikTok', short: 'TikTok', icon: icon('tiktok'), cls: 'tt' },
  instagram: { label: 'Instagram Reels', short: 'Instagram', icon: icon('instagram'), cls: 'ig' },
};

let cache = null;
export async function getAccounts(force = false) {
  if (!cache || force) cache = await api('/api/accounts');
  return cache;
}
export const accountFor = (accounts, platform) => accounts.accounts.find((a) => a.platform === platform);

/** "Post from your own Chrome": the SlientClip extension uploads to YouTube from the user's signed-in Chrome. */
function extensionBox(a, links) {
  const e = a.ext || {};
  const online = e.online;
  const inUse = a.route === 'extension';
  const yt = !e.connected ? '' : e.loggedIn === true
    ? `<span style="color:var(--ok)">YouTube signed in${e.name ? ` as <b>${esc(e.name)}</b>` : ''}</span>`
    : e.loggedIn === false ? '<span style="color:var(--warn)">YouTube is signed out in that Chrome: sign in on youtube.com there</span>'
      : '<span class="muted">YouTube status not reported yet</span>';
  return `<div class="route-box ${inUse ? 'active' : ''}" data-route="extension">
    <div class="row route-head">${icon('monitor')}<b>Chrome extension</b><span class="badge ${inUse ? 'done' : ''}">${inUse ? 'In use' : 'Standby'}</span></div>
    <div class="small muted">Uploads from the Chrome where you're already signed in to YouTube, so no YouTube login is kept on the server. Chrome must be open.</div>
    ${links.length ? `<div class="small">${yt}</div>
      <div class="small row" style="gap:8px;flex-wrap:wrap">Extension <b style="color:${online ? 'var(--ok)' : 'var(--warn)'}">${online ? 'online' : 'offline'}</b> · last seen ${e.lastSeenAt ? timeAgo(e.lastSeenAt) : 'never'}${e.version ? ` · v${esc(e.version)}` : ''}
      <button class="btn sm ghost ext-unlink" data-id="${esc(links[0].id)}">Disconnect</button></div>` : '<div class="small muted">Not connected yet.</div>'}
    <details class="small"${links.length ? '' : ' open'}><summary>${links.length ? 'Setup steps' : 'Set it up (2 minutes)'}</summary><ol>
      <li><a href="/extension.zip" download>Download the extension</a> and unzip it.</li>
      <li>In Chrome open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, press <b>Load unpacked</b> and pick the unzipped <code>slientclip-extension</code> folder.</li>
      <li>Check that this Chrome is signed in to YouTube with the channel you want to post to.</li>
      <li>Come back to this page, click the <b>SlientClip Publisher</b> icon in Chrome's toolbar and press <b>Connect this SlientClip tab</b>.</li>
    </ol>Keep Chrome open: posts are uploaded within a minute of their time, in a background tab.</details>
    <div><a class="btn sm" href="/extension.zip" download>${icon('download')}Download extension</a></div>
  </div>`;
}

/** Status of the always-open server session (the "virtual" browser) for this account. */
function keeperLine(a) {
  const k = a.keeper;
  if (!k || !a.loggedIn || a.demo) return '';
  if (k.open) {
    return `<div class="small keeper-line on">${icon('record')}<span>Always open on the server · refreshed ${timeAgo(k.refreshedAt)}${k.checkedAt ? ` · login checked ${timeAgo(k.checkedAt)}` : ''}</span>
      <button class="btn sm ghost view-keeper" data-sid="${esc(k.sessionId)}" title="See and use the browser that's kept open">${icon('eye')}View</button></div>`;
  }
  if (k.expected) {
    return `<div class="small keeper-line">${k.error ? `${icon('alert')}<span>Couldn't keep the session open: ${esc(k.error)}${k.retryAt ? ` · retrying ${new Date(k.retryAt).toLocaleTimeString()}` : ''}</span>` : `${icon('loader', 'spin')}<span>Opening the always-open session…</span>`}</div>`;
  }
  if (a.platform === 'youtube' && a.route === 'extension') return '<div class="small muted keeper-line">Not kept open while YouTube posts go through your Chrome.</div>';
  return '';
}

// The extension's popup tells the page when it has connected, so the panel updates without a reload.
let accountsRoot = null;
window.addEventListener('slientclip-extension-connected', () => {
  cache = null;
  if (accountsRoot?.isConnected) renderAccounts(accountsRoot).catch(() => {});
});

/** Ask the SlientClip extension in this Chrome (its page bridge, bridge.js); null if it doesn't answer. */
function askExtension(type, timeout) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (v) => { removeEventListener('message', on); clearTimeout(timer); resolve(v); };
    const on = (e) => { if (e.source === window && e.data?.slientclip === 'reply' && e.data.id === id) done(e.data); };
    addEventListener('message', on);
    const timer = setTimeout(() => done(null), timeout);
    window.postMessage({ slientclip: 'request', id, type }, location.origin);
  });
}

function saveJson(data, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const NEEDS_EXTENSION = `<b>"From my Chrome" needs the SlientClip Publisher extension (v1.1 or newer) in this Chrome, connected to this site.</b>
  <ol><li><a href="/extension.zip" download>Download the extension</a> and unzip it (to update, unzip over the old folder and press the reload icon on it in <code>chrome://extensions</code>; a first install: <b>Developer mode</b> → <b>Load unpacked</b>).</li>
  <li>Click the <b>SlientClip Publisher</b> icon in Chrome's toolbar and press <b>Connect this SlientClip tab</b> (or <b>Reconnect</b>), and allow access to this site when Chrome asks.</li>
  <li>Press <b>From my Chrome</b> again.</li></ol>`;

/** Download this Chrome's YouTube login through the extension, then offer to sign the server browser in with it. */
async function copyLoginFromChrome(btn, box, done) {
  box.querySelector('.cookie-help')?.remove();
  btn.disabled = true;
  try {
    if (!(await askExtension('ping', 1500))) {
      box.insertAdjacentHTML('beforeend', `<div class="notice small cookie-help">${NEEDS_EXTENSION}</div>`);
      return;
    }
    toast('Allow the copy in the SlientClip extension dialog', '');
    const r = await askExtension('youtube-cookies', 5 * 60000);
    if (!r?.ok) { toast(r?.error || 'The extension did not answer', r?.declined ? '' : 'error'); return; }
    saveJson(r.cookies, `youtube-cookies-${new Date().toLocaleDateString('sv')}.json`);
    if (!confirm(`Downloaded this Chrome's YouTube login${r.name ? ` (${r.name})` : ''}: ${r.cookies.length} cookies.\n\nSign the server browser in with it now?`)) {
      toast('Saved the cookie file. Import it any time with the upload button.', 'ok');
      return;
    }
    const out = await api('/api/accounts/youtube/cookies', { method: 'POST', body: { cookies: r.cookies } });
    toast(`YouTube: server browser signed in${out.displayName || out.username ? ` as ${out.displayName || out.username}` : ''} from this Chrome's login`, 'ok');
    done();
  } catch (e) {
    toast(e.message, 'error');
  } finally { btn.disabled = false; }
}

/** Open the server browser on the platform's login page; calls onDone after "I'm logged in" (or a demo login). */
export async function loginTo(platform, onDone) {
  const r = await api(`/api/accounts/${platform}/login`, { method: 'POST' });
  if (r.loggedIn) { toast(`${PLATFORM_META[platform].label} connected (demo)`, 'ok'); cache = null; onDone?.(r); return; }
  if (r.headed) toast('A browser window also opened on the server machine.', 'ok');
  openBrowserViewer({
    sessionId: r.sessionId, mode: 'login', platform, title: `Log in to ${PLATFORM_META[platform].label}`,
    onDone: (res) => { cache = null; onDone?.(res); },
  });
}

export async function renderAccounts(root) {
  accountsRoot = root;
  // First render shows a skeleton; re-renders after an action keep the current panel until fresh data arrives.
  const first = !root.querySelector('.accounts');
  const idle = first ? showLoading(root, skeleton.accounts()) : () => {};
  let data, me;
  try {
    [data, me] = await Promise.all([getAccounts(true), api('/api/me')]);
  } catch (e) {
    if (first) root.innerHTML = `<div class="empty">Couldn't load social accounts: ${esc(e.message)}</div>`;
    throw e;
  } finally { idle(); }
  const s = me.settings;
  const b = data.browser;
  root.innerHTML = `
    <div class="section-head"><div><h2 style="margin:0">Social accounts</h2>
      <div class="muted small">SlientClip posts by driving a real browser on the server, the way you would: open the uploader, pick the video, type the caption, press Post.
      Log in once and the session is kept for future posts. No API keys or developer apps needed.${data.keepAliveHours ? ` To keep you signed in, each login is opened in the background every ${data.keepAliveHours} hours.` : ''}</div></div>
      ${data.demo ? '<span class="badge elsewhere" title="PUBLISH_DRY_RUN=true — posting is simulated">Demo mode</span>' : ''}</div>
    ${b.available ? '' : `<div class="notice" style="margin-bottom:12px">No Chrome, Edge or Chromium was found on the server, so logging in and posting can't run${data.demo ? ' (demo mode simulates it)' : ''}. Install one, or set <code>BROWSER_PATH</code>.</div>`}
    <div class="accounts">${data.accounts.map((a) => {
      const m = PLATFORM_META[a.platform];
      const who = a.displayName || a.username;
      const state = a.loggedIn
        ? `Logged in${who ? ` as <b style="color:var(--text)">${esc(who)}</b>` : ''}${a.username && a.username !== who ? ` · @${esc(a.username)}` : ''}${a.checkedAt ? ` · checked ${timeAgo(a.checkedAt)}` : ''}`
        : a.known ? `<span style="color:var(--warn)">Session expired. Log in again.</span>${a.loggedOutReason ? `<div class="small muted" title="${esc(a.loggedOutReason)}">Why: ${esc(a.loggedOutReason)}${a.checkedAt ? ` (${timeAgo(a.checkedAt)})` : ''}</div>` : ''}` : 'Not logged in';
      const history = a.history?.length ? `<details class="acct-history small"><summary class="muted">Login history (${a.history.length})</summary><ul>${a.history.map((h) => `<li class="${h.ok === false ? 'bad' : h.ok ? 'good' : ''}"><span class="muted">${timeAgo(h.at)}</span> ${esc(h.text)}</li>`).join('')}</ul></details>` : '';
      const busy = a.session ? `<div class="small" style="color:var(--accent-2)">${icon('loader', 'spin')} ${esc(a.session.kind === 'post' ? a.session.step : 'Browser open')}</div>` : '';
      const actions = `<div class="row acct-actions">
          ${a.loggedIn
            ? `<button class="btn sm check" title="Check the saved session is still logged in">${icon('refresh')}Check</button>
               <button class="btn sm ghost danger logout-acct" title="Log out and delete the saved session">${icon('logout')}</button>`
            : `<button class="btn sm primary login" ${b.available || data.demo ? '' : 'disabled'}>${icon('login')}Log in</button>`}
          <label class="btn sm ghost import" title="Import cookies exported from your own browser (Cookie-Editor JSON)">${icon('upload')}<input type="file" accept=".json,application/json" hidden></label>
          ${a.platform === 'youtube' ? `<button class="btn sm ghost chrome-cookies" title="Download the YouTube login (cookies) of this Chrome through the SlientClip extension, then import it here">${icon('download')}From my Chrome</button>` : ''}
        </div>`;
      if (a.platform !== 'youtube') {
        return `<div class="account ${a.connected ? 'on' : ''}" data-p="${a.platform}">
          <div class="plat-logo ${m.cls}">${m.icon}</div>
          <div style="min-width:0;flex:1"><div><b>${m.label}</b></div><div class="small muted">${state}</div>${keeperLine(a)}${history}${busy}</div>
          ${actions}
        </div>`;
      }
      // YouTube: two ways to connect, and a choice of which one posts.
      const viaExt = a.route === 'extension';
      const summary = viaExt
        ? (a.connected ? `Posting through <b style="color:var(--text)">your Chrome</b>${a.ext?.name ? ` as ${esc(a.ext.name)}` : ''}` : '<span style="color:var(--warn)">Set to post through your Chrome, but the extension isn\'t ready (see below)</span>')
        : (a.connected ? `Posting through the <b style="color:var(--text)">server browser</b>${who ? ` as ${esc(who)}` : ''}` : 'Not connected: log in with the server browser or connect the Chrome extension');
      const viaBtn = (v, label, title) => `<button data-v="${v}" class="${a.via === v ? 'active' : ''}" title="${esc(title)}">${label}</button>`;
      return `<div class="account yt-account ${a.connected ? 'on' : ''}" data-p="youtube">
        <div class="plat-logo ${m.cls}">${m.icon}</div>
        <div style="min-width:0;flex:1"><div><b>${m.label}</b></div><div class="small muted">${summary}</div></div>
        <div class="yt-via-wrap"><span class="small muted">Post via</span>
          <div class="seg yt-via" role="group" aria-label="How YouTube posts go out">
            ${viaBtn('auto', 'Auto', 'Use the Chrome extension when it is connected and signed in, otherwise the server browser')}
            ${viaBtn('extension', `${icon('monitor')}Chrome extension`, 'Always post YouTube from your own Chrome')}
            ${viaBtn('server', `${icon('server')}Server browser`, 'Always post YouTube from the browser kept open on the server')}
          </div></div>
        <div class="yt-routes">
          <div class="route-box ${viaExt ? '' : 'active'}" data-route="server">
            <div class="row route-head">${icon('server')}<b>Server browser (virtual)</b><span class="badge ${viaExt ? '' : 'done'}">${viaExt ? 'Standby' : 'In use'}</span><span class="spacer"></span>${actions}</div>
            <div class="small muted">A real browser on the server, signed in once, kept open around the clock so the login stays warm. Works with your computer off.</div>
            <div class="small muted">${state}</div>
            ${keeperLine(a)}${history}${busy}
          </div>
          ${extensionBox(a, data.extension || [])}
        </div>
      </div>`;
    }).join('')}</div>
    <div class="settings-grid" style="margin-top:14px">
      <label class="field">When posting, the browser runs
        <select name="publishView">
          <option value="background">In the background (hidden, reports success or failure)</option>
          <option value="foreground">In the foreground (shows the browser window while posting)</option>
        </select>
        <span class="small">${b.canShowWindow ? 'Foreground opens a window on the server machine. You can also watch any post live from its clip.' : 'This server has no screen, so posts run hidden. Use <b>Watch</b> on a post to see it live.'}</span></label>
      <label class="field">YouTube visibility
        <select name="youtubeVisibility"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></label>
      <label class="field">TikTok: who can watch
        <select name="tiktokPrivacy"><option value="everyone">Everyone</option><option value="friends">Friends</option><option value="only_me">Only me</option></select></label>
    </div>
    <div class="small muted" style="margin-top:10px">If a platform blocks the login (Google sometimes says "This browser may not be secure"), log in on your own browser, export that site's cookies with the Cookie-Editor extension (Export → JSON), and import the file with the ${icon('upload')} button. For YouTube, <b>From my Chrome</b> does the export for you through the SlientClip extension.
      To keep an imported login signed in, export it from a <b>separate browser profile or a private window</b> and then close that window without signing out. If you keep using the same login in your everyday browser, Google can sign the copy out.</div>`;

  for (const k of ['publishView', 'youtubeVisibility', 'tiktokPrivacy']) {
    const sel = root.querySelector(`select[name=${k}]`);
    sel.value = s[k];
    sel.onchange = async () => {
      try { await api('/api/settings', { method: 'PUT', body: { [k]: sel.value } }); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'error'); }
    };
  }
  const rerender = () => renderAccounts(root);
  root.querySelectorAll('.account').forEach((el) => {
    const p = el.dataset.p;
    const label = PLATFORM_META[p].label;
    el.querySelector('.login')?.addEventListener('click', () => loginTo(p, rerender).catch((e) => toast(e.message, 'error')));
    el.querySelector('.check')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`/api/accounts/${p}/check`, { method: 'POST' });
        toast(r.loggedIn ? `${label}: still logged in` : `${label}: session expired. Log in again.`, r.loggedIn ? 'ok' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      rerender();
    });
    el.querySelector('.logout-acct')?.addEventListener('click', async () => {
      if (!confirm(`Log out of ${label}? The saved browser session is deleted and scheduled auto-posts for it are removed.`)) return;
      await api(`/api/accounts/${p}`, { method: 'DELETE' });
      toast(`Logged out of ${label}`, 'ok');
      rerender();
    });
    el.querySelector('.ext-unlink')?.addEventListener('click', async (e) => {
      if (!confirm('Disconnect the SlientClip extension? With "Auto", YouTube posts then go through the server browser (if it\'s logged in).')) return;
      await api(`/api/ext/links/${e.currentTarget.dataset.id}`, { method: 'DELETE' });
      toast('Extension disconnected', 'ok');
      rerender();
    });
    el.querySelectorAll('.yt-via button').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await api('/api/settings', { method: 'PUT', body: { youtubeVia: btn.dataset.v } });
        toast({ auto: 'YouTube: posting through the extension when it\'s connected, otherwise the server browser', extension: 'YouTube posts now go through your Chrome extension', server: 'YouTube posts now go through the server browser' }[btn.dataset.v], 'ok');
      } catch (err) { toast(err.message, 'error'); }
      cache = null;
      rerender();
    }));
    el.querySelector('.view-keeper')?.addEventListener('click', (e) => {
      openBrowserViewer({ sessionId: e.currentTarget.dataset.sid, mode: 'session', platform: p, title: `${label} on the server (always open)` });
    });
    el.querySelector('.chrome-cookies')?.addEventListener('click', (e) => copyLoginFromChrome(e.currentTarget, e.currentTarget.closest('.route-box') || el, rerender));
    el.querySelector('.import input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const cookies = JSON.parse(await file.text());
        const r = await api(`/api/accounts/${p}/cookies`, { method: 'POST', body: { cookies } });
        toast(`${label}: logged in${r.username ? ` as @${r.username}` : ''} from imported cookies`, 'ok');
      } catch (err) { toast(err instanceof SyntaxError ? 'That file is not cookie JSON' : err.message, 'error'); }
      rerender();
    });
  });
}
