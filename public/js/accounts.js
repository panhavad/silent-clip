import { api, esc, toast } from './api.js';
import { icon } from './icons.js';

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

export async function renderAccounts(root) {
  const data = await getAccounts(true);
  root.innerHTML = `
    <div class="section-head"><div><h2 style="margin:0">Connected accounts</h2>
      <div class="muted small">Link your channels once — SlientClip then uploads clips for you (Post now, scheduled, or auto-publish).</div></div>
      ${data.demo ? '<span class="badge elsewhere" title="PUBLISH_DRY_RUN=true — uploads are simulated">Demo mode</span>' : ''}</div>
    <div class="accounts">${data.accounts.map((a) => {
      const m = PLATFORM_META[a.platform];
      return `<div class="account ${a.connected ? 'on' : ''}" data-p="${a.platform}">
        <div class="plat-logo ${m.cls}">${m.icon}</div>
        <div style="min-width:0;flex:1"><div><b>${m.label}</b></div>
          <div class="small muted">${a.connected
            ? `Connected as <b style="color:var(--text)">${esc(a.displayName || a.username)}</b>${a.username && a.username !== a.displayName ? ` · @${esc(a.username)}` : ''}`
            : a.configured ? 'Not connected' : 'Not configured on this server (missing app keys in .env)'}</div></div>
        ${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : ''}
        ${a.connected
          ? `<button class="btn sm danger disconnect">${icon('x')}Disconnect</button>`
          : `<a class="btn sm primary ${a.configured ? '' : 'disabled'}" ${a.configured ? `href="/connect/${a.platform}"` : ''}>${icon('link')}Connect</a>`}
      </div>`;
    }).join('')}</div>`;
  root.querySelectorAll('.disconnect').forEach((b) => {
    b.onclick = async () => {
      const p = b.closest('.account').dataset.p;
      if (!confirm(`Disconnect ${PLATFORM_META[p].label}? Scheduled auto-posts for it will be removed.`)) return;
      await api(`/api/accounts/${p}`, { method: 'DELETE' });
      toast(`${PLATFORM_META[p].label} disconnected`, 'ok');
      renderAccounts(root);
    };
  });
}
