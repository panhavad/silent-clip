// Runs clip jobs in a separate worker process (clip-worker.js), one at a time. The worker stays up between clips
// (the speech model stays loaded) and exits after CLIP_WORKER_IDLE_SEC without work to give its memory back.
// If the worker dies mid-job (killed for using too much memory, or a crash in native code), only that job fails
// with ClipWorkerCrash; the server and everything it is watching keep running, and the next job starts a new worker.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clip-worker.js');

export class ClipWorkerCrash extends Error {
  constructor(code, signal) {
    super(`The clip worker stopped while working${signal ? ` (${signal})` : code != null ? ` (exit code ${code})` : ''}, most likely because the server ran out of memory`);
    this.name = 'ClipWorkerCrash';
    this.code = code;
    this.signal = signal;
  }
}

export function createClipRunner({ script = SCRIPT, idleMs = Number(process.env.CLIP_WORKER_IDLE_SEC ?? 300) * 1000 } = {}) {
  let child = null;
  let nextId = 1;
  let idleTimer = null;
  const jobs = new Map();

  function spawn() {
    const c = fork(script, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    c.on('message', (msg) => {
      const j = jobs.get(msg?.id);
      if (!j) return;
      if (msg.type === 'stage') j.hooks.stage?.(msg.stage);
      else if (msg.type === 'note') j.hooks.note?.(msg.message);
      else if (msg.type === 'done' || msg.type === 'error') {
        jobs.delete(msg.id);
        if (msg.type === 'done') j.resolve(msg.result); else j.reject(new Error(msg.message));
        armIdle();
      }
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      for (const [id, j] of jobs) { jobs.delete(id); j.reject(new ClipWorkerCrash(code, signal)); }
    });
    c.on('error', () => {});
    return c;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (jobs.size || !child) return;
    idleTimer = setTimeout(() => { if (!jobs.size && child) { child.disconnect(); child = null; } }, idleMs);
    idleTimer.unref?.();
  }

  return {
    run(job, hooks = {}) {
      clearTimeout(idleTimer);
      child ||= spawn();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve, reject, hooks });
        child.send({ id, job });
      });
    },
    get running() { return Boolean(child); },
    stop() {
      clearTimeout(idleTimer);
      const c = child;
      child = null;
      c?.kill();
    },
  };
}
