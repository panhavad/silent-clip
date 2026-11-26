// Finds the streamer's face in sampled clip frames with the bundled UltraFace model (public/models, ~1.5 MB) on
// onnxruntime-web, and turns that into a streamer-cam plan. Runs off the main thread.
import * as ort from '/vendor/ort/ort.wasm.min.mjs';
import { FACE_MODEL, FACE_IN_W, FACE_IN_H, faceInput, decodeFaces, planFromFaces } from './facecam.js';

ort.env.wasm.wasmPaths = `${self.location.origin}/vendor/ort/`;
ort.env.logLevel = 'error';

let session = null;
const load = () => {
  session ||= ort.InferenceSession.create(`${self.location.origin}/models/${FACE_MODEL}`, { executionProviders: ['wasm'] })
    .catch((e) => { session = null; throw e; });
  return session;
};

self.onmessage = async ({ data: { id, frames } }) => {
  try {
    const s = await load();
    const faces = [];
    for (const f of frames) {
      const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', faceInput(f), [1, 3, FACE_IN_H, FACE_IN_W]) });
      faces.push(decodeFaces(r.scores.data, r.boxes.data));
    }
    self.postMessage({ id, type: 'done', plan: planFromFaces({ frames, faces }) });
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e?.message || String(e) });
  }
};
