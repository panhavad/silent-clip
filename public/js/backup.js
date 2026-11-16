import { api, toast } from './api.js';
import { icon } from './icons.js';

export function renderBackup(root, { onRestored }) {
  root.innerHTML = `
    <div class="section-head"><div><h2 style="margin:0">Backup &amp; restore settings</h2>
      <div class="muted small">Save your clipping settings, auto-publish schedule and streamer list to a file, then restore them any time, on this account or another one.
      Clips and linked social accounts are not included.</div></div></div>
    <div class="row wrap">
      <a class="btn primary" href="/api/backup" download>${icon('download')}Download settings backup</a>
      <label class="btn">${icon('upload')}Restore from file<input type="file" accept=".json,application/json" class="restore-file" hidden></label>
      <label class="row small"><input type="checkbox" class="restore-replace"> Replace my streamer list (otherwise merge)</label>
    </div>`;
  root.querySelector('.restore-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const replace = root.querySelector('.restore-replace').checked;
      if (!confirm(`Restore settings from "${file.name}"${backup.exportedAt ? ` (saved ${new Date(backup.exportedAt).toLocaleString()})` : ''}? Your current settings will be overwritten.`)) return;
      const r = await api('/api/backup/restore', { method: 'POST', body: { backup, mode: replace ? 'replace' : 'merge' } });
      toast(`Restored settings and ${r.streamers} streamer(s)`, 'ok');
      onRestored?.();
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not a valid backup' : err.message, 'error');
    }
  };
}
