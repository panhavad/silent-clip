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

export async function drawOverlay({ W, H, caption, chatLine, login, layout }) {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  const u = W / 720;
  const videoBottom = layout === 'crop' ? H * 0.68 : (H + W * 9 / 16) / 2;
  if (caption) {
    ctx.font = `900 ${Math.round(58 * u)}px "Arial Black", Impact, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const lines = wrap(ctx, caption.toUpperCase(), W * 0.86);
    const lh = 70 * u;
    const top = (layout === 'crop' ? H * 0.17 : H * 0.2) - ((lines.length - 1) * lh) / 2;
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
    const y = videoBottom + 110 * u;
    ctx.fillStyle = 'rgba(145, 70, 255, 0.92)';
    roundRect(ctx, W / 2 - tw / 2 - 26 * u, y - 34 * u, tw + 52 * u, 68 * u, 34 * u);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, W / 2, y, W * 0.86);
  }
  if (login) {
    ctx.font = `600 ${Math.round(26 * u)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6 * u;
    ctx.fillText(`twitch.tv/${login}`, W / 2, videoBottom + 40 * u);
  }
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function filterGraph({ W, H, layout, withOverlay }) {
  const bw = Math.round(W / 8 / 2) * 2, bh = Math.round(H / 8 / 2) * 2;
  const base = layout === 'crop'
    ? `[0:v]fps=30,scale=-2:${H},crop=${W}:${H},setsar=1[base]`
    : `[0:v]fps=30,split=2[a][b];` +
      `[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H},eq=brightness=-0.12:saturation=1.2,setsar=1[bg];` +
      `[b]scale=${W}:-2,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  return withOverlay ? `${base};[base][1:v]overlay=0:0,format=yuv420p[v]` : `${base};[base]format=yuv420p[v]`;
}

/**
 * Render a vertical clip. Jobs are serialized so several watchers can share one encoder.
 * @returns {Promise<{video: Blob, thumb: Blob, width: number, height: number, duration: number}>}
 */
export function renderClip(job) {
  const run = queue.then(() => doRender(job));
  queue = run.catch(() => {});
  return run;
}

async function doRender({ bytes, ext = 'ts', offsetSec = 0, durationSec = 30, caption = '', chatLine = '', login = '',
  layout = 'blur', resolution = '720x1280', captions = true, thumbAt = 20, onProgress }) {
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
    const args = [
      '-ss', offsetSec.toFixed(3), '-i', `in.${ext}`,
      ...(withOverlay ? ['-i', 'ov.png'] : []),
      '-t', durationSec.toFixed(3),
      '-filter_complex', filterGraph({ W, H, layout, withOverlay }),
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
