// Version badge + automatic update to a newly deployed release, shared by the dashboard, watch window and login page.
const POLL_MS = 60 * 1000;
const RELOAD_KEY = 'sc-update-reload';

// The code fingerprint this page actually runs: pages load their modules from /v/<fingerprint>/js/...
export const LOADED_ASSETS = (/\/v\/([\w-]+)\/js\//.exec(import.meta.url) || [])[1] || '';

// Tidy the address bar after an update reload (see reloadFresh).
{
  const u = new URL(location.href);
  if (u.searchParams.has('_v')) { u.searchParams.delete('_v'); history.replaceState(history.state, '', u); }
}

export function versionTitle(b) {
  const parts = [`SlientClip v${b.version}`];
  if (b.commit) parts.push(`commit ${b.commit}`);
  if (b.builtAt) parts.push(`built ${new Date(b.builtAt).toLocaleString()}`);
  if (b.startedAt) parts.push(`server started ${new Date(b.startedAt).toLocaleString()}`);
  return parts.join('\n');
}

export function renderVersion(el, build) {
  if (!el || !build) return;
  el.textContent = `v${build.version}`;
  el.title = versionTitle(build);
  el.dataset.commit = build.commit || '';
  el.classList.remove('hidden');
}

const sameBuild = (a, b) => a.version === b.version && (a.commitFull || '') === (b.commitFull || '');
const isNewer = (loaded, now) => (LOADED_ASSETS && now.assets ? now.assets !== LOADED_ASSETS : !!now.version && !sameBuild(loaded, now));

// Something the user is in the middle of that a reload would lose.
function userBusy() {
  const a = document.activeElement;
  if (a && (a.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !/^(button|submit|checkbox|radio|range)$/.test(a.type)))) return true;
  return !!document.querySelector('.modal-back, dialog[open]');
}

// Reload past every cache: the page itself is never cached, and the query makes even a misbehaving proxy fetch it again.
function reloadFresh(assets) {
  const u = new URL(location.href);
  u.searchParams.set('_v', assets || Date.now().toString(36));
  location.replace(u);
}

/**
 * Keeps the page on the deployed release. When the server runs newer code than this page, the page reloads itself
 * as soon as nothing would be lost; until then `pill` (a button) offers the update. `busy()` reports page work a
 * reload would interrupt (watching or rendering in this browser).
 */
export function watchForUpdates(loaded, pill, { busy = () => false } = {}) {
  if (!loaded) return;
  let target = null;
  let timer = null;
  const blocked = () => busy() || userBusy();

  const apply = () => {
    if (!target || timer) return;
    // Reloaded for this release a moment ago and still on old code: don't loop, leave it to the button.
    let last = {};
    try { last = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || '{}'); } catch { /* ignore */ }
    if (last.to === (target.assets || target.version) && Date.now() - last.at < 2 * 60 * 1000) return;
    if (blocked()) return;
    if (pill) pill.innerHTML = `Updating to v${target.version}…`;
    timer = setTimeout(() => {
      timer = null;
      if (blocked()) return;
      try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ to: target.assets || target.version, at: Date.now() })); } catch { /* ignore */ }
      reloadFresh(target.assets);
    }, 1500);
  };

  const check = async () => {
    try {
      const now = await (await fetch('/healthz', { cache: 'no-store' })).json();
      if (!isNewer(loaded, now)) return;
      target = now;
      if (pill) {
        pill.innerHTML = `New version v${now.version}${now.commit ? ` (${now.commit})` : ''} · Update`;
        pill.title = `Running v${loaded.version}${loaded.commit ? ` (${loaded.commit})` : ''}. This page updates by itself when you're not in the middle of something; click to update now.`;
        pill.classList.remove('hidden');
        pill.onclick = () => {
          if (busy() && !confirm('Updating reloads the page, which stops watching in this browser. Update now?')) return;
          reloadFresh(now.assets);
        };
      }
      apply();
    } catch { /* server restarting during a deploy; try again later */ }
  };

  setTimeout(check, 3000);
  setInterval(() => (target ? apply() : check()), POLL_MS);
  setInterval(() => target && apply(), 5000);
  document.addEventListener('visibilitychange', () => (target ? apply() : check()));
  addEventListener('focus', () => !target && check());
  addEventListener('online', () => !target && check());
  addEventListener('pageshow', (e) => e.persisted && check()); // restored from the back/forward cache
}
