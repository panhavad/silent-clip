// Client-side rendering with ffmpeg.wasm: cut [offset, offset+duration] from the raw
// Twitch segments, reframe to 9:16 (Shorts / TikTok / Reels) and burn in captions.
// A fresh ffmpeg instance is used per job: ffmpeg.wasm can trap on a second exec() after a
// heavy encode, and loading a cached instance only takes ~0.5s.
const CORE = () => ({
  coreURL: `${location.origin}/vendor/ffmpeg-core/ffmpeg-core.js`,
  wasmURL: `${location.origin}/vendor/ffmpeg-core/ffmpeg-core.wasm`,
});
let queue = Promise.resolve();
let warm = null;

async function createFFmpeg(onLog, onProgress) {
  const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
  const ff = new FFmpeg();
  ff.on('log', ({ message }) => onLog(message));
  ff.on('progress', onProgress);
  await ff.load(CORE());
  return ff;
}

// Warm the HTTP cache (32 MB wasm) so the first clip renders without a long download.
export function preloadRenderer() {
  if (!warm) {
    warm = createFFmpeg(() => {}, () => {}).then((ff) => ff.terminate()).catch((e) => { warm = null; throw e; });
  }
  return warm;
}

// Grab a JPEG frame from the rendered MP4 with the browser's own decoder.
async function snapshot(blob, at) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('thumbnail decode failed')); });
    v.currentTime = Math.max(0, Math.min(at, (v.duration || at) - 0.2));
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 4000); });
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  } catch { return null; } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); }
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Vertical layout anchors (720x1280 reference, scaled by u):
// hook headline on top, video in the middle, spoken subtitles under the video, chat bubble below.
export function anchors(W, H, layout) {
  const u = W / 720;
  if (layout === 'crop') {
    return { u, hookY: H * 0.17, watermarkY: H * 0.69, subY: H * 0.62, chatY: H * 0.76 };
  }
  const vh = W * 9 / 16, vt = (H - vh) / 2, vb = vt + vh;
  return { u, hookY: H * 0.2, watermarkY: vt - 22 * u, subY: vb + 85 * u, chatY: vb + 200 * u };
}

export async function drawOverlay({ W, H, caption, chatLine, login, layout }) {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  const { u, hookY, watermarkY, chatY } = anchors(W, H, layout);
  if (caption) {
    ctx.font = `900 ${Math.round(58 * u)}px "Arial Black", Impact, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const lines = wrap(ctx, caption.toUpperCase(), W * 0.86);
    const lh = 70 * u;
    const top = hookY - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => {
      ctx.lineWidth = 12 * u;
      ctx.strokeStyle = '#000';
      ctx.strokeText(l, W / 2, top + i * lh);
      ctx.fillStyle = i === lines.length - 1 && lines.length > 1 ? '#ffe14d' : '#fff';
      ctx.fillText(l, W / 2, top + i * lh);
    });
  }
  if (chatLine) {
    const text = `💬 ${chatLine}`.slice(0, 48);
    ctx.font = `700 ${Math.round(34 * u)}px "Segoe UI", Arial, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = Math.min(ctx.measureText(text).width, W * 0.86);
    ctx.fillStyle = 'rgba(145, 70, 255, 0.92)';
    roundRect(ctx, W / 2 - tw / 2 - 26 * u, chatY - 34 * u, tw + 52 * u, 68 * u, 34 * u);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, W / 2, chatY, W * 0.86);
  }
  if (login) {
    ctx.font = `600 ${Math.round(24 * u)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6 * u;
    ctx.fillText(`twitch.tv/${login}`, W / 2, watermarkY);
  }
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// One transparent strip per subtitle phrase; ffmpeg shows each during its time range.
export const SUB_STRIP_H = 170;
export async function drawSubtitle({ W, text }) {
  const u = W / 720;
  const h = Math.round(SUB_STRIP_H * u / 2) * 2;
  const c = new OffscreenCanvas(W, h);
  const ctx = c.getContext('2d');
  ctx.font = `900 ${Math.round(52 * u)}px "Arial Black", Impact, "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lines = wrap(ctx, text.toUpperCase(), W * 0.9).slice(0, 2);
  const lh = 64 * u;
  const top = h / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => {
    ctx.lineWidth = 11 * u;
    ctx.strokeStyle = '#000';
    ctx.strokeText(l, W / 2, top + i * lh);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(l, W / 2, top + i * lh);
  });
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { png: new Uint8Array(await blob.arrayBuffer()), height: h };
}

