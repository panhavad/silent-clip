// Main-thread wrapper around transcribe.worker.js + conversion of word timestamps
// into short, readable caption phrases (TikTok/Shorts style).
import { extractAudio } from './render.js';

let worker = null;
let nextId = 1;
let queue = Promise.resolve();
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./transcribe.worker.js', import.meta.url), { type: 'module', name: 'transcribe' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') { p.onProgress?.(data); return; }
      pending.delete(data.id);
      if (data.type === 'done') p.resolve(data.result); else p.reject(new Error(data.message));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Transcription worker crashed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/** Transcribe 16 kHz mono PCM. Jobs are serialized so the model is loaded only once. */
export function transcribe(audio, { language, onProgress } = {}) {
  const run = queue.then(() => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, audio, language }, [audio.buffer]);
  }));
  queue = run.catch(() => {});
  return run;
}

// Common Whisper hallucinations on silence / music.
const NOISE = /^(\s*(thank you|thanks for watching|you|bye|\[.*\]|\(.*\)|♪+|\.+)\s*[.!]*\s*)$/i;

/**
 * Turn transformers.js word chunks into phrases of up to `maxWords` words / `maxChars`
 * characters, breaking on pauses and punctuation.
 * @returns {{text: string, start: number, end: number}[]}
 */
export function toPhrases(result, duration, { maxWords = 4, maxChars = 22 } = {}) {
  const words = [];
  for (const c of result?.chunks || []) {
    const text = String(c.text || '').trim();
    if (!text) continue;
    const [s, e] = c.timestamp || [];
    const start = Number.isFinite(s) ? s : (words.at(-1)?.end ?? 0);
    const end = Number.isFinite(e) ? e : Math.min(duration, start + 0.4);
    // Segment-level chunks (several words) are spread evenly over their time span.
    const parts = text.split(/\s+/);
    const step = (end - start) / parts.length;
    parts.forEach((w, i) => words.push({ text: w, start: start + i * step, end: start + (i + 1) * step }));
  }
  const phrases = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? w.start - cur.end : 0;
    const longer = cur ? `${cur.text} ${w.text}` : w.text;
    if (cur && (cur.count >= maxWords || longer.length > maxChars || gap > 0.6 || /[.!?]$/.test(cur.text))) {
      phrases.push(cur);
      cur = null;
    }
    cur = cur ? { ...cur, text: `${cur.text} ${w.text}`, end: w.end, count: cur.count + 1 } : { text: w.text, start: w.start, end: w.end, count: 1 };
  }
  if (cur) phrases.push(cur);
  return phrases
    .filter((p) => !NOISE.test(p.text))
    // Drop garbage like "P -o -v y": mostly single-letter tokens.
    .filter((p) => { const ws = p.text.split(' ').map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean); return ws.length && ws.join('').length / ws.length >= 1.6; })
    .map((p, i, arr) => {
      // Keep each phrase on screen until the next one starts (if the gap is short) and for at least 0.5s;
      // cap unusually long spans (bad word timestamps) to the last 3.5s.
      const next = arr[i + 1];
      let end = Math.max(p.end, p.start + 0.5);
      if (next && next.start - end < 0.4) end = next.start;
      const start = Math.max(0, p.start, end - 3.5);
      return { text: p.text.replace(/\s+/g, ' ').trim(), start: +start.toFixed(2), end: +Math.min(duration, end).toFixed(2) };
    })
    .filter((p) => p.end > p.start && p.text);
}

/**
 * Full pipeline for one clip: decode audio (ffmpeg.wasm) -> Whisper -> timed phrases.
 * `bytes` is copied, so the caller can still hand the original to the renderer.
 */
export async function autoSubtitles({ bytes, ext, offsetSec, durationSec, language, onProgress }) {
  const audio = await extractAudio({ bytes: bytes.slice(), ext, offsetSec, durationSec });
  const result = await transcribe(audio, {
    language: language || undefined,
    onProgress: (p) => onProgress?.(p.total ? p.loaded / p.total : 0),
  });
  return { phrases: toPhrases(result, durationSec), text: String(result.text || '').trim() };
}

/** Editable text form: one "start-end | text" line per phrase. */
export const phrasesToText = (phrases) => (phrases || []).map((p) => `${p.start.toFixed(1)}-${p.end.toFixed(1)} | ${p.text}`).join('\n');
export function textToPhrases(text) {
  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*\|\s*(.+)$/);
    return m ? { start: Number(m[1]), end: Number(m[2]), text: m[3].trim() } : null;
  }).filter((p) => p && p.end > p.start && p.text);
}
