// Server-side rendering with native ffmpeg (used when a user picks "Run on server").
// Mirrors the browser layout: 9:16 frame, hook headline, timed subtitles.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { anchors, resolveLayout } from '../../public/js/engine/render.js';
import { camFilter } from '../../public/js/engine/facecam.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FONT = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export function run(args, { input, collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: [input ? 'pipe' : 'ignore', collect ? 'pipe' : 'ignore', 'pipe'] });
    const out = [];
    let err = '';
    if (collect) p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-4).join(' ')}`))));
    if (input) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

let available = null;
export async function ffmpegAvailable() {
  if (available === null) available = await run(['-hide_banner', '-version']).then(() => true, () => false);
  return available;
}

// drawtext can't render colour emoji; keep the words.
export const plain = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, '').replace(/\s+/g, ' ').trim();

export function wrap(text, maxChars, maxLines) {
  const lines = [];
  let line = '';
  for (const w of text.split(' ')) {
    const t = line ? `${line} ${w}` : w;
    if (t.length > maxChars && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

const fmt = (n) => Number(n).toFixed(2);

export async function renderServer({ dir, input, offsetSec = 0, durationSec = 30, caption = '',
  layout: wanted = 'blur', cam = null, camPosition = 'top', resolution = '720x1280', captions = true, subtitles = [], thumbAt = 20 }) {
  const [W, H] = String(resolution).split('x').map(Number);
  const { layout, geo } = resolveLayout(W, H, wanted, cam, camPosition);
  const { u, hookY, subY } = anchors(W, H, layout, geo);
  let n = 0;
  const textFile = (text) => {
    const f = path.join(dir, `t${n++}.txt`);
    fs.writeFileSync(f, text);
    return f.replace(/\\/g, '/').replace(/:/g, '\\:');
  };
  const dt = (text, opts) => `drawtext=fontfile='${FONT}':expansion=none:textfile='${textFile(text)}':${opts}`;
  const draws = [];
  if (captions) {
    const hook = wrap(plain(caption).toUpperCase(), 17, 3);
    const lh = 70 * u;
    hook.forEach((l, i) => {
      const y = hookY - ((hook.length - 1) * lh) / 2 + i * lh;
      const color = i === hook.length - 1 && hook.length > 1 ? '0xffe14d' : 'white';
      draws.push(dt(l, `fontsize=${Math.round(56 * u)}:fontcolor=${color}:borderw=${Math.round(6 * u)}:bordercolor=black:x=(w-tw)/2:y=${fmt(y)}-th/2`));
    });
  }
  for (const s of (subtitles || []).slice(0, 80)) {
    if (!(s.end > s.start)) continue;
    const lines = wrap(plain(s.text).toUpperCase(), 20, 2);
    const lh = 62 * u;
    lines.forEach((l, i) => {
      const y = subY - ((lines.length - 1) * lh) / 2 + i * lh;
      draws.push(dt(l, `fontsize=${Math.round(50 * u)}:fontcolor=white:borderw=${Math.round(6 * u)}:bordercolor=black:x=(w-tw)/2:y=${fmt(y)}-th/2:enable='between(t,${fmt(s.start)},${fmt(s.end)})'`));
    });
  }
  const bw = Math.round(W / 8 / 2) * 2, bh = Math.round(H / 8 / 2) * 2;
  const base = geo ? camFilter(W, H, geo) : layout === 'crop'
    ? `[0:v]fps=30,scale=-2:${H},crop=${W}:${H},setsar=1[l0]`
    : `[0:v]fps=30,split=2[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.12:saturation=1.2,setsar=1[bg];[b]scale=${W}:-2,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[l0]`;
  const graph = `${base};[l0]${[...draws, 'format=yuv420p'].join(',')}[v]`;
  const script = path.join(dir, 'graph.txt');
  fs.writeFileSync(script, graph);
  const out = path.join(dir, 'out.mp4');
  await run(['-hide_banner', '-y', '-ss', fmt(offsetSec), '-i', input, '-t', fmt(durationSec),
    '-filter_complex_script', script, '-map', '[v]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-r', '30', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', out]);
  const thumb = path.join(dir, 'thumb.jpg');
  await run(['-hide_banner', '-y', '-ss', fmt(Math.max(0, Math.min(thumbAt, durationSec - 0.5))), '-i', out, '-frames:v', '1', '-q:v', '4', thumb]).catch(() => null);
  return { video: out, thumb: fs.existsSync(thumb) ? thumb : null, width: W, height: H, duration: durationSec, layout };
}

/** 16 kHz mono float PCM for speech recognition. */
export async function extractAudioServer(input, offsetSec, durationSec) {
  const buf = await run(['-hide_banner', '-ss', fmt(offsetSec), '-i', input, '-t', fmt(durationSec), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { collect: true });
  const copy = new Uint8Array(buf.length - (buf.length % 4));
  copy.set(buf.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}
