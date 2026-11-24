// Version badge + "new version deployed" prompt, shared by the dashboard, watch window and login page.
const POLL_MS = 2 * 60 * 1000;

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

// Shows `pill` (a button) once the server reports a different build than the page loaded with.
export function watchForUpdates(loaded, pill) {
  if (!loaded || !pill) return;
  let notified = false;
  const check = async () => {
    if (notified || document.hidden) return;
    try {
      const now = await (await fetch('/healthz', { cache: 'no-store' })).json();
      if (now.version && !sameBuild(loaded, now)) {
        notified = true;
        pill.innerHTML = `New version v${now.version}${now.commit ? ` (${now.commit})` : ''} · Reload`;
        pill.title = `Running v${loaded.version}${loaded.commit ? ` (${loaded.commit})` : ''}. Reload to use the new version.`;
        pill.classList.remove('hidden');
        pill.onclick = () => location.reload();
      }
    } catch { /* server restarting during a deploy; try again later */ }
  };
  setInterval(check, POLL_MS);
  document.addEventListener('visibilitychange', check);
}
