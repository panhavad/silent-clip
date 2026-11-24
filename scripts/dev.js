// Local dev runner: restarts the server only when a file's mtime really changes.
// (node --watch on Windows also fires on reads, which restarts mid-request.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const watchDirs = ['server', 'public/js/engine'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
const mtimes = new Map();
let child = null;
let timer = null;

function start() {
  const args = ['server/index.js'];
  if (fs.existsSync(path.join(root, '.env'))) args.unshift('--env-file=.env');
  child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && !timer) console.log(`[dev] server exited (${code}); waiting for changes`);
    child = null;
  });
}

function restart(file) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] ${path.relative(root, file)} changed, restarting`);
    const go = () => { timer = null; start(); };
    if (child) { child.once('exit', go); child.kill('SIGTERM'); } else go();
  }, 150);
}

for (const dir of watchDirs) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(f));
    if (file.endsWith('.js')) mtimes.set(file, fs.statSync(file).mtimeMs);
  }
  fs.watch(dir, { recursive: true }, (_event, name) => {
    if (!name || !name.endsWith('.js')) return;
    const file = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* deleted */ }
    if (mtimes.get(file) === mtime) return;
    mtimes.set(file, mtime);
    restart(file);
  });
}

// Version badge reads package.json and the git commit at startup, so restart on a bump or a new commit.
for (const rel of ['package.json', '.git/logs/HEAD']) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  fs.watchFile(file, { interval: 1000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) restart(file); });
}

process.on('SIGINT', () => { child?.kill('SIGTERM'); process.exit(0); });
start();
