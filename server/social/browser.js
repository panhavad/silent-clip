// Real-browser automation for posting to YouTube / TikTok / Instagram.
// Each user gets one persistent browser profile per platform (cookies = the logged-in session),
// stored under DATA_DIR/browser/<userId>/<platform>. A session can be watched and controlled
// live from the web app (screencast frames + forwarded clicks/keys), which is how users log in
// even when the server has no screen.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

export const PROFILES_DIR = path.join(DATA_DIR, 'browser');
const VIEWPORT = { width: 1280, height: 800 };
const LOGIN_IDLE_MS = 15 * 60 * 1000;
// Chrome caps cookie lifetimes at 400 days.
const KEEP_COOKIES_SEC = 400 * 86400;

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

// Hidden (headless) Chrome announces itself as "HeadlessChrome", which sites treat as a bot or a
// different device. Present the same identity a normal desktop Chrome of this version sends.
let cachedUA;
async function desktopUserAgent() {
  if (cachedUA) return cachedUA;
  const b = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: process.platform === 'linux' && fs.existsSync('/.dockerenv') ? ['--no-sandbox'] : [] });
  const major = b.version().split('.')[0];
  await b.close();
  const os = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7' }[process.platform] || 'X11; Linux x86_64';
  cachedUA = { ua: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`, major };
  return cachedUA;
}

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
    ];
    // Containers run as a non-root user without user namespaces, where Chrome's sandbox can't start.
    if (process.platform === 'linux' && fs.existsSync('/.dockerenv')) args.push('--no-sandbox');
    let identity = null;
    try {
      if (!this.headed) identity = await desktopUserAgent();
      this.context = await chromium.launchPersistentContext(dir, {
        executablePath: browserExecutable(),
        headless: !this.headed,
        viewport: VIEWPORT,
        locale: 'en-US',
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        acceptDownloads: false,
        ...(identity ? { userAgent: identity.ua } : {}),
      });
    } catch (e) {
      this.release();
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(e.message)) throw new BusyError('This account\'s browser profile is already open');
      throw e;
    }
    this.identity = identity;
    // Hidden Chrome claims a touchscreen (maxTouchPoints 10), which makes sites serve tablet layouts.
    if (identity) await this.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 0 })).catch(() => {});
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
      if (this.identity) {
        const { ua, major } = this.identity;
        const platform = { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux';
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: ua, acceptLanguage: 'en-US,en',
          userAgentMetadata: {
            brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not?A_Brand', version: '99' }],
            fullVersion: `${major}.0.0.0`, platform, platformVersion: platform === 'Windows' ? '10.0.0' : '', architecture: 'x86', model: '', mobile: false,
          },
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

  /**
   * Cookies without an expiry are dropped when Chrome restarts, and this profile is relaunched for every
   * post. Give them a long expiry before closing (like Chrome's "continue where you left off") so logins
   * that rely on them survive.
   */
  async persistSessionCookies() {
    const ctx = this.context;
    if (!ctx) return 0;
    const now = Math.floor(Date.now() / 1000);
    const sessionOnly = (await ctx.cookies().catch(() => [])).filter((c) => c.expires === -1 && c.value && !c.partitionKey);
    let kept = 0;
    for (const c of sessionOnly) {
      try { await ctx.addCookies([{ ...c, expires: now + KEEP_COOKIES_SEC }]); kept++; } catch { /* e.g. __Host- cookies that can't be re-set */ }
    }
    return kept;
  }

  async close() {
    const ctx = this.context;
    await this.persistSessionCookies().catch(() => {});
    this.release();
    this.context = null;
    await ctx?.close().catch(() => {});
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

// Abandoned login windows are closed so the profile can be used for posting again.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.kind === 'login' && Date.now() - s.lastActive > LOGIN_IDLE_MS) s.close();
  }
}, 60000).unref();
