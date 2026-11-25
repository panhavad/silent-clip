// Expired access: the app stays open so the user can look around, but everything is grayed out and
// locked, with a banner asking them to contact an administrator.
import { esc } from './api.js';
import { icon } from './icons.js';

const fmt = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export function lockApp({ expiresAt, contact } = {}) {
  document.body.classList.add('expired');
  const main = document.querySelector('main');
  if (main) main.inert = true;
  let bar = document.querySelector('.expired-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'expired-bar';
    bar.setAttribute('role', 'alert');
    document.querySelector('.topbar').after(bar);
  }
  const mail = contact
    ? `mailto:${encodeURIComponent(contact)}?subject=${encodeURIComponent('Please renew my SlientClip access')}`
    : null;
  bar.innerHTML = `
    <div class="expired-icon">${icon('ban')}</div>
    <div class="expired-text"><b>Your access ${expiresAt ? `expired on ${esc(fmt(expiresAt))}` : 'has expired'}.</b>
      <span>You can still look around, but watching, clipping, posting and changes are turned off. Contact your administrator${contact ? ` (<a href="${esc(mail)}">${esc(contact)}</a>)` : ''} to renew it.</span></div>
    <div class="row expired-actions">
      ${mail ? `<a class="btn sm primary" href="${esc(mail)}">${icon('message')}Contact admin</a>` : ''}
      <button class="btn sm check-access">${icon('refresh')}Check again</button>
    </div>`;
  bar.querySelector('.check-access').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (me && !me.expired) location.reload();
    else e.currentTarget.disabled = false;
  };
}

/** A heads-up while access still works but ends within a week. */
export function warnExpiry(expiresAt) {
  const days = (expiresAt - Date.now()) / 86400000;
  if (!expiresAt || days > 7 || days <= 0 || sessionStorage.getItem('sc-expiry-warned') === String(expiresAt)) return;
  const bar = document.createElement('div');
  bar.className = 'expiry-warning';
  bar.innerHTML = `${icon('clock')}<span>Your access ends on <b>${esc(fmt(expiresAt))}</b>${days < 1 ? ' (today)' : ''}. Contact your administrator to extend it.</span>
    <button class="btn sm ghost" title="Dismiss">${icon('x')}</button>`;
  bar.querySelector('button').onclick = () => { sessionStorage.setItem('sc-expiry-warned', String(expiresAt)); bar.remove(); };
  document.querySelector('.topbar').after(bar);
}
