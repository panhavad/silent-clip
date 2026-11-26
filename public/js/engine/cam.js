// Browser side of the streamer-cam layout: detection (sampled frames -> detect.worker.js) and the saved per-streamer
// setting on the server.
import { sampleFrames } from './render.js';
import { needsDetection, resolvePlan } from './facecam.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./detect.worker.js', import.meta.url), { type: 'module', name: 'detect-cam' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.type === 'done') p.resolve(data.plan); else p.reject(new Error(data.message));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Streamer detection crashed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/** Detect where the streamer is in this clip (see planFromFaces). */
export async function detectCam(src) {
  const frames = await sampleFrames(src);
  if (!frames.length) return { type: 'none', reason: 'no video frames' };
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, frames }, frames.map((f) => f.data.buffer));
  });
}

async function call(login, method = 'GET', body) {
  const res = await fetch(`/api/cams/${encodeURIComponent(login)}`, {
    method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}
export const getCamSetting = (login) => call(login);
export const saveCamSetting = (login, body) => call(login, 'PUT', body);

/**
 * The plan to render a clip of `login` with. `known` is a plan already worked out for this clip (re-renders), used
 * instead of a new detection unless the streamer's setting is manual / off.
 */
export async function planCam(login, src, { known = null, onStatus = () => {}, log = () => {} } = {}) {
  const stored = await getCamSetting(login).catch(() => null);
  let detected = null;
  if (needsDetection(stored)) {
    if (known && known.type !== 'none' && !known.manual) detected = known;
    else {
      onStatus('Finding the streamer cam…');
      try {
        detected = await detectCam(src);
        if (detected.type !== 'none') saveCamSetting(login, { detected }).catch(() => {});
      } catch (e) {
        log(`Streamer cam detection failed: ${e.message}`);
      }
    }
  }
  return resolvePlan(stored, detected);
}
