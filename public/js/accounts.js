import { api, esc, toast, timeAgo } from './api.js';
import { icon } from './icons.js';
import { openBrowserViewer } from './browser-view.js';

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
  const [data, me] = await Promise.all([getAccounts(true), api('/api/me')]);
  const s = me.settings;
  const b = data.browser;
  root.innerHTML = `
    <div class="section-head"><div><h2 style="margin:0">Social accounts</h2>
      <div class="muted small">SlientClip posts by driving a real browser on the server, the way you would: open the uploader, pick the video, type the caption, press Post.
      Log in once and the session is kept for future posts. No API keys or developer apps needed.</div></div>
      ${data.demo ? '<span class="badge elsewhere" title="PUBLISH_DRY_RUN=true — posting is simulated">Demo mode</span>' : ''}</div>
    ${b.available ? '' : `<div class="notice" style="margin-bottom:12px">No Chrome, Edge or Chromium was found on the server, so logging in and posting can't run${data.demo ? ' (demo mode simulates it)' : ''}. Install one, or set <code>BROWSER_PATH</code>.</div>`}
    <div class="accounts">${data.accounts.map((a) => {
      const m = PLATFORM_META[a.platform];
      const who = a.displayName || a.username;
      const state = a.loggedIn
        ? `Logged in${who ? ` as <b style="color:var(--text)">${esc(who)}</b>` : ''}${a.username && a.username !== who ? ` · @${esc(a.username)}` : ''}${a.checkedAt ? ` · checked ${timeAgo(a.checkedAt)}` : ''}`
        : a.known ? '<span style="color:var(--warn)">Session expired. Log in again.</span>' : 'Not logged in';
      return `<div class="account ${a.loggedIn ? 'on' : ''}" data-p="${a.platform}">
        <div class="plat-logo ${m.cls}">${m.icon}</div>
        <div style="min-width:0;flex:1"><div><b>${m.label}</b></div>
          <div class="small muted">${state}</div>
          ${a.session ? `<div class="small" style="color:var(--accent-2)">${icon('loader', 'spin')} ${esc(a.session.kind === 'post' ? a.session.step : 'Browser open')}</div>` : ''}</div>
        <div class="row acct-actions">
          ${a.loggedIn
            ? `<button class="btn sm check" title="Check the saved session is still logged in">${icon('refresh')}Check</button>
               <button class="btn sm ghost danger logout-acct" title="Log out and delete the saved session">${icon('logout')}</button>`
            : `<button class="btn sm primary login" ${b.available || data.demo ? '' : 'disabled'}>${icon('login')}Log in</button>`}
          <label class="btn sm ghost import" title="Import cookies exported from your own browser (Cookie-Editor JSON)">${icon('upload')}<input type="file" accept=".json,application/json" hidden></label>
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
    <div class="small muted" style="margin-top:10px">If a platform blocks the login (Google sometimes says "This browser may not be secure"), log in on your own browser, export that site's cookies with the Cookie-Editor extension (Export → JSON), and import the file with the ${icon('upload')} button.</div>`;

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
