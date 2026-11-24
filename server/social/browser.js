// Real-browser automation for posting to YouTube / TikTok / Instagram.
// Each user gets one persistent browser profile per platform (cookies = the logged-in session),
// stored under DATA_DIR/browser/<userId>/<platform>. A session can be watched and controlled
// live from the web app (screencast frames + forwarded clicks/keys), which is how users log in
// even when the server has no screen.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

export const PROFILES_DIR = path.join(DATA_DIR, 'browser');
const VIEWPORT = { width: 1280, height: 800 };
const LOGIN_IDLE_MS = 15 * 60 * 1000;

const CANDIDATES = {
  win32: [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

let cachedExe;
export function browserExecutable() {
  if (cachedExe !== undefined) return cachedExe;
  const list = [process.env.BROWSER_PATH, ...(CANDIDATES[process.platform] || [])].filter(Boolean);
  cachedExe = list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return cachedExe;
}

// Hidden (headless) Chrome is the same browser, but its user-agent string says "HeadlessChrome".
// Sites (Google especially) tie a login to the device it was made on, so the hidden browser must
// present exactly what the visible one does: the same UA string and the same client hints (brands,
// full version, OS version). These are read from the browser itself, never made up.
let cachedIdentity;
async function realIdentity() {
  if (cachedIdentity) return cachedIdentity;
  const srv = http.createServer((_q, r) => r.end('<!doctype html><title>.</title>'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); // localhost counts as a secure page, so all hints are readable
  const b = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: sandboxArgs() });
  try {
    const page = await b.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const v = await page.evaluate(async () => ({
      ua: navigator.userAgent,
      hints: await navigator.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64']),
    }));
    const fix = (s) => String(s).replace(/Headless\s?/g, '');
    const h = v.hints;
    cachedIdentity = {
      ua: fix(v.ua),
      metadata: h && {
        brands: h.brands.map((x) => ({ brand: fix(x.brand), version: x.version })),
        fullVersionList: h.fullVersionList.map((x) => ({ brand: fix(x.brand), version: x.version })),
        fullVersion: h.uaFullVersion, platform: h.platform, platformVersion: h.platformVersion,
        architecture: h.architecture, model: h.model, mobile: h.mobile, bitness: h.bitness, wow64: h.wow64,
      },
    };
    return cachedIdentity;
  } finally {
    await b.close().catch(() => {});
    srv.close();
  }
}

// Containers run as a non-root user without user namespaces, where Chrome's sandbox can't start.
const sandboxArgs = () => (process.platform === 'linux' && fs.existsSync('/.dockerenv') ? ['--no-sandbox'] : []);

export const browserAvailable = () => process.env.BROWSER_DISABLED !== 'true' && Boolean(browserExecutable());
/** A visible window is only possible when the server machine has a desktop. */
export const canShowWindow = () => process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export const profileDir = (userId, platform) => path.join(PROFILES_DIR, String(userId), platform);

export function deleteProfile(userId, platform) {
  const dir = platform ? profileDir(userId, platform) : path.join(PROFILES_DIR, String(userId));
  fs.rmSync(dir, { recursive: true, force: true });
}

export class BusyError extends Error {
  constructor(msg) { super(msg); this.busy = true; }
}

const sessions = new Map(); // id -> BrowserSession
const byProfile = new Map(); // `${userId}:${platform}` -> BrowserSession

export class BrowserSession {
  constructor({ userId, platform, kind }) {
    this.id = crypto.randomUUID();
    this.userId = userId;
    this.platform = platform;
    this.kind = kind; // 'login' | 'post' | 'check'
    this.step = 'Starting browser';
    this.frame = null;
    this.frameSeq = 0;
    this.lastActive = Date.now();
    this.closed = false;
    this.headed = false;
  }

  get key() { return `${this.userId}:${this.platform}`; }

  async start({ headed = false } = {}) {
    if (!browserAvailable()) throw new Error('No Chrome, Edge or Chromium found on the server (set BROWSER_PATH)');
    if (byProfile.has(this.key)) throw new BusyError('This account\'s browser is busy (a login or another post is running)');
    byProfile.set(this.key, this);
    sessions.set(this.id, this);
    this.headed = headed && canShowWindow();
    const dir = profileDir(this.userId, this.platform);
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
      `--window-size=${VIEWPORT.width + 20},${VIEWPORT.height + 140}`, '--lang=en-US',
      ...sandboxArgs(),
    ];
    let identity = null;
    try {
      await clearStaleLock(dir);
      if (!this.headed) {
        identity = await realIdentity();
        // Browser-wide, so background/service workers send the same UA string as the page.
        args.push(`--user-agent=${identity.ua}`);
      }
      this.context = await chromium.launchPersistentContext(dir, {
        executablePath: browserExecutable(),
        headless: !this.headed,
        viewport: VIEWPORT,
        locale: 'en-US',
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        acceptDownloads: false,
        // The server's own shutdown handler closes browsers and waits for them to save cookies.
        handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
      });
    } catch (e) {
      this.release();
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(e.message)) throw new BusyError('This account\'s browser profile is already open');
      throw e;
    }
    this.identity = identity;
    // Report no touchscreen in both modes (hidden Chrome claims one, and sites then serve tablet layouts),
    // so a login made in a visible window looks like the same device to later hidden sessions.
    await this.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 0 })).catch(() => {});
    this.context.on('page', (p) => this.attach(p));
    this.context.on('close', () => this.release());
    await this.attach(this.context.pages()[0] || await this.context.newPage());
    return this;
  }

  async attach(page) {
    this.page = page;
    this.frame = null;
    page.on('close', () => {
      if (this.page !== page || this.closed || !this.context) return;
      const rest = this.context.pages().filter((p) => !p.isClosed());
      if (rest.length) this.attach(rest[rest.length - 1]);
    });
    try {
      const old = this.cdp;
      this.cdp = null;
      await old?.detach().catch(() => {});
      const cdp = await this.context.newCDPSession(page);
      this.cdp = cdp;
      if (this.identity?.metadata) {
        // The --user-agent switch drops the detailed client hints; put the browser's real ones back.
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: this.identity.ua, acceptLanguage: 'en-US', userAgentMetadata: this.identity.metadata,
        }).catch(() => {});
      }
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (this.cdp !== cdp) return;
        this.frame = Buffer.from(data, 'base64');
        this.frameSeq++;
        this.lastFrameAt = Date.now();
      });
      const startCast = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
      await startCast();
      // The screencast can stall after a cross-document navigation; restart it on each one.
      page.on('framenavigated', (f) => { if (f === page.mainFrame() && this.cdp === cdp) startCast().catch(() => {}); });
    } catch { /* page closed while attaching */ }
  }

  /** Latest JPEG of the active tab (screenshots if the screencast hasn't produced one yet). */
  async getFrame() {
    this.lastActive = Date.now();
    if (!this.frame) await this.snapshot();
    return this.frame;
  }

  /** Fallback when the screencast is quiet: take a screenshot and publish it if the screen changed. */
  async snapshot() {
    if (!this.page || this.page.isClosed() || this.snapping || Date.now() - (this.lastFrameAt || 0) < 1500) return;
    this.snapping = true;
    try {
      const shot = await this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
      if (!this.frame || !shot.equals(this.frame)) { this.frame = shot; this.frameSeq++; }
      this.lastFrameAt = Date.now();
    } catch { /* navigating */ } finally { this.snapping = false; }
  }

  state() {
    let url = '';
    try { url = this.page?.url() || ''; } catch { /* closed */ }
    return { id: this.id, platform: this.platform, kind: this.kind, step: this.step, url, headed: this.headed, closed: this.closed, frameSeq: this.frameSeq };
  }

  /** Forward a user action from the live viewer. Coordinates are 0..1 of the viewport. */
  async input(ev) {
    this.lastActive = Date.now();
    const page = this.page;
    if (!page || page.isClosed()) return;
    const { width, height } = page.viewportSize() || VIEWPORT;
    const px = (v, max) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * max);
    switch (ev.type) {
      case 'click': {
        const x = px(ev.x, width); const y = px(ev.y, height);
        await page.mouse.move(x, y, { steps: 4 });
        await page.mouse.click(x, y, { clickCount: ev.double ? 2 : 1 });
        break;
      }
      case 'scroll':
        await page.mouse.move(px(ev.x ?? 0.5, width), px(ev.y ?? 0.5, height));
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
        break;
      case 'type':
        await page.keyboard.type(String(ev.text || '').slice(0, 2000), { delay: 25 });
        break;
      case 'key':
        if (/^[\w+]{1,40}$/.test(String(ev.key))) await page.keyboard.press(String(ev.key));
        break;
      case 'back': await page.goBack({ timeout: 15000 }).catch(() => {}); break;
      case 'reload': await page.reload({ timeout: 30000 }).catch(() => {}); break;
      case 'goto': if (ev.url) await page.goto(ev.url, { timeout: 45000 }).catch(() => {}); break;
      default: throw new Error('Unknown action');
    }
  }

  async cookies(urls) {
    return this.context ? this.context.cookies(urls) : [];
  }

  release() {
    this.closed = true;
    sessions.delete(this.id);
    if (byProfile.get(this.key) === this) byProfile.delete(this.key);
  }

  async close() {
    this.release();
    const ctx = this.context;
    this.context = null;
    await ctx?.close().catch(() => {});
    // close() returns before Chrome has finished writing cookies and exiting; wait for it to let go.
    if (ctx) await waitForUnlock(profileDir(this.userId, this.platform), 10000);
  }
}

