// Versioned app code: pages load their JS/CSS from /v/<fingerprint>/..., where the fingerprint is a hash of
// the served code. A new release therefore gets new URLs for every module (relative imports and workers
// inherit the prefix), so no browser, proxy or CDN cache can keep serving the previous release's code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGE_NO_STORE = { 'Cache-Control': 'no-store', Vary: 'Cookie' };

function codeFiles() {
  const out = [];
  for (const dir of ['js', 'css']) {
    const abs = path.join(PUBLIC, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true })) {
      const file = path.join(abs, String(f));
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ rel: `${dir}/${String(f).replace(/\\/g, '/')}`, file, st });
    }
  }
  for (const f of fs.readdirSync(PUBLIC)) {
    if (!f.endsWith('.html')) continue;
    const file = path.join(PUBLIC, f);
    out.push({ rel: f, file, st: fs.statSync(file) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

let signature = '';
let current = '';
let checkedAt = 0;
const pages = new Map();

/** Fingerprint of the app code being served. Cheap to call: re-hashed only when a file's size/mtime changes. */
export function assetsVersion() {
  const now = Date.now();
  if (current && now - checkedAt < 1000) return current;
  checkedAt = now;
  const files = codeFiles();
  const sig = files.map((f) => `${f.rel}:${f.st.size}:${f.st.mtimeMs}`).join('|');
  if (sig !== signature) {
    const h = crypto.createHash('sha1');
    for (const f of files) h.update(f.rel).update('\0').update(fs.readFileSync(f.file));
    const next = h.digest('hex').slice(0, 12);
    signature = sig;
    if (next !== current) { current = next; pages.clear(); }
  }
  return current;
}

/** Send a page from public/ with its /js/ and /css/ references pointed at the current versioned path. */
export function sendPage(res, name) {
  const v = assetsVersion();
  let html = pages.get(name);
  if (!html) {
    html = fs.readFileSync(path.join(PUBLIC, name), 'utf8').replace(/(["'])\/(js|css)\//g, `$1/v/${v}/$2/`);
    pages.set(name, html);
  }
  res.set(PAGE_NO_STORE).type('html').send(html);
}

const immutable = express.static(PUBLIC, { index: false, immutable: true, maxAge: '365d' });
// Requests for an older fingerprint (a tab from before the update loading a module late) get today's file, uncached.
const fresh = express.static(PUBLIC, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') });

export function versionedAssets(req, res, next) {
  if (!/^\/(js|css|img)\//.test(req.path)) return res.status(404).end();
  return (req.params.v === assetsVersion() ? immutable : fresh)(req, res, next);
}

/** Every other page in public/ (login.html, watch.html, …), also reachable without ".html". */
export function htmlPages(req, res, next) {
  const m = /^\/([\w-]+)(\.html)?$/.exec(req.path);
  if (!m || !fs.existsSync(path.join(PUBLIC, `${m[1]}.html`))) return next();
  sendPage(res, `${m[1]}.html`);
}
