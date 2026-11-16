// Server-side speech-to-text (Whisper via transformers.js on onnxruntime-node).
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import { toPhrases } from '../../public/js/engine/transcribe.js';

const MODEL = 'onnx-community/whisper-base_timestamped';
let asrPromise = null;

function load() {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(DATA_DIR, 'models');
      return pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' });
    })().catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

export async function transcribeServer(audio, durationSec, language) {
  const asr = await load();
  const opts = { return_timestamps: 'word', chunk_length_s: 30, task: 'transcribe' };
  if (language) opts.language = language;
  const result = await asr(audio, opts);
  return { phrases: toPhrases(result, durationSec), text: String(result.text || '').trim() };
}
