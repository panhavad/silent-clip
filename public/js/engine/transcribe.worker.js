// Speech-to-text for burned-in subtitles. Runs Whisper (transformers.js) inside this worker,
// on WebGPU when available, otherwise WebAssembly. The model is cached by the browser after
// the first download.
import { pipeline, env } from '/vendor/transformers/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/vendor/ort/`;

const MODEL = 'onnx-community/whisper-base_timestamped';
let asrPromise = null;

async function hasWebGPU() {
  try { return Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

function load(progress) {
  if (!asrPromise) {
    asrPromise = (async () => {
      const wasm = { device: 'wasm', dtype: 'q8', progress_callback: progress };
      if (await hasWebGPU()) {
        try {
          return await pipeline('automatic-speech-recognition', MODEL, {
            device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: progress,
          });
        } catch { /* fall back to wasm below */ }
      }
      return pipeline('automatic-speech-recognition', MODEL, wasm);
    })().catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

self.onmessage = async ({ data: { id, audio, language } }) => {
  try {
    const asr = await load((p) => {
      if (p.status === 'progress' && p.total) self.postMessage({ id, type: 'progress', loaded: p.loaded, total: p.total, file: p.file });
    });
    const opts = { return_timestamps: 'word', chunk_length_s: 30, task: 'transcribe' };
    if (language) opts.language = language;
    const result = await asr(audio, opts);
    self.postMessage({ id, type: 'done', result: { text: result.text, chunks: result.chunks || [] } });
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e?.message || String(e) });
  }
};
