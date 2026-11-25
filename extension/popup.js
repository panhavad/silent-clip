// SlientClip Publisher — toolbar popup: connect to a SlientClip site and show what the extension is doing.
const $ = (id) => document.getElementById(id);
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const say = (text, good = false) => { const m = $('message'); m.textContent = text; m.className = `message${good ? ' good' : ''}`; m.hidden = !text; };

async function render() {
  const s = await chrome.storage.local.get(['server', 'token', 'user', 'youtube', 'account', 'lastPoll', 'status', 'lastError', 'log']);
  const paired = Boolean(s.token) && s.status !== 'unpaired';
  $('unpaired').hidden = paired;
  $('paired').hidden = !paired;
  if (!paired) {
    if (s.status === 'unpaired' && s.lastError) say(s.lastError);
    return;
  }
  $('server').textContent = s.server;
  $('user').textContent = s.user?.email || s.user?.name || '';
  const yt = s.youtube || {};
  $('youtube').innerHTML = yt.loggedIn === true
    ? `<span class="ok">Signed in${yt.name ? ` as ${escapeHtml(yt.name)}` : ''}</span>`
    : yt.loggedIn === false
      ? '<span class="bad">Signed out</span> · <a href="https://www.youtube.com/" target="_blank">sign in</a>'
      : '<span class="muted">Checking…</span>';
  $('lastPoll').textContent = ago(s.lastPoll);
  $('error').hidden = !s.lastError;
  $('error').textContent = s.lastError || '';
  const log = s.log || [];
  $('log').innerHTML = log.length
    ? log.map((l) => `<li class="${l.ok === true ? 'good' : l.ok === false ? 'fail' : ''}" title="${new Date(l.at).toLocaleString()}">${escapeHtml(l.text)} <span class="muted">· ${ago(l.at)}</span></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Runs inside the SlientClip tab (with its sign-in) to get a token for this browser. */
async function pairInPage(name) {
  const cfg = await fetch('/api/config').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg?.build) return { error: 'This tab is not a SlientClip site. Open SlientClip, sign in, and try again.' };
  const r = await fetch('/api/ext/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j.error || `Pairing failed (HTTP ${r.status})` };
  return { ...j, server: location.origin };
}

async function connect() {
  say('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) return say('Open your SlientClip site in this tab first.');
  const origin = new URL(tab.url).origin;
  // Lasting access to this one site lets its page use "Copy login from my Chrome"; pairing also works without it.
  const siteAccess = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  let res;
  const pair = async () => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pairInPage, args: ['Chrome'] }))[0].result;
  try {
    res = await pair();
  } catch (e) {
    if (siteAccess) return say(`Could not reach this tab: ${e.message}`);
    // No access to the tab (e.g. the popup wasn't opened from the toolbar): ask for this site, then try again.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!granted) return say(`Could not reach this tab: ${e.message}`);
    try { res = await pair(); } catch (e2) { return say(`Could not reach this tab: ${e2.message}`); }
  }
  if (!res || res.error) return say(res?.error || 'Pairing failed');
  await chrome.storage.local.set({ server: res.server, token: res.token, user: res.user, status: 'ok', lastError: null, log: [] });
  await chrome.runtime.sendMessage({ type: 'registerBridge' }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] }).catch(() => {});
  say('Connected. Checking YouTube in this Chrome…', true);
  const hello = await chrome.runtime.sendMessage({ type: 'paired' });
  await render();
  if (hello?.error) return say(hello.error);
  say(hello?.youtube?.loggedIn
    ? `Connected. YouTube posts will be uploaded from this Chrome${hello.youtube.name ? ` as ${hello.youtube.name}` : ''}.`
    : 'Connected, but YouTube is signed out in this Chrome. Sign in on youtube.com, then press Check now.', Boolean(hello?.youtube?.loggedIn));
  // Let the open SlientClip page refresh its Social accounts panel.
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.dispatchEvent(new Event('slientclip-extension-connected')) }).catch(() => {});
}

$('connect').onclick = connect;
$('reconnect').onclick = connect;
$('check').onclick = async () => {
  $('check').disabled = true;
  say('Checking…', true);
  const r = await chrome.runtime.sendMessage({ type: 'checkNow' });
  $('check').disabled = false;
  say(r?.lastError || (r?.youtube?.loggedIn === false ? 'YouTube is signed out in this Chrome.' : 'All good.'), !r?.lastError && r?.youtube?.loggedIn !== false);
  render();
};
$('disconnect').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  say('Disconnected from SlientClip.');
  render();
};
chrome.storage.onChanged.addListener(render);
render();
