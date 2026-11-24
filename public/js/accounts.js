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
  const seen = links[0]?.lastSeenAt;
  const online = seen && Date.now() - seen < 3 * 60000;
  const inUse = a.method === 'extension';
  return `<div class="ext-box">
    <div class="row" style="gap:8px">${icon('monitor')}<b>Post from your own Chrome</b><span class="badge ${inUse ? 'done' : ''}">${inUse ? 'In use' : 'Recommended'}</span></div>
    <div class="small muted">The SlientClip extension uploads Shorts from the Chrome where you're already signed in to YouTube, so the login never expires here.</div>
    ${links.length ? `<div class="small row" style="gap:8px">Extension <b style="color:${online ? 'var(--ok)' : 'var(--warn)'}">${online ? 'online' : 'offline'}</b> · last seen ${seen ? timeAgo(seen) : 'never'}${links[0].version ? ` · v${esc(links[0].version)}` : ''}
      <button class="btn sm ghost ext-unlink" data-id="${esc(links[0].id)}">Disconnect</button></div>` : ''}
    <details class="small"${links.length ? '' : ' open'}><summary>${links.length ? 'Setup steps' : 'Set it up (2 minutes)'}</summary><ol>
      <li><a href="/extension.zip" download>Download the extension</a> and unzip it.</li>
      <li>In Chrome open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, press <b>Load unpacked</b> and pick the unzipped <code>slientclip-extension</code> folder.</li>
      <li>Check that this Chrome is signed in to YouTube with the channel you want to post to.</li>
      <li>Come back to this page, click the <b>SlientClip Publisher</b> icon in Chrome's toolbar and press <b>Connect this SlientClip tab</b>.</li>
    </ol>Keep Chrome open: posts are uploaded within a minute of their time, in a background tab.</details>
    <div><a class="btn sm" href="/extension.zip" download>${icon('download')}Download extension</a></div>
  </div>`;
}

// The extension's popup tells the page when it has connected, so the panel updates without a reload.
let accountsRoot = null;
window.addEventListener('slientclip-extension-connected', () => {
  cache = null;
  if (accountsRoot?.isConnected) renderAccounts(accountsRoot).catch(() => {});
});

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
        ? `Logged in${who ? ` as <b style="color:var(--text)">${esc(who)}</b>` : ''}${a.username && a.username !== who ? ` · @${esc(a.username)}` : ''}${a.method === 'extension' ? ' · <span style="color:var(--accent-2)">through your Chrome</span>' : ''}${a.checkedAt ? ` · checked ${timeAgo(a.checkedAt)}` : ''}`
        : a.known ? `<span style="color:var(--warn)">Session expired. Log in again.</span>${a.loggedOutReason ? `<div class="small muted" title="${esc(a.loggedOutReason)}">Why: ${esc(a.loggedOutReason)}${a.checkedAt ? ` (${timeAgo(a.checkedAt)})` : ''}</div>` : ''}` : 'Not logged in';
      return `<div class="account ${a.loggedIn ? 'on' : ''}" data-p="${a.platform}">
        <div class="plat-logo ${m.cls}">${m.icon}</div>
        <div style="min-width:0;flex:1"><div><b>${m.label}</b></div>
          <div class="small muted">${state}</div>
          ${a.history?.length ? `<details class="acct-history small"><summary class="muted">Login history (${a.history.length})</summary><ul>${a.history.map((h) => `<li class="${h.ok === false ? 'bad' : h.ok ? 'good' : ''}"><span class="muted">${timeAgo(h.at)}</span> ${esc(h.text)}</li>`).join('')}</ul></details>` : ''}
          ${a.session ? `<div class="small" style="color:var(--accent-2)">${icon('loader', 'spin')} ${esc(a.session.kind === 'post' ? a.session.step : 'Browser open')}</div>` : ''}</div>
        <div class="row acct-actions">
          ${a.loggedIn
            ? `<button class="btn sm check" title="Check the saved session is still logged in">${icon('refresh')}Check</button>
               <button class="btn sm ghost danger logout-acct" title="Log out and delete the saved session">${icon('logout')}</button>`
            : `<button class="btn sm primary login" ${b.available || data.demo ? '' : 'disabled'}>${icon('login')}Log in</button>`}
          <label class="btn sm ghost import" title="Import cookies exported from your own browser (Cookie-Editor JSON)">${icon('upload')}<input type="file" accept=".json,application/json" hidden></label>
        </div>
        ${a.platform === 'youtube' ? extensionBox(a, data.extension || []) : ''}
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
    <div class="small muted" style="margin-top:10px">If a platform blocks the login (Google sometimes says "This browser may not be secure"), log in on your own browser, export that site's cookies with the Cookie-Editor extension (Export → JSON), and import the file with the ${icon('upload')} button.
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
      if (!confirm('Disconnect the SlientClip extension? YouTube posts then wait until you connect it again (or log in with the server browser).')) return;
      await api(`/api/ext/links/${e.currentTarget.dataset.id}`, { method: 'DELETE' });
      toast('Extension disconnected', 'ok');
      rerender();
    });
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
