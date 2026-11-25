export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    // Signed out (or the session ended): back to the product page, where Sign in / Start free live.
    location.href = '/';
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  // Access ran out while the app was open: lock it (handled in app.js).
  if (res.status === 403 && data.code === 'expired') window.dispatchEvent(new CustomEvent('sc-expired', { detail: data }));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(message, type = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.append(wrap); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  wrap.append(el);
  setTimeout(() => el.remove(), 5000);
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
