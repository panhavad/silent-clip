// Server-side streamer-cam detection: samples a few frames of the clip with native ffmpeg and finds faces with the
// bundled UltraFace model (public/models, ~1.5 MB) on onnxruntime-node. About 0.1 s per frame on a CPU.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_W, ANALYSIS_H, SAMPLE_FRAMES, FACE_MODEL, FACE_IN_W, FACE_IN_H, faceInput, decodeFaces, planFromFaces } from '../../public/js/engine/facecam.js';
import { run } from './render.js';

const MODEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'models', FACE_MODEL);
const fmt = (n) => Number(n).toFixed(2);
let session = null;
let ort = null;

function load() {
  if (!session) {
    session = (async () => {
      ort = await import('onnxruntime-node');
      return ort.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 2, logSeverityLevel: 3 });
    })().catch((e) => { session = null; throw e; });
  }
  return session;
}

/** `n` RGB frames (ANALYSIS_W x ANALYSIS_H) spread over [offset, offset + duration]. */
export async function sampleFrames(input, offsetSec, durationSec, n = SAMPLE_FRAMES) {
  const size = ANALYSIS_W * ANALYSIS_H * 3;
  const span = Math.max(1, durationSec - 1);
  const buf = await run(['-hide_banner', '-ss', fmt(offsetSec + 0.5), '-i', input, '-t', fmt(span),
    '-vf', `fps=${n}/${fmt(span)},scale=${ANALYSIS_W}:${ANALYSIS_H}`, '-frames:v', String(n),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { collect: true });
  const frames = [];
  for (let i = 0; i + size <= buf.length; i += size) {
    frames.push({ data: new Uint8Array(buf.buffer, buf.byteOffset + i, size), width: ANALYSIS_W, height: ANALYSIS_H, channels: 3 });
  }
  return frames;
}

/** Faces found in each frame (normalized boxes). */
export async function detectFaces(frames) {
  const s = await load();
  const out = [];
  for (const f of frames) {
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', faceInput(f), [1, 3, FACE_IN_H, FACE_IN_W]) });
    out.push(decodeFaces(r.scores.data, r.boxes.data));
  }
  return out;
}

/** Where is the streamer in this clip? See planFromFaces for the result. */
export async function detectCamServer(input, offsetSec, durationSec) {
  const frames = await sampleFrames(input, offsetSec, durationSec);
  if (!frames.length) return { type: 'none', reason: 'no video frames' };
  return planFromFaces({ frames, faces: await detectFaces(frames) });
}
