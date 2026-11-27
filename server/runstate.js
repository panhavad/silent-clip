// Remembers how the previous server run ended, so a crash/restart loop can be diagnosed from /healthz without access
// to the server's logs: an uncaught error (with its message), a stop signal, or an abrupt kill (no record at all,
// typically the out-of-memory killer), plus the memory figures last seen before it ended.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'run-state.json');
const startedAt = new Date().toISOString();
let previous = null;
let state = null;
let activity = '';
let rejections = 0;
let lastRejection = null;
let workerCrashes = 0;

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const mb = (n) => (n == null ? null : Math.round(Number(n) / 1048576));

function cgroupMemory() {
  const max = read('/sys/fs/cgroup/memory.max');
  const events = read('/sys/fs/cgroup/memory.events');
  return {
    limitMb: max && max !== 'max' ? mb(max) : null,
    usedMb: mb(read('/sys/fs/cgroup/memory.current')),
    peakMb: mb(read('/sys/fs/cgroup/memory.peak')),
    oomKills: events ? Number((/oom_kill (\d+)/.exec(events) || [])[1] || 0) : null,
  };
}

function snapshot() {
  const m = process.memoryUsage();
  return {
    rssMb: mb(m.rss), heapMb: mb(m.heapUsed),
    systemTotalMb: mb(os.totalmem()), systemFreeMb: mb(os.freemem()),
    cgroup: cgroupMemory(), activity,
  };
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch { /* disk full / read-only: diagnostics only */ }
}

/** What the server is busy with (shown if it dies mid-way), e.g. "clip xqc: transcribing". */
export const setActivity = (a) => { activity = String(a || '').slice(0, 120); };
export const noteWorkerCrash = () => { workerCrashes++; };

export function startRunState() {
  try { previous = JSON.parse(read(FILE) || 'null'); } catch { previous = null; }
  if (previous && !previous.ended) previous.ended = 'abruptly (no shutdown recorded: killed, most likely by the out-of-memory killer)';
  state = { startedAt, pid: process.pid, ended: null, last: snapshot(), lastAt: new Date().toISOString() };
  save();
  setInterval(() => { state.last = snapshot(); state.lastAt = new Date().toISOString(); save(); }, 5000).unref();

  process.on('unhandledRejection', (e) => {
    // A stray rejected promise must not take down every watcher; record it and keep running.
    rejections++;
    lastRejection = { at: new Date().toISOString(), message: String(e?.stack || e).split('\n').slice(0, 4).join(' | ').slice(0, 500) };
    console.error('[unhandledRejection]', e);
  });
  process.on('uncaughtException', (e) => {
    console.error('[uncaughtException]', e);
    markEnded(`crashed: ${String(e?.stack || e).split('\n').slice(0, 4).join(' | ').slice(0, 500)}`);
    process.exit(1);
  });
}

export function markEnded(reason) {
  if (!state || state.ended) return;
  state.ended = reason;
  state.last = snapshot();
  state.lastAt = new Date().toISOString();
  save();
}

export function runDiagnostics() {
  return {
    now: snapshot(),
    uptimeSec: Math.round(process.uptime()),
    previousRun: previous && { startedAt: previous.startedAt, endedAt: previous.lastAt, ended: previous.ended, last: previous.last },
    unhandledRejections: rejections, lastRejection, clipWorkerCrashes: workerCrashes,
  };
}