function filterGraph({ W, H, layout, withOverlay, subs = [] }) {
  const bw = Math.round(W / 8 / 2) * 2, bh = Math.round(H / 8 / 2) * 2;
  const parts = [layout === 'crop'
    ? `[0:v]fps=30,scale=-2:${H},crop=${W}:${H},setsar=1[l0]`
    : `[0:v]fps=30,split=2[a][b];` +
      `[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.12:saturation=1.2,setsar=1[bg];` +
      `[b]scale=${W}:-2,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[l0]`];
  let last = 'l0', input = 1, n = 0;
  if (withOverlay) { parts.push(`[${last}][${input++}:v]overlay=0:0[l${++n}]`); last = `l${n}`; }
  for (const s of subs) {
    parts.push(`[${last}][${input++}:v]overlay=0:${s.y}:enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})'[l${++n}]`);
    last = `l${n}`;
  }
  parts.push(`[${last}]format=yuv420p[v]`);
  return parts.join(';');
}

/**
 * Render a vertical clip. Jobs are serialized so several watchers can share one encoder.
 * `subtitles` is a list of {text, start, end} (seconds from clip start) burned in under the video.
 * @returns {Promise<{video: Blob, thumb: Blob, width: number, height: number, duration: number}>}
 */
export function renderClip(job) {
  const run = queue.then(() => doRender(job));
  queue = run.catch(() => {});
  return run;
}

/** Decode the clip's audio to 16 kHz mono float PCM for speech recognition. */
export function extractAudio({ bytes, ext = 'ts', offsetSec = 0, durationSec = 30 }) {
  const run = queue.then(async () => {
    const ff = await createFFmpeg(() => {}, () => {});
    try {
      await ff.writeFile(`in.${ext}`, bytes);
      const code = await ff.exec(['-ss', offsetSec.toFixed(3), '-i', `in.${ext}`, '-t', durationSec.toFixed(3),
        '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'a.pcm']);
      if (code !== 0) throw new Error('Could not extract audio');
      const d = await ff.readFile('a.pcm');
      return new Float32Array(d.buffer, d.byteOffset, Math.floor(d.byteLength / 4));
    } finally {
      ff.terminate();
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function doRender({ bytes, ext = 'ts', offsetSec = 0, durationSec = 30, caption = '', chatLine = '', login = '',
  layout = 'blur', resolution = '720x1280', captions = true, subtitles = [], thumbAt = 20, onProgress }) {
  const [W, H] = String(resolution).split('x').map(Number);
  const logTail = [];
  const ff = await createFFmpeg(
    (m) => { logTail.push(m); if (logTail.length > 30) logTail.shift(); },
    ({ time }) => onProgress?.(Math.min(1, Math.max(0, time / 1e6 / durationSec))),
  );
  const withOverlay = captions && Boolean(caption || chatLine || login);
  try {
    await ff.writeFile(`in.${ext}`, bytes);
    if (withOverlay) await ff.writeFile('ov.png', await drawOverlay({ W, H, caption, chatLine, login, layout }));
    const { subY } = anchors(W, H, layout);
    const subs = [];
    for (const [i, s] of (subtitles || []).slice(0, 60).entries()) {
      if (!(s.end > s.start) || !s.text) continue;
      const { png, height } = await drawSubtitle({ W, text: s.text });
      await ff.writeFile(`sub${i}.png`, png);
      subs.push({ file: `sub${i}.png`, start: s.start, end: s.end, y: Math.round(subY - height / 2) });
    }
    const args = [
      '-ss', offsetSec.toFixed(3), '-i', `in.${ext}`,
      ...(withOverlay ? ['-i', 'ov.png'] : []),
      ...subs.flatMap((s) => ['-i', s.file]),
      '-t', durationSec.toFixed(3),
      '-filter_complex', filterGraph({ W, H, layout, withOverlay, subs }),
      '-map', '[v]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-profile:v', 'high', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', 'out.mp4',
    ];
    const code = await ff.exec(args).catch((e) => { throw new Error(`${e?.message || e} - ${logTail.slice(-3).join(' | ')}`); });
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${logTail.slice(-4).join(' | ')}`);
    const video = new Blob([await ff.readFile('out.mp4')], { type: 'video/mp4' });
    const thumb = await snapshot(video, thumbAt);
    return { video, thumb, width: W, height: H, duration: durationSec };
  } finally {
    ff.terminate();
  }
}