// Chrome (Linux/macOS) marks a profile in use with a SingletonLock symlink to "<hostname>-<pid>".
const lockOwner = (dir) => {
  try {
    const m = /^(.*)-(\d+)$/.exec(fs.readlinkSync(path.join(dir, 'SingletonLock')));
    return m ? { host: m[1], pid: Number(m[2]) } : { host: '', pid: 0 };
  } catch { return null; }
};
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// After a container restart the old PID may belong to another process; on Linux check it's a Chrome for this profile.
const usesProfile = (pid, dir) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(path.resolve(dir)); } catch { return process.platform !== 'linux'; }
};
const lockLive = (o, dir) => o && o.host === os.hostname() && pidAlive(o.pid) && usesProfile(o.pid, dir);

async function waitForUnlock(dir, ms) {
  for (const end = Date.now() + ms; lockLive(lockOwner(dir), dir) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Remove a lock left by a Chrome that is gone (killed, or from an earlier container: a redeploy changes
 * the hostname and Chrome then refuses the profile as "in use on another computer"). A Chrome of this
 * server that is still shutting down is waited for instead.
 */
async function clearStaleLock(dir) {
  await waitForUnlock(dir, 10000);
  const owner = lockOwner(dir);
  if (!owner) return;
  if (lockLive(owner, dir)) throw new BusyError('This account\'s browser profile is already open');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* not there */ }
  }
}

export const getSession = (id) => sessions.get(id) || null;
export const profileBusy = (userId, platform) => byProfile.has(`${userId}:${platform}`);
export const liveSessions = () => [...sessions.values()];

export async function openSession({ userId, platform, kind, headed }) {
  const s = new BrowserSession({ userId, platform, kind });
  await s.start({ headed });
  return s;
}

export async function closeUserSessions(userId, platform) {
  await Promise.all(liveSessions().filter((s) => s.userId === userId && (!platform || s.platform === platform)).map((s) => s.close()));
}

/** Close every browser cleanly (Chrome writes freshly rotated login cookies to disk only on a clean exit). */
export async function closeAllSessions() {
  await Promise.all(liveSessions().map((s) => s.close()));
}

// Abandoned login windows are closed so the profile can be used for posting again.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.kind === 'login' && Date.now() - s.lastActive > LOGIN_IDLE_MS) s.close();
  }
}, 60000).unref();
